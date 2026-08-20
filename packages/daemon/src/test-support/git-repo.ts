import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { freshDir } from "./fresh-dir";

const run = promisify(execFile);

/**
 * A directory with a real repository behind it, on a branch and a commit this
 * machine can name.
 *
 * Real rather than simulated: what reads it is `git` itself, spawned in a
 * subprocess, so a fixture that wrote `.git` by hand would be testing this
 * machine's idea of a repository instead of the one the probe actually asks.
 *
 * The identity is set on the repository rather than left to whatever the
 * machine running the tests has configured, because a machine with no
 * `user.email` refuses to commit at all.
 */
export async function freshRepo(): Promise<string> {
  const dir = freshDir();
  await run("git", ["init", "-q", "-b", "trunk"], { cwd: dir });
  await run("git", ["config", "user.email", "t@example.invalid"], { cwd: dir });
  await run("git", ["config", "user.name", "T"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "one\n");
  await run("git", ["add", "a.txt"], { cwd: dir });
  await run("git", ["commit", "-qm", "first"], { cwd: dir });
  return dir;
}
