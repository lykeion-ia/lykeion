import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { runBridge } from "./bridge";
import { DAEMON_VERSION, readDaemonConfig, USAGE, type DaemonConfig } from "./config";
import { labLabel, readState, revokedStatePath, setAsidePairing, type PairedState } from "./state";
import { beginPairing, beginSignIn, PairingRefused, type PairingSession } from "./pairing";
import { cliFingerprint, platformTag, probeAgentClis } from "./probe";
import { adapterFor, rememberAdapters } from "./ready-adapters";
import { acceptAdapter, revokeAdapter } from "./adapter-consent";
import type { AdapterLaunch } from "./agent-registry";
import { installAgentHomes } from "./agent-install";
import { heartbeat, report, workspacesGone } from "./lab";
import { createRetryLoop, type RetryLoop } from "./retry";
import { startKernelHost, type KernelHost } from "./kernel-host";
import { startRuns, type RunSubsystem } from "./runs";
import { heldWorkspaces, removeWorkspaces } from "./workspace";
import {
  acquireControl,
  callControl,
  ControlHeld,
  controlFilePath,
  heldMessage,
  inspectClaim,
  isProcessAlive,
  probeControl,
  readControlFile,
  removeControlFileIf,
  silentMessage,
  startControlServer,
  waitForExit,
  type ControlFile,
  type ControlServer,
} from "./control";

/** How often this machine tells the lab it is still there. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/** How often this machine looks again for what it can run. A report is sent
 *  again only when that comes back different from what was last sent. */
const PROBE_INTERVAL_MS = 5 * 60 * 1000;

/** How often this machine asks the lab which of the working directories it
 *  holds belong to a Study or a Task that is gone. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Where a daemon running in the background says everything it would have
 *  said to a terminal. */
const LOG_FILE = "daemon.log";

/** How long the launching process waits for a background daemon to say it
 *  is up, by claiming the data directory. */
const STARTUP_TIMEOUT_MS = 15_000;

/** How long `stop` waits for the process it asked to stop to be gone. */
const STOP_TIMEOUT_MS = 10_000;

const STARTUP_POLL_MS = 100;

/** Everything the serving process holds open. Gathered in one place because
 *  shutting down cleanly means letting go of every one of them — a single
 *  handle left behind is a daemon that answered `stop` and kept running. */
let heartbeatTimer: NodeJS.Timeout | undefined;
let probeTimer: NodeJS.Timeout | undefined;
let controlServer: ControlServer | undefined;
let pairingSession: PairingSession | undefined;
let runSubsystem: RunSubsystem | undefined;
let kernelHost: KernelHost | undefined;
let stopping = false;

/**
 * Everything this daemon currently has out in the world that answers to
 * somebody else's clock: calls to the lab, and the local commands a probe
 * asks for their version. A lab that accepts a connection and then says
 * nothing holds a call for as long as the runtime's own request timeout,
 * which is five minutes — far longer than a person watching `stop` will
 * wait, and long enough that the process is left looking wedged. Nothing
 * else here can end those calls, so they are all given this to answer to.
 */
const inFlight = new AbortController();

/** The data directory this process is serving, once it has claimed one. The
 *  refusal below is raised by a call made minutes or days after the command
 *  line was read, from a callback that was built before it. */
let servingDir: string | undefined;

