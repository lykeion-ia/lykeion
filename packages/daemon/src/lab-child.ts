import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * How the lab is started when nobody says otherwise. It goes through the
 * package manager because that is the only way to reach `@lykeion/server`
 * from a checkout today: the daemon is a bundle of its own package and the
 * lab is a sibling package that has to be built before it can be run. That
 * makes the default only usable from inside the repository — `pnpm` has to
 * be on the path, and the working directory has to be somewhere in the
 * workspace — which is exactly the seam this is written as an argument for.
 * When the lab ships inside the daemon's own distribution, one default here
 * becomes something like `[process.execPath, <bundled server>]` and every
 * caller and every test is unchanged.
 */
export const DEFAULT_LAB_COMMAND: readonly string[] = [
  "pnpm",
  "--filter",
  "@lykeion/server",
  "start",
];

/** How long the lab is given to announce itself. Generous because the
 *  default command builds the lab before it runs it, and a machine that
 *  needs twenty seconds to do that on a cold cache is slow rather than
 *  broken. It is a bound rather than a guess: without one, a lab that binds
 *  nothing and says nothing leaves the daemon waiting for a line that will
 *  never come, with no front door and no error either. */
const LAB_STARTUP_TIMEOUT_MS = 60_000;

/** How long a lab asked to stop is given to stop on its own before it is
 *  ended outright. Asking first lets the lab close its database the way it
 *  means to; not waiting forever is what keeps a lab that has wedged from
 *  holding a daemon's shutdown — and its port — open behind it. */
const LAB_STOP_GRACE_MS = 5_000;

/**
 * Whether a signal on this platform can address a process group rather than
 * a single process, which is what supervising a lab reached through a
 * wrapper needs.
 *
 * POSIX only. Windows has no signalable process group behind a negative pid,
 * so there the lab is ended by ending the process this daemon spawned, and
 * anything that process started is left to whatever the wrapper does about
 * it — with the default command, a leaked lab. That is a real cost and it is
 * accepted rather than solved: Lykeion cannot confine an agent's run
 * anywhere but macOS today, so a daemon on Windows cannot run a Task at all
 * and a `taskkill /T` path here would be written for nobody. What is not
 * accepted is a shutdown that never returns — see {@link startLabChild} for
 * how that fails fast instead.
 */
const SIGNALS_REACH_GROUPS = process.platform !== "win32";

/** How often a lab being stopped is asked whether it has really gone. There
 *  is no event to wait on for a process this daemon did not spawn itself, so
 *  this is the resolution of "stopped" — short enough that shutting a daemon
 *  down does not feel like it is waiting on anything. */
const GROUP_POLL_MS = 10;

/**
 * The line `@lykeion/server` prints once it is listening, which is the only
 * way to learn a port it was told to pick for itself. Anchored and read from
 * the end so that the port is the port and not some number inside a host
 * name, and matched on the whole line so that a line merely quoting this one
 * — a log line, an error repeating a URL — cannot be mistaken for it.
 *
 * This couples the daemon to a sentence in another package. The coupling is
 * deliberate and cheap to notice: the tests here announce on exactly this
 * line, so a lab that changes what it prints fails them rather than hanging
 * for a minute in front of a researcher.
 */
const ANNOUNCEMENT = /^Lykeion workspace server on [a-z]+:\/\/[^\s/]+?:(\d+)$/;

/** A lab running beside this machine, reachable only through the front door. */
export interface LabChild {
  /** The port the lab took: a free one it was left to choose unless a caller
   *  named one, which only `--lab-only` does. Read from the lab's own
   *  startup line rather than assumed, because a port chosen for it is the
   *  only thing that can be. */
  readonly port: number;
  /** Resolves when the lab has ended, however it ended. `--lab-only` is
   *  alive for no other reason than to hold this one process, so that is
   *  what it waits on rather than on a schedule of its own. */
  readonly finished: Promise<void>;
  /** Ends the lab and waits until it has really ended. Safe to call twice,
   *  since the daemon can be told to shut down from more than one place. */
  stop(): Promise<void>;
}

