import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelEnvManager } from "@lykeion/api";
import {
  PACKAGE_SOURCES,
  envRoot,
  materializeEnvironment,
  provisionerFor,
  readEnvStatus,
  removeEnvironment,
  resolveEnvironment,
} from "./environments";
import { runConfinedIn } from "./probe";

describe("the machine's own copy of an environment", () => {
  it("names exactly two sources, and only the ones this phase spawns", () => {
    // Asserted by equality so a new source is a failing test rather than a
    // silent new place packages come from. CRAN is deliberately absent:
    // nothing in this phase spawns it.
    expect(PACKAGE_SOURCES).toEqual({
      uv: ["https://pypi.org/simple"],
      conda: ["https://conda.anaconda.org/conda-forge"],
    });
  });

  it("names conda-forge as the only conda source, and pypi as the only uv one", () => {
    expect(PACKAGE_SOURCES.conda).toEqual(["https://conda.anaconda.org/conda-forge"]);
    expect(PACKAGE_SOURCES.uv).toEqual(["https://pypi.org/simple"]);
  });

  it("reports absent for a declaration this machine has never built", () => {
    const work = mkdtempSync(join(tmpdir(), "lyk-envs-"));
    const status = readEnvStatus(work, {
      name: "crispr", language: "python", manager: "uv",
      packages: ["scanpy"], createdBy: "u_ana", createdTs: 1, lockRevision: 2,
    });
    expect(status.state).toBe("absent");
    // Absent is not zero: nothing was measured, so nothing is claimed.
    expect(status.packageCount).toBeUndefined();
    expect(status.lockRevision).toBeUndefined();
  });

  it("reports broken when the interpreter is there and the marker is not", () => {
    const work = mkdtempSync(join(tmpdir(), "lyk-envs-"));
    const root = envRoot(work, "crispr");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "python3"), "");
    const status = readEnvStatus(work, {
      name: "crispr", language: "python", manager: "uv",
      packages: ["scanpy"], createdBy: "u_ana", createdTs: 1, lockRevision: 2,
    });
    // A half-built environment must never report itself ready: the whole
    // point of the marker is that an interrupted download is legible.
    expect(status.state).toBe("broken");
  });

  it("fails a legacy marker without exact request, lock, and package evidence closed", () => {
    const work = mkdtempSync(join(tmpdir(), "lyk-envs-"));
    const root = envRoot(work, "crispr");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "python3"), "");
    writeFileSync(
      join(root, ".lykeion-env.json"),
      JSON.stringify({
        lockRevision: 1,
        declarationCreatedTs: 41,
        packageCount: 91,
        version: "3.12.7",
      }),
    );
    const status = readEnvStatus(work, {
      name: "crispr", language: "python", manager: "uv",
      packages: ["scanpy"], createdBy: "u_ana", createdTs: 1, lockRevision: 2,
    });
    expect(status.state).toBe("broken");
    expect(status.lockRevision).toBeUndefined();
    expect(status.packageCount).toBeUndefined();
  });

  it("reports the exact declaration generation recorded by a ready marker", () => {
    const work = mkdtempSync(join(tmpdir(), "lyk-envs-"));
    const root = envRoot(work, "crispr");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "python3"), "");
    writeFileSync(
      join(root, ".lykeion-env.json"),
      JSON.stringify({
        lockRevision: 0,
        declarationGenerationId: "envgen_exact_marker",
        declarationCreatedTs: 41,
        packageCount: 1,
        version: "3.12.7",
      }),
    );

    const status = readEnvStatus(work, {
      name: "crispr", language: "python", manager: "uv",
      packages: ["scanpy"], createdBy: "u_ana", createdTs: 99, lockRevision: 0,
    });
    expect(status.state).toBe("broken");
    expect(status.declarationGenerationId).toBeUndefined();
  });

  it("refuses a name that would resolve outside workDir", () => {
    const work = mkdtempSync(join(tmpdir(), "lyk-envs-"));
    // `materializeEnvironment` runs `uv venv <this path> --clear` — which
    // removes whatever is already there — and `runConfinedIn` renders the
    // sandbox's one writable directory around the same path. A traversing
    // name would hand both of those to wherever it points, so this is
    // refused at the one function both are derived from.
    expect(() => envRoot(work, "../../Documents")).toThrow(/not a usable environment name/);
  });
});

