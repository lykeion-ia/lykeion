import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOnPath } from "./command-path";

/** What an agent's own CLI says about who it is signed in as. */
export interface AuthState {
  signedIn: boolean;
  /** Whatever the CLI names the account by, when it names one at all. */
  account?: string;
  /**
   * Whether this reader actually understood what it was handed.
   *
   * Absent means yes, so every existing reader stays correct by saying
   * nothing. `false` means the output matched none of the shapes this CLI is
   * known to answer with — which is a different fact from "not signed in",
   * and the two are only safe to fold together where the question is "may
   * this agent be offered". Folded, they read alike: a status command given
   * the wrong arguments prints a usage error, matches no "logged in", and
   * reports a confidently signed-out agent.
   *
   * `redirect.ts` is where the difference bites. It proves a declared
   * `homeEnv` by requiring a scratch home to read as signed out — so an
   * unrecognised answer would certify an isolation nobody observed, which is
   * precisely the failure that rung exists to prevent. An answer nobody
   * understood is not an answer.
   */
  recognised?: boolean;
}

/**
 * What a command answered with, kept as the two streams it actually wrote
 * to rather than one. Which stream a CLI uses is the CLI's own choice, not
 * this machine's: Claude Code's `--json` answer is on stdout; Codex's
 * `login status` prints "Logged in using ChatGPT" on stderr — always, with
 * or without `--json`, because it has no `--json` for this subcommand at
 * all. Handed over separately rather than concatenated, so a `read` closure
 * that only needs one stream is never put at risk by a stray line the CLI
 * wrote to the other — the two are unrelated facts about the same run, not
 * one fact split across two pipes.
 */
export interface CommandOutput {
  stdout: string;
  stderr: string;
}

/**
 * How this agent is asked who it is signed in as, and how a sign-in is
 * started.
 *
 * Both are ordinary subcommands of the CLI itself, run against the home we
 * pointed it at. Asked rather than looked for: a predicate written against a
 * credential filename breaks the day the vendor moves their storage, and one
 * written against the CLI's own answer does not.
 */
export interface AuthDeclaration {
  status: {
    args: readonly string[];
    /** Total over any output, including output from a CLI that failed. What
     *  a status command prints when it cannot answer is not a crash here —
     *  it is the description of an agent that is not signed in.
     *
     *  Reads whichever stream (or both) this agent's CLI actually answers
     *  on — see `CommandOutput`. Getting this wrong reads as a signed-out
     *  agent rather than as a crash: nothing here throws over the wrong
     *  stream being empty, which is exactly why this went unnoticed for as
     *  long as `agentAuthStates` has existed, until a test exercised a real,
     *  signed-in CLI's real streams rather than a hand-written string or an
     *  injected fake (see `agent-auth.test.ts`'s integration test). */
    read: (output: CommandOutput) => AuthState;
  };
  login: { args: readonly string[] };
}

/**
 * How an agent is told to offer no skills. Two mechanisms, because the two
 * CLIs offer two — neither is a fact about the agent's name, only about what
 * it accepts.
 *
 * Read, not merely recorded. A row's own `skillsOff` is what `sessionMeta`
 * and `seeds` are handed (see both below), so this is the one place either
 * flag is written down and editing it here is what changes what an agent is
 * actually told. It used to be a second copy of two constants the mechanisms
 * referenced directly, which meant a row could declare one thing and send
 * another — with a passing typecheck.
 */
export interface SkillsOff {
  /** Raw CLI flags, carried through the adapter's `_meta` channel. */
  extraArgs?: Record<string, null>;
  /** Feature toggles rendered into the agent's own config file. */
  features?: Record<string, boolean>;
}

/**
 * Who stands behind an adapter, which decides whether the researcher is asked
 * before it runs.
 *
 * This matters because of where an adapter runs rather than what it does. It
 * is spawned inside the boundary with read and write on the Lykeion-owned
 * agent home — which holds the credential the researcher signed in with for
 * that agent — and the profile renders `(allow network-outbound)`
 * unrestricted, because the agent has to reach its vendor's API. A hostile
 * adapter therefore has both the credential and a way to send it somewhere.
 * That has been true of every adapter shipped so far; what changes as the
 * catalogue fills in is how many people it is true of.
 */
