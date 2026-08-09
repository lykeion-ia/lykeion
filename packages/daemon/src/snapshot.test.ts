import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTaskDir } from "./workspace";
import { restoreSnapshot, snapshotPathFor, takeSnapshot } from "./snapshot";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(): { workDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-snap-"));
  dirs.push(dir);
  return { workDir: dir };
}

it("keeps a Task's snapshot outside the directory the agent may write", () => {
  const { workDir: work } = fresh();
  const task = ensureTaskDir(work, "s_1", "t_1");
  const snapshot = snapshotPathFor(work, "s_1", "t_1");
  expect(snapshot.startsWith(`${task}/`)).toBe(false);
  expect(snapshot).toBe(join(work, "studies", "s_1", "snapshots", "t_1"));
});

it("takes a snapshot of what the directory held when the turn started", async () => {
  const { workDir: work } = fresh();
  const task = ensureTaskDir(work, "s_1", "t_1");
  writeFileSync(join(task, "counts.csv"), "a,b\n");
  mkdirSync(join(task, "results"));
  writeFileSync(join(task, "results", "out.csv"), "1,2\n");

  const taken = await takeSnapshot(work, "s_1", "t_1");
  expect(taken.taken).toBe(true);
  const snapshot = snapshotPathFor(work, "s_1", "t_1");
  expect(readFileSync(join(snapshot, "counts.csv"), "utf8")).toBe("a,b\n");
  expect(readFileSync(join(snapshot, "results", "out.csv"), "utf8")).toBe("1,2\n");
});

it("keeps exactly one snapshot per Task, replacing it when the next turn starts", async () => {
  const { workDir: work } = fresh();
  const task = ensureTaskDir(work, "s_1", "t_1");
  writeFileSync(join(task, "first.txt"), "one\n");
  await takeSnapshot(work, "s_1", "t_1");

  rmSync(join(task, "first.txt"));
  writeFileSync(join(task, "second.txt"), "two\n");
  await takeSnapshot(work, "s_1", "t_1");

  const snapshot = snapshotPathFor(work, "s_1", "t_1");
  expect(existsSync(join(snapshot, "second.txt"))).toBe(true);
  expect(existsSync(join(snapshot, "first.txt"))).toBe(false);
});

it("puts the directory back, including a file the turn deleted", async () => {
  const { workDir: work } = fresh();
  const task = ensureTaskDir(work, "s_1", "t_1");
  writeFileSync(join(task, "kept.csv"), "a,b\n");
  writeFileSync(join(task, "deleted-later.csv"), "keep me\n");
  await takeSnapshot(work, "s_1", "t_1");

  // What the turn did.
  rmSync(join(task, "deleted-later.csv"));
  writeFileSync(join(task, "kept.csv"), "overwritten\n");
  writeFileSync(join(task, "added.csv"), "new\n");

  await restoreSnapshot(work, "s_1", "t_1");

  expect(readFileSync(join(task, "kept.csv"), "utf8")).toBe("a,b\n");
  expect(readFileSync(join(task, "deleted-later.csv"), "utf8")).toBe("keep me\n");
  expect(existsSync(join(task, "added.csv"))).toBe(false);
});

it("can be restored twice from the one snapshot it keeps", async () => {
  const { workDir: work } = fresh();
  const task = ensureTaskDir(work, "s_1", "t_1");
  writeFileSync(join(task, "kept.csv"), "a,b\n");
  await takeSnapshot(work, "s_1", "t_1");

  writeFileSync(join(task, "added.csv"), "new\n");
  await restoreSnapshot(work, "s_1", "t_1");
  writeFileSync(join(task, "added.csv"), "new again\n");
  await restoreSnapshot(work, "s_1", "t_1");

  expect(existsSync(join(task, "added.csv"))).toBe(false);
  expect(readFileSync(join(task, "kept.csv"), "utf8")).toBe("a,b\n");
});

