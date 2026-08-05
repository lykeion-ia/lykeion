import { homedir } from "node:os";
import { join } from "node:path";

/** This build's own version, carried on the pairing approval screen so a lab
 *  owner can tell which build of the daemon is asking to join, and on every
 *  report after that so the same number is what the lab shows on screen. */
export const DAEMON_VERSION = "0.1.0";

/**
 * What this program was asked to do. `serve` is the machine itself — the
 * process that pairs, heartbeats and reports; `status` and `stop` are two
 * ways of talking to one that is already running. `help` and `version` are
 * not words anybody types: they are what the two flags that ask this program
 * about itself resolve to, and they are commands here so that answering one
 * is a thing this program does rather than a thing it does on the way to
 * serving.
 */
export type DaemonCommand = "serve" | "status" | "stop" | "help" | "version";

/** The words that name a command. */
const COMMANDS: readonly DaemonCommand[] = ["serve", "status", "stop"];

/** Flags that carry a value, written either as `--flag value` or
 *  `--flag=value`. */
const VALUE_FLAGS: readonly string[] = ["--lab", "--port", "--data-dir", "--work-dir"];

/** Flags that stand on their own. */
const BARE_FLAGS: readonly string[] = ["--no-browser", "--detached", "--help", "-h", "--version"];

/** What `--help` prints. Written out here, beside the parsing it describes,
 *  so that a flag gained or lost is one edit rather than two that can drift
 *  apart — a help screen that names a flag the parser refuses is worse than
 *  no help screen at all. */
export const USAGE = `lykeion-daemon — the per-machine process that pairs a computer with a lab.

Usage:
  lykeion-daemon [serve] [flags]   Pair this machine if it is not paired, then
                                   heartbeat and report until it is stopped.
                                   The default when no command is named.
  lykeion-daemon status [flags]    Ask a running daemon how it is doing.
                                   Always answers with JSON, whatever went wrong.
  lykeion-daemon stop [flags]      Ask a running daemon to stop, and wait until
                                   it actually has.

Flags:
  --lab <url>        The lab to pair with. Only used while unpaired; once a
                     token is on disk the lab it names is the lab. [LYKEION_LAB]
  --port <n>         The loopback port the pairing page binds. 0 takes whatever
                     is free. [LYKEION_DAEMON_PORT]
  --data-dir <dir>   Where this machine keeps what it knows about itself. One
                     directory is one machine identity, and all three commands
                     read it. [LYKEION_DAEMON_DATA_DIR]
  --work-dir <dir>   Where session workspaces live while an agent runs in
                     them. Defaults to --data-dir. [LYKEION_DAEMON_WORK_DIR]
  --no-browser       Print the pairing link rather than opening a browser on it.
  --detached         Serve in the background and return to the terminal.
                     Implies --no-browser.
  -h, --help         Print this and do nothing else.
  --version          Print this build's version and do nothing else.

A flag beats the environment variable beside it, and an environment variable
set to the empty string counts as unset. A flag reads the same before the
command as after it, and a flag that takes a value takes it either way round:
--data-dir <dir> and --data-dir=<dir> are the same thing.`;

/**
 * Everything the daemon reads about its environment, resolved once at
 * startup. A researcher who runs the daemon with no configuration at all
 * still gets a working process: no lab paired yet, a free loopback port for
 * the setup page, and a platform-conventional place to keep its own state.
 */
export interface DaemonConfig {
  command: DaemonCommand;
  /** The lab to pair with. Undefined until the person names one. */
  lab?: string;
  /** The loopback port the setup page is served on. 0 picks a free one. */
  port: number;
  openBrowser: boolean;
  detached: boolean;
  /** Where this machine keeps what it knows about itself. One directory is
   *  one daemon: it holds the token, and the file that says which process
   *  owns both. Naming another one is how a machine runs a second daemon
   *  against a second lab, and how this program can be exercised without
   *  touching the one the account actually runs. */
  dataDir: string;
  /** Where session workspaces live while an agent runs in them — separate
   *  from `dataDir` so the two can sit on different disks, and defaulting to
   *  it when a researcher has no reason to keep them apart. */
  workDir: string;
}

/**
 * An unset environment variable and one set to the empty string mean the
 * same thing here: absent. A shell profile or a launch agent blanks a
 * setting by assigning it nothing, and `??` alone treats that empty string
 * as a real value — which for `lab` would pair the daemon with the empty
 * string rather than leaving it unpaired.
 */
function nonEmpty(raw: string | undefined): string | undefined {
  return raw === undefined || raw === "" ? undefined : raw;
}

/** The platform's conventional home for this machine's own application data. */
function defaultDataDir(env: Record<string, string | undefined>): string {
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "Lykeion", "daemon");
  if (process.platform === "win32")
    return join(
      nonEmpty(env.APPDATA) ?? join(homedir(), "AppData", "Roaming"),
      "Lykeion",
      "daemon",
    );
  return join(
    nonEmpty(env.XDG_DATA_HOME) ?? join(homedir(), ".local", "share"),
    "lykeion",
    "daemon",
  );
}

function readPort(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`LYKEION_DAEMON_PORT must be a port number, not ${raw}`);
  return port;
}

/** A command line taken apart: the words that name what to do, the value
 *  flags with what they were given, and the bare flags that were present. */
