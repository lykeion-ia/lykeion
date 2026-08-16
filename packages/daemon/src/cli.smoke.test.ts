import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The command itself, run the way a researcher runs it.
 *
 * Everything else in this package tests functions. This tests the thing on
 * PATH: that the wrapper loads, that the bundle it loads answers, and that the
 * two questions a program must answer about itself do so without binding a
 * port, claiming a data directory, or pairing anything. A build that broke any
 * of that would pass every other test in this repository and fail on the first
 * command anybody types.
 */

const here = dirname(fileURLToPath(import.meta.url));
const binary = join(here, "..", "bin", "lykeion.js");
const bundle = join(here, "..", "dist", "main.js");

/** The newest mtime under `src/`, which is what the bundle has to be newer
 *  than to be worth trusting. */
function newestSource(): number {
  let newest = 0;
  for (const entry of readdirSync(here, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    newest = Math.max(newest, statSync(join(entry.parentPath, entry.name)).mtimeMs);
  }
  return newest;
}

/** Built on demand rather than assumed. `dist/` is output and is not in the
 *  repository, so a fresh checkout has none — and a test that skipped for
 *  that reason would be a test that never runs in CI.
 *
 *  Rebuilt whenever it is older than the sources beside it, rather than
 *  skipped for merely existing. Because `dist/` is ignored rather than
 *  tracked, it outlives operations that replace every tracked file around it,
 *  so a bundle being present says nothing about what is inside it. Presence
 *  was once taken for currency, and this suite answered questions about the
 *  command by reading a six-day-old build of a different one. */
let rebuilt = false;
function built(): void {
  if (rebuilt) return;
  if (existsSync(bundle) && statSync(bundle).mtimeMs > newestSource()) {
    rebuilt = true;
    return;
  }
  execFileSync("pnpm", ["exec", "esbuild", "src/cli.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`], {
    cwd: join(here, ".."),
    stdio: "pipe",
  });
  rebuilt = true;
}

it("answers about itself without binding a port or claiming a directory", () => {
  built();
  const version = execFileSync(process.execPath, [binary, "--version"], { encoding: "utf8" });
  expect(version.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  const help = execFileSync(process.execPath, [binary, "--help"], { encoding: "utf8" });
  for (const word of ["serve", "open", "url", "status", "stop", "logs", "pair"])
    expect(help).toContain(word);
}, 60_000);

it("calls itself by the name it is installed under", () => {
  // Every refusal and every instruction this program prints names a command.
  // Until there was a binary, all of them named one that did not exist —
  // which is the whole reason this task exists, and exactly the kind of thing
  // that drifts back the moment somebody adds a message.
  built();
  const help = execFileSync(process.execPath, [binary, "--help"], { encoding: "utf8" });
  expect(help).toContain("lykeion —");
  expect(help).not.toContain("lykeion-daemon");
}, 60_000);

it("does nothing at all when something merely imports the program", () => {
  // `main.ts` used to call itself on the way in, so importing ANY part of it
  // ran the whole command line. Under vitest that reached the last branch —
  // vitest's own argv names no command — and `serve` bound this machine's
  // ports and claimed the researcher's real data directory. `main.test.ts`
  // imports one function for one assertion and was silently doing all of it.
  //
  // Run rather than inspected: a grep for `main()` at the end of a file is a
  // fact about the text, and what matters is that the module can be loaded
  // without the program happening.
  built();
  const module = join(here, "..", "dist", "importable.mjs");
  execFileSync(
    "pnpm",
    ["exec", "esbuild", "src/main.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${module}`],
    { cwd: join(here, ".."), stdio: "pipe" },
  );

  // Pointed at a directory of this test's own, so that a regression here
  // fails rather than doing to the researcher's real data directory exactly
  // what this test exists to prevent.
  const dataDir = mkdtempSync(join(tmpdir(), "lykeion-import-"));
  try {
    const said = execFileSync(process.execPath, [module], {
      encoding: "utf8",
      stdio: "pipe",
      // A serve that got through would never return on its own; this is what
      // turns "hangs forever" into a failing test.
      timeout: 20_000,
      env: {
        ...process.env,
        LYKEION_DAEMON_DATA_DIR: dataDir,
        LYKEION_DAEMON_WORK_DIR: join(dataDir, "work"),
        LYKEION_DAEMON_PORT: "0",
      },
    });
    expect(said).toBe("");
    // Nothing claimed the directory it was pointed at either — the module
    // exited because it had nothing to do, not because a port was taken.
    expect(existsSync(dataDir)).toBe(true);
    expect(readdirSync(dataDir)).toEqual([]);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(module, { force: true });
  }
}, 60_000);

it("refuses an unknown command by name rather than serving", () => {
  // The dangerous default. `serve` binds two ports, claims a data directory
  // and pairs a new machine, so a typo that fell through to it would do all
  // of that on a line whose meaning was never in doubt.
  built();
  expect(() =>
    execFileSync(process.execPath, [binary, "restart"], { encoding: "utf8", stdio: "pipe" }),
  ).toThrow(/restart is not a command/);
}, 60_000);
