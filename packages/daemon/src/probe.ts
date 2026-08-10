import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { delimiter, join } from "node:path";
import type { AgentCli, AgentOption } from "@lykeion/api";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { connectAcp } from "./acp";
import { confinementFor } from "./agent-home";
import { confine, noBackendReason, policyFor, sandboxBackendFor } from "./sandbox";
import { readAdvertised } from "./agent-options";
import { adapterEnvFor, sessionMetaFor } from "./session";

/**
 * What a probe of this machine can say about a catalogue entry, before it is
 * attached to a particular runtime record. The daemon fills in `runtimeId`
 * once it knows which machine it is pairing as; probing itself has no
 * opinion on that.
 */
export type ProbedCli = Omit<AgentCli, "runtimeId">;

/**
 * The coding-agent CLIs the daemon knows how to look for, in the order they
 * are reported. `command` is the bare executable name searched for on PATH —
 * never a path, and never passed through a shell.
 */
export const CATALOGUE: ReadonlyArray<{ id: string; name: string; command: string }> = [
  { id: "claude", name: "Claude Code", command: "claude" },
  { id: "codex", name: "Codex", command: "codex" },
  { id: "gemini", name: "Gemini", command: "gemini" },
  { id: "copilot", name: "Copilot", command: "copilot" },
  { id: "cursor", name: "Cursor", command: "cursor" },
  { id: "opencode", name: "opencode", command: "opencode" },
  { id: "kimi", name: "Kimi", command: "kimi" },
  { id: "kiro", name: "Kiro", command: "kiro" },
  { id: "qoder", name: "Qoder", command: "qoder" },
  { id: "codebuddy", name: "CodeBuddy", command: "codebuddy" },
  { id: "hermes", name: "Hermes", command: "hermes" },
  { id: "openclaw", name: "OpenClaw", command: "openclaw" },
  { id: "pi", name: "Pi", command: "pi" },
];

/**
 * ACP adapter candidates for each catalogue entry, in preference order.
 * Each is a separate program from the CLI itself, resolved on `PATH` the
 * same way, never through a shell. An id with no entry has no known bridge
 * to speak ACP through yet, whatever the CLI itself can do on its own.
 */
const ADAPTER_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  claude: ["claude-agent-acp", "claude-code-acp"],
  codex: ["codex-acp"],
};

const WINDOWS_EXTENSIONS = [".exe", ".cmd", ".bat"];

/**
 * How long a command is given to answer `--version`. Ten seconds is far more
 * than a program needs to print a string, and deliberately so: a probe runs
 * once every five minutes, nothing waits on its answer, and the commands
 * being asked are routinely a version-manager shim, a launcher script, or a
 * runtime starting cold — several seconds of real work before the version is
 * printed. A budget set close to what a working command actually takes turns
 * every probe into a race, and a race is decided by how loaded the machine
 * is rather than by what is installed on it.
 *
 * It is still a budget. A command that has hung answers nothing, and the
 * probe that asked it goes on without it rather than waiting forever; a
 * daemon that has been asked to stop takes its probes back through `signal`
 * without waiting this out at all.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ProbeOptions {
  /** PATH to search, colon/semicolon-separated. Defaults to the process's own. */
  path?: string;
  /** How long a `--version` call is given to answer before the probe gives up
   *  on hearing one. */
  timeoutMs?: number;
  /** Takes the probe back. Every catalogued command is allowed the version
   *  budget to answer, and that is time a daemon which has been asked to stop
   *  would otherwise spend waiting on programs it no longer cares about. */
  signal?: AbortSignal;
  /** Receives the exact executable whose successful handshake made an agent
   *  ready, so session launch can use the same resolved adapter. */
  onAdapterResolved?: (agentId: string, command: string) => void;
  /** The platform whose sandbox backend would confine a session here.
   *  Production passes none and this machine's own platform is used. */
  platform?: string;
  /** Where this machine keeps its own state. Required, because a probe runs
   *  the researcher's own agent CLI and confines it the way a session is
   *  confined — and it can only deny this machine's own token if it is told
   *  where that is. */
  dataDir: string;
}

/**
 * Whether `candidate` is a file this machine can run as a command. POSIX
 * marks that with the executable bit; Windows has none, so a file simply
 * existing under one of the conventional executable extensions counts.
 */
