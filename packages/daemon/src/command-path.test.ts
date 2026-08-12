import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunnable } from "./command-path";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it("isRunnable refuses a file without the executable bit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-probe-"));
  dirs.push(dir);
  const file = join(dir, "claude");
  writeFileSync(file, "not executable");
  expect(await isRunnable(file)).toBe(false);
});

it("isRunnable accepts a file with the executable bit set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-probe-"));
  dirs.push(dir);
  const file = join(dir, "claude");
  writeFileSync(file, "#!/bin/sh\necho hi\n");
  chmodSync(file, 0o755);
  expect(await isRunnable(file)).toBe(true);
});
