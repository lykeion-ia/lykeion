import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOGUE, entryFor, isolationFor, lykeionHomeFor, type CommandOutput } from "./agent-registry";
import { confinementFor } from "./agent-home";
import { confine, noBackendReason, policyFor, sandboxBackendFor } from "./sandbox";
import { resolveOnPath } from "./command-path";

/** One declared agent, and whether this machine can act as anybody through it. */
export interface AgentAuth {
  agent: string;
  name: string;
  /**
   * Whether this machine has this agent's CLI at all.
   *
   * Kept apart from `signedIn` because the two answers call for opposite
   * things from a researcher. "Not installed" folds into "signed out" for the
   * purpose of running anything — an agent this machine cannot act as either
   * way — but a surface that could not tell them apart offers a sign-in for a
   * CLI that is not there, which spawns nothing, reports nothing and leaves
   * the row waiting forever. That is exactly what the pairing page used to
   * do; see `renderAgentSignInPage`.
   */
  available: boolean;
  signedIn: boolean;
  account?: string;
}

/** Runs a command and hands back both streams it printed to. Injected so the
 *  tests can prove the parsing and the environment without a CLI installed.
 *  Both streams, not one: which stream a CLI answers on is the CLI's own
 *  choice (see `CommandOutput`), and a `RunCommand` that only ever captured
 *  stdout would silently misreport every declared agent whose own status
 *  command answers on stderr instead. */
export type RunCommand = (
  command: string,
  args: readonly string[],
  env: Record<string, string>,
) => Promise<CommandOutput>;

/** Long enough for a version-manager shim or a cold runtime, short enough
 *  that a wedged CLI does not hold a pairing page open. */
const STATUS_TIMEOUT_MS = 10_000;

/**
 * What `confinedRunCommand`'s default needs from a caller to build a boundary
 * at all: the clock a probe cycle or a pairing request is already running on,
 * and where this machine's own state lives so the boundary can deny it.
 * `dataDir` is required for the reason `ProbeOptions.dataDir` is — every
 * confined run denies this machine's own token, and it can only do that if
 * it is told where that token is.
 */
export interface AuthCheckOptions {
  /** PATH to search for each declared agent's own command. Defaults to the
   *  process's own. */
  path?: string;
  /** How long a status command is given to answer before this gives up on
   *  hearing one. */
  timeoutMs?: number;
  /** Takes the check back before its own timeout — the same signal a probe
   *  cycle or a pairing request already carries, so a declared agent's own
   *  CLI hanging never outlives whatever asked about it. */
  signal?: AbortSignal;
  /** The platform whose sandbox backend would confine this check. Defaults
   *  to this machine's own. */
  platform?: string;
  /** Where this machine keeps its own state — required, so the boundary can
   *  deny this machine's own token the way every other confined run does:
   *  `policyFor` folds `dataDir` itself into what is denied (`deniedPaths`),
   *  so this is the one directory an agent confined by this check can never
   *  read.
   *
   *  A trap for anyone reasoning from the tests rather than from
   *  production: `AuthCheckOptions.dataDir` accepts any string, including a
   *  placeholder like the test file's own `dataDir: "/unused"`. That
   *  placeholder resolves without complaint — `canonicalPrefix` walks up to
   *  the deepest ancestor that exists, and one always does — so a call
   *  built by copying the test's options compiles, confines its command,
   *  and answers, while never actually naming this machine's real state
   *  directory as denied at all. Nothing here can catch that; passing this
   *  machine's real `dataDir` (the one `serve` claimed and every other
   *  confined caller already uses) is what has to. */
  dataDir: string;
  /** What each throwaway workspace this creates is named, so a test watching
   *  for its own leaks can watch a prefix nobody else is using. The temp
   *  directory is shared by every process on the machine and by every test
   *  file the runner has in flight at once — a test that watched the default
   *  would be reporting on workspaces belonging to whoever else happened to
   *  be asking at the same moment. Production has one caller and no reason
   *  to set it. */
  workspacePrefix?: string;
  /** How a command is wrapped in its boundary. Injectable for the reason
   *  `run` is throughout this file: the workspace has to survive `confine`
   *  throwing, and every real way of making it throw either needs a platform
   *  this machine is not or a policy that cannot be built by a caller. A
   *  seam is honest about being a seam; a contrived input pretends to be a
   *  scenario. */
  confineFn?: typeof confine;
  /** Variables to clear from the environment before running, whatever this
   *  process inherited. The redirect proof needs it: a CLI that reads its
   *  sign-in out of an ambient variable answers the same from any home, and
   *  a question asked in that environment is not asking anything. */
  unsetEnv?: readonly string[];
}

