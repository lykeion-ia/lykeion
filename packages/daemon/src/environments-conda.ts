import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { MaterializeEnvironmentOptions, Provisioner, ResolveEnvironmentOptions } from "./environments";
import { envRoot, PACKAGE_SOURCES, writeMarker } from "./environments";
import {
  environmentLockfileFingerprint,
  environmentPackageFingerprint,
} from "@lykeion/api/environment-setup-evidence";
import { runConfinedIn } from "./probe";

/**
 * What conda-forge calls an R library.
 *
 * A researcher asks for `ggplot2`, because that is its name. conda-forge
 * ships it as `r-ggplot2`, because that is the channel's convention for R
 * packages. The declaration stores what the researcher wrote — the parent
 * spec says of it, "This is the list everyone sees. It is text." — and the
 * translation happens here, at the one point a name is handed to a solver.
 *
 * Names already carrying the prefix are left alone: `r-base` is the
 * interpreter itself and is spelled that way by everyone, and prefixing
 * blindly would ask for `r-r-base`, which does not exist.
 *
 * Its limit, stated rather than hidden: a package whose conda-forge name is
 * not `r-<name>` still fails to resolve, by name, in the solver's own words.
 * This is a convention, not a lookup table, and it is not this function's
 * job to become one.
 */
export function condaPackageName(requested: string): string {
  return requested.startsWith("r-") ? requested : `r-${requested}`;
}

/** One package of a micromamba solve — the fields this reads, not every
 *  field it carries. */
interface CondaPackage {
  url: string;
  md5?: string;
  name?: string;
}

/** A `--dry-run --json` solve, as much of it as this file reads. */
export interface CondaSolve {
  actions?: { FETCH?: CondaPackage[]; LINK?: CondaPackage[] };
}

/**
 * The solve, as the text every later machine replays.
 *
 * Read off `LINK`, not `FETCH`, and that distinction is a bug this file
 * already shipped once. `FETCH` is what the solver would have to DOWNLOAD —
 * so a package already sitting in this machine's shared package cache from
 * an earlier resolve is absent from it while still being part of the
 * environment. Since every R environment in a lab shares `r-base`, the
 * second environment any machine resolves would have produced a lockfile
 * missing most of itself, and every other machine would have replayed that
 * incomplete text faithfully. `LINK` is the environment: what will be
 * installed, cached or not.
 *
 * `url#<md5>` with a BARE fragment is conda's `@EXPLICIT` format, and it is
 * the format because that is what the tool reads. Measured, not assumed: a
 * line written `#sha256=…` is accepted and then verified against nothing —
 * `micromamba create --safety-checks enabled` refuses it with "md5 and
 * sha256 sum unknown" even when the hash is CORRECT, because it never
 * parsed it. Written bare, the same command exits 0 on a good hash and
 * fails with "tarball has incorrect MD5" on a bad one.
 *
 * So the integrity this buys is md5, and md5 alone. That is worth stating
 * precisely, because it is easy to overclaim: it catches a corrupted
 * download and a careless substitution, and it does NOT withstand deliberate
 * collision. It is not the attested pin the spec's Known limits asks for,
 * and the "replayed unauthenticated" residual against C-020 stands for R
 * exactly as it stands for Python.
 *
 * An artifact the solve gave no md5 for is REFUSED rather than written with
 * an empty fragment. A line a machine takes on trust is worse than no
 * lockfile, because it looks like one.
 */
export function explicitLockfileFrom(solved: CondaSolve): string {
  const linked = solved.actions?.LINK ?? [];
  const lines = linked.map((pkg) => {
    if (pkg.md5 === undefined || pkg.md5 === "")
      throw new Error(
        `the solver named no md5 for ${pkg.name ?? pkg.url}, and a pin nothing can verify ` +
          "is worse than no pin — it looks like one",
      );
    return `${pkg.url}#${pkg.md5}`;
  });
  return ["@EXPLICIT", ...lines, ""].join("\n");
}

/** How many artifacts an explicit lockfile pins: one per URL line. The
 *  `@EXPLICIT` header and the trailing blank are not packages, and a comment
 *  line is not one either — conda writes those above the URLs the same way
 *  `uv pip compile` does.
 *
 *  Not the same figure as uv's `countLockedPackages`, and a reader comparing
 *  two environments' `packageCount` across managers is comparing two things.
 *  This counts the whole installed closure, every shared artifact included —
 *  `r-base` alone brings ninety-odd — where uv's counts the top-level
 *  requirements its compiled lockfile writes at column zero. Both are honest
 *  about their own format and neither converts into the other. */
export function countCondaPackages(lockfile: string): number {
  return lockfile
    .split("\n")
    .filter((line) => line.startsWith("http://") || line.startsWith("https://")).length;
}