export interface LabChildOptions {
  /**
   * The port the lab is told to bind, `0` — a free one, chosen by the
   * operating system — unless somebody says otherwise. Only `--lab-only`
   * says otherwise: with no front door in front of it the lab is what a
   * browser opens, so it takes the port a browser opens.
   */
  port?: number;
  /** Overrides {@link LAB_STARTUP_TIMEOUT_MS}. A test that means to watch a
   *  silent lab be given up on cannot spend a minute doing it. */
  startupTimeoutMs?: number;
}

/**
 * Where a lab this daemon starts keeps its records: beside this machine's
 * own state rather than mixed into it. The two are different things with
 * different lifetimes — a machine that is unpaired and paired again is a new
 * identity, and the studies in the lab it was talking to are not — and one
 * directory holding both is a directory neither can be cleared out of.
 *
 * The same rule in both topologies, so that a researcher who serves a lab
 * with `--lab-only` today and pairs a machine against the same data
 * directory tomorrow finds the lab they already had rather than an empty one.
 */
export function labDataDir(dataDir: string): string {
  return join(dataDir, "lab");
}

/** The file a data directory records "the lab for this machine runs here"
 *  in. Its presence is the record; what is written inside it is for whoever
 *  finds it. */
function labHereRecord(dataDir: string): string {
  return join(dataDir, "lab-here");
}

/**
 * Whether this data directory says the lab lives on this computer, and so
 * whether this daemon is the thing that has to start it.
 *
 * Read from disk rather than inferred from the lab's address, because the
 * two are different questions with the same answer written on them: a lab
 * URL on loopback is where the lab is, not whose job it is to run it, and a
 * researcher who starts `@lykeion/server` in their own terminal and points a
 * daemon at it must not have a second one started underneath them.
 */
export function labIsHere(dataDir: string): boolean {
  return existsSync(labHereRecord(dataDir));
}

/** Records that the lab for this machine runs on this computer, so that
 *  every later start of this daemon brings it up again. Written by whoever
 *  asks the researcher the question — the setup wizard — and read here. */
/**
 * Forgets that record, so the next start of this daemon looks for its lab
 * elsewhere.
 *
 * The absence of the file is what "the lab is not here" means, so answering
 * *somewhere else* has to be able to REMOVE it rather than merely decline to
 * write it. Without this, a researcher who chose wrongly and came back would
 * be told their answer was taken while the daemon went on starting a lab they
 * had just said they did not want.
 */
export function forgetLabHere(dataDir: string): void {
  rmSync(labHereRecord(dataDir), { force: true });
}

export function recordLabHere(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    labHereRecord(dataDir),
    "This machine's daemon runs the lab itself, and serves it on the daemon's own address.\n" +
      "Delete this file to stop it, and point the daemon at a lab elsewhere instead.\n",
  );
}

/**
 * Starts a lab on this computer and reports the port it took.
 *
 * The child is given `LYKEION_PORT=0` and `LYKEION_HOST=127.0.0.1`, so it
 * binds a free port on loopback and nothing else can reach it. That is the
 * whole shape of this topology: the daemon holds 1421, the browser only ever
 * opens 1421, and `forwardTo` carries what the application calls the rest of
 * the way. Giving the child a fixed port instead would put two processes in
 * a race for it on every restart, and would publish an address a researcher
 * could bookmark and then find gone.
 *
 * It is started in a process group of its own and stopped by signalling that
 * whole group, rather than the one process this daemon spawned. The default
 * command reaches the lab through a package manager, so the process this
 * spawns is a wrapper and the lab is its grandchild: signalling the child
 * alone kills the wrapper and leaves the lab holding its port and its
 * database, which is exactly the leak this supervisor exists to prevent. It
 * cost a bring-up to find, because a test that spawns `node` directly has no
 * wrapper in the middle and cannot see it.
 *
 * The group is also swept from an `exit` handler, so a daemon that ends
 * without being asked to — an uncaught exception, a signal it handles — does
 * not leave a lab behind. The one thing nothing here can cover is `SIGKILL`
 * on the daemon itself: no handler runs, and the lab is left running.
 *
 * All of which is POSIX, and this supervisor is a POSIX supervisor — see
 * {@link SIGNALS_REACH_GROUPS} for why that is a decision rather than an
 * oversight. On Windows `stop` ends the process it spawned and returns,
 * leaving whatever that process started; it fails fast and visibly rather
 * than waiting on a group that cannot be asked about, because an orphan a
 * researcher can see and end is worth more than a shutdown that never
 * returns.
 */
