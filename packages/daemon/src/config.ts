import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** This build's own version, carried on the pairing approval screen so a lab
 *  owner can tell which build of the daemon is asking to join, and on every
 *  report after that so the same number is what the lab shows on screen. */
export const DAEMON_VERSION = "0.1.0";

/**
 * What this program was asked to do. `serve` is the machine itself — the
 * process that pairs, heartbeats and reports; `status`, `stop`, `open`,
 * `url` and `logs` are five ways of talking to one that is already running.
 * `open` and `url` both mint a fresh link to this machine's own page — the
 * first opens a browser on it, the second prints it alone for a caller over
 * SSH — and neither one is `status`, which answers nothing but how the
 * daemon is doing and must be safe to poll. `help` and `version` are not
 * words anybody types: they are what the two flags that ask this program
 * about itself resolve to, and they are commands here so that answering one
 * is a thing this program does rather than a thing it does on the way to
 * serving.
 */
export type DaemonCommand =
  | "serve"
  | "status"
  | "stop"
  | "open"
  | "url"
  | "logs"
  | "pair"
  | "help"
  | "version";

/** The words that name a command. */
const COMMANDS: readonly DaemonCommand[] = [
  "serve",
  "status",
  "stop",
  "open",
  "url",
  "logs",
  "pair",
];

/** Flags that carry a value, written either as `--flag value` or
 *  `--flag=value`. */
const VALUE_FLAGS: readonly string[] = ["--lab", "--port", "--data-dir", "--work-dir", "--code"];

/** Flags that stand on their own. */
const BARE_FLAGS: readonly string[] = [
  "--no-browser",
  "--detached",
  "--help",
  "-h",
  "--version",
  "--tail",
  "--lab-only",
];

/** What `--help` prints. Written out here, beside the parsing it describes,
 *  so that a flag gained or lost is one edit rather than two that can drift
 *  apart — a help screen that names a flag the parser refuses is worse than
 *  no help screen at all. */
export const USAGE = `lykeion — the per-machine process that pairs a computer with a lab.

Usage:
  lykeion [serve] [flags]   Pair this machine if it is not paired, then
                            heartbeat and report until it is stopped.
                            The default when no command is named.
  lykeion status [flags]    Ask a running daemon how it is doing.
                            Always answers with JSON, whatever went wrong.
  lykeion stop [flags]      Ask a running daemon to stop, and wait until
                            it actually has.
  lykeion open [flags]      Mint a fresh link to this machine's own page
                            and open a browser on it.
  lykeion url [flags]       Print a fresh link and nothing else, for a
                            machine you reach over SSH.
  lykeion logs [flags]      Print the newest log from the data directory.
                            --tail follows it.
  lykeion pair --code <c>   Finish pairing a machine that has no browser:
                            hand a running daemon the code the lab gave
                            whoever pasted its request.

Flags:
  --lab <url>        The lab to pair with. Only used while unpaired; once a
                     token is on disk the lab it names is the lab. [LYKEION_LAB]
  --port <n>         The loopback port the pairing page binds. Defaults to
                     1421; 0 takes whatever is free. [LYKEION_DAEMON_PORT]
  --data-dir <dir>   Where this machine keeps what it knows about itself. One
                     directory is one machine identity, and every command but
                     --help and --version reads it. [LYKEION_DAEMON_DATA_DIR]
  --work-dir <dir>   Where Task workspaces live while an agent runs in them.
                     Defaults to ~/Documents/Lykeion, and may not be inside
                     --data-dir. [LYKEION_DAEMON_WORK_DIR]
  --lab-only         Serve a lab on this computer and no machine: no pairing,
                     no agents, nothing to run a Task on. The lab itself binds
                     --port. Cannot be given with --lab, which says the lab is
                     somewhere else, nor with --detached, which hands back a
                     daemon that status and stop can find again.
  --code <code>      The one-time code the lab gave for this machine's pasted
                     request. Only pair takes it.
  --no-browser       Print the pairing link rather than opening a browser on it,
                     and, when a lab is named, print the request as one line to
                     paste into it from a computer that has one.
  --detached         Serve in the background and return to the terminal.
                     Implies --no-browser.
  --tail             Follow the log logs prints rather than printing it once.
                     Only logs reads it.
  -h, --help         Print this and do nothing else.
  --version          Print this build's version and do nothing else.

A flag beats the environment variable beside it, and an environment variable
set to the empty string counts as unset. A flag reads the same before the
command as after it, and a flag that takes a value takes it either way round:
--data-dir <dir> and --data-dir=<dir> are the same thing.`;

