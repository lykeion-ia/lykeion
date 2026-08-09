import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A run's own working files, inside the Task directory the boundary already
 * grants — so nothing here needs a rule of its own, and nothing here is the
 * researcher's.
 *
 * One module owns the layout because more than one thing writes into it: a
 * child's temporary directory and the payloads too large to send inline. A
 * directory several callers each create entries in is a directory whose shape
 * nothing states, and whose contents nothing can safely exclude.
 */
export const SCRATCH_DIR = ".lykeion";

export function scratchRoot(workspace: string): string {
  return join(workspace, SCRATCH_DIR);
}

/** Where a confined child writes its temporary files. The machine's shared
 *  temporary directory is one directory for every process on it, so a run's
 *  own scratch belongs inside its own workspace. */
export function tmpDir(workspace: string): string {
  return join(scratchRoot(workspace), "tmp");
}

export function ensureTmpDir(workspace: string): string {
  const dir = tmpDir(workspace);
  mkdirSync(dir, { recursive: true });
  return dir;
}