interface CommandLine {
  words: string[];
  values: Map<string, string>;
  present: Set<string>;
}

/**
 * Takes the daemon's own command line apart — no library, since the whole
 * package carries zero runtime dependencies — and refuses anything on it
 * this program does not have, before any of it is acted on. A flag it does
 * not know is a typo or a flag from something else, and either way the
 * person meant something the daemon cannot do: reading `--lba https://…` as
 * "serve" pairs a machine they never asked to pair, mints an identity, and
 * runs until they notice.
 *
 * A value flag is written `--flag value` or `--flag=value`, and the two mean
 * the same thing. Both forms are what people's hands already type, and a
 * program that takes only one of them refuses a line whose meaning is not in
 * any doubt.
 *
 * They differ in one place, and only because the ambiguity is real in one of
 * them: `--data-dir --no-browser` is somebody who forgot the value, so it is
 * refused rather than keeping a machine's identity in a directory called
 * `--no-browser`, while `--data-dir=--no-browser` names that directory on
 * purpose and is taken at its word. `--data-dir` with nothing after it at
 * all, and `--data-dir=` with nothing after the sign, are both a value that
 * was not given — falling back to the default there is how `stop --data-dir`
 * stops the daemon somebody was not talking about.
 *
 * A word that is not a flag, and is not the value of one, is a command word.
 * Where it sits on the line is not information: a flag reads the same before
 * the command as after it.
 */
function scan(argv: string[]): CommandLine {
  const words: string[] = [];
  const values = new Map<string, string>();
  const present = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (!arg.startsWith("-")) {
      words.push(arg);
      continue;
    }
    const sign = arg.indexOf("=");
    const name = sign === -1 ? arg : arg.slice(0, sign);

    if (VALUE_FLAGS.includes(name)) {
      let value: string;
      if (sign === -1) {
        const next = argv[index + 1];
        if (next === undefined) throw new Error(`${name} needs a value, and nothing followed it`);
        if (next.startsWith("-"))
          throw new Error(`${name} needs a value, and ${next} is another flag`);
        value = next;
        index += 1;
      } else {
        value = arg.slice(sign + 1);
        if (value === "") throw new Error(`${name} needs a value, and nothing followed the =`);
      }
      // The first of a repeated flag wins, so that a line naming the same
      // flag twice reads the same way whichever form each was written in.
      if (!values.has(name)) values.set(name, value);
      continue;
    }

    if (BARE_FLAGS.includes(name)) {
      if (sign !== -1)
        throw new Error(`${name} does not take a value — it is either given or it is not`);
      present.add(name);
      continue;
    }

    throw new Error(`${name} is not something this program takes — run --help to see what it does`);
  }

  return { words, values, present };
}

/**
 * Which of the commands the line names. A line with no command word on it is
 * `serve`, so the plainest way to run this machine — name a lab and nothing
 * else — stays the plainest way to run it. A word that is not one of the
 * three is refused by name rather than quietly serving: somebody who typed
 * `lykeion-daemon restart` meant something, and starting a second daemon is
 * not it. A second word is refused for saying what it is: two commands is
 * not a thing to pick a winner from.
 *
 * The two flags that ask this program about itself are answered first and
 * wherever they appear. Somebody asking what a command does has not asked
 * for it to be run, and this program's version of running it binds two
 * ports, claims a data directory and pairs a new machine.
 */
function readCommand(line: CommandLine): DaemonCommand {
  if (line.present.has("--help") || line.present.has("-h")) return "help";
  if (line.present.has("--version")) return "version";
  const [first, second] = line.words;
  if (second !== undefined)
    throw new Error(`${second} is not something this program takes — run --help to see what it does`);
  if (first === undefined) return "serve";
  const command = COMMANDS.find((name) => name === first);
  if (command === undefined)
    throw new Error(
      `${first} is not a command — this program takes serve, status, or stop, and --help for the rest`,
    );
  return command;
}

export function readDaemonConfig(
  env: Record<string, string | undefined>,
  argv: string[],
): DaemonConfig {
  const line = scan(argv);
  const command = readCommand(line);
  // Answered without reading the rest of the line. Both say something about
  // this program rather than doing anything with a lab, a port or a
  // directory, and refusing one of those would answer a question about the
  // program with a complaint about something else.
  if (command === "help" || command === "version") {
    const dir = defaultDataDir(env);
    return { command, port: 0, openBrowser: false, detached: false, dataDir: dir, workDir: dir };
  }

  const detached = line.present.has("--detached");
  const lab = nonEmpty(line.values.get("--lab")) ?? nonEmpty(env.LYKEION_LAB);
  const port = readPort(nonEmpty(line.values.get("--port")) ?? nonEmpty(env.LYKEION_DAEMON_PORT));
  const openBrowser = !detached && !line.present.has("--no-browser");
  const dataDir =
    nonEmpty(line.values.get("--data-dir")) ??
    nonEmpty(env.LYKEION_DAEMON_DATA_DIR) ??
    defaultDataDir(env);
  const workDir =
    nonEmpty(line.values.get("--work-dir")) ?? nonEmpty(env.LYKEION_DAEMON_WORK_DIR) ?? dataDir;

  return { command, lab, port, openBrowser, detached, dataDir, workDir };
}
