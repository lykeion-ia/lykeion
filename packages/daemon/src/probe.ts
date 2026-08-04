import { access, constants } from "node:fs/promises";
import { execFile } from "node:child_process";
import { delimiter, join } from "node:path";
import type { AgentCli } from "@lykeion/api";

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
): Promise<string> {
  return new Promise((resolvePromise) => {
    execFile(resolved, ["--version"], { timeout: timeoutMs, signal }, (error, stdout, stderr) => {
      if (error) {
        resolvePromise("");
        return;
      }
      resolvePromise(firstSpokenLine(stdout) || firstSpokenLine(stderr));
    });
  });
}

/**
 * One catalogue entry, settled as two separate questions in the order they
 * can be answered.
 *
 * Whether the command resolves on PATH to a file this machine can run is
 * what `available` reports, and it is the whole of what it reports. A search
 * of PATH either finds such a file or does not; there is no clock on it and
 * nothing to lose a race to.
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
async function probeOne(
  entry: { id: string; name: string; command: string },
  pathValue: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ProbedCli> {
  const resolved = await resolveOnPath(entry.command, pathValue);
  if (resolved === undefined)
    return { id: entry.id, name: entry.name, command: entry.command, available: false, version: "" };

  const version = await readVersion(resolved, timeoutMs, signal);
  return { id: entry.id, name: entry.name, command: entry.command, available: true, version };
}

/**
 * Probes every catalogued CLI concurrently and reports them back in
 * catalogue order, so the list a machine reports never depends on which
 * binary happened to answer first.
 */
export async function probeAgentClis(options: ProbeOptions): Promise<ProbedCli[]> {
  const pathValue = options.path ?? process.env.PATH ?? "";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Promise.all(CATALOGUE.map((entry) => probeOne(entry, pathValue, timeoutMs, options.signal)));
}

/**
 * A probe's result, reduced to what two probes of the same machine are
 * judged identical on: which ids are present, at which version, and
 * whether each is installed. `id` alone is not enough — a version bump on a
 * CLI that was already known, or one that has left PATH, both leave the id
 * set unchanged and still have to compare as different. Sorted by id first,
 * so probing the catalogue in a different order never registers as a change
 * on its own.
 */
export function cliFingerprint(clis: ProbedCli[]): string {
  return JSON.stringify(
    [...clis].sort((a, b) => a.id.localeCompare(b.id)).map((cli) => [cli.id, cli.version, cli.available]),
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
