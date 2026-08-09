import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ensureTmpDir, scratchRoot, tmpDir } from "./scratch";
import { freshDir } from "./test-support/fresh-dir";

it("puts a run's scratch inside the directory the boundary already grants", () => {
  const workspace = freshDir();
  expect(scratchRoot(workspace)).toBe(join(workspace, ".lykeion"));
  expect(tmpDir(workspace)).toBe(join(workspace, ".lykeion", "tmp"));
});

it("creates the temporary directory it names", () => {
  const workspace = freshDir();
  const dir = ensureTmpDir(workspace);
  expect(existsSync(dir)).toBe(true);
  expect(dir).toBe(tmpDir(workspace));
});
