import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { KernelEnvDeclaration, KernelEnvManager, KernelEnvStatus } from "@lykeion/api";
import { condaProvisioner } from "./environments-conda";
import { platformTag, runConfinedIn } from "./probe";

/**
 * Where each manager is allowed to fetch from, and the only place a source
 * is named (C-022). `conda` is conda-forge alone for the same reason `uv`
 * is PyPI alone: a set a resolver is told, rather than whatever it picks
 * up. The caveat recorded against C-022 still applies to both — this bounds
 * what the resolver is TOLD, and a lockfile line naming another host is
 * still replayed as written. */
export const PACKAGE_SOURCES = {
  uv: ["https://pypi.org/simple"],
  conda: ["https://conda.anaconda.org/conda-forge"],
} as const;

/** `--default-index`/`--index` arguments for `uv`, built from
 *  `PACKAGE_SOURCES.uv` rather than a literal flag anywhere else in this
 *  file — so a second source added there is a second index here, not a
 *  silently-ignored addition. The first source is the default index; any
 *  further ones are additional indexes, the same distinction `uv` itself
 *  draws between `--default-index` and `--index`. */
function uvIndexArgs(sources: readonly string[]): string[] {
  return sources.flatMap((url, i) => (i === 0 ? ["--default-index", url] : ["--index", url]));
}

/** An id that is safe to use as one path segment — the same shape
 *  `workspace.ts`'s and `snapshot.ts`'s own `SAFE_ID` guards. Applied here
 *  because `envRoot` is the one point both consumers of a declaration's
 *  `name` are derived from: `materializeEnvironment` runs `uv venv --clear`
 *  against it, which removes whatever is already there, and `runConfinedIn`
 *  renders the sandbox policy with that same path as the run's writable
 *  workspace. A name like `../../Documents` would resolve outside `workDir`,
 *  handing both of those to wherever it points. Nothing wires an untrusted
 *  name through this yet — that is Task 4 — but this is the one function
 *  both derive from, so the guard does not get to wait for that wiring. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Where this machine keeps its own copy of an environment. Exactly the path
 *  the parent spec names and `sandbox.test.ts` already asserts boundaries
 *  over: `<workDir>/envs/<name>`. */
export function envRoot(workDir: string, name: string): string {
  if (!SAFE_ID.test(name)) throw new Error(`${name} is not a usable environment name`);
  return join(workDir, "envs", name);
}

/** The interpreter a built environment is entered through — the same path
 *  `readEnvStatus` probes to call the build `ready`, so what makes an
 *  environment look usable and what a kernel is actually launched from
 *  cannot drift apart. Two independently written copies of this join would
 *  let the probe keep reporting `ready` while a launch reached for something
 *  else, and that failure surfaces as a kernel which will not start on a
 *  machine whose own status says the environment is fine.
 *
 *  Resolved through `envRoot`, so the `SAFE_ID` guard standing between an
 *  unsafe name and every other path in this file stands in front of this one
 *  too rather than being checked a second way here. */
export function envInterpreter(workDir: string, name: string): string {
  return join(envRoot(workDir, name), "bin", "python3");
}

/** The **prefix** of the base interpreter a built environment's own
 *  `bin/python3` links out to — `uv venv` records that interpreter's `bin`
 *  directory in `pyvenv.cfg`'s `home` key, and this is the directory above
 *  it, read back off disk rather than inherited from whichever interpreter
 *  this daemon or its kernel host happens to be running under.
 *
 *  `dirname` and not `home` itself, because what a kernel has to read is not
 *  only the executable. A base is laid out `<prefix>/bin/python3.13`
 *  alongside `<prefix>/lib/python3.13/`, so the standard library is a
 *  SIBLING of `home` rather than anything beneath it. The boundary renders
 *  each of these as `(allow file-read* (subpath …))` under a `(deny
 *  default)` (`sandbox.ts`), and a granted directory's parent is not
 *  implicitly readable — so a grant on `home` alone hands the kernel its
 *  executable and refuses it `os.py`, which is a kernel that dies before its
 *  first instruction. The prefix subsumes `home` as a subpath, so this one
 *  path is both. It is the same thing the floor already reports for itself:
 *  `interpreters.py` names `sys.base_prefix`, not the directory the binary
 *  sits in.
 *
 *  Read off this venv rather than assumed, and that is the whole point.
 *  `materializeEnvironment` runs `uv venv` with no `--python`, on purpose:
 *  which Python an environment is built on is a fact about its lockfile's
 *  own `requires-python`, not about the daemon — so the base can be a
 *  different managed CPython from the one the host floor reports. A boundary
 *  written from the host's base and not this one names a directory the venv
 *  never links into, and the kernel is refused with nothing useful said
 *  about why.
 *
 *  `undefined` when there is no readable `pyvenv.cfg`, or none with a usable
 *  `home` in it — which is NOT "this venv has no base". It is this machine
 *  not being able to say what the base is, and the caller widens rather than
 *  narrows on it. */
