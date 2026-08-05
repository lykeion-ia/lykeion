import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
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
 * Where one session's agent runs. Nested under its Study so removing a Study
 * takes its sessions with it in one recursive delete, rather than needing a
 * scan of what belonged to what.
 */
export function ensureSessionDir(dataDir: string, studyId: string, sessionId: string): string {
  const dir = join(
    dataDir,
    "studies",
    segment("study", studyId),
    "sessions",
    segment("session", sessionId),
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Removes session directories nothing has touched for `maxAgeSeconds`, and
 * answers with what it removed. A session's workspace is scratch: what was
 * worth keeping is an artifact, and a machine that ran for a month should not
 * be holding every directory it ever opened.
 *
 * `keep`, when given, names directories never removed no matter how old they
 * look — a session whose ACP subprocess is still running is the reason this
 * exists: `mtime` only moves when something touches the directory itself,
 * not when the agent writes somewhere underneath it, so a long-running turn
 * can look untouched for hours while its process is very much still using
 * the directory it is standing in.
 */
export function sweepSessions(
  dataDir: string,
  now: number,
  maxAgeSeconds: number,
  keep: (dir: string) => boolean = () => false,
): string[] {
  const removed: string[] = [];
  const studies = join(dataDir, "studies");
  for (const study of listDirs(studies)) {
    const sessions = join(studies, study, "sessions");
    for (const session of listDirs(sessions)) {
      const dir = join(sessions, session);
      if (keep(dir)) continue;
      const touched = Math.floor(statSync(dir).mtimeMs / 1000);
      if (now - touched < maxAgeSeconds) continue;
      rmSync(dir, { recursive: true, force: true });
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