it("refuses to restore a Task with no snapshot, and leaves the directory alone", async () => {
  const { workDir: work } = fresh();
  const task = ensureTaskDir(work, "s_1", "t_1");
  writeFileSync(join(task, "work.csv"), "a,b\n");

  await expect(restoreSnapshot(work, "s_1", "t_1")).rejects.toThrow(/no snapshot/i);
  expect(readFileSync(join(task, "work.csv"), "utf8")).toBe("a,b\n");
});

it("takes no snapshot of a directory too large to copy, and says why", async () => {
  const { workDir: work } = fresh();
  const task = ensureTaskDir(work, "s_1", "t_1");
  writeFileSync(join(task, "big.bin"), Buffer.alloc(4096));

  const taken = await takeSnapshot(work, "s_1", "t_1", { maxCopyBytes: 0, clone: false });
  expect(taken.taken).toBe(false);
  expect(taken.reason).toMatch(/too large/i);
  expect(existsSync(snapshotPathFor(work, "s_1", "t_1"))).toBe(false);
});

it("falls back to a real copy where the volume cannot clone", async () => {
  const { workDir: work } = fresh();
  const task = ensureTaskDir(work, "s_1", "t_1");
  writeFileSync(join(task, "counts.csv"), "a,b\n");

  const taken = await takeSnapshot(work, "s_1", "t_1", { clone: false });
  expect(taken.taken).toBe(true);
  expect(readFileSync(join(snapshotPathFor(work, "s_1", "t_1"), "counts.csv"), "utf8")).toBe("a,b\n");
});

it("leaves a run's own scratch out of the snapshot it takes", async () => {
  const { workDir } = fresh();
  const task = ensureTaskDir(workDir, "st_1", "tk_1");
  writeFileSync(join(task, "data.csv"), "a,b\n1,2\n");
  mkdirSync(join(task, ".lykeion", "tmp"), { recursive: true });
  writeFileSync(join(task, ".lykeion", "tmp", "pip-build.log"), "x".repeat(4096));

  expect(await takeSnapshot(workDir, "st_1", "tk_1")).toEqual({ taken: true });

  const snapshot = snapshotPathFor(workDir, "st_1", "tk_1");
  expect(existsSync(join(snapshot, "data.csv"))).toBe(true);
  expect(existsSync(join(snapshot, ".lykeion"))).toBe(false);
});

it("measures only what it would copy when the volume cannot clone", async () => {
  const { workDir } = fresh();
  const task = ensureTaskDir(workDir, "st_1", "tk_1");
  writeFileSync(join(task, "data.csv"), "a,b\n1,2\n");
  mkdirSync(join(task, ".lykeion", "tmp"), { recursive: true });
  writeFileSync(join(task, ".lykeion", "tmp", "big"), "x".repeat(50_000));

  // A ceiling above the Task's real files and below the scratch it is not
  // going to copy. A measurement that counted the scratch would refuse here.
  const result = await takeSnapshot(workDir, "st_1", "tk_1", {
    clone: false,
    maxCopyBytes: 10_000,
  });

  expect(result).toEqual({ taken: true });
  const snapshot = snapshotPathFor(workDir, "st_1", "tk_1");
  expect(existsSync(join(snapshot, ".lykeion"))).toBe(false);
});

it("keeps a run's live scratch across a restore", async () => {
  const { workDir } = fresh();
  const task = ensureTaskDir(workDir, "st_1", "tk_1");
  writeFileSync(join(task, "data.csv"), "before\n");
  await takeSnapshot(workDir, "st_1", "tk_1");

  writeFileSync(join(task, "data.csv"), "after\n");
  mkdirSync(join(task, ".lykeion", "tmp"), { recursive: true });
  writeFileSync(join(task, ".lykeion", "tmp", "adapter.sock"), "");

  await restoreSnapshot(workDir, "st_1", "tk_1");

  expect(readFileSync(join(task, "data.csv"), "utf8")).toBe("before\n");
  // The adapter standing in this directory is still using it. Putting the
  // files back is about the researcher's work, not about the temporary
  // files of the process doing the putting back.
  expect(existsSync(join(task, ".lykeion", "tmp", "adapter.sock"))).toBe(true);
});
