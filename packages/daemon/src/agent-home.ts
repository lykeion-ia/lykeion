import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalPath, NO_AGENT_HOME, type AgentHome } from "./sandbox";

/**
 * Where each agent this daemon knows how to run keeps its own installation.
 *
 * The boundary a run executes inside is drawn around the researcher's data, and
 * that alone leaves the program itself with nothing: no token to prove who it
 * is, nowhere to write what it learned, no scratch directory for its shell.
 * Every one of those failures reaches a researcher in the agent's own words
 * rather than the kernel's — a turn that says it is not signed in, or a shell
 * that fails before it runs anything — which is why this is declared here and
 * asserted, instead of being discovered one adapter at a time.
 *
 * Declared per agent AND per workspace. Per agent, so running one opens nothing
 * belonging to another. Per workspace, because the parts of an installation
 * that matter most are the ones an agent keeps separately for each directory it
 * works in: this Task's scratch and this Task's record are the agent's own, and
 * every other Task's are the researcher's business alone.
 *
 * Written against the home directory rather than probed: a researcher who has
 * never started one of these programs has no such directory yet, and a rule
 * written where it will be is what lets the program create it on first run.
 */

/**
 * The name the tools that keep per-directory state derive from a working
 * directory: every separator and underscore becomes a dash.
 *
 * Stated once, here, because two different places are keyed by it and a run
 * whose scratch directory is named differently from the one its shell will
 * try to create gets no shell at all. It is the agent's own convention rather
 * than this machine's, so it is asserted directly — if it ever changes, the
 * test that names it fails before a researcher meets a shell that cannot run.
 */
export function workspaceKey(workspace: string): string {
  return workspace.replace(/[/_]/g, "-");
}

/**
 * The shape of the scratch file an agent's shell writes its working directory
 * into after every command, then removes. The name carries a fresh random part
 * each time, so there is nothing to grant but the shape.
 *
 * Written against the resolved temporary directory, because the kernel
 * canonicalizes the path being accessed and a rule naming the unresolved one
 * matches nothing. Anchored at both ends and admitting no separator, so it can
 * only ever name a file sitting directly in that directory.
 *
 * Without it a command runs, prints what it was asked for, and is then drawn
 * as failed because the shell could not tidy up after itself.
 */
function shellScratchPattern(): string[] {
  try {
    // The character set is spelled out rather than written as an exclusion.
    // A bracket expression holding a separator or a dash is not something the
    // sandbox's own regex parser accepts, and it rejects the entire profile
    // rather than the one rule — which does not look like a bad rule when it
    // happens, it looks like an agent that is no longer installed.
    return [`^${canonicalPath("/tmp")}/claude-[a-zA-Z0-9]+-cwd$`];
  } catch {
    return [];
  }
}

/** The root the shell tool keeps its per-directory working directories under.
 *  One directory for every run on this machine and for the researcher's own
 *  sessions of the same program, which is exactly why a run is given the one
 *  entry inside it that belongs to this Task, and never the root. */
function shellScratchRoot(): string {
  return `/tmp/claude-${process.getuid?.() ?? 0}`;
}

function homesFor(workspace: string): Record<string, AgentHome> {
  const home = homedir();
  const claude = join(home, ".claude");
  const codex = join(home, ".codex");
  const key = workspaceKey(workspace);
  return {
    claude: {
      state: [
        claude,
        join(home, "Library", "Caches", "claude-cli-nodejs"),
        // What its shell creates before it runs anything at all.
        join(shellScratchRoot(), key),
        // Its record of this Task, kept beside every other Task's, which is
        // why the directory holding them is denied and this one entry is not.
        join(claude, "projects", key),
      ],
      // This machine's own credential service. What it holds is reached
      // through the operating system, which decides per item and asks the
      // researcher about anything not the program's own — the same decision it
      // makes when this program runs outside any boundary of ours.
      credentials: [join(home, "Library", "Keychains")],
      // Each of these decides what runs the next time the researcher starts
      // this program themselves, with no boundary around it. Readable, so the
      // agent still starts configured; never writable.
      sealed: [
        join(claude, "settings.json"),
        join(claude, "settings.local.json"),
        join(claude, "hooks"),
        join(claude, "agents"),
        join(claude, "commands"),
        join(claude, "plugins"),
      ],
      // The researcher's own work with this program, most of it nothing to do
      // with Lykeion. A run needs to write its own record, not to read the
      // account of every conversation they have ever had.
      private: [join(claude, "projects"), join(claude, "history.jsonl"), join(claude, "todos")],
      patterns: shellScratchPattern(),
    },
    codex: {
      // Its credential is a file inside the state directory below, which the
      // agent must be able to rewrite when the token it holds is refreshed.
      state: [codex],
      credentials: [],
      sealed: [join(codex, "config.toml")],
      private: [],
      patterns: [],
    },
  };
}

/**
 * What `agent` reaches of its own while working in `workspace`. An agent this
 * machine has no entry for declares nothing and reaches nothing: the boundary
 * is not widened by an id nobody recognizes.
 */
export function agentHomeFor(agent: string, workspace: string): AgentHome {
  return homesFor(workspace)[agent] ?? NO_AGENT_HOME;
}

/**
 * Everything a policy needs to know about which agent it is confining: the
 * installation this one owns, and the ones it may not touch. Taken together so
 * a caller cannot pass the first and forget the second, which would leave an
 * agent scoped to its own store and still able to read every other.
 */
export function confinementFor(
  agent: string,
  workspace: string,
): { home: AgentHome; foreign: string[] } {
  return { home: agentHomeFor(agent, workspace), foreign: foreignHomes(agent, workspace) };
}

/**
 * Every other agent's installation — denied, so running one agent never opens
 * what belongs to another.
 *
 * This has to be said out loud rather than left to the default. A home
 * directory's hidden entries are readable, because that is how an agent reads
 * its own configuration at all, and one of those entries is where another
 * agent keeps its credential. Scoping a store to the agent that owns it means
 * nothing while every other agent can read it by another name.
 */
export function foreignHomes(agent: string, workspace: string): string[] {
  const homes = homesFor(workspace);
  const mine = homes[agent] ?? NO_AGENT_HOME;
  const own = new Set([...mine.state, ...mine.credentials]);
  const foreign = new Set<string>();
  for (const [id, home] of Object.entries(homes)) {
    if (id === agent) continue;
    for (const path of [...home.state, ...home.credentials]) if (!own.has(path)) foreign.add(path);
  }
  return [...foreign];
}

/**
 * Every agent installation on this machine, for a policy that belongs to no
 * agent. A kernel authenticates from nothing and owns no installation, so an
 * agent's home is no more reachable from a cell than another agent's is from
 * that agent.
 */
export function allAgentHomes(workspace: string): string[] {
  const homes = homesFor(workspace);
  return [...new Set(Object.values(homes).flatMap((home) => [...home.state, ...home.credentials]))];
}