export async function startLabChild(
  dataDir: string,
  command: readonly string[] = DEFAULT_LAB_COMMAND,
  options: LabChildOptions = {},
): Promise<LabChild> {
  const [program, ...args] = command;
  if (program === undefined) throw new Error("a lab command has to name something to run");

  const child = spawn(program, args, {
    env: {
      ...process.env,
      LYKEION_PORT: String(options.port ?? 0),
      // Loopback whichever port it took. A lab reachable from the network
      // is a lab this project is not ready to offer — its sign-in has no
      // rate limiting and its session tokens are stored as given — and the
      // daemon starting one is not the moment to decide otherwise.
      LYKEION_HOST: "127.0.0.1",
      LYKEION_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
    // A group of its own, so that everything the command starts on its way
    // to the lab can be signalled together. See this function's own comment
    // for what it costs to signal only the process spawned here, and
    // {@link SIGNALS_REACH_GROUPS} for the platform that cannot have it —
    // where detaching would buy nothing and cost the child a console.
    detached: SIGNALS_REACH_GROUPS,
  });

  /**
   * Asks the lab's group a question, and answers whether there was anybody
   * there to ask. The group is this daemon's own and can be nobody else's:
   * `detached` above made the process `spawn` returned the leader of a new
   * group whose id is that process's own id, so `-pid` names the group this
   * call created and the processes it went on to start. A group that has
   * already gone is not an error worth raising — every caller here is on its
   * way out and the only thing that could be reported is that there is
   * nothing left to do.
   */
  const askGroup = (signal: NodeJS.Signals | 0): boolean => {
    const pid = child.pid;
    if (pid === undefined) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Whether there is nothing left of the lab at all — asked with signal `0`,
   * which delivers nothing and only reports whether there is still somebody
   * there to deliver it to. There is no event for a grandchild's ending, and
   * the process this daemon spawned exiting says nothing about the one
   * holding the port, so this is the only honest way to know.
   *
   * Where there are no groups to ask about, the question narrows to the one
   * process this daemon spawned, which is the only one it can speak to.
   */
  const groupGone = (): boolean =>
    SIGNALS_REACH_GROUPS ? !askGroup(0) : child.exitCode !== null || child.signalCode !== null;

  /**
   * Ends what is left of the lab's group, and nothing else on this computer.
   *
   * Every signal that can end a process goes through here, and every one of
   * them is preceded by the check above, because the two ways this could
   * reach a stranger both run through an id that is no longer ours. A pid is
   * not handed out again while it is still in use as a process group's id,
   * so a group with anybody in it is this daemon's group; and an empty one
   * is an id that could since have gone to somebody else, so it is asked
   * about and then left alone rather than signalled. The daemon this machine
   * is running beside is not this daemon's to end.
   *
   * Off POSIX it ends the spawned process and accepts what that leaves. See
   * {@link SIGNALS_REACH_GROUPS}.
   */
  const endGroup = (signal: NodeJS.Signals): void => {
    if (groupGone()) return;
    if (SIGNALS_REACH_GROUPS) askGroup(signal);
    else child.kill(signal);
  };

  // Registered before anything can fail, so that every path out of this
  // function — including one where the daemon crashes a moment later —
  // still ends the lab. `endGroup` is what decides whether there is anything
  // left to end, so this needs no flag of its own to remember whether it has
  // already run.
  const killOnDaemonExit = (): void => endGroup("SIGKILL");
  process.once("exit", killOnDaemonExit);

  let exited = false;
  const finished = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });

  const stop = async (): Promise<void> => {
    // Skipped when the process this daemon spawned has gone and left nobody
    // behind it, which is what makes stopping a lab that has already stopped
    // cost nothing — and what makes a second `stop` a question rather than a
    // second round of signals.
    if (!(exited && groupGone())) {
      endGroup("SIGTERM");
      const outright = setTimeout(() => endGroup("SIGKILL"), LAB_STOP_GRACE_MS);
      try {
        // Both, because neither on its own means the lab has stopped: the
        // spawned process ending can leave the lab it started running, and a
        // group can look empty for the moment between a wrapper exiting and
        // the runtime reaping it. Bounded, because a process that survives
        // `SIGKILL` is not one waiting any longer will help with.
        await finished;
        const deadline = Date.now() + LAB_STOP_GRACE_MS * 2;
        while (!groupGone() && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, GROUP_POLL_MS));
      } finally {
        clearTimeout(outright);
      }
    }
    // Last, and only if there is really nothing left. A `stop` that ran out
    // of patience on a lab that will not go is the one moment the sweep on
    // the way out is worth the most, and letting go of it first — which this
    // did, until a review caught it — would take the safety net away from
    // exactly the case it exists for.
    if (groupGone()) process.removeListener("exit", killOnDaemonExit);
  };

  // `{ end: false }` because a pipe ends its destination when the source
  // ends, and the destination here is the daemon's own stderr: a lab that
  // stopped would otherwise take the daemon's ability to report anything
  // with it.
  child.stderr?.pipe(process.stderr, { end: false });

  try {
    const port = await announcedPort(child, options.startupTimeoutMs ?? LAB_STARTUP_TIMEOUT_MS);
    return { port, finished, stop };
  } catch (failure) {
    // A start that failed leaves nothing behind. The child may well be
    // running — a lab that bound a port and never announced it is the
    // interesting case — and the caller has no handle to stop it with,
    // because there is nothing to return.
    await stop();
    throw failure;
  }
}