const retries: RetryLoop = createRetryLoop({
  onRefused: () => {
    // The lab has forgotten this machine. Retrying cannot fix that, and
    // staying up pretending otherwise only keeps a dead claim alive.
    //
    // The pairing on disk goes with it. A token the lab has repudiated is
    // not this machine's identity any more, and a daemon that went on
    // reading it as one would answer `status` with a pairing that does not
    // exist, announce it on every later start, and never offer the link
    // that is the only way back into a lab.
    if (servingDir !== undefined && setAsidePairing(servingDir))
      console.error(
        `this machine's pairing has been set aside as ${revokedStatePath(servingDir)} — ` +
          `starting the daemon again offers a link to pair it into a lab afresh`,
      );
    void shutdown().then(() => {
      process.exitCode = 1;
    });
  },
});

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Lets go of everything this process holds: both timer chains, any backoff
 * being waited out, every call still in flight, the pairing session if one
 * is open, and the control endpoint's hold on the event loop. Nothing here
 * kills the process — with every handle released the loop has nothing left
 * to run and Node ends on its own, which is the only version of this that
 * proves there was no handle left behind.
 *
 * Two things it deliberately does not do. It does not close the control
 * endpoint outright, only unreferences it, so a daemon that is slow to
 * leave still answers for itself instead of looking like a pid that was
 * reused. And it does not release the claim on the data directory: this
 * function returning is not this process exiting, and a claim dropped by a
 * daemon that is still running is how two daemons end up on one machine
 * identity. The claim comes off at `exit`, which is the only moment that
 * means it.
 */
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (heartbeatTimer) clearTimeout(heartbeatTimer);
  if (probeTimer) clearTimeout(probeTimer);
  heartbeatTimer = undefined;
  probeTimer = undefined;
  retries.stop();
  inFlight.abort();

  const runs = runSubsystem;
  runSubsystem = undefined;
  if (runs) await runs.stop();

  // Stopped after the run subsystem, not before: runs.stop() drains rather
  // than aborts — it awaits every live session's own close, gives a queued
  // turn a durable ending, and keeps retrying a batch the lab has not yet
  // accepted — and a session reaching this machine's kernels during any of
  // that needs the host still standing to reach. A host stopped first is a
  // host that answers none of those calls, which is the same failure a
  // machine that crashed outright would leave behind.
  const host = kernelHost;
  kernelHost = undefined;
  if (host) await host.stop();

  const session = pairingSession;
  pairingSession = undefined;
  if (session) await session.close();

  controlServer?.release();
}

/** No probe ever fingerprints to the empty string — even nothing installed
 *  at all is a non-empty catalogue of "not available" entries — so this is
 *  never mistaken for a real prior report, and the very first probe always
 *  reports. One function for both the first report and every later one:
 *  there is no separate "initial" case to keep behaving the same as this
 *  one as the two would otherwise drift apart. */
let lastReported = "";

/**
 * Probes this machine and reports again only when what it found differs, on
 * `(id, version, available)`, from what was last sent.
 */
async function reportIfChanged(machine: PairedState, dataDir: string): Promise<void> {
  const resolved = new Map<string, AdapterLaunch>();
  const clis = await probeAgentClis({
    // A probe runs the researcher's own agent CLI and confines it exactly
    // as a session is confined, and the boundary denies this machine's own
    // state — so it has to be told where that is.
    dataDir,
    signal: inFlight.signal,
    onAdapterResolved: (agentId, launch) => resolved.set(agentId, launch),
  });
  rememberAdapters(resolved);
  if (cliFingerprint(clis) === lastReported) return;
  await retries.run(machine.lab, "report", () =>
    report(
      machine.lab,
      machine.token,
      {
        platform: platformTag(),
        daemonVersion: DAEMON_VERSION,
        // Nothing this daemon can do counts as a capability worth advertising
        // to the lab.
        capabilities: [],
        clis,
      },
      inFlight.signal,
    ),
  );
  lastReported = cliFingerprint(clis);
}

/** `reportIfChanged`, with a failure logged rather than left to reject —
 *  every caller of this reschedules on completion, and a probe that failed
 *  must be tried again in five minutes the same as one that succeeded, not
 *  leave probing stopped for good. */
function runProbeCycle(machine: PairedState, dataDir: string): Promise<void> {
  return reportIfChanged(machine, dataDir).catch((err: unknown) => {
    if (stopping) return;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`probe against ${machine.lab} failed: ${message}`);
  });
}

function scheduleHeartbeat(machine: PairedState): void {
  if (stopping) return;
  heartbeatTimer = setTimeout(() => {
    void retries
      .run(machine.lab, "heartbeat", () => heartbeat(machine.lab, machine.token, inFlight.signal))
      .then(() => scheduleHeartbeat(machine));
  }, HEARTBEAT_INTERVAL_MS);
}

function scheduleProbe(machine: PairedState, dataDir: string): void {
  if (stopping) return;
  probeTimer = setTimeout(() => {
    void runProbeCycle(machine, dataDir).then(() => scheduleProbe(machine, dataDir));
  }, PROBE_INTERVAL_MS);
}

