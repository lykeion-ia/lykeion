import { spawn } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SCRATCH_DIR } from "./scratch";

/**
 * What a Task's working directory held when a turn started, so a turn can be
 * discarded and the files put back.
 *
 * The snapshot lives beside the Task's directory rather than inside it. The
 * sandbox grants the agent write access to that directory, and a snapshot
 * the agent can edit or delete is not a snapshot.
 *
 * Exactly one is kept per Task, replaced when the next turn starts, because
 * only the newest turn can be reverted. Nothing accumulates.
 */

/** An id that is safe to use as one path segment, the same shape the
 *  workspace layout requires. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function segment(kind: string, value: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`${value} is not a usable ${kind} id`);
  return value;
}

/**
 * How large a directory may be before a real copy is refused, where the
 * volume cannot clone. A clone costs nothing and is not rationed; a copy
 * costs its own size in space and time, and a snapshot that takes a minute
 * at the start of every turn is worse than no snapshot at all.
 */
const DEFAULT_MAX_COPY_BYTES = 256 * 1024 * 1024;

export function snapshotPathFor(workDir: string, studyId: string, taskId: string): string {
  return join(
    workDir,
    "studies",
    segment("study", studyId),
    "snapshots",
    segment("task", taskId),
  );
}

function taskPathFor(workDir: string, studyId: string, taskId: string): string {
  return join(workDir, "studies", segment("study", studyId), "tasks", segment("task", taskId));
}

/** Runs one program with an argument array and answers with whether it
 *  succeeded. Never a shell: the paths here come from a layout this machine
 *  built, and they still never reach one. */
function run(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

/** Copy-on-write where the volume offers it. The platform's own copy
 *  program is asked for a clone; a volume that cannot clone refuses, and
 *  the caller falls back to a real copy. */
function clone(source: string, destination: string): Promise<boolean> {
  return run("/bin/cp", ["-c", "-R", "-p", source, destination]);
}

function copy(source: string, destination: string): Promise<boolean> {
  return run("/bin/cp", ["-R", "-p", source, destination]);
}

function sizeOf(path: string): number {
  let total = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === SCRATCH_DIR) continue;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) total += statSync(child).size;
    }
  };
  try {
    walk(path);
  } catch {
    return total;
  }
  return total;
}

/** Whether a snapshot was taken, and when it was not, the reason a
 *  researcher is shown beside a Revert control that cannot restore
 *  anything. A control that cannot restore is worse than an absent one, and
 *  silently skipping the snapshot would produce exactly that. */
export interface SnapshotResult {
  taken: boolean;
  reason?: string;
}

export async function takeSnapshot(
  workDir: string,
  studyId: string,
  taskId: string,
  options: { maxCopyBytes?: number; clone?: boolean } = {},
): Promise<SnapshotResult> {
  const source = taskPathFor(workDir, studyId, taskId);
  const destination = snapshotPathFor(workDir, studyId, taskId);
  if (!existsSync(source)) return { taken: false, reason: "this Task has no working directory yet" };
  mkdirSync(join(destination, ".."), { recursive: true });
  // The copy program copies INTO a destination that already exists, so the
  // previous snapshot goes first: what is kept is one snapshot of this
  // turn's starting state, never a snapshot nested inside its predecessor.
  rmSync(destination, { recursive: true, force: true });

  if (options.clone !== false && (await clone(source, destination))) {
    rmSync(join(destination, SCRATCH_DIR), { recursive: true, force: true });
    return { taken: true };
  }
  rmSync(destination, { recursive: true, force: true });

  const limit = options.maxCopyBytes ?? DEFAULT_MAX_COPY_BYTES;
  const size = sizeOf(source);
  if (size > limit)
    return {
      taken: false,
      reason: `this Task's files are too large to copy on a volume that cannot clone them (${size} bytes, over ${limit})`,
    };
  if (await copy(source, destination)) {
    rmSync(join(destination, SCRATCH_DIR), { recursive: true, force: true });
    return { taken: true };
  }
  rmSync(destination, { recursive: true, force: true });
  return { taken: false, reason: "this Task's files could not be copied" };
}

/**
 * Puts the Task's working directory back to what the snapshot holds.
 *
 * The snapshot itself is never moved, so a restore can be asked for again.
 * The new directory is built alongside and swapped in, and every failure
 * leaves the directory exactly as it was — a caller truncates the record
 * only after this returns, and a record truncated over an un-restored
 * directory describes a state that never existed.
 */
export async function restoreSnapshot(
  workDir: string,
  studyId: string,
  taskId: string,
): Promise<void> {
  const snapshot = snapshotPathFor(workDir, studyId, taskId);
  if (!existsSync(snapshot)) throw new Error(`there is no snapshot of ${taskId} to restore`);
  const task = taskPathFor(workDir, studyId, taskId);
  const staged = `${snapshot}.restoring`;
  const replaced = `${snapshot}.replaced`;

  rmSync(staged, { recursive: true, force: true });
  rmSync(replaced, { recursive: true, force: true });
  if (!(await clone(snapshot, staged)) && !(await copy(snapshot, staged))) {
    rmSync(staged, { recursive: true, force: true });
    throw new Error(`the snapshot of ${taskId} could not be read back`);
  }

  const hadDirectory = existsSync(task);
  try {
    if (hadDirectory) renameSync(task, replaced);
  } catch (err) {
    rmSync(staged, { recursive: true, force: true });
    throw err;
  }
  try {
    mkdirSync(join(task, ".."), { recursive: true });
    renameSync(staged, task);
  } catch (err) {
    // Nothing has been lost: the directory the turn left behind goes back
    // where it was, and the refusal below is what the caller acts on.
    if (hadDirectory) renameSync(replaced, task);
    rmSync(staged, { recursive: true, force: true });
    throw err;
  }
  // What a turn wrote is what goes back. The files the process doing the
  // restoring is standing in are not part of that: an adapter holding this
  // directory open keeps its temporary files, and the socket a kernel is
  // reached through does not move out from under it.
  const carried = join(replaced, SCRATCH_DIR);
  if (hadDirectory && existsSync(carried)) {
    rmSync(join(task, SCRATCH_DIR), { recursive: true, force: true });
    renameSync(carried, join(task, SCRATCH_DIR));
  }
  rmSync(replaced, { recursive: true, force: true });
}

/** Removes a Task's snapshot, for a Task the lab no longer has. */
export function dropSnapshot(workDir: string, studyId: string, taskId: string): void {
  rmSync(snapshotPathFor(workDir, studyId, taskId), { recursive: true, force: true });
}
