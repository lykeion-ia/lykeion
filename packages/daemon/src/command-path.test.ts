import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunnable, resolveOnPath } from "./command-path";

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

it("resolveOnPath answers a command that is already a path, without searching PATH", async () => {
  // What a shell does, and what this did not. A conda environment's own
  // `bin/Rscript` is a full path to a file the daemon just built, and every
  // PATH directory joined with it (`join("/usr/bin", "/tmp/x")` →
  // "/usr/bin/tmp/x") names nothing — so it resolved to `undefined`, and the
  // caller reported an unrunnable command with two empty output streams.
  const dir = mkdtempSync(join(tmpdir(), "lykeion-probe-"));
  dirs.push(dir);
  const file = join(dir, "Rscript");
  writeFileSync(file, "#!/bin/sh\necho hi\n");
  chmodSync(file, 0o755);

  // An EMPTY path, so a version that searched would have nowhere to look and
  // this could only pass by answering the path it was given.
  expect(await resolveOnPath(file, "")).toBe(file);
});

it("resolveOnPath refuses a path that names nothing runnable, rather than falling back to PATH", async () => {
  // The other half: answering a path directly must not become answering
  // SOMETHING for a path that is wrong. `sh` exists on PATH under that bare
  // name, and a lookup that quietly fell back would find it and hand a
  // caller the wrong binary entirely.
  //
  // Said plainly: this one does NOT go red against the implementation it was
  // written for. The old PATH-joining version also answered `undefined`
  // here, by a different route. It guards the shape of a FUTURE mistake —
  // a fallback added to the branch above — and is kept for that rather than
  // counted as coverage of this change. The test above it is the one that
  // fails when the branch is removed.
  const dir = mkdtempSync(join(tmpdir(), "lykeion-probe-"));
  dirs.push(dir);
  expect(await resolveOnPath(join(dir, "sh"), "/bin:/usr/bin")).toBeUndefined();
});
