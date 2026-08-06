import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** An id that is safe to use as one path segment. Ids the lab mints are
 *  already of this shape; validating anyway is what keeps a value that
 *  arrived over the wire from naming somewhere else on the disk. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function segment(kind: string, value: string): string {
  if (!SAFE_ID.test(value)) throw new Error(`${value} is not a usable ${kind} id`);
  return value;
}

/**
 * Where a Task's agent runs. Keyed to the Task, which persists, rather than
 * to a session, which is created per machine and per agent and changes
 * whenever either does — so a Task's work accumulates in one place across
 * every agent and machine that touches it. Sessions come and go inside it.
 *
 * Nested under its Study so removing a Study takes its Tasks with it in one
 * recursive delete, rather than needing a scan of what belonged to what.
 */
export function ensureTaskDir(dataDir: string, studyId: string, taskId: string): string {
  const dir = join(
    dataDir,
    "studies",
    segment("study", studyId),
    "tasks",
    segment("task", taskId),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** What this machine holds a working directory for. */
export interface HeldWorkspaces {
  studyIds: string[];
  taskIds: string[];
}

/** Every Study and Task this machine currently holds a directory for, so a
 *  caller can ask the lab which of them it still has. */
export function heldWorkspaces(dataDir: string): HeldWorkspaces {
  const studies = join(dataDir, "studies");
  const studyIds = listDirs(studies);
  const taskIds = studyIds.flatMap((study) => listDirs(join(studies, study, "tasks")));
  return { studyIds, taskIds };
}

/**
 * Removes the working directory of every Task named, and every Study
 * directory named — the recursive delete this layout is nested for, since a
 * Study's directory holds its Tasks'.
 *
 * A Task's directory is not scratch: it holds the work of every turn the
 * Task has run, across every session that touched it, and revert restores to
 * it. So nothing ages out on a timer. What is removed is what the lab says
 * is gone.
 *
 * `keep` names directories never removed whatever the lab says — a Task
 * whose ACP subprocess is still standing in the directory is the reason this
 * exists, since removing it out from under a running adapter would take the
 * turn's own work with it.
 */
export function removeWorkspaces(
  dataDir: string,
  gone: HeldWorkspaces,
  keep: (dir: string) => boolean = () => false,
): string[] {
  const removed: string[] = [];
  const studies = join(dataDir, "studies");
  const goneStudies = new Set(gone.studyIds);
  const goneTasks = new Set(gone.taskIds);
  for (const study of listDirs(studies)) {
    const studyDir = join(studies, study);
    if (goneStudies.has(study)) {
      const tasks = join(studyDir, "tasks");
      if (listDirs(tasks).some((task) => keep(join(tasks, task)))) continue;
      rmSync(studyDir, { recursive: true, force: true });
      removed.push(studyDir);
      continue;
    }
    const tasks = join(studyDir, "tasks");
    for (const task of listDirs(tasks)) {
      if (!goneTasks.has(task)) continue;
      const dir = join(tasks, task);
      if (keep(dir)) continue;
      rmSync(dir, { recursive: true, force: true });
      // The snapshot of a Task that is gone has nothing left to restore to.
      rmSync(join(studyDir, "snapshots", task), { recursive: true, force: true });
      removed.push(dir);
    }
  }
  return removed;
}

function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}