/**
 * `agentAuthStates`'s default `RunCommand`: confines a declared agent's own
 * subcommand — `auth status`, in practice — exactly as `probe.ts`'s
 * `readVersion` confines a `--version` call: the resolved path, not the bare
 * command name, wrapped by `confine()`.
 *
 * The resolved path matters on its own, not only because `readVersion` does
 * the same. `confine()` grants a program's own realpath so the boundary
 * covers wherever a symlink on `PATH` actually points; handed the bare name
 * instead, that grant never renders — `programLocation()` treats a name with
 * no separator in it as relative to this process's own working directory and
 * finds nothing there.
 * What is left is only the broader allow for the *directory* the command sits
 * in, which happens to still cover an install living under a dotfile
 * (`~/.local/bin/claude`, whose symlink target is a sibling of `~/.local/bin`
 * and so also sits under the incidental `$HOME/.*` allow rendered for reading
 * configuration) but covers nothing for an install anywhere else, such as
 * `~/tools/node/bin` — where the exec is refused outright and a signed-in
 * agent reads back as signed out, permanently, with no line in any log
 * naming why.
 *
 * What this buys, and what it does not. `agentAuthStates`'s previous, bare
 * default ran the command directly, with a fixed timeout and no `AbortSignal`
 * wired in at all — a declared agent's CLI that hangs and ignores its
 * termination signal held whatever called this open behind it (a probe
 * cycle's own shutdown; a pairing request, worse, since nothing there could
 * reclaim it at all). This gives the check the same boundary and the same
 * `signal` `readVersion` already has, so an `agentAuthStates` *status* check
 * never runs a catalogue command unconfined or uncancellable. `startSignIn`,
 * elsewhere in this file, is the one place that still does, on purpose — a
 * sign-in has to open a real browser and let the CLI write a real credential
 * (to a keychain, in Claude Code's case), and confining or cancelling that
 * would break the thing it is starting, not protect it. This does not, on
 * its own, stop a hung CLI from holding things open: a `--version` or `auth
 * status` run against a program sitting somewhere this boundary can still
 * read and exec — the ordinary case, an install under `PATH` — is spawned
 * exactly as before, and if it ignores `SIGTERM` (which is what
 * `signal`-driven cancellation, and `execFile`'s own `timeout`, both send)
 * it holds the caller open exactly as before, until it exits on its own.
 * What was confined here is *whether an unconfined status check ever
 * happens at all* — not a guarantee that every such check can be cut short.
 */
/** `env` with `names` removed rather than blanked. A CLI that reads an
 *  ambient credential usually treats the empty string as "set", so emptying
 *  one would leave the very behaviour the caller asked to be rid of. */
function withoutAmbient(
  env: Record<string, string | undefined>,
  names: readonly string[] | undefined,
): Record<string, string | undefined> {
  if (names === undefined || names.length === 0) return env;
  const stripped = { ...env };
  for (const name of names) delete stripped[name];
  return stripped;
}

