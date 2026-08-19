import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  materializeEnvironment,
  provisionerFor,
  readEnvStatus,
  removeEnvironment,
  resolveEnvironment,
} from "./environments";
import type { KernelEnvDeclaration } from "@lykeion/api";

/**
 * One R environment, built for real, and a cell run inside it.
 *
 * Everything else on this branch tests the conda backend against a recorded
 * solve. That is the right shape for the lockfile's FORMAT — a fixture kept
 * whole cannot drift the way a hand-written one does — but it cannot say
 * whether micromamba accepts what this code hands it. The three flags this
 * branch chose after measuring them (`--safety-checks enabled`, the `HOME`
 * redirection, `--file` over a package list) live or die against the real
 * binary and nothing else.
 *
 * SKIPPED, not passed, where micromamba is absent. A skipped test folded into
 * a green total is how a feature ships untested, and this project has been
 * bitten by exactly that once already — so the skip says which of the two
 * happened, out loud, rather than leaving it to a count.
 */
const hasMicromamba =
  spawnSync("micromamba", ["--version"], { encoding: "utf8" }).status === 0;

/**
 * Whether there is room to do this at all.
 *
 * A conda R environment is ~950MB and this builds one at a time plus two
 * package caches, so it wants a few gigabytes free. Checked UP FRONT because
 * of how it fails otherwise: micromamba running out of space reports "Found
 * incorrect downloads. Aborting", which reads exactly like a corrupted
 * artifact or a bad hash and sends a reader looking at the lockfile. That
 * cost real time once already.
 *
 * A skip, not a failure: a full disk is a fact about this machine, not about
 * this branch. It names the number so the skip is actionable rather than
 * mysterious.
 */
const GIGABYTE = 1024 ** 3;
const freeBytes = (() => {
  try {
    const fs = statfsSync(tmpdir());
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    // A platform whose free space this cannot read is not a reason to skip —
    // it is a reason not to claim anything about the disk. Let it run.
    return Number.POSITIVE_INFINITY;
  }
})();
const hasRoom = freeBytes >= 3 * GIGABYTE;

if (hasMicromamba && !hasRoom)
  console.warn(
    `skipping the conda integration build: it needs about 3GB free and this machine has ` +
      `${(freeBytes / GIGABYTE).toFixed(1)}GB`,
  );

const dirs: string[] = [];
function fresh(): string {
  const made = mkdtempSync(join(tmpdir(), "lykeion-conda-"));
  dirs.push(made);
  return made;
}

afterAll(() => {
  // Gigabytes, if this ran. Removed whatever the assertions did.
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  // Two minutes, not vitest's default ten SECONDS. A conda R environment is
  // a few hundred thousand small files, and removing two of them plus their
  // caches does not fit in ten seconds on a laptop — the first genuinely
  // green run of this test still reported the FILE as failed for that reason
  // alone, with the test itself passing, which is a confusing way to be told
  // that cleanup was slow.
}, 120_000);

const declaration = (name: string): KernelEnvDeclaration => ({
  name,
  language: "r",
  manager: "conda",
  packages: ["r-base", "jsonlite"],
  createdTs: 0,
  lockRevision: 1,
});