/**
 * Reads the port off the lab's own startup line, and forwards everything
 * else it prints so that a researcher watching the daemon sees the lab's log
 * as well. The announcement itself is swallowed, and the daemon says where
 * the lab is in its own words: the line names the port the lab bound, which
 * behind a front door is a number nobody should be opening and which changes
 * on every restart.
 *
 * Three ways this ends badly, and each of them says which one it was:
 * the lab exits before announcing (a build that failed, a port refused, a
 * data directory it cannot open), the command cannot be run at all, or the
 * lab keeps running and never announces anything.
 */
function announcedPort(
  child: ReturnType<typeof spawn>,
  startupTimeoutMs: number,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const stdout = child.stdout;
    if (stdout === null) {
      reject(new Error("the lab was started without a pipe to read its startup line from"));
      return;
    }

    const patience = setTimeout(() => {
      reject(
        new Error(
          `the lab did not say where it was listening within ${startupTimeoutMs}ms of being started`,
        ),
      );
    }, startupTimeoutMs);

    let found = false;
    let pending = "";
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      pending += chunk;
      for (let newline = pending.indexOf("\n"); newline !== -1; newline = pending.indexOf("\n")) {
        const line = pending.slice(0, newline).trimEnd();
        pending = pending.slice(newline + 1);
        const announcement = found ? null : ANNOUNCEMENT.exec(line);
        if (announcement === null) {
          process.stdout.write(`${line}\n`);
          continue;
        }
        found = true;
        clearTimeout(patience);
        resolve(Number(announcement[1]));
      }
    });

    child.once("error", (cause) => {
      clearTimeout(patience);
      reject(new Error(`the lab could not be started: ${(cause as Error).message}`, { cause }));
    });

    child.once("exit", (code, signal) => {
      clearTimeout(patience);
      // Whatever the lab was in the middle of saying when it went is the
      // best evidence there is of why, so it is printed rather than dropped.
      if (pending !== "") process.stdout.write(`${pending}\n`);
      reject(
        new Error(
          signal === null
            ? `the lab exited with code ${code} before it said where it was listening`
            : `the lab was killed by ${signal} before it said where it was listening`,
        ),
      );
    });
  });
}