export function envBase(workDir: string, name: string): string | undefined {
  let home: string | undefined;
  try {
    home = venvConfigValue(readVenvConfig(envRoot(workDir, name)), "home");
  } catch {
    // No `pyvenv.cfg` there at all, or unreadable. Not a venv without a
    // base — a base this machine cannot name.
    return undefined;
  }
  // `home =` with nothing after it names no directory, and a boundary
  // granting "" is a boundary granting a path nobody meant.
  if (home === undefined || home === "") return undefined;
  // Nothing relative gets to become a grant: `dirname("python")` is `.`,
  // which resolves against whatever directory this daemon happens to have
  // been started in and would open it to the run. A `home` that is not an
  // absolute path is a file this machine cannot read a base out of, which is
  // the same answer as an unreadable file above.
  if (!isAbsolute(home)) return undefined;
  // A trailing separator would make `dirname` answer the bin directory
  // itself — the exact path this exists to climb out of, arrived at through
  // a spelling difference in a file nobody here writes.
  const bin = home.replace(/\/+$/, "");
  // `home = /`: a root is nobody's base.
  return bin === "" ? undefined : dirname(bin);
}

/** The file that makes `broken` legible. Written only once `uv` has returned
 *  successfully — see `materializeEnvironment` — so an interpreter present
 *  without this file beside it is exactly what a partial or interrupted
 *  provision looks like from outside. */
const MARKER_NAME = ".lykeion-env.json";

/** What the marker records about the build that finished: which lockfile
 *  revision it was built from, how many packages that lockfile named, and
 *  which interpreter `uv venv` produced. */
export interface EnvMarker {
  lockRevision: number;
  packageCount: number;
  version: string;
}

/** The marker, if the file both exists and holds the three fields
 *  `readEnvStatus` needs — undefined otherwise, which `readEnvStatus` reads
 *  the same way as a marker that was never written at all. A half-written or
 *  corrupted marker is not a fact this machine can stand behind, so it is
 *  treated as no marker rather than trusted partially. */
function readMarker(path: string): EnvMarker | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as EnvMarker).lockRevision === "number" &&
      typeof (parsed as EnvMarker).packageCount === "number" &&
      typeof (parsed as EnvMarker).version === "string"
    )
      return parsed as EnvMarker;
  } catch {
    // Not valid JSON. Reported as no marker, below.
  }
  return undefined;
}

/**
 * Writes the completion marker, and it is written LAST by every manager for
 * the same reason: an interpreter with no marker beside it is exactly what an
 * interrupted provision looks like from outside, which is what makes `broken`
 * reachable at all.
 *
 * Exported, and one function rather than one per arm, because both managers
 * must write the file `readEnvStatus` reads. Two independent `writeFileSync`
 * calls naming the same filename is a filename that can drift in one place
 * and not the other — and the failure that produces is an environment this
 * machine built reporting itself `broken` forever, with nothing wrong on
 * disk.
 */
export function writeMarker(workspace: string, marker: EnvMarker): void {
  writeFileSync(join(workspace, MARKER_NAME), JSON.stringify(marker));
}

/**
 * What this machine currently holds of `declaration`, read from disk rather
 * than tracked anywhere — a couple of `stat`s, safe to call on every render.
 *
 * The three states, in the order they are actually checked:
 * - No `bin/python3`: `absent`. Nothing was measured, so nothing beyond the
 *   name, language, manager, platform and root is claimed — `version`,
 *   `packageCount` and `lockRevision` all stay undefined rather than reading
 *   as zero.
 * - `bin/python3` present, marker missing or unreadable: `broken`. An
 *   interpreter with no completion marker beside it is exactly what a
 *   partial or interrupted provision leaves behind.
 * - Both present: `ready`, carrying the marker's own `version`,
 *   `packageCount` and `lockRevision` — which machine's copy this is,
 *   pinned to whichever revision IT was built from rather than the lab's
 *   current one. Comparing the two is how "a revision behind" is derived;
 *   there is no fourth `KernelEnvState` for it.
 *
 * The interpreter is the manager's, through `provisionerFor` — the one
 * definition a kernel is also launched from, so `ready` cannot mean a
 * different file than the one that gets run.
 */