export type AdapterProvenance =
  /** The CLI's own ACP mode — the same program, under a flag. */
  | "vendor"
  /** Published under the `agentclientprotocol` organisation. */
  | "protocol"
  /** Anyone else: an individual, or a company that is neither this CLI's
   *  vendor nor the ACP project. A catch-all on purpose — a publisher nobody
   *  has classified yet should need the researcher's acceptance, not inherit
   *  someone else's trust. */
  | "community";

/**
 * How one adapter is started.
 *
 * A name alone cannot express an adapter that IS the CLI under a flag, which
 * is what a CLI shipping its own ACP mode looks like. `{ command, args }` is
 * already the shape every consumer downstream takes — `runs.ts`, `session.ts`,
 * `sandbox.ts`, `naming.ts` — so this is the declaration catching up with the
 * rest of the daemon rather than a new idea.
 */
export interface AdapterLaunch {
  /** The bare executable searched for on PATH — never a path, never a shell.
   *  The same rule `CatalogueEntry.command` carries, said again because
   *  `args` is where a path starts looking reasonable. */
  command: string;
  args: readonly string[];
  provenance: AdapterProvenance;
}

/**
 * What it takes to run one agent without the researcher's own installation
 * in the picture.
 *
 * An entry carrying one of these is an agent Lykeion can confine; an entry
 * without one is inert — not probed, not rendered, never asked to sign in.
 * That is the whole of how "everything the agent has, Lykeion put there" is
 * kept: an agent that could arrive carrying somebody's personal skills is not
 * offered, rather than offered with a caveat.
 */
export interface Isolation {
  adapters: readonly AdapterLaunch[];
  /** The variable that moves this CLI's entire configuration to a directory
   *  of ours. Observed rather than assumed — see the spec's evidence. */
  homeEnv: string;
  /**
   * Where this agent's sign-in actually lives, when `homeEnv` does not reach
   * it. Read-only, for the reason `AgentHome.credentials` already is: a run
   * proves who it is, and never edits the record of who it is.
   *
   * Absent by default, because the ordinary case needs nothing here — a CLI
   * that keeps its OAuth token inside the directory `homeEnv` redirects is
   * already covered by the home grant, and that is true of every CLI on
   * this machine except one. Claude Code is the documented exception: on
   * macOS its credential lives in the login keychain rather than in
   * `CLAUDE_CONFIG_DIR` — Linux and Windows keep it inside the config
   * directory, which is why only the macOS-specific entry below declares
   * anything here at all. A CLI that keeps its own credential inside its
   * home, the way Codex's `auth.json` does, must not declare this: doing so
   * would be an unearned widening of what its confined runs can read, not a
   * fix for anything actually missing.
   */
  credentialsOutsideHome?: readonly string[];
  /**
   * Where this CLI's own installation lives, when it is neither
   * `~/.<command>` nor `~/.config/<command>`.
   *
   * Named so it can be DENIED — the same and only reason `researcherHomes`
   * names anything at all. The observed case is a CLI shipping as an editor
   * build: `~/.<command>` exists and holds its plugins, while its sign-in
   * sits in an application-support profile outside the hidden entries
   * entirely. A derivation that finds the plugin directory reports success
   * and protects nothing, which is worse than one that finds nothing —
   * nobody goes looking for a hole they have been told is closed.
   */
  researcherHome?: readonly string[];
  /**
   * Variables that authenticate this CLI no matter which home it was pointed
   * at, so the redirect proof has to clear them before it asks.
   *
   * Observed, not assumed. `CLAUDE_CODE_OAUTH_TOKEN=<anything at all>` makes
   * `claude auth status` answer `{"loggedIn":true,"authMethod":"oauth_token"}`
   * against a config directory created empty a moment earlier, and
   * `ANTHROPIC_API_KEY` does the same with `authMethod:"api_key"`. Neither is
   * validated first — the answer reports that the variable is set, not that
   * the credential behind it works.
   *
   * Left alone, a researcher who exports either one would have every agent
   * refused with "your redirect is not working", which is both wrong and
   * unactionable: the redirect is fine, and the thing overriding it is in
   * their shell. Codex shows this is per-CLI rather than universal —
   * `OPENAI_API_KEY` does not move `codex login status` at all — so it
   * belongs on the row that observed it.
   */
  ambientAuthEnv?: readonly string[];
  auth: AuthDeclaration;
  /** What closes the set this CLI ships inside its own binary, which no
   *  redirected home can reach. Handed to `sessionMeta` and `seeds` below,
   *  which are the two mechanisms that carry it — so what a row declares
   *  here is what the agent is told, rather than a description of it. */
  skillsOff: SkillsOff;
  /**
   * What this agent's adapter is handed on `session/new`'s `_meta`, or absent
   * for an adapter with no such channel.
   *
   * Handed this row's own `skillsOff` rather than reaching for a constant of
   * its own: an adapter channel is where a CLI's raw flags travel, and those
   * flags are declared once, above.
   *
   * Declared here rather than assembled where sessions are opened, because
   * assembling it there means asking which agent is being opened, and this is
   * the one file allowed to ask that. The shape inside is the adapter's, not
   * ours — `claudeCode.options` is what the claude adapters spread over their
   * SDK defaults — so it is quoted rather than modelled.
   *
   * Async because claude's own entry has to resolve a binary on `PATH` before
   * it can answer — see `pathToClaudeCodeExecutable` below. Every declared
   * entry pays that shape even though only one needs it today, so a caller
   * never has to ask which kind of answer this is before awaiting it.
   */
  sessionMeta?: (skillsOff: SkillsOff) => Promise<Record<string, unknown>>;
  /** Files Lykeion writes into the home on every daemon start. Rewritten
   *  rather than seeded once, so a hand-edit cannot quietly reintroduce a
   *  server and leave the isolation looking intact.
   *
   *  Handed this row's own `skillsOff` for the reason `sessionMeta` is: a
   *  config file is the other place a CLI's feature toggles travel, and a row
   *  that rendered a different set from the one it declared would be
   *  describing an isolation it does not establish. `home` comes second
   *  because a row that names no path in what it writes can leave it off. */
  seeds?: (
    skillsOff: SkillsOff,
    home: string,
  ) => ReadonlyArray<{ name: string; contents: string }>;
}