/**
 * Everything the daemon reads about its environment, resolved once at
 * startup. A researcher who runs the daemon with no configuration at all
 * still gets a working process: no lab paired yet, the same loopback port
 * every time, and a platform-conventional place to keep its own state.
 */
export interface DaemonConfig {
  command: DaemonCommand;
  /** The lab to pair with. Undefined until the person names one. */
  lab?: string;
  /**
   * The one-time code a person carried back from a lab they pasted this
   * machine's request into. Set only by `pair`, which is the only command
   * that has anything to do with one.
   */
  code?: string;
  /**
   * Serve a lab on this computer and nothing else — no pairing session, no
   * front door, no machine. The lab binds `port` itself, which is what makes
   * `--lab-only` the one topology where 1421 is the lab rather than the
   * daemon in front of it: there is no daemon in front of it to hold that
   * port, and the browser still opens the same address it opens everywhere
   * else. Anyone who wants a machine on this computer too wants the default,
   * where the front door holds 1421 and the lab child takes a free port
   * behind it.
   */
  labOnly: boolean;
  /** The loopback port the setup page is served on. 1421 unless somebody
   *  says otherwise, and 0 picks a free one. */
  port: number;
  openBrowser: boolean;
  detached: boolean;
  /** Whether `logs` should keep the process open and print each new line as
   *  it is written, rather than printing what is on disk once and exiting.
   *  Read by no command but `logs`. */
  tail: boolean;
  /** Where this machine keeps what it knows about itself. One directory is
   *  one daemon: it holds the token, and the file that says which process
   *  owns both. Naming another one is how a machine runs a second daemon
   *  against a second lab, and how this program can be exercised without
   *  touching the one the account actually runs. */
  dataDir: string;
  /**
   * Where Task workspaces live while an agent runs in them. A disjoint tree
   * from `dataDir`, never inside it: the sandbox denies this machine's own
   * state — the token is the machine's identity, and an agent that can read
   * it off disk can impersonate the machine — and a deny is rendered after
   * the allows so it wins on conflict. A workspace inside the denied tree
   * would therefore be a workspace the run cannot write.
   *
   * Always absolute, whatever was typed. Everything downstream concatenates
   * onto this — the sandbox profile's subpaths, and an environment's
   * `interpreter`, which the kernel host refuses outright unless it is
   * absolute — so a relative one here is a machine that starts no kernels at
   * all. See `readDaemonConfig`.
   */
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

/** In the researcher's Documents folder rather than inside this machine's
 *  private state, so Task outputs are both discoverable and kept outside the
 *  boundary every agent is denied. */
function defaultWorkDir(_dataDir: string): string {
  return join(homedir(), "Documents", "Lykeion");
}

/** Whether `inner` is `outer` or lies beneath it, read lexically on the
 *  names as given: a configuration is refused before anything is created,
 *  so there may be nothing on disk yet to resolve. */
function within(outer: string, inner: string): boolean {
  const root = resolve(outer);
  const path = resolve(inner);
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** The port the browser opens, in every topology. Fixed rather than
 *  ephemeral so `ssh -L 1421:localhost:1421` needs nothing looked up first,
 *  and so the address `probe.ts` tells a researcher to re-open is one they
 *  can actually know. `0` still takes whatever is free, for a second daemon
 *  on one machine. */
const DEFAULT_PORT = 1421;

function readPort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
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
 * seven is refused by name rather than quietly serving: somebody who typed
 * `lykeion restart` meant something, and starting a second daemon is
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
      `${first} is not a command — this program takes serve, status, stop, open, url, logs or pair, and --help for the rest`,
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
    return {
      command,
      port: 0,
      openBrowser: false,
      detached: false,
      tail: false,
      labOnly: false,
      dataDir: dir,
      workDir: dir,
    };
  }