export function readEnvStatus(workDir: string, declaration: KernelEnvDeclaration): KernelEnvStatus {
  const root = envRoot(workDir, declaration.name);
  const base = {
    name: declaration.name,
    language: declaration.language,
    manager: declaration.manager,
    platform: platformTag(),
    root,
  };

  // The MANAGER's interpreter, not python's. `bin/python3` for a uv venv,
  // `bin/Rscript` for a conda prefix — and asking the wrong one is not a
  // near miss: an R environment probed for `bin/python3` reads `absent`
  // however completely it is built, which is the shape of a bug this branch
  // already shipped once at a different layer.
  //
  // It also carries the protection the daemon's own declaration gate used to
  // provide and no longer does. That gate refused any language this machine
  // had not discovered, which incidentally stopped an `r` row with a python
  // venv under it from being offered; the gate now asks about capability
  // instead, so THIS is what keeps a declaration to the language it claims.
  // A conda declaration with only `bin/python3` on disk is `absent`, and the
  // R driver is never handed a python interpreter.
  const interpreter = provisionerFor(declaration.manager).interpreter(workDir, declaration.name);
  if (!existsSync(interpreter)) return { ...base, state: "absent" };

  const marker = readMarker(join(root, MARKER_NAME));
  if (marker === undefined) return { ...base, state: "broken" };

  return {
    ...base,
    state: "ready",
    version: marker.version,
    packageCount: marker.packageCount,
    lockRevision: marker.lockRevision,
  };
}

/**
 * Frees this machine's own copy of `name` — the build under `envRoot`,
 * never the lab-wide declaration, which this function does not know about
 * and cannot touch. What `kernel-env-reclaim` calls: small, local and
 * reversible, since anyone can rebuild it later from the lockfile the lab
 * still holds (D2).
 *
 * Resolves the path through `envRoot`, not a raw `join`, so the same
 * `SAFE_ID` guard a build's own confinement is rendered against also stands
 * between an unsafe name and this call — a delete is the last place in this
 * file to take a path on trust. A name with nothing on disk under it is not
 * an error: reclaiming a copy that was never built, or already reclaimed,
 * is the state the caller asked for, already reached.
 */
export function removeEnvironment(workDir: string, name: string): void {
  const root = envRoot(workDir, name);
  rmSync(root, { recursive: true, force: true });
}

/** What every provisioning call needs beyond what it is specifically doing:
 *  where this machine keeps its own state, which PATH to search, which
 *  platform to render the boundary for, how long to wait, a way to cancel,
 *  and where a build's progress lines go. The same shape `runConfinedIn`
 *  itself takes, since both resolve and materialize are nothing but a
 *  `uv` invocation through it. */
