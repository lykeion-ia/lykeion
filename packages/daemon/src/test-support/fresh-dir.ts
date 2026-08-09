import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory of this machine's own, removed when the test using it ends. */
export function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-test-"));
  dirs.push(dir);
  return dir;
}