/** `-c <channel>` arguments, built from `PACKAGE_SOURCES.conda` rather than a
 *  literal anywhere else — so a second channel added there is a second
 *  channel here, not a silently ignored addition (C-022). */
function channelArgs(sources: readonly string[]): string[] {
  return sources.flatMap((url) => ["-c", url]);
}

/** Where micromamba keeps what it writes, and it writes more than its
 *  package cache. Measured against the real binary under a read-only home:
 *  a solve fails in `create_directories` on `$HOME/.cache` during config
 *  load, and an install fails opening `$HOME/.conda/environments.txt` to
 *  register the prefix — neither of which `MAMBA_ROOT_PREFIX` or
 *  `CONDA_PKGS_DIRS` redirects. So `HOME` itself is pointed here, which
 *  moves all three at once rather than chasing each variable as it is
 *  discovered.
 *
 *  Outside every `envRoot`, for the reason uv's cache is: nested inside the
 *  environment being built it would not survive a re-provision that clears
 *  the target, and it would never be shared between two environments that
 *  hold the same package — which for R is nearly all of them. */
function cacheDir(workDir: string): string {
  return join(workDir, ".mamba-cache");
}

function condaOpts(opts: ResolveEnvironmentOptions | MaterializeEnvironmentOptions) {
  const cache = cacheDir(opts.workDir);
  return {
    dataDir: opts.dataDir,
    ...(opts.path === undefined ? {} : { path: opts.path }),
    ...(opts.platform === undefined ? {} : { platform: opts.platform }),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.onLine === undefined ? {} : { onLine: opts.onLine }),
    env: {
      HOME: cache,
      XDG_CACHE_HOME: join(cache, ".cache"),
      MAMBA_ROOT_PREFIX: cache,
      CONDA_PKGS_DIRS: join(cache, "pkgs"),
    },
    writable: [cache],
  };
}

/**
 * The conda/micromamba arm of `Provisioner`.
 *
 * `interpreter` and `base` were real from Task 2 — `readEnvStatus` probes
 * them on every render of the Machines screen, long before any R environment
 * has been built anywhere, so a stub that threw there would crash every
 * reader instead of reporting `absent`.
 */