/**
 * Removes the working directory of every Study and Task this machine holds
 * one for that the lab no longer has. A Task's directory is not scratch — it
 * holds the work of every turn that Task has run — so nothing here decides
 * on its own that a directory has gone stale: it asks, and removes only what
 * the lab said is gone.
 *
 * A lab that cannot be reached removes nothing, and a failure is logged
 * rather than left to bring the rest of this machine down with it.
 */
async function sweepWorkDir(workDir: string, machine: PairedState): Promise<void> {
  try {
    const held = heldWorkspaces(workDir);
    if (held.studyIds.length === 0 && held.taskIds.length === 0) return;
    const gone = await workspacesGone(machine.lab, machine.token, held, inFlight.signal);
    // A Task with a live ACP subprocess is excluded whatever the lab says:
    // removing the directory an adapter is standing in would take the turn's
    // own work with it, and the answer is still true on the next sweep.
    const live = new Set(runSubsystem?.liveSessionDirs() ?? []);
    removeWorkspaces(workDir, gone, (dir) => live.has(dir));
  } catch (err) {
    console.error(`sweeping ${workDir} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Sweeps again every hour for as long as this machine keeps running.
 *  Unreferenced, unlike the heartbeat and probe schedules: those are what a
 *  running `serve` is actually for and are meant to keep the process up,
 *  but clearing workspaces the lab has let go of is upkeep, never a reason
 *  on its own for this process to still be here. */
function scheduleSweep(workDir: string, machine: PairedState): void {
  if (stopping) return;
  const timer = setInterval(() => void sweepWorkDir(workDir, machine), SWEEP_INTERVAL_MS);
  timer.unref?.();
}

/** What both this machine's own control endpoint and a `status` run against
 *  a daemon that is not there answer with. `machine` is what the lab calls
 *  this computer once it has said, and what this computer would propose
 *  calling itself until then. */
function describe(config: DaemonConfig, machine: PairedState | undefined): Record<string, unknown> {
  return {
    version: DAEMON_VERSION,
    lab: machine?.lab ?? config.lab ?? null,
    machine: machine?.machineName ?? hostname(),
    paired: machine !== undefined,
  };
}

/** What starts this machine's kernel host: `uv`, resolving the interpreter
 *  and lockfile `packages/kernel-host`'s own `pyproject.toml` pins, run
 *  against that package by path rather than against whatever a bare
 *  `python` on this machine's `PATH` happens to be — a pinned lockfile
 *  resolved against an unpinned interpreter is not pinned at all. The path
 *  is built from this file's own location so it holds whether this module is
 *  run from source or from the bundle `build` produces, both of which sit
 *  two directories below `packages`. */
function kernelHostLaunch(): { command: string; args: string[] } {
  const kernelHostDir = join(import.meta.dirname, "..", "..", "kernel-host");
  return { command: "uv", args: ["run", "--project", kernelHostDir, "lykeion-kernel-host"] };
}

/**
 * This machine's kernel host, started the first time something on it needs
 * one rather than the moment this machine finishes pairing. A machine that is
 * never asked to run an agent never syncs a `uv` environment and never holds
 * a Python process open.
 *
 * The first ask is a session opening, not a cell running, and it cannot be
 * later than that: an agent reaches its kernels over a socket this host
 * binds for the Task, and the agent's own program connects to that socket as
 * it opens its session. The socket therefore has to exist before the session
 * does, and the only thing that can bind it is a host that is already
 * running. So a researcher who runs a turn and never runs a cell
 * does pay for this once.
 *
 * Every call while the one already started is still running returns that host
 * rather than starting a second. A host that has since died is not handed
 * back a second time either: `kernelHost` existing is not the same claim as it
 * still answering, and a caller of this is asking for something it can use.
 * `shutdown()` already lets `kernelHost` stay `undefined` rather than
 * assuming this was ever called.
 */
export function kernelHostFor(): KernelHost {
  const held = kernelHost;
  if (held?.running) return held;
  // Told to stop before it is replaced, and never merely dropped. A host
  // stops answering for reasons that say nothing about whether its process
  // is gone — a failed write to its input is one — so a machine that let go
  // of this reference without stopping it would leave an interpreter running
  // that nothing on this machine holds the other end of, and `shutdown()`
  // would stop only whichever host came last. Not awaited, because a caller
  // is asking for a host it can use and the one being replaced is no longer
  // that; the stop escalates to a kill on its own clock.
  if (held) void held.stop();
  const launch = kernelHostLaunch();
  kernelHost = startKernelHost({
    command: launch.command,
    args: launch.args,
    // stop() ends this same process to end this same conversation, so the
    // exit it causes is not news — only one this machine did not ask for is.
    onExit: (reason) => {
      if (!stopping) console.error(`this machine's kernel host exited (${reason})`);
    },
  });
  return kernelHost;
}