export function confinedRunCommand(options: AuthCheckOptions): RunCommand {
  const pathValue = options.path ?? process.env.PATH ?? "";
  const timeoutMs = options.timeoutMs ?? STATUS_TIMEOUT_MS;
  const platform = options.platform ?? process.platform;
  return async (command, args, env) => {
    const resolved = await resolveOnPath(command, pathValue);
    if (resolved === undefined) throw new Error(`${command} is not on PATH`);
    // Checked before anything is created on disk. `confine()` throws this
    // same fact one line later, and by then a workspace would already exist
    // with nothing left to remove it — `probeCliVersion`'s own call into
    // `readVersion` is guarded the identical way, before `readVersion` ever
    // makes one, and this is that guard moved to where the platform is
    // actually known rather than assumed to have already been checked.
    if (sandboxBackendFor(platform) === undefined) throw new Error(noBackendReason(platform));
    const agent = CATALOGUE.find((entry) => entry.command === command)?.id ?? command;
    const workspace = mkdtempSync(join(tmpdir(), options.workspacePrefix ?? "lykeion-auth-"));
    // Handed over once `execFile` owns the directory as its working
    // directory, after which its own callback removes it. Until then nothing
    // else would: the removal below lives inside that callback, so anything
    // throwing in between — a policy that will not render, a spawn that fails
    // synchronously — would leave the workspace behind with no one left to
    // clean it up. The platform-with-no-backend case is already guarded
    // above, before the directory exists at all; this covers every other way.
    let handedOff = false;
    try {
      const confined = (options.confineFn ?? confine)(
        platform,
        policyFor({ workspace, grants: [], dataDir: options.dataDir, ...confinementFor(agent, workspace) }),
        { command: resolved, args: [...args] },
      );
      const answer = new Promise<CommandOutput>((resolvePromise, rejectPromise) => {
        execFile(
          confined.command,
          confined.args,
          {
            timeout: timeoutMs,
            signal: options.signal,
            cwd: workspace,
            env: withoutAmbient({ ...process.env, ...env }, options.unsetEnv),
          },
          (error, stdout, stderr) => {
            rmSync(workspace, { recursive: true, force: true });
          // Resolved on whatever was printed even when the exit code is not
          // zero: a CLI that answers "Not logged in" and exits non-zero has
          // answered the question, and the declaration's `read` is what
          // decides. Checked against both streams — a CLI that answers only
          // on stderr (Codex's `login status` always does) has still
          // answered, and treating an empty stdout alone as "said nothing"
          // would reject that answer before `read` ever saw it. Only a
          // command that said nothing on either stream is a run this
          // machine could not learn from.
            if (error && !stdout && !stderr) rejectPromise(error);
            else resolvePromise({ stdout, stderr });
          },
        );
      });
      handedOff = true;
      return await answer;
    } finally {
      if (!handedOff) rmSync(workspace, { recursive: true, force: true });
    }
  };
}

/** The environment one of this agent's own commands is run with: our home,
 *  and nothing else added. */
function homeEnvFor(agent: string): Record<string, string> | undefined {
  const isolation = isolationFor(agent);
  return isolation === undefined ? undefined : { [isolation.homeEnv]: lykeionHomeFor(agent) };
}

/**
 * Who each declared agent is signed in as, asked of the agents themselves.
 *
 * Asked rather than looked for. Where a CLI keeps its credential inside a
 * redirected home is its business and can change in a release; whether it
 * considers itself signed in is a question it answers directly, and the
 * answer stays true across that change.
 *
 * An agent that cannot answer is reported signed out rather than raised: this
 * runs behind a page the researcher is waiting on, and one CLI missing from
 * PATH must not take the other's answer with it.
 *
 * Confined by default (see `confinedRunCommand`) — every caller gets that for
 * free unless it supplies its own `run`, which is what the tests below do to
 * prove the parsing without a CLI, a sandbox backend, or a real `dataDir`.
 */
export async function agentAuthStates(
  options: AuthCheckOptions,
  run: RunCommand = confinedRunCommand(options),
): Promise<AgentAuth[]> {
  const declared = CATALOGUE.filter((entry) => entry.isolation !== undefined);
  const pathValue = options.path ?? process.env.PATH ?? "";
  return Promise.all(
    declared.map(async (entry) => {
      const isolation = entry.isolation!;
      const env = { [isolation.homeEnv]: lykeionHomeFor(entry.id) };
      // The same question `confinedRunCommand` asks a line later before it
      // spawns anything, asked here as well so the answer is carried rather
      // than thrown away. Without it every caller sees only `signedIn:
      // false`, and a surface built on that offers a sign-in for a CLI that
      // is not on this machine.
      const available = (await resolveOnPath(entry.command, pathValue)) !== undefined;
      // Answered without spawning anything. A CLI this machine does not have
      // cannot say who it is signed in as, and asking it anyway spawns a
      // confined process that fails ENOENT — per missing CLI, on every hit of
      // `/agents`, which the sign-in page polls every two seconds for as long
      // as a tab is open. That page no longer offers a button for such an
      // agent, but this is the surface underneath it, and a paired daemon now
      // holds the listener for its whole life rather than only during setup.
      if (!available) return { agent: entry.id, name: entry.name, available, signedIn: false };
      let state = { signedIn: false } as { signedIn: boolean; account?: string };
      try {
        state = isolation.auth.status.read(await run(entry.command, isolation.auth.status.args, env));
      } catch {
        // Not installed, not on PATH, or wedged past the timeout. Each is an
        // agent this machine cannot act as, which is what signed-out means.
      }
      return {
        agent: entry.id,
        name: entry.name,
        available,
        signedIn: state.signedIn,
        ...(state.account === undefined ? {} : { account: state.account }),
      };
    }),
  );
}