export const condaProvisioner: Provisioner = {
  /**
   * Asks micromamba what it WOULD install, and writes that down.
   *
   * `--dry-run --json` rather than a build: resolution and installation are
   * two steps here for the same reason they are for uv (D4). The first
   * machine resolves and the lab keeps the text; every later machine replays
   * it and never solves at all.
   *
   * `onLineStreams: ["stderr"]` for uv's own reason, one layer along: the
   * solve this call returns is written to stdout, and a caller's progress
   * channel fed both streams would receive the whole JSON document, one line
   * at a time, dressed up as build progress.
   */
  async resolve(opts: ResolveEnvironmentOptions) {
    const workspace = envRoot(opts.workDir, opts.name);
    mkdirSync(workspace, { recursive: true });
    const result = await runConfinedIn(
      workspace,
      "micromamba",
      [
        "create",
        "--dry-run",
        "--json",
        "--yes",
        "-p",
        workspace,
        ...channelArgs(PACKAGE_SOURCES.conda),
        ...opts.packages.map(condaPackageName),
      ],
      { ...condaOpts(opts), onLineStreams: ["stderr"] },
    );
    if (!result.ok)
      throw new Error(`micromamba solve failed: ${(result.stderr || result.stdout).trim()}`);
    let solved: CondaSolve;
    try {
      solved = JSON.parse(result.stdout) as CondaSolve;
    } catch {
      // Said in this file's own words rather than left as a JSON parse error
      // naming a column: what went wrong is that a solver this machine ran
      // answered with something that is not a solve, and the text it did
      // answer with is the only useful thing to carry back.
      throw new Error(`micromamba answered with something that is not a solve: ${result.stdout.trim()}`);
    }
    return { lockfile: explicitLockfileFrom(solved) };
  },

  /**
   * Builds the environment from the lockfile, and never re-solves.
   *
   * `--file <explicit>` is what makes that true: micromamba fetches exactly
   * the artifacts the text names and never asks a solver anything.
   *
   * What that buys, stated precisely rather than generously. With
   * `--safety-checks enabled` each artifact is verified against the md5 in
   * its own line, so a corrupted download or a careless substitution fails
   * the build instead of landing silently. It is md5, and md5 does not
   * withstand a deliberate collision — so this is NOT the attested pin the
   * spec's Known limits asks for, and C-020's "the pin is replayed
   * unauthenticated" residual stands for R exactly as it stands for Python.
   * An earlier version of this comment claimed otherwise and was wrong.
   *
   * The marker is written LAST, through the one exported writer, and only
   * once the install has returned successfully — the ordering that makes
   * `broken` mean an interrupted provision rather than a mystery.
   */
  async materialize(opts: MaterializeEnvironmentOptions) {
    const workspace = envRoot(opts.workDir, opts.name);
    const provision = condaOpts(opts);
    // BESIDE the prefix, never inside it. Measured against micromamba 2.9.0:
    // `create -p <dir>` aborts with "Non-conda folder exists at prefix" when
    // the target holds ANY file that is not part of a conda environment, and
    // an empty directory is fine. Written into the prefix — which is where
    // this was until the first end-to-end build — the lockfile made the very
    // install it describes impossible, so no conda environment could ever be
    // materialized. Every test before that one worked from a recorded solve
    // and never ran the binary.
    //
    // The cache directory is where it goes because that is already granted
    // writable in `condaOpts` and already outside every `envRoot`. Named per
    // environment so two builds running at once do not overwrite each
    // other's, and named off `basename(workspace)` rather than off
    // `opts.name` directly so the `SAFE_ID` guard inside `envRoot` is the one
    // thing standing between a declaration's name and a path, here as
    // everywhere else in this file.
    const cache = cacheDir(opts.workDir);
    const lockPath = join(cache, `${basename(workspace)}.lock.txt`);
    mkdirSync(workspace, { recursive: true });
    mkdirSync(cache, { recursive: true });
    writeFileSync(lockPath, opts.lockfile);
    const built = await runConfinedIn(
      workspace,
      "micromamba",
      // `--safety-checks enabled` and not the default. Measured: the default is
      // `warn`, under which an artifact whose md5 does not match the lockfile
      // installs SUCCESSFULLY with a warning on stderr and exit 0 — so the
      // hashes would sit in the text meaning nothing. Under `enabled` the same
      // build exits 1 with "tarball has incorrect MD5".
      ["create", "--yes", "--safety-checks", "enabled", "-p", workspace, "--file", lockPath],
      provision,
    );
    if (!built.ok)
      throw new Error(`micromamba create failed: ${(built.stderr || built.stdout).trim()}`);

    // Read back from the environment this call just built rather than parsed
    // out of micromamba's own log text, which is free-form and not this
    // file's to depend on. `--version` is asked of the interpreter that was
    // installed, which is the same file `readEnvStatus` calls `ready` and the
    // same one a kernel is launched from.
    const asked = await runConfinedIn(
      workspace,
      condaProvisioner.interpreter(opts.workDir, opts.name),
      ["--version"],
      provision,
    );
    // Both streams, because which one carries the banner is not a thing to
    // depend on. Measured against a real conda-forge R 4.6.1: `Rscript
    // --version` writes "Rscript (R) version 4.6.1 (2026-06-24)" to STDOUT
    // and exits 0. An earlier version of this comment asserted stderr and
    // said it had measured that; it had not, and the code was right by
    // accident rather than by the reason it gave.
    const said = `${asked.stdout} ${asked.stderr}`;
    const version = /\b(\d+\.\d+\.\d+)\b/.exec(said)?.[1];
    // Thrown rather than defaulted, the way uv's `readVenvVersion` throws
    // when `pyvenv.cfg` names no `version_info`. An empty string would pass
    // `readMarker`'s `typeof version === "string"` check and mark the
    // environment `ready`, and the card would then render a blank fact
    // instead of the `—` it shows for something nobody measured. "Absent is
    // not zero" is the rule, and an unread version is absent — so this build
    // does not finish rather than finishing with a fact nobody took.
    if (!asked.ok || version === undefined)
      throw new Error(
        `built the environment but could not read its R version: ${(asked.stderr || asked.stdout).trim()}`,
      );
    const packageCount = countCondaPackages(opts.lockfile);
    writeMarker(workspace, {
      schemaVersion: 2,
      requestId: opts.requestId,
      name: opts.name,
      manager: opts.manager,
      lockRevision: opts.lockRevision,
      declarationGenerationId: opts.declarationGenerationId,
      lockfileFingerprint: environmentLockfileFingerprint(opts.lockfile),
      packageFingerprint: environmentPackageFingerprint(opts.requestedPackages),
      ...(opts.declarationCreatedTs === undefined
        ? {}
        : { declarationCreatedTs: opts.declarationCreatedTs }),
      packageCount,
      version,
    });
    return { version, packageCount };
  },

  // Resolved through `envRoot`, same as uv's own `envInterpreter` — one
  // guard against a traversing name in front of every manager's build path,
  // not a second copy of it.
  interpreter(workDir, name) {
    return join(envRoot(workDir, name), "bin", "Rscript");
  },
  // Unlike a uv venv, a conda/micromamba prefix is self-contained: nothing
  // it installs links out to a base interpreter kept elsewhere, so there is
  // no `pyvenv.cfg`-shaped fact to read back. `undefined` here is not "this
  // machine cannot say" (envBase's meaning for uv) — it is "the question
  // does not apply to this manager".
  base() {
    return undefined;
  },
};