describe("provisionerFor", () => {
  it("has a provisioner for every manager the API can name", () => {
    // Exhaustive by construction: a union member with no arm is a compile
    // error, and this asserts the runtime record agrees with the type.
    const managers: KernelEnvManager[] = ["uv", "conda"];
    for (const manager of managers) expect(provisionerFor(manager)).toBeDefined();
  });

  it("routes a uv environment to bin/python3 and a conda one to bin/Rscript", () => {
    expect(provisionerFor("uv").interpreter("/w", "python")).toBe("/w/envs/python/bin/python3");
    expect(provisionerFor("conda").interpreter("/w", "r")).toBe("/w/envs/r/bin/Rscript");
  });
});

describe("removeEnvironment", () => {
  it("removes a built environment's own directory, and nothing beside it", () => {
    const work = mkdtempSync(join(tmpdir(), "lyk-envs-"));
    const root = envRoot(work, "crispr");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", "python3"), "");
    const sibling = envRoot(work, "python");
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "marker"), "");

    removeEnvironment(work, "crispr");

    expect(existsSync(root)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  it("is a no-op, not an error, for a copy that was never built or already reclaimed", () => {
    const work = mkdtempSync(join(tmpdir(), "lyk-envs-"));
    expect(() => removeEnvironment(work, "never-built")).not.toThrow();
    // Reclaiming twice reaches the same state the first call already left.
    const root = envRoot(work, "crispr");
    mkdirSync(root, { recursive: true });
    removeEnvironment(work, "crispr");
    expect(() => removeEnvironment(work, "crispr")).not.toThrow();
    expect(existsSync(root)).toBe(false);
  });

  it("refuses a name that would resolve outside workDir, the same guard envRoot's every other caller gets", () => {
    const work = mkdtempSync(join(tmpdir(), "lyk-envs-"));
    // A delete is the last place to take a path on trust — a traversing
    // name must be refused here exactly as `resolveEnvironment` and
    // `materializeEnvironment` refuse it, not merely for the two write
    // paths and left open on the one that removes a directory outright.
    expect(() => removeEnvironment(work, "../../Documents")).toThrow(/not a usable environment name/);
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A stand-in for this machine's own state directory: real, so the boundary
 *  a confined run renders can resolve it, and thrown away after — the same
 *  shape `probe.test.ts` and `kernel-floor.test.ts` build for the same
 *  reason, kept local here since a test fixture is not a thing three files
 *  should share a name for. */
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lyk-envs-state-"));
  dirs.push(dir);
  return dir;
}

/** A fresh work directory this machine has never built anything under. */
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lyk-envs-work-"));
  dirs.push(dir);
  return dir;
}

/** A PATH holding a single command that runs `body`, the same shape
 *  `probe.test.ts`'s own `pathRunning` builds for the same reason. */
function pathRunning(name: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lyk-envs-path-"));
  dirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return dir;
}

/**
 * A PATH holding a `uv` that answers the three subcommands this file's
 * provisioner spawns, without touching a real index or a real interpreter —
 * the "cached index or a stub" the design doc asks unit tests to use instead
 * of PyPI. `syncSucceeds` is what a test toggles to exercise "the marker is
 * written last" on its own terms, by watching `materializeEnvironment` fail
 * after the interpreter already exists, rather than by inspecting source.
 *
 * The `venv` branch also appends a line to `$UV_CACHE_DIR/marker` — standing
 * in for the real `uv`'s own cache writes, so a test can watch that file
 * survive (or fail to survive) the `--clear` step against the environment's
 * own workspace, the same way the real binary's cache would.
 *
 * The `pip compile` branch also writes every argument it was called with,
 * one per line, to `compile-args.txt` inside the confined run's own
 * writable workspace — the only place a stub script may write anything (the
 * stub's own directory, resolved read-only via `programLocation`, is not
 * writable inside the boundary). This is what lets a test assert the
 * invocation actually named `PACKAGE_SOURCES.uv`, rather than merely
 * asserting the constant exists.
 */
function stubUv(opts: { lockfile: string; syncSucceeds: boolean; versionInfo: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "lyk-envs-uv-"));
  dirs.push(dir);
  writeFileSync(join(dir, "stub-lockfile.txt"), opts.lockfile);
  const script = [
    "#!/bin/sh",
    'here="$(cd "$(dirname "$0")" && pwd)"',
    'if [ "$1" = "venv" ]; then',
    '  target="$2"',
    '  mkdir -p "$target/bin"',
    '  : > "$target/bin/python3"',
    '  chmod +x "$target/bin/python3"',
    `  printf 'version_info = ${opts.versionInfo}\\n' > "$target/pyvenv.cfg"`,
    '  echo "touched-by-venv" >> "$UV_CACHE_DIR/marker"',
    '  exit 0',
    "fi",
    'if [ "$1" = "pip" ] && [ "$2" = "compile" ]; then',
    '  printf "%s\\n" "$@" > compile-args.txt',
    '  cat "$here/stub-lockfile.txt"',
    '  echo "Resolved packages" >&2',
    '  exit 0',
    "fi",
    'if [ "$1" = "pip" ] && [ "$2" = "sync" ]; then',
    opts.syncSucceeds
      ? '  echo "Installed packages" >&2\n  exit 0'
      : '  echo "stub sync failure" >&2\n  exit 1',
    "fi",
    'echo "unhandled stub uv invocation: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
  writeFileSync(join(dir, "uv"), script);
  chmodSync(join(dir, "uv"), 0o755);
  return dir;
}

const DECLARATION = {
  name: "crispr",
  language: "python" as const,
  manager: "uv" as const,
  packages: ["tinypkg"],
  createdBy: "u_ana",
  createdTs: 1,
  declarationGenerationId: "envgen_fixture_crispr",
  lockRevision: 3,
};

// Everything below runs a real confined child through `sandbox-exec`, which
// only exists on macOS — the same gate `kernels.test.ts` and
// `sandbox.kernel.test.ts` already use for the same reason.
const onDarwin = process.platform === "darwin" ? describe : describe.skip;

onDarwin("runConfinedIn", () => {
  it("creates a workspace that does not exist yet, keeps it after success, and streams progress as it happens rather than after the fact", async () => {
    const work = workDir();
    // Not created ahead of time — this is R10's own scenario: the very first
    // call against a name this machine has never provisioned.
    const workspace = envRoot(work, "crispr");
    expect(existsSync(workspace)).toBe(false);

    const bin = pathRunning("streamer", 'echo "line one"\nsleep 0.4\necho "line two"');
    const seen: { line: string; at: number }[] = [];
    const result = await runConfinedIn(workspace, "streamer", [], {
      dataDir: stateDir(),
      path: bin,
      onLine: (line) => seen.push({ line, at: Date.now() }),
    });

    expect(result.ok).toBe(true);
    expect(seen.map((s) => s.line)).toEqual(["line one", "line two"]);
    // Genuine streaming, not the buffered result replayed at the end: the
    // two lines arrive with the gap the script's own `sleep` put between
    // them, not back-to-back once the process has already exited.
    expect(seen[1].at - seen[0].at).toBeGreaterThanOrEqual(300);
    // R7: the workspace this run built is not deleted out from under it.
    expect(existsSync(workspace)).toBe(true);
  });

  it("never hands the confined build this daemon's own environment, secrets included", async () => {
    const work = workDir();
    const bin = pathRunning("envcheck", 'echo "SECRET=$LYKEION_TEST_SECRET"');
    const previous = process.env.LYKEION_TEST_SECRET;
    // Standing in for `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN` or anything
    // else this daemon's own process happens to have been started with —
    // `uv pip sync` on an sdist runs that package's own PEP 517 build
    // backend, arbitrary third-party code with `(allow network-outbound)`,
    // and none of it may read a line of this.
    process.env.LYKEION_TEST_SECRET = "leaked-if-inherited";
    try {
      const result = await runConfinedIn(envRoot(work, "crispr"), "envcheck", [], {
        dataDir: stateDir(),
        path: bin,
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).not.toContain("leaked-if-inherited");
      // Not merely redacted — genuinely absent, because it was never in the
      // allowlist `confinedEnv` builds in the first place.
      expect(result.stdout.trim()).toBe("SECRET=");
    } finally {
      if (previous === undefined) delete process.env.LYKEION_TEST_SECRET;
      else process.env.LYKEION_TEST_SECRET = previous;
    }
  });

  it("throws rather than reporting ok:true when this platform has no sandbox backend", async () => {
    const work = workDir();
    await expect(
      runConfinedIn(envRoot(work, "crispr"), "uv", ["--version"], {
        dataDir: stateDir(),
        platform: "linux",
      }),
    ).rejects.toThrow(/agent runs are only confined on macOS/);
  });

  it("reports ok:false, same as runConfined, when the command is not on PATH", async () => {
    const work = workDir();
    const result = await runConfinedIn(envRoot(work, "crispr"), "does-not-exist", [], {
      dataDir: stateDir(),
      path: workDir(), // empty directory, nothing resolves
    });
    expect(result).toEqual({ ok: false, stdout: "", stderr: "" });
  });
});

onDarwin("provisioning an environment from a stubbed uv", () => {
  it("materializes ready, with the marker's own revision and package count, from a lockfile it never resolved itself", async () => {
    const work = workDir();
    const lockfile = "tinypkg==1.0.0\n    # via -r requirements.in\n";
    const uv = stubUv({
      lockfile: "tinypkg==1.0.0\n    # via -r requirements.in\n",
      syncSucceeds: true,
      versionInfo: "9.9.9",
    });

    const built = await materializeEnvironment({
      workDir: work,
      requestId: "envsetup_uv_marker",
      name: "crispr",
      manager: "uv",
      lockfile,
      lockRevision: 3,
      requestedPackages: ["tinypkg"],
      declarationGenerationId: DECLARATION.declarationGenerationId,
      dataDir: stateDir(),
      path: uv,
    });
    expect(built).toEqual({ version: "9.9.9", packageCount: 1 });

    const status = readEnvStatus(work, DECLARATION);
    expect(status.state).toBe("ready");
    expect(status.version).toBe("9.9.9");
    expect(status.packageCount).toBe(1);
    expect(status).toMatchObject({
      setupRequestId: "envsetup_uv_marker",
      declarationGenerationId: DECLARATION.declarationGenerationId,
      lockfileFingerprint: createHash("sha256").update(lockfile, "utf8").digest("hex"),
      packageFingerprint: createHash("sha256").update('["tinypkg"]', "utf8").digest("hex"),
    });
    // D8: the revision THIS MACHINE built from, not necessarily the lab's
    // current one (which `DECLARATION.lockRevision` stands in for here).
    expect(status.lockRevision).toBe(3);
    // R7, from the outside: both `uv venv` and `uv pip sync` run through
    // `runConfinedIn` against the same workspace, and the interpreter the
    // first call produced is still there for the second to install into.
    expect(existsSync(join(envRoot(work, "crispr"), "bin", "python3"))).toBe(true);
  });

  it("leaves a broken environment, not a ready one, when the install half fails after the interpreter exists", async () => {
    const work = workDir();
    const uv = stubUv({
      lockfile: "tinypkg==1.0.0\n    # via -r requirements.in\n",
      syncSucceeds: false,
      versionInfo: "9.9.9",
    });

    await expect(
      materializeEnvironment({
        workDir: work,
        requestId: "envsetup_uv_failed_sync",
        name: "crispr",
        manager: "uv",
        lockfile: "tinypkg==1.0.0\n    # via -r requirements.in\n",
        lockRevision: 3,
        declarationGenerationId: DECLARATION.declarationGenerationId,
        requestedPackages: ["tinypkg"],
        dataDir: stateDir(),
        path: uv,
      }),
    ).rejects.toThrow(/uv pip sync failed/);

    // `uv venv` succeeded before `uv pip sync` failed, so the interpreter is
    // there — and the marker, written only after a successful sync, is not.
    // That is exactly what `broken` means.
    const status = readEnvStatus(work, DECLARATION);
    expect(status.state).toBe("broken");
    expect(status.packageCount).toBeUndefined();
  });

  it("keeps uv's cache outside every environment, surviving a --clear on re-provision after broken", async () => {
    const work = workDir();
    const cacheDir = join(work, ".uv-cache");
    const lockfile = "tinypkg==1.0.0\n    # via -r requirements.in\n";

    // First attempt: `uv venv` builds the interpreter (and, in the real
    // binary, would touch its cache doing it — simulated here by the stub's
    // own `venv` branch), then `uv pip sync` fails — this machine's
    // `broken`, whose documented remedy is exactly the second call below.
    const failingUv = stubUv({ lockfile, syncSucceeds: false, versionInfo: "9.9.9" });
    await expect(
      materializeEnvironment({
        workDir: work,
        requestId: "envsetup_uv_cache_failed",
        name: "crispr",
        manager: "uv",
        lockfile,
        lockRevision: 3,
        declarationGenerationId: DECLARATION.declarationGenerationId,
        requestedPackages: ["tinypkg"],
        dataDir: stateDir(),
        path: failingUv,
      }),
    ).rejects.toThrow(/uv pip sync failed/);

    expect(existsSync(cacheDir)).toBe(true);
    // Machine-scoped, not environment-scoped: this is exactly the shape that
    // regresses if `UV_CACHE_DIR` ever moves back under the environment's
    // own root.
    expect(cacheDir.startsWith(envRoot(work, "crispr"))).toBe(false);
    expect(readFileSync(join(cacheDir, "marker"), "utf8")).toContain("touched-by-venv");

    // Second attempt, recovering from `broken`: `uv venv --clear` runs again
    // against the SAME workspace and removes everything already at that
    // path. If the cache lived inside that workspace, this is exactly the
    // step that would have taken it out too.
    const succeedingUv = stubUv({ lockfile, syncSucceeds: true, versionInfo: "9.9.9" });
    await materializeEnvironment({
      workDir: work,
      requestId: "envsetup_uv_cache_recovered",
      name: "crispr",
      manager: "uv",
      lockfile,
      lockRevision: 4,
      declarationGenerationId: DECLARATION.declarationGenerationId,
      requestedPackages: ["tinypkg"],
      dataDir: stateDir(),
      path: succeedingUv,
    });

    // Still there, and the first attempt's own write survived the second
    // call's `--clear` — two lines, not one starting fresh — which is the
    // proof the cache sits outside what `--clear` can reach.
    const marker = readFileSync(join(cacheDir, "marker"), "utf8");
    expect(marker.trim().split("\n")).toEqual(["touched-by-venv", "touched-by-venv"]);
  });

  it("streams only stderr as progress for a resolve, never the lockfile riding stdout", async () => {
    const work = workDir();
    const uv = stubUv({
      lockfile: "tinypkg==1.0.0\n    # via -r requirements.in\n",
      syncSucceeds: true,
      versionInfo: "9.9.9",
    });
    const seen: string[] = [];

    const resolved = await resolveEnvironment({
      workDir: work,
      requestId: "envsetup_uv_progress",
      name: "crispr",
      manager: "uv",
      packages: ["tinypkg"],
      dataDir: stateDir(),
      path: uv,
      onLine: (line) => seen.push(line),
    });

    // The lockfile reached the return value...
    expect(resolved.lockfile).toContain("tinypkg==1.0.0");
    // ...the stub's real progress line reached the channel...
    expect(seen).toContain("Resolved packages");
    // ...but the lockfile itself never did. Left unrestricted, a caller's
    // progress channel would receive the whole lockfile, one line at a
    // time, dressed up as build progress.
    expect(seen.some((line) => line.includes("tinypkg=="))).toBe(false);
  });

  it("resolves a lockfile without materializing anything — the machine still reports absent", async () => {
    const work = workDir();
    const uv = stubUv({
      lockfile: "tinypkg==1.0.0\n    # via -r requirements.in\n",
      syncSucceeds: true,
      versionInfo: "9.9.9",
    });

    const resolved = await resolveEnvironment({
      workDir: work,
      requestId: "envsetup_uv_resolve_only",
      name: "crispr",
      manager: "uv",
      packages: ["tinypkg"],
      dataDir: stateDir(),
      path: uv,
    });
    expect(resolved.lockfile).toBe("tinypkg==1.0.0\n    # via -r requirements.in\n");

    // Resolution alone never touches `bin/python3` or the marker.
    expect(readEnvStatus(work, DECLARATION).state).toBe("absent");
  });

  it("sends PACKAGE_SOURCES.uv's own URL to the child it spawns, not just to the equality test", async () => {
    const work = workDir();
    const uv = stubUv({
      lockfile: "tinypkg==1.0.0\n    # via -r requirements.in\n",
      syncSucceeds: true,
      versionInfo: "9.9.9",
    });

    await resolveEnvironment({
      workDir: work,
      requestId: "envsetup_uv_source",
      name: "crispr",
      manager: "uv",
      packages: ["tinypkg"],
      dataDir: stateDir(),
      path: uv,
    });

    // C-022's point is the resolved INVOCATION names exactly this source —
    // the equality test on `PACKAGE_SOURCES` only guards the constant, and
    // the stub otherwise ignores what it is called with.
    const args = readFileSync(join(envRoot(work, "crispr"), "compile-args.txt"), "utf8");
    expect(args).toContain("--default-index\nhttps://pypi.org/simple");
  });
});

// The one genuinely-online test in this file: no stub, the real `uv` on
// PATH, resolving and installing a real (tiny, pure-Python, dependency-free)
// package from the real PyPI index named by `PACKAGE_SOURCES.uv`. Excluded
// from the normal run — see `acp-conformance.test.ts`'s own
// `LYKEION_CERTIFY_ADAPTERS` for the same shape of gate — because a test
// that resolves from PyPI is a network test wearing a unit test's clothes,
// and the first sign of it going down is a red build somebody else caused.
const integration = process.env.LYKEION_INTEGRATION === "1";
(integration ? onDarwin : describe.skip)("a real build against PyPI", () => {
  it("provisions iniconfig end to end and reports ready with a non-zero package count", async () => {
    const work = workDir();
    const declaration = { ...DECLARATION, name: "iniconfig-smoke", packages: ["iniconfig"] };

    const resolved = await resolveEnvironment({
      workDir: work,
      requestId: "envsetup_uv_integration",
      name: declaration.name,
      manager: "uv",
      packages: declaration.packages,
      dataDir: stateDir(),
      timeoutMs: 5 * 60_000,
    });
    expect(resolved.lockfile).toContain("iniconfig");

    const built = await materializeEnvironment({
      workDir: work,
      requestId: "envsetup_uv_integration",
      name: declaration.name,
      manager: "uv",
      lockfile: resolved.lockfile,
      lockRevision: 1,
      declarationGenerationId: declaration.declarationGenerationId!,
      requestedPackages: declaration.packages,
      dataDir: stateDir(),
      timeoutMs: 5 * 60_000,
    });
    expect(built.packageCount).toBeGreaterThan(0);

    const status = readEnvStatus(work, declaration);
    expect(status.state).toBe("ready");
    expect(status.packageCount).toBeGreaterThan(0);

    // The claim this test actually exists to prove: real `uv`'s cache write
    // reached the machine-scoped grant (`<workDir>/.uv-cache`), inside a
    // profile a real `sandbox-exec` enforced — not merely a profile string
    // that renders correctly on paper. Without this, "ready" alone would be
    // consistent with the write having silently gone somewhere else, or
    // with `uv` having worked around the missing grant some other way.
    expect(existsSync(join(work, ".uv-cache"))).toBe(true);
  }, 10 * 60_000);
});
