import type { AgentCli } from "./agent-cli";

/** What a paired machine can do. Empty until a daemon says otherwise. */
export type MachineCapability = "sessions" | "kernels";

/** A machine a researcher has paired with this lab. */
export interface Machine {
  id: string;
  /** Chosen when the machine was paired. Not unique: a member may
   *  reasonably have two machines called "laptop". */
  name: string;
  /** The member it belongs to, and the only member who may run on it. */
  ownerId: string;
  /** "{os}-{arch}", e.g. "macos-aarch64". */
  platform: string;
  daemonVersion: string;
  /** Derived from `lastSeenTs` on every read, never stored: a daemon that
   *  is killed must not be able to leave "online" behind it. */
  health: "online" | "unstable" | "offline";
  lastSeenTs: number;
  capabilities: MachineCapability[];
  /** Why `capabilities` carries no `"kernels"`, on a machine where it does
   *  not. Absent both on a machine that CAN host kernels and on one whose
   *  daemon has never checked — the same "absent is not zero" rule
   *  `AgentCli.heldBackReason` follows: silence is not a claim that the
   *  floor was measured and failed. */
  kernelsReason?: string;
  /** Which process-visibility rule this machine's own platform applies —
   *  what tells a researcher whether an em dash in a memory or processor
   *  column means "not measured yet" or "this platform will not say".
   *  Sourced from the machine that reported it, never inferred here from
   *  `platform`: two machines can report the same platform string and owe a
   *  researcher different answers. Absent on a daemon that predates this
   *  report. */
  processVisibility?: string;
  /** Absent on a machine that is not yours. An empty array would be
   *  indistinguishable from a machine with nothing installed, and what a
   *  colleague has on their PATH is their business. */
  clis?: AgentCli[];
}

/** A kernel language. */
export type Language = "python" | "r";

/** Which provisioner builds an environment. Named rather than repeated as an
 *  inline union, because `provisionerFor`'s record is keyed by it and an
 *  exhaustive switch over a type written in three places is three places to
 *  forget. */
export type KernelEnvManager = "uv" | "conda";

/**
 * Provisioning state of one of Lykeion's own managed kernel environments:
 * - `absent`  — never provisioned; the honest first-install default.
 * - `ready`   — interpreter + valid completion marker present.
 * - `broken`  — a partial/interrupted provision; the remedy is to re-provision.
 */
export type KernelEnvState = "absent" | "ready" | "broken";

/**
 * A snapshot of one managed kernel environment, surfaced on the Machines
 * screen. Cheap to compute (a couple of `stat`s) — safe to poll on render.
 * camelCase on the wire.
 */
export interface KernelEnvStatus {
  state: KernelEnvState;
  /** The env's name (its directory under the work directory's `envs`). */
  name: string;
  /** Which language a kernel bound to this environment runs. */
  language: Language;
  /** Which provisioner built it. */
  manager: KernelEnvManager;
  /** Resolved interpreter version (e.g. "3.12.7") when `ready`. */
  version?: string;
  /** "{os}-{arch}", e.g. "macos-aarch64". */
  platform: string;
  /** Installed package count at provision time. */
  packageCount?: number;
  /** Display path of the env root. */
  root: string;
  /** Which lockfile revision this machine's copy was built from. Absent on a
   *  copy no machine has built. Compared against the declaration's own
   *  `lockRevision` to derive "a revision behind" — which is exactly why
   *  `KernelEnvState` has no fourth value for it: an older pin is still a
   *  pin, and those kernels keep working. */
  lockRevision?: number;
}

/**
 * One environment as this lab has declared it — the name, what was asked
 * for, and the lockfile revision currently pinning it.
 *
 * Lab-wide and machine-free by construction. Whether any particular machine
 * has actually built the gigabytes is `KernelEnvStatus`, reported by that
 * machine. The lab's list is the truth about what exists; a machine's report
 * is the truth about what is built, and neither overwrites the other.
 */
export interface KernelEnvDeclaration {
  name: string;
  language: Language;
  manager: KernelEnvManager;
  /** What was asked for — `["scanpy"]` — not the ninety-package closure
   *  that satisfies it. That is the lockfile, and it is not carried here. */
  packages: string[];
  /** Who declared it. Absent means Lykeion declared it, not a person — the
   *  `python` starter seeded on a fresh lab, before any user exists to own
   *  it. Writing a member's id here for a declaration they never made would
   *  be a false statement about them on a screen every researcher reads;
   *  absent is the honest fact, the same way `stoppedBy` stays absent on a
   *  kernel nobody stopped rather than naming somebody. */
  createdBy?: string;
  createdTs: number;
  /** Rises by one on every successful resolve. `0` means nothing has been
   *  resolved yet, so no machine can build this from a lockfile. */
  lockRevision: number;
}