(hasMicromamba && hasRoom ? it : it.skip)(
  "builds a declared R environment, replays it verbatim into a second root, and runs a cell in both",
  async () => {
    const dataDir = fresh();
    const workDir = fresh();

    // `jsonlite` is written as a researcher writes it. `condaPackageName`
    // maps it to conda-forge's `r-jsonlite` inside the backend, and
    // `r-base` is left alone because it already carries the prefix — both
    // halves of that rule are exercised by this one call reaching a solver
    // that would fail on `r-r-base`.
    const { lockfile } = await resolveEnvironment({
      manager: "conda",
      dataDir,
      workDir,
      name: "rstats",
      packages: ["r-base", "jsonlite"],
      path: process.env.PATH,
      timeoutMs: 900_000,
    });
    expect(lockfile.startsWith("@EXPLICIT")).toBe(true);
    // Every pinned line carries a hash, because `--safety-checks enabled`
    // refuses the whole install otherwise. This is the assertion that would
    // have caught the lockfile being read off `FETCH` — an environment whose
    // packages are already cached lists nothing there.
    const pinned = lockfile.split("\n").filter((line) => line.startsWith("http"));
    expect(pinned.length).toBeGreaterThan(1);
    for (const line of pinned) expect(line).toMatch(/#[0-9a-f]{32}$/);

    const built = await materializeEnvironment({
      manager: "conda",
      dataDir,
      workDir,
      name: "rstats",
      lockfile,
      lockRevision: 1,
      path: process.env.PATH,
      timeoutMs: 900_000,
    });
    expect(built.packageCount).toBe(pinned.length);

    const status = readEnvStatus(workDir, declaration("rstats"));
    expect(status.state).toBe("ready");

    const ran = spawnSync(provisionerFor("conda").interpreter(workDir, "rstats"), [
      "-e",
      "cat(jsonlite::toJSON(1:3))",
    ]);
    expect(ran.stdout.toString()).toContain("[1,2,3]");

    // Read before the root goes, because the root is about to go.
    const firstMarker = JSON.parse(
      readFileSync(join(workDir, "envs", "rstats", ".lykeion-env.json"), "utf8"),
    );
    // The identity of what was installed, not how much of it. `conda-meta`
    // holds one `<name>-<version>-<build>.json` per linked package, so this
    // set IS the closure — the thing D4 claims two machines share. Counting
    // instead would let two different closures of the same size pass as
    // identical, which is exactly the failure "every machine builds the same
    // environment" is a claim about.
    const closureOf = (dir: string) =>
      readdirSync(join(dir, "envs", "rstats", "conda-meta"))
        .filter((entry) => entry.endsWith(".json"))
        .sort();
    const firstClosure = closureOf(workDir);
    expect(firstClosure.length).toBe(built.packageCount);
    // A built R environment is ~950MB and this test builds two. Reclaimed
    // between them rather than held: every assertion about the first is
    // already made above, and two live at once put this test's peak past
    // what a developer laptop reliably has free. Found the hard way — the
    // first version of this test failed on a full disk with micromamba
    // reporting "Found incorrect downloads", which reads like a corrupt
    // artifact and is not one.
    removeEnvironment(workDir, "rstats");

    // D4, observed: a SECOND machine's root, built from the same lockfile
    // text and nothing else — its own work directory, and therefore its own
    // package cache, exactly as a colleague's laptop has. That no solve runs
    // here is structural rather than measured — `materializeEnvironment`
    // takes no package list, so there is nothing for it to solve FROM — and
    // what this checks is the consequence: the same closure, package for
    // package, and an R that can load the library.
    const second = fresh();
    const replayed = await materializeEnvironment({
      manager: "conda",
      dataDir,
      workDir: second,
      name: "rstats",
      lockfile,
      lockRevision: 1,
      path: process.env.PATH,
      timeoutMs: 900_000,
    });
    expect(replayed.packageCount).toBe(built.packageCount);
    expect(replayed.version).toBe(built.version);

    const secondMarker = JSON.parse(
      readFileSync(join(second, "envs", "rstats", ".lykeion-env.json"), "utf8"),
    );
    expect(secondMarker.packageCount).toBe(firstMarker.packageCount);
    expect(secondMarker.version).toBe(firstMarker.version);
    expect(secondMarker.lockRevision).toBe(1);
    // D4 as an equality between two closures rather than between two
    // numbers: same packages, same versions, same builds, in both roots.
    expect(closureOf(second)).toEqual(firstClosure);

    const alsoRan = spawnSync(provisionerFor("conda").interpreter(second, "rstats"), [
      "-e",
      "cat(jsonlite::toJSON(1:3))",
    ]);
    expect(alsoRan.stdout.toString()).toContain("[1,2,3]");
  },
  1_800_000,
);