interface ProvisionOptions {
  dataDir: string;
  path?: string;
  platform?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

export interface ResolveEnvironmentOptions extends ProvisionOptions {
  workDir: string;
  name: string;
  /** What was asked for — `declaration.packages`. Not the resolved closure;
   *  that is what this call produces. */
  packages: string[];
  /** Which backend resolves `name` — `provisionerFor`'s own key. A caller
   *  assembling this object is the one place that has to know which manager
   *  `name` belongs to; nothing below this point falls back to guessing. */
  manager: KernelEnvManager;
}

export interface ResolvedEnvironment {
  /** The lockfile text `uv pip compile` produced — what a lab stores beside
   *  the declaration, and what every later machine replays rather than
   *  resolving afresh (D4's whole point). */
  lockfile: string;
}

export interface MaterializeEnvironmentOptions extends ProvisionOptions {
  workDir: string;
  name: string;
  /** The lockfile text to build from — this machine's own resolve, or one
   *  replayed from the lab exactly as D4 requires, so two machines building
   *  from the same lockfile hold one environment rather than two
   *  independently-resolved ones sharing a name. */
  lockfile: string;
  /** Which revision `lockfile` is. Recorded on the completion marker, so
   *  `readEnvStatus` answers "which revision THIS MACHINE built from" rather
   *  than assuming it matches whatever the lab currently holds. */
  lockRevision: number;
  /** Which backend materializes `name` — see `ResolveEnvironmentOptions.manager`. */
  manager: KernelEnvManager;
}

export interface MaterializedEnvironment {
  version: string;
  packageCount: number;
}

/**
 * What a backend supplies to build and probe one manager's own environments.
 * Deliberately four members and no more: no `version` or `countPackages` arm,
 * because those are facts about a FINISHED build, written into the
 * completion marker by `materialize` itself — `readEnvStatus` reads that
 * marker back off disk rather than asking a provisioner to state them a
 * second time. Widening this interface to carry them would give two places
 * a build's own numbers could disagree.
 */
export interface Provisioner {
  resolve(opts: ResolveEnvironmentOptions): Promise<ResolvedEnvironment>;
  materialize(opts: MaterializeEnvironmentOptions): Promise<MaterializedEnvironment>;
  interpreter(workDir: string, name: string): string;
  base(workDir: string, name: string): string | undefined;
}

/**
 * uv's own arm of `Provisioner` — every line of `resolve` and `materialize`
 * this file had before this seam existed, moved here unchanged. `interpreter`
 * and `base` are `envInterpreter`/`envBase` themselves, not a second
 * definition of either: `runs.ts`'s own kernel launch calls those same two
 * functions directly, so a build routed through this record and a launch
 * that is not still agree on one path.
 */
const uvProvisioner: Provisioner = {
  /**
   * Turns a requested package list into a lockfile, by asking `uv` to resolve
   * it against `PACKAGE_SOURCES.uv` and nothing else. Confined the same way
   * `materialize` is (D5): the one writable directory is this environment's
   * own root, even though nothing has been built there yet — `runConfinedIn`
   * is what makes that directory exist before the boundary is rendered
   * around it.
   *
   * Resolution only, never an install: this does not touch `bin/python3` or
   * the completion marker, so calling this alone leaves `readEnvStatus`
   * reporting `absent`, exactly as it should for a machine that has resolved
   * a lockfile but not yet materialized it.
   *
   * `onLine` is wired to stderr only, never stdout: `uv pip compile` writes
   * the lockfile it resolved — the very thing this call returns — to stdout,
   * and `execConfined` otherwise feeds both streams into the same callback.
   * Left unrestricted, a caller's progress channel would receive the whole
   * lockfile, one line at a time, dressed up as build progress.
   */
  async resolve(opts: ResolveEnvironmentOptions): Promise<ResolvedEnvironment> {
    const workspace = envRoot(opts.workDir, opts.name);
    mkdirSync(workspace, { recursive: true });
    const requirementsPath = join(workspace, "requirements.in");
    writeFileSync(requirementsPath, `${opts.packages.join("\n")}\n`);

    const result = await runConfinedIn(
      workspace,
      "uv",
      ["pip", "compile", requirementsPath, ...uvIndexArgs(PACKAGE_SOURCES.uv)],
      { ...uvOpts(opts), onLineStreams: ["stderr"] },
    );
    if (!result.ok) throw new Error(`uv pip compile failed: ${(result.stderr || result.stdout).trim()}`);
    return { lockfile: result.stdout };
  },

  /**
   * Builds `<workDir>/envs/<name>` from `lockfile`: `uv venv` for the
   * interpreter, then `uv pip sync` to install exactly what the lockfile
   * pins — never a fresh resolve, which is D4's whole point. Confined per D5,
   * through the same `runConfinedIn` `resolve` uses.
   *
   * The completion marker is written LAST, and only once `uv pip sync` has
   * itself returned successfully. That ordering is what makes `broken`
   * reachable at all: a provision that dies between `uv venv` and a
   * successful `uv pip sync` leaves an interpreter with no marker beside it,
   * which `readEnvStatus` reads as `broken` rather than `ready` — recovery is
   * simply calling this again with the same lockfile.
   *
   * Returns only what changed here, not a full `KernelEnvStatus`: this
   * function does not know a declaration's `packages`, `createdBy` or
   * `createdTs`, and it should not need to — reading the whole status back is
   * `readEnvStatus`'s job, from what this call left on disk.
   */
  async materialize(opts: MaterializeEnvironmentOptions): Promise<MaterializedEnvironment> {
    const workspace = envRoot(opts.workDir, opts.name);
    const provision = uvOpts(opts);

    // No `mkdirSync` here: unlike `resolve`, nothing is written into
    // `workspace` before the first confined call, so `runConfinedIn`'s own
    // creation of it (R10) is all this needs.
    //
    // `--clear` so a re-provision over a `broken` leftover — an earlier
    // interpreter with no marker beside it — starts from nothing rather than
    // building on top of whatever an interrupted run left behind. And run
    // FIRST, before anything else is written into `workspace`: `--clear`
    // means what it says and removes everything already at the target path,
    // not merely what `uv venv` itself would have written there — including a
    // lockfile this call had already written, the one time this was tried the
    // other way round.
    const venv = await runConfinedIn(workspace, "uv", ["venv", workspace, "--clear"], provision);
    if (!venv.ok) throw new Error(`uv venv failed: ${(venv.stderr || venv.stdout).trim()}`);

    const lockPath = join(workspace, "uv.lock.txt");
    writeFileSync(lockPath, opts.lockfile);
    // The same one definition the probe and the launch both use: what this
    // installs into is the file `readEnvStatus` calls `ready` and the file a
    // kernel is started from, or the build is finished somewhere neither of
    // them looks.
    const pythonPath = envInterpreter(opts.workDir, opts.name);
    const sync = await runConfinedIn(
      workspace,
      "uv",
      ["pip", "sync", lockPath, "--python", pythonPath, ...uvIndexArgs(PACKAGE_SOURCES.uv)],
      provision,
    );
    // Nothing below this line runs when the install failed — the marker is
    // written last, and only once this has actually returned successfully.
    if (!sync.ok) throw new Error(`uv pip sync failed: ${(sync.stderr || sync.stdout).trim()}`);

    const version = readVenvVersion(workspace);
    const packageCount = countLockedPackages(opts.lockfile);
    writeMarker(workspace, { lockRevision: opts.lockRevision, packageCount, version });

    return { version, packageCount };
  },

  interpreter: envInterpreter,
  base: envBase,
};

/** Which backend builds an environment of this manager.
 *
 *  A record rather than a branch inside each function, because the risk is
 *  in the READERS: a reader that forgot conda would parse a `pyvenv.cfg`
 *  that was never written and report a built R environment as `broken` —
 *  a missing branch wearing the face of a broken build. Keyed by the API's
 *  own union, so an arm that does not exist is a compile error. */
const PROVISIONERS: Record<KernelEnvManager, Provisioner> = {
  uv: uvProvisioner,
  conda: condaProvisioner,
};

export function provisionerFor(manager: KernelEnvManager): Provisioner {
  return PROVISIONERS[manager];
}

/**
 * The one `resolve` every caller goes through — `runs.ts`'s own
 * `handleKernelEnvSetup`, or a test naming its manager directly — dispatched
 * to whichever backend `opts.manager` names. Kept as a standalone exported
 * function, rather than asking every caller to spell
 * `provisionerFor(opts.manager).resolve(opts)` itself, so `resolveEnvironment`
 * stays the one name this file has always exported for it.
 */
export function resolveEnvironment(opts: ResolveEnvironmentOptions): Promise<ResolvedEnvironment> {
  return provisionerFor(opts.manager).resolve(opts);
}

/** The `materialize` half of the same dispatch — see `resolveEnvironment`. */
export function materializeEnvironment(opts: MaterializeEnvironmentOptions): Promise<MaterializedEnvironment> {
  return provisionerFor(opts.manager).materialize(opts);
}

/** Where this machine keeps `uv`'s own HTTP and build cache for every
 *  environment it builds — `<workDir>/.uv-cache`, a sibling of `envs/`,
 *  never a path beneath any particular `envRoot`. See `uvOpts` for why it
 *  lives here rather than inside the environment being built. */
function uvCacheDir(workDir: string): string {
  return join(workDir, ".uv-cache");
}

/**
 * The subset of `ProvisionOptions` `runConfinedIn` itself takes, read off
 * whichever of the two option shapes above called this — plus the one
 * environment variable every `uv` invocation in this file needs, and the
 * grant that variable requires, since neither is part of the boundary
 * `runConfinedIn` draws on its own.
 *
 * `uv` keeps its own HTTP and build cache under `~/.cache/uv` by default,
 * and writes to it on every resolve and every install — not merely reads.
 * That path belongs to neither `policy.workspace` (this environment's own
 * root) nor anything `programLocation` grants (which is read-only, and is
 * `uv`'s own installed location, not its cache), so it sits under the same
 * `(deny default)` as everything else this boundary does not name. Verified
 * against the real binary: `uv venv` inside a profile shaped exactly like
 * `runConfinedIn` renders fails with "Operation not permitted" opening a
 * file under `~/.cache/uv/sdists-v9` — a plain `--version` check never
 * touches that path, which is why `probeKernelFloor`'s existing use of
 * `uv --version` never surfaced this.
 *
 * `UV_CACHE_DIR` points at `uvCacheDir(opts.workDir)` — a machine-wide
 * directory outside every `envRoot`, not inside the one being built — and
 * that directory is granted through `runConfinedIn`'s `writable`, which
 * `policyFor` turns into a genuine second grant rather than a wider
 * `workspace`. Nested inside `workspace` was tried first and reverted: it
 * does not survive `uv venv --clear`, which removes everything already at
 * its target path — recovering a `broken` environment by re-provisioning
 * would restart the cache from nothing on every attempt, turning a flaky
 * connection into a download that never converges — and it is never shared
 * between environments, so building `python` and then `crispr` would
 * re-download every package the two have in common. A shared, concurrently-
 * written cache is `uv`'s ordinary case on any developer machine; a poisoned
 * entry cannot change what gets installed, because the lockfile pins hashes
 * and `uv` verifies them.
 *
 * What this does not cover: a machine that has never run `uv`'s own Python
 * management before may still need to WRITE a freshly-downloaded interpreter
 * under `~/.local/share/uv/python`, which `programLocation` only grants
 * read access to. Every machine this was verified against already had a
 * managed Python cached there, so this is recorded as a known limit rather
 * than fixed blind.
 */
function uvOpts(
  opts: ProvisionOptions & { workDir: string },
): ProvisionOptions & { env: Record<string, string>; writable: string[] } {
  const cacheDir = uvCacheDir(opts.workDir);
  return {
    dataDir: opts.dataDir,
    path: opts.path,
    platform: opts.platform,
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
    onLine: opts.onLine,
    env: { UV_CACHE_DIR: cacheDir },
    writable: [cacheDir],
  };
}

/** The `pyvenv.cfg` `uv venv` leaves in a built environment, as text — the
 *  one place that filename is written, so nothing reads a venv's record of
 *  itself out of a second path. Throws where it cannot be read. */
function readVenvConfig(workspace: string): string {
  return readFileSync(join(workspace, "pyvenv.cfg"), "utf8");
}

/** One `key = value` line out of that file — the one parser for it, so
 *  `readVenvVersion` and `envBase` cannot come to disagree about its shape.
 *  `undefined` where the file carries no such key.
 *
 *  The value is the rest of the line rather than its first token: `home` is
 *  a path, and a path may have spaces in it.
 *
 *  Compared rather than matched. Building a `RegExp` around an interpolated
 *  `key` reads as a general helper and is not one: a key carrying `.`, `*`
 *  or `(` would silently match a line it does not name, or fail to match the
 *  line it does. Both call sites pass a literal today, and neither this
 *  function nor the next caller has to remember that. */
function venvConfigValue(cfg: string, key: string): string | undefined {
  for (const line of cfg.split("\n")) {
    const at = line.indexOf("=");
    if (at === -1) continue;
    // `trimEnd` and not `trim`: `key   =` is the same key, an indented line
    // is not — which is what anchoring at the start of the line said.
    if (line.slice(0, at).trimEnd() !== key) continue;
    return line.slice(at + 1).trim();
  }
  return undefined;
}

/** The interpreter version `uv venv` just built, read from the structured
 *  `pyvenv.cfg` it writes rather than parsed out of either command's own
 *  human-readable log output — which is free text this file does not
 *  control the wording of. */
function readVenvVersion(workspace: string): string {
  const cfg = readVenvConfig(workspace);
  const version = venvConfigValue(cfg, "version_info");
  if (version === undefined) throw new Error(`pyvenv.cfg has no version_info: ${cfg}`);
  return version;
}

/** How many packages a `uv`-produced lockfile actually pins: one line per
 *  top-level requirement, in the `name==version` shape `uv pip compile`
 *  writes at column zero, with `# via ...` annotation lines indented beneath
 *  each one and a header of `#`-prefixed comment lines above them both. */
function countLockedPackages(lockfile: string): number {
  const topLevel = (line: string): boolean => line.length > 0 && !line.startsWith(" ") && !line.startsWith("#");
  return lockfile.split("\n").filter(topLevel).length;
}
