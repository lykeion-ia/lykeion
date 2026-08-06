import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTaskDir, heldWorkspaces, removeWorkspaces } from "./workspace";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), "lykeion-ws-"));
  dirs.push(d);
  return d;
}

it("gives a Task a directory under its Study", () => {
  const data = fresh();
  const dir = ensureTaskDir(data, "s_cmp", "t_1");
  expect(dir).toBe(join(data, "studies", "s_cmp", "tasks", "t_1"));
  expect(existsSync(dir)).toBe(true);
});

it("is safe to call twice for one Task", () => {
  const data = fresh();
  expect(ensureTaskDir(data, "s_cmp", "t_1")).toBe(ensureTaskDir(data, "s_cmp", "t_1"));
});

it("refuses an id that would climb out of the data directory", () => {
  const data = fresh();
  expect(() => ensureTaskDir(data, "../../etc", "t_1")).toThrow(/not a usable/);
  expect(() => ensureTaskDir(data, "s_cmp", "..")).toThrow(/not a usable/);
});

it("names every Study and Task it holds a directory for", () => {
  const data = fresh();
  ensureTaskDir(data, "s_a", "t_1");
  ensureTaskDir(data, "s_a", "t_2");
  ensureTaskDir(data, "s_b", "t_3");
  const held = heldWorkspaces(data);
  expect(held.studyIds.sort()).toEqual(["s_a", "s_b"]);
  expect(held.taskIds.sort()).toEqual(["t_1", "t_2", "t_3"]);
});

it("removes the directory of a Task that is gone and leaves one that is not", () => {
  const data = fresh();
  const gone = ensureTaskDir(data, "s_a", "t_gone");
  const held = ensureTaskDir(data, "s_a", "t_held");
  expect(removeWorkspaces(data, { studyIds: [], taskIds: ["t_gone"] })).toEqual([gone]);
  expect(existsSync(gone)).toBe(false);
  expect(existsSync(held)).toBe(true);
});

it("takes a Study's Tasks with it when the Study is gone", () => {
  const data = fresh();
  const task = ensureTaskDir(data, "s_gone", "t_1");
  const other = ensureTaskDir(data, "s_kept", "t_2");
  expect(removeWorkspaces(data, { studyIds: ["s_gone"], taskIds: [] })).toEqual([
    join(data, "studies", "s_gone"),
  ]);
  expect(existsSync(task)).toBe(false);
  expect(existsSync(other)).toBe(true);
});

it("never removes a directory the caller says is still live", () => {
  const data = fresh();
  const live = ensureTaskDir(data, "s_a", "t_live");
  expect(removeWorkspaces(data, { studyIds: [], taskIds: ["t_live"] }, (d) => d === live)).toEqual(
    [],
  );
  expect(existsSync(live)).toBe(true);
  // A Study taken whole would take that directory with it, so it is spared
  // too, and asked about again on the next sweep.
  expect(removeWorkspaces(data, { studyIds: ["s_a"], taskIds: [] }, (d) => d === live)).toEqual([]);
  expect(existsSync(live)).toBe(true);
});

it("never removes what nothing said was gone", () => {
  const data = fresh();
  const kept = ensureTaskDir(data, "s_cmp", "t_1");
  mkdirSync(join(data, "studies", "s_cmp"), { recursive: true });
  const stray = join(data, "studies", "s_cmp", "notes.txt");
  writeFileSync(stray, "keep me");
  expect(removeWorkspaces(data, { studyIds: [], taskIds: [] })).toEqual([]);
  expect(existsSync(kept)).toBe(true);
  expect(existsSync(stray)).toBe(true);
});
