import { afterEach, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeKernelFloor } from "./kernel-floor";
import { runConfined } from "./probe";

/** `runConfined` is the one spawn `probeKernelFloor` can make, wrapped in a
 *  spy that calls straight through to the real thing. Nothing here is
 *  stubbed: every test below runs exactly the confined process it always did,
 *  against the same PATH, on the same budget. What the wrapper adds is a
 *  record of whether that spawn happened at all — which the last test in this
 *  file is named for and could not otherwise say.
 *
 *  A stub `uv` touching a file would have been the lighter way to record it,
 *  and it cannot work: the boundary a confined run is rendered inside denies
 *  writes outside its own throwaway workspace, so a `uv` that really ran
 *  leaves no mark on this side of it — it fails with "Operation not
 *  permitted" instead, which is a different answer from the one being
 *  measured. */
vi.mock("./probe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./probe")>();
  return { ...actual, runConfined: vi.fn(actual.runConfined) };
});

const dirs: string[] = [];
afterEach(() => {
  // Calls only — `mockClear` keeps the implementation above, which is the
  // real `runConfined` and has to stay that way for the next test.
  vi.clearAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A stand-in for this machine's own state directory — real, so the boundary
 *  a confined run renders can resolve it, and thrown away after. */
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-floor-state-"));
  dirs.push(dir);
  return dir;
}

/** A PATH holding the named commands, each answering whatever shell body it
 *  is given — the same shape `probe.test.ts`'s own `pathRunning` builds for
 *  the same reason, kept local here since a test fixture is not a thing two
 *  files should share a name for. */
function pathRunning(commands: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-floor-path-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(commands)) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

// Every test below spawns (or, for the first, comes right up to the edge of
// spawning) a real confined process through `probeKernelFloor` — the same
// class of run `probe.test.ts` gives 30s throughout this package, and for the
// same reason: `packages/daemon` has no `vitest.config.ts`, so a bare `it()`
// here inherits vitest's 5s default, while `probe.ts`'s own budget for a
// confined command (`DEFAULT_TIMEOUT_MS`) is 10s. A spawn the probe would
// happily wait out must not lose to the TEST's own deadline first — that
// failure is silent and easy to misread as a real regression, since it still
// leaves an assertion below false.

it(
  "names the requirement a machine is missing",
  async () => {
    const floor = await probeKernelFloor({ dataDir: stateDir(), path: "/nowhere" });
    expect(floor.ready).toBe(false);
    expect(floor.reason).toContain("uv");
  },
  30_000,
);

it(
  "is ready on a machine that has what it needs",
  async () => {
    const floor = await probeKernelFloor({
      dataDir: stateDir(),
      path: pathRunning({ uv: 'echo "uv 0.9.0"', micromamba: 'echo "micromamba 1.5.0"' }),
    });
    expect(floor.ready).toBe(true);
    expect(floor.reason).toBeUndefined();
    expect(floor.rReady).toBe(true);
    expect(floor.rReason).toBeUndefined();
  },
  30_000,
);

it(
  "does not ask about R",
  async () => {
    // Phase 2 settled that a missing language is a per-language fact: a
    // machine without R publishes no R tool, offers no R chip, and hosts
    // Python perfectly well. Folding R into the floor would undo that —
    // proven here by a PATH that gives this machine a working `uv` and an
    // `R` that fails outright: the floor stays ready either way, because it
    // never looks for anything under that name.
    const floor = await probeKernelFloor({
      dataDir: stateDir(),
      path: pathRunning({ uv: 'echo "uv 0.9.0"', micromamba: 'echo "micromamba 1.5.0"', R: "exit 1" }),
    });
    expect(floor.ready).toBe(true);
  },
  30_000,
);

it("names the missing kernel host when this installation does not ship one, without ever asking about uv", async () => {
  // `projectDir` stands in for `kernelHostDir()`'s real answer so this can
  // point at a directory that genuinely does not exist, rather than
  // deleting or renaming the `packages/kernel-host` this repository actually
  // ships beside every daemon. `uv` is real and working here on purpose: if
  // the missing-project check were ever skipped, this would report ready
  // rather than naming what is missing.
  //
  const floor = await probeKernelFloor({
    dataDir: stateDir(),
    projectDir: join(tmpdir(), `lykeion-no-kernel-host-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    path: pathRunning({ uv: 'echo "uv 0.9.0"', micromamba: 'echo "micromamba 1.5.0"' }),
  });
  expect(floor.ready).toBe(false);
  expect(floor.reason).toBe("this installation is missing its kernel host");
  // "without ever asking about uv" is half of what this test is named for,
  // and nothing recorded it: the two assertions above are equally true of an
  // implementation that spawns `uv`, waits out its own confined-run budget,
  // and only then notices the missing directory — a daemon paying for a
  // subprocess on every probe cycle to learn something an `existsSync`
  // already told it.
  expect(runConfined).not.toHaveBeenCalled();
});

it(
  "holds no R environments when micromamba is missing, but still hosts Python",
  async () => {
    const floor = await probeKernelFloor({
      path: pathRunning({ uv: 'echo "uv 0.9.0"' }),
      dataDir: stateDir(),
    });
    // Python kernels work without micromamba, so `ready` is true.
    expect(floor.ready).toBe(true);
    expect(floor.reason).toBeUndefined();
    // R environments need micromamba, so `rReady` is false.
    expect(floor.rReady).toBe(false);
    expect(floor.rReason).toContain("micromamba");
    expect(floor.rReason).toContain("brew install micromamba");
  },
  30_000,
);
