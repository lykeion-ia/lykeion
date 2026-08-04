import type { AgentCli } from "./agent-cli";

/** What a paired machine can do. Empty until a daemon says otherwise. */
export type RuntimeCapability = "sessions";

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
  /** Absent on a machine that is not yours. An empty array would be
   *  indistinguishable from a machine with nothing installed, and what a
   *  colleague has on their PATH is their business. */
  clis?: AgentCli[];
}

/** A kernel language. */
export type Language = "python" | "r";

/**
 * Provisioning state of Lykeion's own managed Python environment (the kernel
 * env):
 * - `absent`  — never provisioned; the honest first-install default.
 * - `ready`   — interpreter + valid completion marker present.
 * - `broken`  — a partial/interrupted provision; the remedy is to re-provision.
 */
export type KernelEnvState = "absent" | "ready" | "broken";

/**
 * A snapshot of the managed Python environment, surfaced on the Runtimes
 * screen. Cheap to compute (a couple of `stat`s) — safe to poll on render.
 * camelCase on the wire.
 */
export interface KernelEnvStatus {
  state: KernelEnvState;
  /** The env's name (its directory under runtime/envs), e.g. "python". */
  name: string;
  /** Which provisioner built it. */
  manager: "uv" | "conda";
  /** Resolved interpreter version (e.g. "3.12.7") when `ready`. */
  python?: string;
  /** "{os}-{arch}", e.g. "macos-aarch64". */
  platform: string;
  /** Installed package count from `uv pip freeze` at provision time. */
  packageCount?: number;
  /** Display path of the env root. */
  root: string;
}

/**
 * Coarse liveness of the Study's shared Python kernel — what the Notebook
 * strip renders as its status dot.
 */
export type KernelState = "starting" | "idle" | "busy" | "dead";

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

/**
 * One executed notebook cell — the agent's `run_python` or the researcher's
 * REPL, both onto the one shared namespace.
 */
export interface NotebookCell {
  /** The kernel's execution counter at completion (0 if it reported none). */
  executionCount: number;
  /** The cell source, verbatim. */
  source: string;
  /** Who ran the cell — the same vocabulary `RunRecord.surface` uses. */
  surface: "agent" | "notebook";
  /** Which language's kernel ran the cell. */
  language: Language;
  /** Whether the cell completed without raising. */
  ok: boolean;
  /** Wall time in milliseconds. */
  wallMs: number;
  /** Epoch seconds when recorded. */
  ts: number;
  /** The cell's output messages, in arrival order. */
  outputs: KernelMessage[];
}

/**
 * The Notebook strip's view of the Study kernel. `envReady`/`launched` decide
 * Setup vs. idle vs. the live `state`.
 */
export interface NotebookStatus {
  /** Is the managed Python env provisioned? `false` → the panel shows Setup. */
  envReady: boolean;
  /** Has a kernel process been launched for this Study yet? */
  launched: boolean;
  /** The live kernel state (meaningful only when `launched`; `idle` before). */
  state: KernelState;
  /** The last completed cell's execution counter (0 before any cell). */
  executionCount: number;
}