/**
 * O-3, settled against real installations (scratch homes under
 * /tmp/lykeion-o3 and /tmp/lykeion-o3-codex; the researcher's own
 * ~/.claude and ~/.codex were never touched):
 *
 * - claude: `auth login --claudeai` prints "Opening browser to sign in…",
 *   then a fallback URL ("If the browser didn't open, visit: …"), then
 *   blocks on "Paste code here if prompted > " with stdin wired to
 *   /dev/null — it did not exit on that EOF, so the wait is on the OAuth
 *   callback, not on the paste. It attempts to open a browser itself
 *   *and* prints the URL as a fallback.
 * - codex: `login` prints "Starting local login server on
 *   http://localhost:1455.", then the same shape — "If your browser did
 *   not open, navigate to this URL…" plus the URL — and a note that a
 *   headless machine should use `codex login --device-auth` instead. It
 *   also opens a browser itself and starts a local callback listener.
 *
 * Both CLIs write a usable URL to stdout before blocking, so `stdio:
 * "ignore"` (below) starts the process fine but throws that URL away —
 * fine for O-3's purpose of watching the shape, wrong for a real sign-in.
 * Neither needed an attached terminal to reach the URL: both were run with
 * stdin from /dev/null and still printed it. The open question O-3 was
 * scoped to answer is settled: a browser-opens-itself path exists on both,
 * but so does a URL a headless daemon can capture and render — capturing
 * stdout and surfacing that URL (codex's `--device-auth` shape) is the
 * fallback this task leaves for later work, not an unknown.
 */
export async function startSignIn(
  agent: string,
  spawnFn: typeof spawn = spawn,
  path: string = process.env.PATH ?? "",
): Promise<{ started: boolean; reason?: string }> {
  const entry = entryFor(agent);
  const isolation = entry?.isolation;
  const env = homeEnvFor(agent);
  if (entry === undefined || isolation === undefined || env === undefined)
    return { started: false, reason: `Lykeion cannot sign in to ${agent}` };
  // Asked before anything is spawned, so this answers honestly rather than
  // reporting a sign-in as started and letting the caller find out by
  // watching a row that never turns over. The sign-in page already refuses
  // to offer a button for an agent it was told is unavailable; this is the
  // same invariant held for any caller of this, rather than for that one
  // page. The command is still spawned by the bare name below — resolving is
  // what answers the question, not what changes which binary runs.
  if ((await resolveOnPath(entry.command, path)) === undefined)
    return { started: false, reason: `${entry.name} is not installed on this machine` };
  try {
    const child = spawnFn(entry.command, [...isolation.auth.login.args], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, ...env },
    });
    // A command this machine cannot spawn at all — a CLI declared here but
    // missing from PATH, most often — surfaces asynchronously through this
    // event, after the try/catch above has already returned. An
    // EventEmitter given no listener for its own 'error' event throws that
    // error into the process that created it: without this, one agent's
    // missing CLI would take the whole daemon down, not just this sign-in.
    // The `{ started: true }` below has already gone out by the time this
    // could fire, and nothing here can retract it — the page finds out the
    // honest way, by polling agentAuthStates and never seeing this agent's
    // row turn over.
    //
    // Said out loud rather than swallowed. Whoever is looking at that row
    // spinning has no other way to learn why, and this is the only place on
    // this machine that knows: the daemon's own log is where a researcher
    // whose sign-in never completes is sent, and a listener that discarded
    // this left it saying nothing at all.
    child.on("error", (error: Error) => {
      console.error(`${entry.name}'s sign-in could not be started: ${error.message}`);
    });
    child.unref();
    return { started: true };
  } catch (error) {
    return {
      started: false,
      reason: `${entry.name}'s sign-in could not be started: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