export interface CatalogueEntry {
  id: string;
  name: string;
  /** The bare executable searched for on PATH — never a path, never a shell. */
  command: string;
  /** Absent means Lykeion cannot yet isolate this agent. Phase 2 fills these
   *  in; phase 3 gives each an adapter. */
  isolation?: Isolation;
}

/**
 * Where an agent Lykeion runs keeps everything: its configuration, its
 * sign-in, its record of the Tasks it has worked in.
 *
 * Its own root rather than a corner of the daemon's data directory. That
 * directory holds this machine's identity, and `config.ts` already refuses a
 * workspace inside it for exactly this reason — a place the agent reaches by
 * design cannot be carved out of a place it must never reach.
 */
export function lykeionHomeFor(agent: string): string {
  return join(homedir(), ".lykeion", "agents", agent);
}

/** Each observed `stable true` on a stock install, and each puts tools or
 *  skills in front of the agent that Lykeion did not name. Read by the row
 *  below, which is what hands it to the mechanism that renders it. */
const CODEX_FEATURES: Record<string, boolean> = {
  plugins: false,
  apps: false,
  skill_search: false,
  browser_use: false,
  computer_use: false,
  image_generation: false,
  goals: false,
  in_app_browser: false,
};

/** Codex's whole configuration, rendered from this row and nothing else. An
 *  empty `mcp_servers` here is not a merge against the researcher's table —
 *  there is no researcher's table in reach — it is the whole of what this
 *  agent is told about tool servers before `session/new`. */
function codexConfig(features: Record<string, boolean>): string {
  return [
    "# Written by Lykeion on every daemon start. Edits here are overwritten.",
    "",
    "mcp_servers = {}",
    "",
    "[features]",
    ...Object.entries(features).map(([name, on]) => `${name} = ${on}`),
    "",
  ].join("\n");
}

/**
 * The coding-agent CLIs the daemon knows how to look for, in the order they
 * are reported.
 *
 * All thirteen stay listed. The eleven without an `isolation` are the roadmap
 * phases 2 and 3 work through: phase 2 establishes where each keeps its
 * configuration and how to redirect it, phase 3 gives each a bridge to speak
 * ACP through. Until both land, an entry is inert rather than deleted, so
 * re-admitting one is filling in a row.
 */
