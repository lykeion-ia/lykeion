import { existsSync } from "node:fs";
import { join } from "node:path";
import { runConfined } from "./probe";

/**
 * Whether this machine can host a kernel at all, and what is missing when it
 * cannot.
 *
 * Deliberately thin. It asks whether *a* kernel can be started, not whether a
 * particular language can: phase 2 settled that a missing language is a
 * per-language fact — a machine without R publishes no R tool, offers no R
 * chip, and hosts Python perfectly well. Folding R in here would undo that.
 */
export interface KernelFloor {
  ready: boolean;
  /** Written for a person, the way `rememberHeldBack` writes one: this is
   *  the sentence a researcher reads on the Machines screen. */
  reason?: string;
  /** Whether this machine can build R environments (requires micromamba).
   *  Separate from `ready` because a machine may host Python kernels without
   *  R capability — phase 2's own principle. The R field is deliberately
   *  ahead of its consumer: a later task routes this to the UI. */
  rReady: boolean;
  /** Why R environments are unavailable, if `rReady` is false. Written for a
   *  person, the same way `reason` is. */
  rReason?: string;
}

/** Where this machine's own `packages/kernel-host` sits, built from this
 *  file's own location so it holds whether this module runs from source or
 *  from the bundle `build` produces — both of which sit two directories
 *  below `packages`.
 *
 *  The one place this path is computed. `kernelHostLaunch()` in `main.ts`
 *  resolves the SAME directory to actually run the kernel host — it imports
 *  this rather than repeating the `join()` expression, because two of them
 *  could drift, and this floor would then vouch for a directory the launch
 *  does not use. */
export function kernelHostDir(): string {
  return join(import.meta.dirname, "..", "..", "kernel-host");
}

/** What `probeKernelFloor` needs to run its one confined check — the same
 *  shape `probe.ts`'s own `ProbeOptions` takes, since this is asked from the
 *  same probe cycle, on the same clock, against the same PATH. */
export interface KernelFloorOptions {
  /** Where this machine keeps its own state. Required for the reason every
   *  confined run needs it: the boundary denies this machine's own token,
   *  and it can only do that if it is told where that is. */
  dataDir: string;
  /** PATH to search for `uv`. Defaults to the process's own. */
  path?: string;
  /** The platform whose sandbox backend would confine this check. Defaults
   *  to this machine's own. */
  platform?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Where this machine's kernel-host package is expected to sit. Defaults
   *  to `kernelHostDir()` — the real directory `kernelHostLaunch()` in
   *  `main.ts` launches against. Injectable for the same reason `path` is:
   *  a test proving the "this installation is missing its kernel host"
   *  branch must not depend on deleting or renaming the real
   *  `packages/kernel-host` this repository ships beside every daemon. */
  projectDir?: string;
}

export async function probeKernelFloor(opts: KernelFloorOptions): Promise<KernelFloor> {
  // Three things must be true for a machine to host kernels, each with its own
  // sentence: the kernel host package shipped by this daemon, the `uv` tool
  // that starts kernels, and (separately, since it is language-specific)
  // `micromamba` to build R environments. A machine lacking micromamba still
  // hosts Python; one lacking uv or the kernel host hosts nothing.
  //
  // All reason strings are daemon-authored free text that the lab shows to
  // every member who can see this machine — not merely its owner (see
  // `machines.ts`'s `kernelsReason` and `rEnvironmentsReason`). The vocabulary
  // has to stay closed and path-free: never something like "uv not found in
  // /Users/ana/…", which would leak a colleague's own filesystem to the rest
  // of the lab. All reasons below honour that.
  const project = opts.projectDir ?? kernelHostDir();
  if (!existsSync(project))
    return {
      ready: false,
      reason: "this installation is missing its kernel host",
      rReady: false,
      rReason: "this installation is missing its kernel host",
    };

  // Spawned through `probe.ts`'s own confined spawner — DO NOT write a
  // second one. The one there was taught at 159d0f2 to pass the `cwd` its
  // boundary was rendered for, and a fresh spawner here would reproduce
  // exactly the bug that fixed.
  const found = await runConfined("uv", ["--version"], opts);
  if (!found.ok)
    return {
      ready: false,
      reason: "uv is not installed, and Lykeion starts kernels with it",
      rReady: false,
      rReason: "uv is not installed, and Lykeion builds R environments with it",
    };

  // Micromamba is only needed for R environments, not for Python kernels. A
  // machine with `uv` but no `micromamba` is still ready to host Python but
  // cannot build R environments — a per-language fact, per phase 2.
  const mamba = await runConfined("micromamba", ["--version"], opts);
  const rReady = mamba.ok;
  const rReason = !mamba.ok
    ? "micromamba is not installed, and Lykeion builds R environments with it — install it with `brew install micromamba`"
    : undefined;

  return { ready: true, rReady, rReason };
}

/**
 * Which process-visibility rule this machine applies, as one sentence.
 *
 * Sourced from the machine rather than inferred in the browser from
 * `Machine.platform`: a Linux box with `hidepid=2` and one without report the
 * same platform string and owe a researcher different answers. This is what
 * separates the two readings of an em dash — nothing measured yet, versus
 * this platform will not say.
 */
export function processVisibility(): string {
  if (process.platform === "darwin")
    return "macOS reports memory and processor use for a process Lykeion started itself.";
  if (process.platform === "linux")
    return "Linux reports these through /proc; a machine mounted with hidepid may withhold them.";
  return "This platform has not been checked for process visibility.";
}