export async function isRunnable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Searches `pathValue` the way a shell's own command lookup would, but
 * without ever invoking a shell: split on the platform separator, and for
 * each directory, the first candidate that exists and is runnable wins.
 */
async function resolveOnPath(command: string, pathValue: string): Promise<string | undefined> {
  const dirs = pathValue.split(delimiter).filter((dir) => dir.length > 0);
  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? WINDOWS_EXTENSIONS.map((ext) => join(dir, command + ext))
        : [join(dir, command)];
    for (const candidate of candidates) {
      if (await isRunnable(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * The first line of an answer with anything on it. A CLI that opens its
 * version output with a blank line, or clears the screen before printing,
 * still said what it was asked; taking line zero regardless would read that
 * as having said nothing.
 */
function firstSpokenLine(output: string): string {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** A directory a confined probe works in, and the one directory it may
 *  write. Removed again whichever way the probe went. */
function throwawayWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "lykeion-probe-"));
}

/**
 * Asks a resolved executable which build it is, and answers with what it
 * said — or the empty string, when it said nothing usable. Always an
 * argument array, never a shell string: a catalogue command name that
 * happened to contain shell syntax must not gain any meaning from it.
 *
 * Both streams are read, because a good number of command-line programs
 * answer `--version` on the error stream and exit zero; refusing to look
 * there would leave a working tool's build unread.
 *
 * A rejection, a non-zero exit and a timeout are one fact from here: this
 * machine could not be told which build it has. That is all they are. None
 * of them says the command is missing — the file was found and run, which is
 * the only thing "installed" ever meant — so none of them is reported that
 * way.
 */
function readVersion(
  resolved: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  platform: string,
  dataDir: string,
  agent: string,
): Promise<string> {
  // Asking a program what it is means running it, and it is the
  // researcher's agent CLI — the same code a turn drives. It is confined
  // exactly as a session is, so nothing about a probe is a way around the
  // boundary.
  const workspace = throwawayWorkspace();
  const confined = confine(
    platform,
    policyFor({ workspace, grants: [], dataDir, ...confinementFor(agent, workspace) }),
    { command: resolved, args: ["--version"] },
  );
  return new Promise((resolvePromise) => {
    const done = (version: string) => {
      rmSync(workspace, { recursive: true, force: true });
      resolvePromise(version);
    };
    execFile(
      confined.command,
      confined.args,
      // In the directory the boundary was rendered for. Without this the
      // child inherits whichever directory this daemon happens to have been
      // started in, which the profile does not allow — and a program that
      // cannot reach its own working directory does not get as far as
      // printing its version, so every build reads as unknown.
      { timeout: timeoutMs, signal, cwd: workspace },
      (error, stdout, stderr) => {
        if (error) {
          done("");
          return;
        }
        done(firstSpokenLine(stdout) || firstSpokenLine(stderr));
      },
    );
  });
}

/**
 * Whether the command resolves on `PATH` to a file this machine can run, and
 * which build it is when it does.
 *
 * Whether the command resolves at all is what `available` reports, and it is
 * the whole of what it reports. A search of `PATH` either finds such a file
 * or does not; there is no clock on it and nothing to lose a race to.
 *
 * Which build that file is, is the second question, and asking it means
 * running a program that answers on its own schedule. A command that will
 * not say — because it printed nothing, failed, or was still starting when
 * the budget ran out — leaves the build unknown, and an unknown build is
 * reported as the empty string beside an available command. That is a
 * narrower claim than a version, and a true one: a screen showing it says
 * the tool is there and its build is unknown, which is exactly what was
 * observed. Calling the command missing instead would report an absence
 * nobody saw, on a machine where a researcher can run the thing by typing
 * its name.
 */
async function probeCliVersion(
  command: string,
  pathValue: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  platform: string,
  dataDir: string,
  agent: string,
): Promise<{ available: boolean; version: string }> {
  const resolved = await resolveOnPath(command, pathValue);
  if (resolved === undefined) return { available: false, version: "" };
  // Found by looking, not by running: a machine whose platform has no
  // backend cannot confine this program, so it is never executed. The CLI
  // is still reported as installed, with its build unknown — a narrower
  // claim than a version, and a true one.
  if (sandboxBackendFor(platform) === undefined) return { available: true, version: "" };
  return {
    available: true,
    version: await readVersion(resolved, timeoutMs, signal, platform, dataDir, agent),
  };
}

/** Whatever `promise` settles to, unless `timeoutMs` passes or `signal`
 *  fires first. A probe's own clock, not the adapter's: an `initialize` a
 *  real adapter never answers must not hold the probe cycle open the way it
 *  would hold a researcher who actually needs the session — this is what
 *  keeps that from happening. `signal` firing and the timer firing are told
 *  apart in the rejection so a caller never mistakes an operator's stop for
 *  the adapter simply running out of time. */
function raced<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPromise(new Error(`did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        rejectPromise(err);
      },
    );
  });
}

/** The `initialize` handshake ACP opens with, the same shape `session.ts`
 *  sends when it opens a real session — a probe asking the same question a
 *  session start would, so `sessionReady` never claims more than a session
 *  start could actually cash in. */
const INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
};

/**
 * Whether `agentId` can actually be run: its adapter resolved on `PATH` and
 * answered `initialize` inside the probe's own budget. An id with no adapter
 * mapping is settled without spawning anything — there is nothing to look
 * for. Otherwise the adapter is spawned, asked, and always closed again
 * before this returns, whichever way the handshake went — a probe that
 * leaves an adapter process behind on every cycle would leak one every five
 * minutes, forever, for a machine that only ever finds the same answer.
 */
async function probeAdapter(
  agentId: string,
  pathValue: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onResolved: ((agentId: string, command: string) => void) | undefined,
  platform: string,
  dataDir: string,
): Promise<
  | { sessionReady: true; options?: AgentOption[] }
  | { sessionReady: false; sessionReadyReason: string }
> {
  // Asked before anything is looked for. A machine whose platform has no
  // sandbox backend cannot confine a run, and no agent is offered on it —
  // an agent that is never offered is the whole of how "never launch an
  // unsandboxed run" is kept before a run is even asked for.
  if (sandboxBackendFor(platform) === undefined)
    return { sessionReady: false, sessionReadyReason: noBackendReason(platform) };

  const adapterCommands = ADAPTER_COMMANDS[agentId];
  if (adapterCommands === undefined)
    return { sessionReady: false, sessionReadyReason: `no ACP adapter is known for ${agentId} yet` };

  let resolved: string | undefined;
  for (const candidate of adapterCommands) {
    const found = await resolveOnPath(candidate, pathValue);
    if (found !== undefined) {
      resolved = found;
      break;
    }
  }
  if (resolved === undefined)
    return {
      sessionReady: false,
      sessionReadyReason: `none of ${adapterCommands.join(", ")} is installed — install an ACP adapter to run ${agentId} sessions`,
    };

  // Confined exactly as a real session is. A probe that opens a session
  // opens one an agent could act in, and "never launch an unsandboxed run"
  // is not a rule about which caller asked — and the same goes for the
  // isolation a real session carries: the per-agent adapter env rides the
  // spawn here just as it does in `startSession`.
  const workspace = throwawayWorkspace();
  const confined = confine(
    platform,
    policyFor({ workspace, grants: [], dataDir, ...confinementFor(agentId, workspace) }),
    { command: resolved, args: [] },
  );
  const connection = await connectAcp(confined.command, confined.args, {
    cwd: workspace,
    env: { ...process.env, ...adapterEnvFor(agentId) },
  });
  // A throwaway session, opened and closed on every path. Options are
  // advertised on `session/new` rather than on `initialize`, and a Task
  // holds no session until its first Send — so without this the picker would
  // be empty at exactly the moment a researcher wants it, choosing a model
  // BEFORE asking the first question. A probe cycle costs one more round
  // trip; the adapter is torn down either way.
  let sessionId: string | undefined;
  try {
    await raced(connection.request("initialize", INITIALIZE_PARAMS), timeoutMs, signal);
    onResolved?.(agentId, resolved);
    let options: AgentOption[] | undefined;
    try {
      // A throwaway session is still a session the owner's registries could
      // leak into, so it carries the same `_meta` a real one does.
      const meta = sessionMetaFor(agentId);
      const created = await raced(
        connection.request("session/new", {
          cwd: workspace,
          mcpServers: [],
          ...(meta === undefined ? {} : { _meta: meta }),
        }),
        timeoutMs,
        signal,
      );
      sessionId = (created as { sessionId?: string }).sessionId;
      options = readAdvertised(created).options;
    } catch {
      // An entitlement refusal, an unauthenticated CLI: the agent keeps the
      // `sessionReady` answer its handshake earned, and what it offers is
      // left UNKNOWN rather than reported as nothing.
      //
      // The next probe that gets a session is what fills it in — which is
      // why `cliFingerprint` counts the options. A real session reads the
      // same answer when a turn starts, but keeps it to itself: nothing on
      // the run path carries it back to the lab.
    }
    return { sessionReady: true, ...(options === undefined ? {} : { options }) };
  } catch (err) {
    const tail = connection.stderrTail().trim();
    return { sessionReady: false, sessionReadyReason: tail || (err instanceof Error ? err.message : String(err)) };
  } finally {
    // Closed on every path, including the failing ones: a probe that leaks a
    // session leaks one every cycle, forever.
    if (sessionId !== undefined) connection.notify("session/cancel", { sessionId });
    await connection.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** One catalogue entry, settled as two independent questions asked at once:
 *  whether the CLI itself is installed and which build it is, and whether a
 *  session can actually be started against it. Run concurrently rather than
 *  one after the other, so a catalogue entry with both to check never costs
 *  more than the slower of the two — not their sum. */
async function probeOne(
  entry: { id: string; name: string; command: string },
  pathValue: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onResolved: ((agentId: string, command: string) => void) | undefined,
  platform: string,
  dataDir: string,
): Promise<ProbedCli> {
  const [cli, adapter] = await Promise.all([
    probeCliVersion(entry.command, pathValue, timeoutMs, signal, platform, dataDir, entry.id),
    probeAdapter(entry.id, pathValue, timeoutMs, signal, onResolved, platform, dataDir),
  ]);
  return { id: entry.id, name: entry.name, command: entry.command, ...cli, ...adapter };
}

/**
 * Probes every catalogued CLI concurrently and reports them back in
 * catalogue order, so the list a machine reports never depends on which
 * binary happened to answer first.
 */
export async function probeAgentClis(options: ProbeOptions): Promise<ProbedCli[]> {
  const pathValue = options.path ?? process.env.PATH ?? "";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Promise.all(
    CATALOGUE.map((entry) =>
      probeOne(
        entry,
        pathValue,
        timeoutMs,
        options.signal,
        options.onAdapterResolved,
        options.platform ?? process.platform,
        options.dataDir,
      ),
    ),
  );
}

/**
 * A probe's result, reduced to what two probes of the same machine are
 * judged identical on: which ids are present, at which version, whether
 * each is installed, whether each can actually run a session, and what each
 * said it offers. `id` alone is not enough — a version bump on a CLI that
 * was already known, one that has left PATH, or an adapter that starts or
 * stops answering, all leave the id set unchanged and still have to compare
 * as different. Sorted by id first, so probing the catalogue in a different
 * order never registers as a change on its own.
 *
 * The options belong here for a reason worth stating. A probe that reaches
 * an adapter but cannot open a throwaway session leaves them UNKNOWN rather
 * than reporting them as nothing (see `probeAdapter`) — an ordinary outcome
 * for a CLI that is installed but not signed in. Left out of this hash, the
 * successful probe five minutes later compared equal to the failed one and
 * was dropped, so the lab kept its "unknown" for the life of the daemon and
 * the composer offered a bare *Default* against an agent that had a whole
 * catalogue to give. Nothing else could correct it: a real session reads
 * what the agent advertises, but keeps it to itself.
 */
export function cliFingerprint(clis: ProbedCli[]): string {
  return JSON.stringify(
    [...clis]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((cli) => [cli.id, cli.version, cli.available, cli.sessionReady, cli.options]),
  );
}

/** "{os}-{arch}", the form the contract's `Runtime.platform` uses. */
export function platformTag(): string {
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case "darwin-arm64":
      return "macos-aarch64";
    case "darwin-x64":
      return "macos-x86_64";
    case "linux-x64":
      return "linux-x86_64";
    case "linux-arm64":
      return "linux-aarch64";
    case "win32-x64":
      return "windows-x86_64";
    default:
      return key;
  }
}