export interface KernelEnvCreateInput {
  name: string;
  language: Language;
  packages: string[];
}

/**
 * What a kernel is, and what makes two of them different things. A context
 * owns one kernel per language it runs code in, so a session that writes both
 * Python and R holds two — and `name` is the context axis: `"main"` for the
 * session's own, and a delegated subagent's own name once there are any.
 *
 * `taskId` is in the identity because the boundary a kernel runs inside is
 * rendered for one Task directory. A kernel whose Task were left implicit
 * would have a working directory decided by whichever Task its session
 * happened to run first.
 *
 * `environment` is in the identity for the same reason: two environments are
 * two interpreters, which are two processes, which are two namespaces. A
 * kernel whose environment were left implicit would run in whichever one its
 * session happened to configure first.
 */
export interface KernelIdentity {
  sessionId: string;
  taskId: string;
  name: string;
  language: Language;
  environment: string;
}

/**
 * Where a kernel stands.
 * - `lazy`      — it has an identity and no process. Nothing has run code yet.
 * - `starting`  — a process is coming up.
 * - `idle`      — up, holding a namespace, running nothing.
 * - `running`   — executing a cell.
 * - `stopped`   — ended on purpose: idle expiry, an environment change, the
 *                 session ending, or a researcher stopping it.
 * - `crashed`   — ended without anyone choosing to end it, which is a
 *                 different fact and never reported as the one above.
 * - `reclaimed` — ended by the machine's own memory pressure policy rather
 *                 than a researcher's choice or a crash — a third ending,
 *                 never reported as either of the other two. Only an `idle`
 *                 kernel is ever a candidate; a `running` one is never taken.
 */
export type KernelState =
  | "lazy"
  | "starting"
  | "idle"
  | "running"
  | "stopped"
  | "crashed"
  | "reclaimed";

/**
 * What a kernel is using, as the machine holding it last reported. Every
 * field is optional and an absent one means the platform could not say —
 * rendered as unavailable, never as zero. A zero is a measurement.
 */
export interface KernelResources {
  memoryBytes?: number;
  cpuPercent?: number;
  gpuPercent?: number;
  vramBytes?: number;
}

/** A kernel a machine is holding, as the lab last heard. */
export interface RunningKernel extends KernelIdentity {
  /** Minted by the machine from the identity above; every call names this. */
  id: string;
  machineId: string;
  studyId: string;
  state: KernelState;
  /** Which incarnation of the process is behind this identity. A kernel
   *  outlives its own process — a restart raises this and keeps the id. */
  incarnation: number;
  /** The process behind this incarnation. Absent before one is started. */
  processId?: number;
  /** The counter the last completed cell reported. */
  executionCount: number;
  /** Cells waiting behind the one running. */
  queueDepth: number;
  /** The title of the last cell it ran, absent before the first. */
  lastCellTitle?: string;
  startedTs?: number;
  lastActivityTs?: number;
  /** When this machine's own memory pressure policy took the kernel back.
   *  Absent on one nobody's policy reclaimed — including one a researcher
   *  stopped, which is a different fact and never reported as this one —
   *  and gone again the moment a fresh process comes up behind the same
   *  identity. */
  reclaimedTs?: number;
  /** The member who ended this kernel, for as long as it stays ended. Absent
   *  on one nobody ended — including one that crashed, which is a different
   *  fact and never reported as this one — and gone again the moment a fresh
   *  process comes up behind the same identity. */
  stoppedBy?: string;
  /** What that member said when they ended it. Absent when they said
   *  nothing, and absent once the cell that was running has been handed it:
   *  the sentence is delivered to the call it interrupted, not kept. */
  stopReason?: string;
  /** Why the process behind this kernel RIGHT NOW was started, when anything
   *  other than a cell arriving started it — an environment rebuilt
   *  underneath it, today. Unlike `stopReason`, this survives the relaunch,
   *  because that is the whole point: a kernel that was idle when its
   *  environment was rebuilt has no cell to hand a sentence to, and its
   *  namespace would otherwise go with nothing anywhere saying why. Absent on
   *  one nobody explained — a lazy relaunch, a researcher's own Restart — and
   *  gone again the moment a later relaunch puts a process behind this
   *  identity with its own answer, or none. */
  restartReason?: string;
  resources?: KernelResources;
  /** Its last several readings, oldest first — the same figures `resources`
   *  carries the newest of, kept across the ticks a screen might have missed
   *  between polls. Absent for a kernel nobody has sampled since it (or its
   *  process) started; each slot carries only the fields that tick's probe
   *  could measure, the same rule `resources` follows. */
  series?: Array<{ memoryBytes?: number; cpuPercent?: number }>;
}

