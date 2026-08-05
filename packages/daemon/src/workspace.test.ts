import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSessionDir, sweepSessions } from "./workspace";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fresh(): string {
  const d = mkdtempSync(join(tmpdir(), "lykeion-ws-"));
  dirs.push(d);
  return d;
}

it("gives a session a directory under its study", () => {
  const data = fresh();
  const dir = ensureSessionDir(data, "s_cmp", "se_1");
  expect(dir).toBe(join(data, "studies", "s_cmp", "sessions", "se_1"));
  expect(existsSync(dir)).toBe(true);
});

it("is safe to call twice for one session", () => {
  const data = fresh();
  expect(ensureSessionDir(data, "s_cmp", "se_1")).toBe(ensureSessionDir(data, "s_cmp", "se_1"));
});

it("refuses an id that would climb out of the data directory", () => {
  const data = fresh();
  expect(() => ensureSessionDir(data, "../../etc", "se_1")).toThrow(/not a usable/);
  expect(() => ensureSessionDir(data, "s_cmp", "..")).toThrow(/not a usable/);
});

it("sweeps a session directory older than the age it is given, and leaves a young one", () => {
  const data = fresh();
  const old = ensureSessionDir(data, "s_cmp", "se_old");
  const young = ensureSessionDir(data, "s_cmp", "se_young");
  const now = 1_700_000_000;
  utimesSync(old, now - 60_000, now - 60_000);
  utimesSync(young, now - 10, now - 10);
  const swept = sweepSessions(data, now, 6 * 60 * 60);
  expect(swept).toEqual([old]);
  expect(existsSync(old)).toBe(false);
  expect(existsSync(young)).toBe(true);
});

it("leaves anything that is not a session directory alone", () => {
  const data = fresh();
  mkdirSync(join(data, "studies", "s_cmp"), { recursive: true });
  const stray = join(data, "studies", "s_cmp", "notes.txt");
  writeFileSync(stray, "keep me");
  expect(sweepSessions(data, 1_700_000_000, 0)).toEqual([]);
  expect(existsSync(stray)).toBe(true);
});

it("never removes a session directory the caller says is still live, however old it looks", () => {
  const data = fresh();
  const live = ensureSessionDir(data, "s_cmp", "se_live");
  const now = 1_700_000_000;
  utimesSync(live, now - 60_000, now - 60_000);
  const swept = sweepSessions(data, now, 6 * 60 * 60, (dir) => dir === live);
  expect(swept).toEqual([]);
  expect(existsSync(live)).toBe(true);
});