  const detached = line.present.has("--detached");
  const tail = line.present.has("--tail");
  const labOnly = line.present.has("--lab-only");
  const lab = nonEmpty(line.values.get("--lab")) ?? nonEmpty(env.LYKEION_LAB);
  // Two answers to one question. `--lab-only` says the lab is this computer
  // and `--lab` says it is that URL, and a line carrying both has not asked
  // for either strongly enough to pick: serving here would ignore the
  // address somebody typed, and joining there would ignore the lab they
  // asked to run. Only the flag is refused, never the environment variable,
  // because `LYKEION_LAB` is a shell profile's standing answer for the
  // machines on this computer and `--lab-only` on one command line is the
  // person overriding it on purpose.
  if (labOnly && nonEmpty(line.values.get("--lab")) !== undefined)
    throw new Error(
      "--lab-only serves a lab here and --lab joins one elsewhere — asking for both asks for neither",
    );
  // Refused for the same reason, one step further on: `--detached` returns to
  // the terminal as soon as the daemon it started has claimed its data
  // directory, and it is the claim that `status` and `stop` then find it by.
  // A lab-only daemon claims nothing and answers neither, because it is a lab
  // and not a machine — so the two together would print that the background
  // daemon failed to start, exit 1, and leave a lab running behind that
  // sentence with nothing able to name it but the port it holds.
  if (labOnly && detached)
    throw new Error(
      "--lab-only serves a lab, which is not something --detached can hand back to the terminal — a lab-only daemon claims no data directory, so nothing could find it again to ask its status or stop it",
    );
  const code = nonEmpty(line.values.get("--code"));
  // Refused rather than ignored, in both directions. `pair` with no code has
  // nothing to carry and would send a daemon to the lab with the empty
  // string; `serve --code` is somebody who meant `pair --code` and would get
  // a daemon that dropped the code on the floor and started pairing from
  // scratch — a second request, and a code still in their hand for the first.
  if (command === "pair" && code === undefined)
    throw new Error('pair needs the code the lab gave you: lykeion pair --code <code>');
  if (command !== "pair" && code !== undefined)
    throw new Error(`--code is what pair carries back — ${command} does not take one`);
  const port = readPort(nonEmpty(line.values.get("--port")) ?? nonEmpty(env.LYKEION_DAEMON_PORT));
  const openBrowser = !detached && !line.present.has("--no-browser");
  const dataDir =
    nonEmpty(line.values.get("--data-dir")) ??
    nonEmpty(env.LYKEION_DAEMON_DATA_DIR) ??
    defaultDataDir(env);
  // Made absolute HERE, once, rather than left as whatever was typed. This is
  // not tidiness: `<workDir>/envs/<name>/bin/python3` becomes an environment
  // entry's `interpreter` on the wire to the kernel host, and
  // `_environments_from` refuses a relative one — for its own good reason,
  // since a relative interpreter would be resolved against the HOST's working
  // directory and put a directory of its choosing in front of every cell's
  // `PATH`. It refuses the WHOLE confinement on the first bad entry, floor
  // included, so `configure_session` fails and the session gets no kernel
  // tools at all. One `lykeion --work-dir ./work` therefore costs a machine
  // every kernel it has, with one line on stderr as the only trace — the
  // exact failure `runs.ts`'s per-entry guards exist to prevent, arriving
  // through the door beside them. `resolve` against this process's own cwd is
  // what the person typing a relative path already meant.
  const workDir = resolve(
    nonEmpty(line.values.get("--work-dir")) ??
      nonEmpty(env.LYKEION_DAEMON_WORK_DIR) ??
      defaultWorkDir(dataDir),
  );
  // Refused here rather than started in a shape whose sandbox cannot be
  // rendered: the boundary denies the data directory, and a workspace
  // inside it is a workspace the agent would be denied every write to.
  if (within(dataDir, workDir))
    throw new Error(
      `--work-dir ${workDir} is inside --data-dir ${dataDir}, and an agent's workspace cannot live in the directory this machine keeps its own state in`,
    );

  return { command, lab, code, port, openBrowser, detached, tail, labOnly, dataDir, workDir };
}
