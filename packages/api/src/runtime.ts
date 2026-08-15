import type { AgentCli } from "./agent-cli";

/** What a paired machine can do. Empty until a daemon says otherwise. */
export type RuntimeCapability = "sessions" | "kernels";

/** A machine a researcher has paired with this lab. */
export interface Runtime {
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
  capabilities: RuntimeCapability[];
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

/**
 * Provisioning state of one of Lykeion's own managed kernel environments:
 * - `absent`  — never provisioned; the honest first-install default.
 * - `ready`   — interpreter + valid completion marker present.
 * - `broken`  — a partial/interrupted provision; the remedy is to re-provision.
 */
export type KernelEnvState = "absent" | "ready" | "broken";

/**
 * A snapshot of one managed kernel environment, surfaced on the Runtimes
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
  manager: "uv" | "conda";
  /** Resolved interpreter version (e.g. "3.12.7") when `ready`. */
  version?: string;
  /** "{os}-{arch}", e.g. "macos-aarch64". */
  platform: string;
  /** Installed package count at provision time. */
  packageCount?: number;
  /** Display path of the env root. */
  root: string;
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
 */
export interface KernelIdentity {
  sessionId: string;
  taskId: string;
  name: string;
  language: Language;
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
  runtimeId: string;
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
  /** The named environment this kernel runs in. */
  environment: string;
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
 * One entry per runtime, never one for the lab: a figure summed across
 * several researchers' laptops would describe nowhere. Every field but the
 * id is optional, and an offline machine carries none of them — a machine
 * that answered "no kernels" and a machine nobody could reach must not
 * render alike.
 */
export interface MachineCompute {
  runtimeId: string;
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