export const CATALOGUE: ReadonlyArray<CatalogueEntry> = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    isolation: {
      // One adapter, though two are published that speak ACP for this CLI.
      // `claude-code-acp` was dropped rather than kept with a caveat, which
      // is this interface's own rule applied one level down: an agent
      // Lykeion cannot properly run is not offered.
      //
      // Two independent findings, both observed rather than reasoned:
      //
      // Its plan channel is gone. `claude-code-acp` 0.16.2 translates only
      // `TodoWrite` into an ACP plan, and Claude Code 2.1.228 no longer
      // ships that tool at all — its own `system.init` tool list carries
      // `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` and no `TodoWrite`.
      // A real turn asked for a plan records one and this adapter drops it:
      // the conformance suite's "proposes a plan" fails on it every run,
      // while `claude-agent-acp` 0.64.2, which handles both tool names,
      // passes the same behaviour unchanged.
      //
      // And it carries somebody else's skills. Left to itself it spawns a
      // `cli.js` vendored at its own build time — observed stuck at 2.1.44
      // against a 2.1.228 install — through which `keybindings-help`
      // survived `--disable-slash-commands`. `pathToClaudeCodeExecutable`
      // below closes that, but only for an adapter that honours the key.
      //
      // Re-adding it takes a release of `claude-code-acp` that maps the
      // Task tools, verified by that behaviour passing rather than by a
      // version number — and re-adding it here is the whole change, since
      // nothing else in this daemon names an adapter.
      adapters: [{ command: "claude-agent-acp", args: [], provenance: "protocol" }],
      homeEnv: "CLAUDE_CONFIG_DIR",
      // Both observed to report a signed-in account against a home created
      // empty a moment earlier, and neither is checked before answering —
      // see `ambientAuthEnv`'s own doc.
      ambientAuthEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
      // Observed against a real, signed-in install, confined: with this
      // absent, `claude auth status --json` inside the boundary answers
      // `{"loggedIn":false}` even for an account that is genuinely signed
      // in, because macOS Claude Code writes its OAuth token to the login
      // keychain rather than to CLAUDE_CONFIG_DIR — see Isolation's own
      // doc on `credentialsOutsideHome` for why only this entry needs it.
      credentialsOutsideHome: [join(homedir(), "Library", "Keychains")],
      auth: {
        // `--json` is this command's default; asked for by name anyway, so a
        // release that changes the default does not silently change what is
        // being parsed here.
        status: {
          args: ["auth", "status", "--json"],
          // `--json` writes to stdout, so this reads only that — stderr is
          // not this closure's to read, and folding it in on the chance a
          // release ever moves the answer would risk a stray stderr line
          // breaking a `JSON.parse` that already succeeded.
          read: ({ stdout }) => {
            try {
              const parsed = JSON.parse(stdout) as { loggedIn?: boolean; email?: string };
              // JSON that parses but carries no `loggedIn` is not this
              // command's answer — it is some other JSON this CLI happened to
              // print, and reading it as "signed out" would be inventing one.
              if (typeof parsed.loggedIn !== "boolean") return { signedIn: false, recognised: false };
              const account = typeof parsed.email === "string" ? parsed.email : undefined;
              return {
                signedIn: parsed.loggedIn,
                recognised: true,
                ...(account === undefined ? {} : { account }),
              };
            } catch {
              // Not JSON at all: a usage error from wrong arguments, a crash,
              // an empty stream. Signed out is what the pairing page should
              // do with it, but it is not something anybody understood, and
              // the redirect proof must not read it as one.
              return { signedIn: false, recognised: false };
            }
          },
        },
        login: { args: ["auth", "login", "--claudeai"] },
      },
      // Observed: this empties the skill set outright, including skills
      // arriving by --plugin-dir. That is why Lykeion's own catalogue can
      // never travel by the CLI's plugin channel (spec D-6).
      skillsOff: { extraArgs: { "disable-slash-commands": null } },
      // The claude adapters build their SDK options from the machine owner's
      // own setting sources. The empty `settingSources` closes the filesystem
      // sources, `strictMcpConfig` closes what rides outside them, and
      // `extraArgs` closes the skills the CLI ships inside its own binary,
      // which no redirected home can reach.
      //
      // `pathToClaudeCodeExecutable` names which binary the adapter runs.
      // It is inert for the one adapter declared above: `claude-agent-acp`
      // resolves its own current binary and overrides `_meta` with it, so
      // this changes nothing there today. It stays for two reasons that do
      // not depend on that. It pins the binary deterministically for any
      // adapter that does honour the key — which is the gap that made
      // `claude-code-acp` unrunnable, a `cli.js` vendored at that adapter's
      // own build time and observed stuck at 2.1.44 against a 2.1.228
      // install, with `keybindings-help` surviving `disable-slash-commands`
      // through it. And it is what a future adapter, or a future release of
      // the one above that stops resolving its own, would be run by; a
      // declaration that has to be rediscovered the next time an adapter
      // changes its mind is worse than one that is briefly redundant.
      //
      // Resolved on `PATH` rather than hardcoded to `command: "claude"`, the
      // same way `agent-auth.ts` and `probe.ts` already resolve every
      // catalogued command before spawning it, so a machine that renamed or
      // moved its install is asked, not assumed. Omitted rather than sent as
      // an explicit `undefined` when nothing resolves: a machine with no
      // `claude` on PATH cannot offer this agent at all through the ordinary
      // discovery path, but a session that somehow still opens one this way
      // degrades to whatever the adapter would have done unprompted, rather
      // than crashing on a promise this closure never rejects.
      sessionMeta: async (skillsOff) => {
        const resolved = await resolveOnPath("claude", process.env.PATH ?? "");
        return {
          claudeCode: {
            options: {
              settingSources: [],
              strictMcpConfig: true,
              // This row's own declaration, not a constant beside it: what
              // closes the skill set and what is sent on the wire are the
              // same object, so they cannot come to disagree.
              ...(skillsOff.extraArgs === undefined ? {} : { extraArgs: skillsOff.extraArgs }),
              ...(resolved === undefined ? {} : { pathToClaudeCodeExecutable: resolved }),
            },
          },
        };
      },
    },
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    isolation: {
      adapters: [{ command: "codex-acp", args: [], provenance: "protocol" }],
      homeEnv: "CODEX_HOME",
      auth: {
        status: {
          args: ["login", "status"],
          // Observed: this command's own "Logged in using ..." line prints
          // to stderr, not stdout — with or without `--json`, which this
          // subcommand does not have at all. Both streams are checked
          // separately (never concatenated — see `CommandOutput`) so
          // whichever one carries the answer is read regardless. Anchored
          // to the start of a line on each: "Not logged in" contains
          // "logged in", and a substring test would read a refusal as an
          // approval — the one mistake this predicate must never make.
          //
          // Recognised means one of the two sentences this command is known
          // to answer with actually appeared. Anything else — a usage error
          // from wrong arguments, a crash, silence — is signed out for the
          // pairing page's purposes and NOT an answer for the redirect
          // proof's, which must not certify an isolation on the strength of
          // output nobody parsed.
          read: ({ stdout, stderr }) => {
            const said = (pattern: RegExp) => pattern.test(stdout) || pattern.test(stderr);
            const signedIn = said(/^\s*logged in/im);
            return { signedIn, recognised: signedIn || said(/^\s*not logged in/im) };
          },
        },
        login: { args: ["login"] },
      },
      skillsOff: { features: CODEX_FEATURES },
      // Rendered from this row's own declaration above, so the file written
      // into the home is the set the row declares and not a second copy of
      // it that a later edit could leave behind.
      seeds: (skillsOff) => [
        { name: "config.toml", contents: codexConfig(skillsOff.features ?? {}) },
      ],
    },
  },
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

export function entryFor(agent: string): CatalogueEntry | undefined {
  return CATALOGUE.find((entry) => entry.id === agent);
}

/** What confines `agent`, or undefined for one nobody has declared. An id
 *  this machine does not recognise reaches nothing, which is the same answer
 *  an undeclared entry gets. */
export function isolationFor(agent: string): Isolation | undefined {
  return entryFor(agent)?.isolation;
}
