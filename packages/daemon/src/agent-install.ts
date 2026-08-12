import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGUE, lykeionHomeFor } from "./agent-registry";

/**
 * The name a CLI's own binary has been observed using for the file it
 * writes to remember "I already planted my bundle here." Named once,
 * structurally, rather than assumed to belong to one particular CLI — an
 * entry whose binary never writes such a file simply never has one to keep.
 *
 * This machine does not know the file's format, and does not need to:
 * whatever the CLI itself wrote there last is, by construction, a marker
 * that CLI's own next run will recognise as its own. Keeping it — while
 * clearing everything the bundle it was guarding brought in beside it — is
 * what lets a CLI's own "already planted" check answer yes to nothing worth
 * replanting.
 */
const REPLANT_MARKER = ".codex-system-skills.marker";

/**
 * Clears whatever a CLI's own binary replanted into `home`, keeping only the
 * marker it wrote to remember having done so.
 *
 * A CLI can plant a bundle of its own skills into a fresh home the first
 * time it runs there, entirely apart from whatever that agent's row seeded —
 * observed of Codex's `skills/.system`, which a conformance run found
 * surviving every `[features]` toggle that row turns off. Named structurally,
 * by where such a bundle would sit under any declared agent's home, rather
 * than by which agent this is: an entry with nothing there loses nothing.
 *
 * Deleting the whole directory outright was tried first and works on disk,
 * but cannot win on its own: the CLI replants at the start of every process
 * it spawns. Keeping the marker the CLI itself wrote — while clearing
 * everything the bundle brought in beside it — lets that CLI's own check find
 * its own answer still standing and skip replanting.
 *
 * Called from two places, and both are needed. `installAgentHomes` runs it
 * once per daemon start, which is what clears a bundle left behind by a
 * previous run. `startSession` runs it again for the agent it is about to
 * open, which is what closes the case a daemon start cannot reach at all: a
 * home with no marker yet — this machine's very first time running this CLI
 * — meets one real plant from the first process to run there, which is
 * ordinarily a probe cycle's own `login status` or its throwaway
 * `session/new`, minutes before any researcher opens a session. Swept only at
 * daemon start, that bundle would then be in front of every session for the
 * rest of the daemon's life, which is D-1 failing on every machine that has
 * not run Lykeion before. It is a `readdirSync` over one directory that
 * usually does not exist, so it is cheap enough to ask again per session.
 *
 * Deliberately not written ahead of the CLI as a marker of our own. Whether
 * that CLI's "already planted" check reads the file's presence or its
 * contents is not established, and a sweep works either way.
 */
export function sweepReplantedSkills(agent: string, root: (agent: string) => string = lykeionHomeFor): void {
  const systemSkills = join(root(agent), "skills", ".system");
  if (!existsSync(systemSkills)) return;
  for (const child of readdirSync(systemSkills)) {
    if (child === REPLANT_MARKER) continue;
    rmSync(join(systemSkills, child), { recursive: true, force: true });
  }
}

/** What one declared agent's installation looks like after this ran. An
 *  agent that is not `ready` is one this machine cannot confine, and is
 *  therefore not offered — the same answer a platform with no sandbox
 *  backend gets. */
export interface InstallResult {
  agent: string;
  home: string;
  ready: boolean;
  reason?: string;
}

/**
 * Puts every declared agent's home where the declaration says, and writes the
 * files the declaration seeds.
 *
 * Run on every daemon start rather than once at install. A configuration
 * written once is one a researcher can edit — to add back a marketplace, or
 * an MCP server — and the isolation would then be intact in the file that
 * described it and gone in the file that governs. Rewriting means the
 * contents are always exactly what the row says, and the agent is handed it
 * read-only besides.
 *
 * `root` exists for the tests, which must not write to the researcher's real
 * home to prove this works.
 */
export function installAgentHomes(
  root: (agent: string) => string = lykeionHomeFor,
): InstallResult[] {
  const results: InstallResult[] = [];
  for (const entry of CATALOGUE) {
    const isolation = entry.isolation;
    if (isolation === undefined) continue;
    const home = root(entry.id);
    try {
      mkdirSync(home, { recursive: true });
      for (const seed of isolation.seeds?.(isolation.skillsOff, home) ?? [])
        writeFileSync(join(home, seed.name), seed.contents, { mode: 0o600 });
      // Clears a bundle a previous run of this CLI planted. The gap this one
      // call cannot close — a home with no marker yet, where the first
      // process to run plants a bundle minutes after this line — is closed by
      // `startSession` asking the same question again for the agent it is
      // opening. See `sweepReplantedSkills`.
      sweepReplantedSkills(entry.id, root);
      results.push({ agent: entry.id, home, ready: true });
    } catch (error) {
      results.push({
        agent: entry.id,
        home,
        ready: false,
        reason: `Lykeion could not prepare ${entry.name}'s installation at ${home}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }
  return results;
}