/**
 * The machine itself: claims the data directory, pairs if it has not
 * already, then heartbeats and reports for as long as it is left alone.
 */
async function runServe(config: DaemonConfig): Promise<void> {
  // Read before anything is claimed or bound, so a state file that will not
  // parse fails on the spot. Pairing again on top of one would throw away
  // whatever token it already holds without anyone deciding that was right.
  let machine = readState(config.dataDir);
  // Before the first call to a lab can be made, which is the earliest a
  // refusal can arrive.
  servingDir = config.dataDir;

  const token = randomBytes(32).toString("base64url");
  controlServer = await startControlServer({
    token,
    handlers: {
      status: () => {
        // Asking a daemon how it is doing is how a person who lost the link
        // gets another one, so every ask mints one — and retires the last,
        // which is what keeps a link that was printed into a log or a
        // scrollback from staying good.
        //
        // Minted whether or not this machine is paired, because the page
        // behind it is not the same page in the two cases and both are
        // needed. Unpaired, it opens the form that names a lab. Paired, it
        // opens the sign-in step and nothing else — the loopback server for a
        // paired daemon routes neither `/connect` nor `/paired` (see
        // `alreadyPaired`), so this link cannot re-home this machine or spend
        // a second code. It is named apart from `pairingLink` for that
        // reason: a caller that could not tell the two apart would offer one
        // where the other belongs.
        //
        // Withholding it while paired is what this used to do, and it left
        // the researcher `probe.ts` sends to "Lykeion's setup page" with no
        // such page anywhere on this machine.
        const link = pairingSession?.rotateNonce();
        return {
          running: true,
          pid: process.pid,
          ...describe(config, machine),
          ...(link === undefined ? {} : machine ? { signInLink: link } : { pairingLink: link }),
        };
      },
      stop: () => {
        void shutdown();
      },
      setAdapterConsent: (agent, command, accepted) => {
        // Against this machine's own data directory, the same place the
        // pairing token lives — an acceptance decides what runs beside a
        // credential, so it belongs with the rest of what only this account
        // may edit.
        if (accepted) acceptAdapter(config.dataDir, agent, command);
        else revokeAdapter(config.dataDir, agent, command);
      },
    },
  });

  const claim: ControlFile = { pid: process.pid, port: controlServer.port, token };
  try {
    await acquireControl(config.dataDir, claim);
  } catch (err) {
    await controlServer.close();
    controlServer = undefined;
    if (err instanceof ControlHeld) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // The one moment at which letting go of the claim is honest. Registered
  // only now, so a process that never held this directory cannot remove
  // somebody else's claim on its way out, and matched against what was
  // written, so a daemon leaving late cannot remove the claim of one that
  // has since taken over.
  process.once("exit", () => removeControlFileIf(config.dataDir, claim));

  // A daemon told to stop by its terminal, or by whatever manages it, ends
  // the same way one told through its own control endpoint does.
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  if (!machine) {
    pairingSession = await beginPairing(config);
    try {
      machine = await pairingSession.paired;
    } catch (err) {
      // A stop while pairing was open ends that session by design, and the
      // rejection it causes is the shutdown working rather than something
      // to report as a pairing failure.
      if (stopping) return;
      // A refusal is a person's answer, not a failure to reach anything, so
      // it says what to do next instead of reading as a fault. Starting the
      // daemon again is the whole of it: a new run opens a new request.
      if (err instanceof PairingRefused)
        console.error(`${err.message} — start this daemon again to ask a second time`);
      else console.error(err instanceof Error ? err.message : String(err));
      await shutdown();
      process.exitCode = 1;
      return;
    }
    // `pairingSession` is deliberately left open here, not closed — this
    // used to be the moment pairing was entirely done, but the page
    // `/paired` just answered is not a dead end any more (see `pairing.ts`'s
    // `renderAgentSignInPage`): it goes on polling `/agents` and posting to
    // `/agents/signin` on this exact loopback server while a researcher
    // signs each agent in. Closing the session the instant `paired` resolves
    // — what this line used to do — would race that page's own first
    // request and always win: its `setInterval` does not even fire for two
    // seconds, let alone whatever it takes a person to read the page and
    // press a button. `shutdown()` is what closes it now, on the same terms
    // as everything else this process opened — see the `pairingSession`
    // handling there, unchanged by this.
  }

  // A stop that arrived while pairing was still open has already let go of
  // everything; starting the timers now would hand the process back the
  // handles it just released.
  if (stopping) return;

  // A copy that cannot become undefined again, so the two schedules below
  // can be handed this machine's identity from inside a callback.
  const identity = machine;
  out(`Paired as "${identity.machineName}" with ${labLabel(identity)}`);

  // Seeded before anything asks an agent about its home: a run and the first
  // probe cycle below both reach into it, and an installation that is not
  // there yet is indistinguishable from one this machine cannot use.
  for (const result of installAgentHomes()) if (!result.ready) console.error(result.reason);

  // The sign-in step, kept reachable for a daemon that was already paired
  // when it started. A machine that pairs during this run already has one of
  // these — the session `beginPairing` opened, deliberately left standing for
  // the page `/paired` rendered — and it goes on serving `/` as the sign-in
  // page from here. This is the other half: every later start of the same
  // machine. Without it, D-5's "reachable again later by re-opening the
  // daemon's local address" is false the moment the first pairing finishes,
  // and the dock's own instruction names a page that does not exist.
  //
  // A port this machine cannot bind is a page this machine cannot offer, and
  // nothing more: said once and stepped past, rather than taken as a reason
  // for a paired daemon not to run at all. Everything below is what this
  // process is actually for.
  if (pairingSession === undefined) {
    try {
      pairingSession = await beginSignIn(config, identity);
    } catch (err) {
      // Named as a port only when one was actually named. `config.port`
      // defaults to 0, which means "whatever is free" rather than port zero,
      // and printing it reads as a nonsense number to whoever is trying to
      // work out what is holding the address.
      const where = config.port === 0 ? "on its loopback port" : `on port ${config.port}`;
      console.error(
        `this machine's sign-in page could not be opened ${where}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  runSubsystem = startRuns({
    lab: identity.lab,
    token: identity.token,
    workDir: config.workDir,
    dataDir: config.dataDir,
    adapterFor,
    kernelHost: kernelHostFor,
  });

  // Swept once now, so a directory the lab had already let go of before
  // this machine started does not wait an hour to go, and then again on the
  // schedule below.
  void sweepWorkDir(config.workDir, identity);
  scheduleSweep(config.workDir, identity);

  // The heartbeat schedule starts unconditionally, before the first report is
  // even attempted: a lab that is refusing reports (a routing regression, a
  // 500, anything short of the 401 the retry loop treats as terminal) must not
  // also stop this machine from saying it is alive — that is the one thing
  // this schedule exists to keep true regardless of what else is failing.
  scheduleHeartbeat(identity);
  // One probe chain rather than two: the five-minute timer is armed by the
  // first probe finishing rather than alongside it. Two chains against a lab
  // that is refusing reports each open their own retry loop, so it takes twice
  // the traffic while it is already failing, and `lastReported` ends up written
  // by whichever chain settled last rather than by the report the lab actually
  // applied — which then suppresses a report that should have been sent.
  void runProbeCycle(identity, config.dataDir).then(() => scheduleProbe(identity, config.dataDir));
}

/** The arguments the background copy is started with: the same ones this
 *  process was given, minus the flag that says to go to the background —
 *  a child that kept it would launch a child of its own, forever — and
 *  plus the one that says not to reach for a browser, which is the whole
 *  of what detaching already meant for a process with no terminal. */
function backgroundArgs(argv: string[]): string[] {
  const args = argv.filter((arg) => arg !== "--detached");
  if (!args.includes("--no-browser")) args.push("--no-browser");
  return args;
}

/** Waits for the background copy to claim the data directory under its own
 *  pid, which is the first thing a daemon that got as far as running does. */
async function waitForClaim(
  dir: string,
  pid: number,
  hasExited: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (readControlFile(dir)?.pid === pid) return true;
    if (hasExited() || Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, STARTUP_POLL_MS));
  }
}

/**
 * Starts the machine in the background and gets out of the way. The child
 * is its own session leader with its terminal given up, so closing the
 * window it was started from does not take it down.
 *
 * Its output goes to a file rather than nowhere. A background daemon that
 * cannot reach its lab prints a retry line every few seconds, and a
 * researcher whose Runtimes screen says offline needs those lines to be
 * somewhere — discarding them would leave the one process that knows what
 * is wrong as the only thing that cannot say so.
 */
async function runDetached(config: DaemonConfig): Promise<void> {
  // Noticed here as well as in the child, so somebody who asked for a
  // second background daemon is told so on the terminal they asked from,
  // rather than by a line in a log they have no reason to open. The child's
  // own claim is still what decides it.
  const held = await inspectClaim(config.dataDir);
  if (held && held.state !== "gone") {
    console.error(
      held.state === "answering"
        ? heldMessage(config.dataDir, held.file.pid)
        : silentMessage(config.dataDir, held.file.pid, held.file.port),
    );
    process.exitCode = 1;
    return;
  }

  mkdirSync(config.dataDir, { recursive: true });
  const logPath = join(config.dataDir, LOG_FILE);
  // Mode `0600` and then set again, for the reason the state file's is: a
  // file that already exists keeps the permissions it has. What lands here
  // is not only diagnostics — an unpaired daemon prints its pairing link,
  // and a link is a working door into this machine's setup page for as long
  // as it is unspent. A world-readable log would hand that to every account
  // on a shared workstation.
  const log = openSync(logPath, "a", 0o600);
  chmodSync(logPath, 0o600);
  const child = spawn(process.execPath, [process.argv[1] ?? "", ...backgroundArgs(process.argv.slice(2))], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  // The child has its own copy of the descriptor from here on, and this
  // process is about to end anyway; holding a second one open only risks
  // keeping the file alive after the daemon has finished with it.
  closeSync(log);

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.unref();

  const pid = child.pid;
  if (pid === undefined) {
    console.error(`could not start a background daemon — see ${logPath}`);
    process.exitCode = 1;
    return;
  }

  if (!(await waitForClaim(config.dataDir, pid, () => exited, STARTUP_TIMEOUT_MS))) {
    console.error(`the background daemon did not start — see ${logPath}`);
    process.exitCode = 1;
    return;
  }

  out(`Serving in the background as pid ${pid}.`);
  out(`Its output goes to ${logPath}`);
}

/** The answer for a daemon that is not answering: everything that can be
 *  known from disk alone, which is enough to tell a person whether this
 *  machine is paired and to which lab.
 *
 *  `silent` separates the two ways of not answering, because they call for
 *  opposite responses and this is the one command written to be read by a
 *  program. Nothing running at all invites starting one; a process holding
 *  the claim and saying nothing does not, and a caller that cannot tell them
 *  apart will try to start a daemon that is already there. */
function offlineStatus(config: DaemonConfig, silent: boolean): Record<string, unknown> {
  return { running: false, silent, ...describe(config, readState(config.dataDir)) };
}

/**
 * Always answers with JSON on standard output, whatever went wrong. This is
 * the one command written to be read by something other than a person, and
 * a transport failure printed as prose where an object was promised breaks
 * every caller that parses it. Anything worth saying about why the daemon
 * could not be reached goes to standard error, alongside the answer rather
 * than instead of it.
 */
async function runStatus(config: DaemonConfig): Promise<void> {
  const file = readControlFile(config.dataDir);
  let silent = false;
  if (file) {
    // The same question `stop` and `serve` ask, and answered on the same
    // short clock, so all three agree about what is running and none of
    // them makes a person wait on a process that is not going to reply.
    const state = await probeControl(file);
    if (state === "silent") {
      silent = true;
      // Said plainly on the error stream too, because a person reading this
      // wants the pid and the port, and the answer on the output stream
      // carries neither.
      console.error(
        `pid ${file.pid} holds ${controlFilePath(config.dataDir)} and did not answer on port ${file.port}`,
      );
    }
    if (state === "answering") {
      try {
        const answer = await callControl(file, "/status");
        if (answer.status === 200) {
          out(JSON.stringify(answer.body, null, 2));
          return;
        }
        console.error(`the daemon on pid ${file.pid} answered status with ${answer.status}`);
      } catch (err) {
        console.error(
          `the daemon on pid ${file.pid} stopped answering: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  out(JSON.stringify(offlineStatus(config, silent), null, 2));
}

/** Says the claim is finished with and clears it. Only ever reached once
 *  asking the port has shown that nothing stands behind it. */
function clearAbandoned(config: DaemonConfig, file: ControlFile, why: string): void {
  removeControlFileIf(config.dataDir, file);
  out(`No daemon is running for ${config.dataDir} — cleared a claim ${why}.`);
}

async function runStop(config: DaemonConfig): Promise<void> {
  const file = readControlFile(config.dataDir);
  if (!file) {
    out(`No daemon is running for ${config.dataDir}.`);
    return;
  }

  // Asked before anything is stopped or cleared, and the three answers get
  // three different treatments. A process that is there but silent is left
  // exactly as it is: it may be a healthy daemon that is merely not
  // scheduled, and clearing its claim would invite a second daemon onto its
  // machine identity.
  const state = await probeControl(file);
  if (state === "gone") {
    clearAbandoned(config, file, `left by pid ${file.pid}, which is not running this daemon`);
    return;
  }
  if (state === "silent") {
    console.error(silentMessage(config.dataDir, file.pid, file.port));
    process.exitCode = 1;
    return;
  }

  let status: number;
  try {
    status = (await callControl(file, "/stop")).status;
  } catch (err) {
    // It answered the ping a moment ago, so this is a daemon that went away
    // mid-conversation rather than one that was never there.
    if (!isProcessAlive(file.pid)) {
      clearAbandoned(config, file, `left by pid ${file.pid}, which has since gone`);
      return;
    }
    console.error(
      `the daemon on pid ${file.pid} stopped answering: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
    return;
  }

  if (status !== 200) {
    console.error(`the daemon on pid ${file.pid} answered stop with ${status}`);
    process.exitCode = 1;
    return;
  }

  // Said only once it is true. A daemon that took the request and then hung
  // on to a handle it forgot to let go of is exactly the failure this
  // command exists to notice, and a 200 alone cannot tell it apart from a
  // process that actually ended.
  if (!(await waitForExit(file.pid, STOP_TIMEOUT_MS))) {
    console.error(`the daemon on pid ${file.pid} took the stop but is still running`);
    process.exitCode = 1;
    return;
  }
  removeControlFileIf(config.dataDir, file);
  out(`Stopped the daemon on pid ${file.pid}.`);
}

/** The word that says this process is a relay rather than this machine. */
const BRIDGE = "bridge";

async function main(): Promise<void> {
  // Answered before this program's own command line is read at all. A relay
  // is not this machine — it pairs with nothing, claims no directory and
  // holds no identity — and the arguments that address one are not arguments
  // this machine takes.
  if (process.argv[2] === BRIDGE) {
    process.exitCode = await runBridge(process.argv.slice(3));
    return;
  }
  const config = readDaemonConfig(process.env, process.argv.slice(2));
  // Answered before anything binds a port, claims a directory or mints a
  // pairing link. Somebody asking what this program is has not asked it to
  // introduce their computer to a lab.
  if (config.command === "help") return out(USAGE);
  if (config.command === "version") return out(DAEMON_VERSION);
  if (config.command === "status") return runStatus(config);
  if (config.command === "stop") return runStop(config);
  if (config.detached) return runDetached(config);
  return runServe(config);
}

main().catch(async (err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  // A failure on the way up can happen with the control endpoint already
  // bound and this directory already claimed — a pairing port that is in
  // use is enough. Without this the process would sit there on that one
  // handle: never paired, never heartbeating, holding a claim, and
  // answering `status` as a healthy daemon that offers no way to pair it.
  await shutdown();
  process.exitCode = 1;
});