/**
 * What one machine's kernels are using, against what that machine has.
 *
 * One entry per machine, never one for the lab: a figure summed across
 * several researchers' laptops would describe nowhere. Every field but the
 * id is optional, and an offline machine carries none of them — a machine
 * that answered "no kernels" and a machine nobody could reach must not
 * render alike.
 */
export interface MachineCompute {
  machineId: string;
  memoryBytes?: number;
  totalMemoryBytes?: number;
  cpuPercent?: number;
  cores?: number;
  kernelCount?: number;
  runningCount?: number;
  /** The machine's kernels summed by index, oldest first — one slot per tick
   *  the shortest-lived of them has lived through, since a longer-running
   *  kernel's earlier readings describe a moment the shorter one was not
   *  there for. Absent when none of this machine's kernels has a series of
   *  its own. */
  series?: Array<{ memoryBytes?: number; cpuPercent?: number }>;
  /** Every environment this lab has declared, as this machine holds it:
   *  `ready` with what it holds and the revision it was built from, or
   *  `absent` because those gigabytes have never been downloaded here.
   *  Absent (the field) when the machine has not reported — which is NOT the
   *  same fact as a machine holding none.
   *
   *  Unlike every other field above, this one survives the machine going
   *  offline: it is what the machine last reported holding, persisted
   *  rather than re-asked on every poll, because an environment changes on
   *  the order of minutes-to-never rather than every cell. An offline
   *  machine's kernel counts read as unknown because nothing can ask it
   *  right now; its environments read as what it last said, because that is
   *  still the truth about what is on its disk. */
  environments?: KernelEnvStatus[];
}

/**
 * One kernel output message, forwarded from the bridge verbatim (structurally
 * isomorphic to a Jupyter message). Tagged on `kind`, with snake_case fields
 * — NOT camelCase. A payload too large to inline is spilled to
 * `.lykeion/outputs/` and referenced by `data_ref`.
 */
export type KernelMessage =
  | { kind: "stream"; name: string; text: string }
  | {
      kind: "display_data";
      data: Record<string, unknown>;
      data_ref: Record<string, unknown>;
      metadata: unknown;
    }
  | {
      kind: "execute_result";
      execution_count: number;
      data: Record<string, unknown>;
      data_ref: Record<string, unknown>;
    }
  | { kind: "error"; ename: string; evalue: string; traceback: string[] };

/** Who ran a cell. The agent and the researcher share one namespace, so a
 *  cell that does not say which of them produced it is a record nobody can
 *  read back. */
export type CellSurface = "agent" | "repl";

export interface CellOrigin {
  surface: CellSurface;
  /** A member id when `surface` is `"repl"`, an agent id when it is
   *  `"agent"`. */
  by: string;
}

/** One executed cell. */
export interface NotebookCell {
  id: string;
  kernelId: string;
  /** The context that ran it, carried from the kernel's identity so a cell
   *  can be grouped without resolving its kernel. */
  name: string;
  language: Language;
  environment: string;
  /** The kernel's execution counter at completion (0 if it reported none). */
  executionCount: number;
  /** The cell source, verbatim. */
  source: string;
  origin: CellOrigin;
  /** Whether the cell completed without raising. */
  ok: boolean;
  /** Wall time in milliseconds. */
  wallMs: number;
  /** Epoch seconds when recorded. */
  ts: number;
  /** The cell's output messages, in arrival order. */
  outputs: KernelMessage[];
  /** What this cell installed into the kernel that ran it, and into nothing
   *  else — a `pip install` inside a cell lands in a per-incarnation overlay
   *  under the Task's own directory, so it is gone the moment that kernel
   *  restarts and it exists on no other machine in the lab.
   *
   *  Noticed by listing that directory before the cell and after it, never by
   *  reading the source: `!pip install`, `%pip`, `subprocess.run`,
   *  `os.system` and `python -m pip` are all the same event on disk, and the
   *  next spelling will be too. The claim is every install that lands where
   *  pip installs by DEFAULT — `uv pip install` aims at the environment
   *  instead and is refused by the boundary rather than recorded here, and an
   *  install given an explicit destination elsewhere in the Task is just a
   *  cell writing files.
   *
   *  ABSENT on a cell that installed nothing, never `[]`. A reader shows this
   *  where it is present, and an empty array on every ordinary cell would put
   *  the surface on every row of every notebook in the lab. */
  installed?: string[];
  /** The tool call this cell arrived as, joining it to the Execution Log
   *  entry carrying the same `toolUseId`. Set on an agent's cell one of two
   *  ways: the provider forwards its own id for the call in the MCP call's
   *  `_meta` and the kernel keeps it on the cell, or — when a provider
   *  forwards none — the daemon reads the session's own log and names the
   *  kernel call the cell arrived as. Absent on a cell the researcher
   *  typed, which is not a tool call, and on an agent's cell neither path
   *  could join truthfully. */
  toolUseId?: string;
}
