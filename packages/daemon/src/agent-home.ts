import { homedir } from "node:os";
import { join } from "node:path";
import { CATALOGUE, lykeionHomeFor } from "./agent-registry";
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
 * The working directory an agent will believe it was started in.
 *
 * A process asks the kernel where it is and is answered with a physical path,
 * every link already followed — so an agent opened in a directory reached
 * through one keys its per-directory state on the place the link points at,
 * never on the name Lykeion opened it by. `workspaceKey` is the agent's own
 * convention; which directory it is applied to is this machine's, and stating
 * it here is what keeps the two ends of that name together.
 *
 * Without it a run whose workspace is named `/tmp/…` and resolved
 * `/private/tmp/…` is granted a scratch directory and a Task record under one
 * name while the agent creates the other, and every shell it tries to run
 * fails at the `mkdir` before running anything — which reaches a researcher
 * as an agent talking about `EPERM`, not as a boundary saying no.
 *
 * Falls back to the name as given when it will not resolve: a directory that
 * is not there is not one an agent can be started in either, so there is
 * nothing yet to place — while a caller asking what an agent would reach in a
 * directory this machine does not have still gets an answer rather than a throw.
 */
function physicalWorkspace(workspace: string): string {
  try {
    return canonicalPath(workspace);
  } catch {
    return workspace;
  }
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

/**
 * The installations this machine knows about, ours and the researcher's.
 *
 * Ours is what an agent runs against. Theirs is named here for one reason: so
 * it can be denied. A home directory's hidden entries are readable by default
 * — that is how a program reads its own configuration at all — and a run that
 * could read `~/.claude` reads a credentials file holding live OAuth tokens
 * for a dozen services with nothing to do with Lykeion. Naming it is what
 * makes `foreignHomes` deny it.
 */
function homesFor(workspace: string): Record<string, AgentHome> {
  const key = workspaceKey(physicalWorkspace(workspace));
  const homes: Record<string, AgentHome> = {};
  for (const entry of CATALOGUE) {
    if (entry.isolation === undefined) continue;
    const own = lykeionHomeFor(entry.id);
    homes[entry.id] = {
      state: [
        own,
        // What its shell creates before it runs anything at all.
        join(shellScratchRoot(), key),
        // Its record of this Task, kept beside every other Task's, which is
        // why the directory holding them is denied and this one entry is not.
        join(own, "projects", key),
      ],
      // Ordinarily a file inside the home above, which it must be able to
      // rewrite when the token it holds is refreshed — nothing separate to
      // declare there. `credentialsOutsideHome` is the declared exception:
      // an agent whose sign-in lives somewhere `homeEnv` does not reach
      // (Claude Code's macOS keychain entry, at the time of writing) names
      // it there rather than this file asking which agent it is.
      credentials: [...(entry.isolation.credentialsOutsideHome ?? [])],
      // What Lykeion wrote is what governs this run, and a write here would
      // outlive it. Rewritten from the declaration every daemon start anyway;
      // sealing it means a run cannot make that rewrite the only thing
      // standing between a session and its own contamination.
      sealed: (entry.isolation.seeds?.(entry.isolation.skillsOff, own) ?? []).map((seed) =>
        join(own, seed.name),
      ),
      // Every other Task's record. A run writes its own and reads no other.
      private: [join(own, "projects")],
      // Rendered read AND write, which is what a rotating credential needs:
      // the row's own `credentialPatterns` join the shell's scratch shape
      // here rather than beside `credentials`, because `credentials` is
      // rendered read-only on purpose and must stay that way — a row may
      // read a store it may not rewrite, and most should.
      patterns: [...shellScratchPattern(), ...(entry.isolation.credentialPatterns ?? [])],
    };
  }
  return homes;
}

/**
 * The researcher's own installations. Named only to be denied.
 *
 * Not only the two agents this machine runs. `~/.claude` and `~/.codex` were
 * the first two found reachable, but the blanket read grant every declared
 * agent gets over a home directory's hidden entries (see
 * `renderSeatbeltProfile`'s comment on `hidden`) reaches every hidden
 * top-level entry, not only those two — and a conformance run surfaced a
 * live example: `codex-acp`, asked to list its skills, named several that
 * belong to none of its own bundle but to `~/.agents/skills`, a directory
 * this list did not yet carry.
 *
 * Nor only the agents this machine can run. The list is derived from the
 * whole catalogue rather than from the entries carrying an `isolation`,
 * because being undeclared is what makes a CLI dangerous here, not what
 * makes it safe: Lykeion not knowing how to confine Gemini does nothing
 * about the researcher's own Gemini sitting in `~/.gemini` with its OAuth
 * credentials and its MCP tokens, reachable through the same blanket read.
 * An entry earns its denial by being a CLI, and gains its declaration
 * later — or never.
 */
function researcherHomes(): string[] {
  return [
    // Every CLI the catalogue names, declared or not. A CLI Lykeion cannot
    // yet run is not a CLI whose installation is safe to read: the danger is
    // the researcher's copy of it, which exists on their machine whether or
    // not this daemon knows how to confine the thing. Deriving the list here
    // is what stops it drifting from the catalogue — hand-maintained, it
    // already fell behind twice, and the second time `~/.gemini` sat
    // readable with `oauth_creds.json` and `mcp-oauth-tokens.json` in it
    // while `gemini` had been a catalogue row all along.
    //
    // `~/.<command>` because that is what every installation on this machine
    // has been observed to use — `.claude`, `.codex`, `.gemini`, `.copilot`,
    // `.openclaw`, five for five. A CLI keeping its configuration somewhere
    // else is not covered by this and needs its own path recorded; that
    // belongs on the catalogue row rather than here, and is phase 2's.
    ...CATALOGUE.map((entry) => join(homedir(), `.${entry.command}`)),
    // Both conventions, for every entry, rather than one per row. Which of
    // the two a given CLI follows is exactly the fact this list must not have
    // to be right about in advance: a wrong guess leaves a credential
    // directory readable, and a needless deny costs a directory nothing was
    // going to read anyway. The asymmetry is the whole argument.
    ...CATALOGUE.map((entry) => join(homedir(), ".config", entry.command)),
    // Anywhere else a row says its own CLI keeps things. `~/.<command>` was
    // five for five on the installations this machine had, and then a sixth
    // broke it in the instructive direction — an editor build whose
    // `~/.<command>` holds only its plugins, with the sign-in somewhere the
    // rule never looks. A row that knows better says so here.
    ...CATALOGUE.flatMap((entry) => entry.isolation?.researcherHome ?? []),
    // The stores that belong to no single CLI, so no row derives them.
    // `~/.agents` and `~/.gsd` are both a shared, cross-tool skills catalogue
    // — the same shape `~/.claude/skills` is, just not scoped to one CLI's
    // config directory. `~/.gsd` was found holding a second copy of some of
    // the same skill names under a `.migrated-to-agents` marker recording
    // that its catalogue moved and left residue behind, so denying only one
    // would leave the other reachable. `~/.mcp-auth` is `mcp-remote`'s own
    // OAuth cache for whatever remote MCP servers the researcher has
    // authenticated to outside any agent Lykeion runs — live third-party
    // tokens, not any agent's own.
    join(homedir(), ".agents"),
    join(homedir(), ".gsd"),
    join(homedir(), ".mcp-auth"),
  ];
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
  const foreign = new Set<string>(researcherHomes());
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
  return [
    ...new Set([
      ...researcherHomes(),
      ...Object.values(homes).flatMap((home) => [...home.state, ...home.credentials]),
    ]),
  ];
}
