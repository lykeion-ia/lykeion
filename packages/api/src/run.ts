/**
 * The run loop contract. A run is an event stream — plan → approve → execute,
 * permission cards, execution-log entries — plus a decision channel back.
 * The in-memory implementation simulates a scripted run, so the Task surface
 * is fully interactive.
 */

import type { Priority, Stage, Task, TaskStatus } from "./types";

/** A plan step's live status. Drives the run strip's
 *  current step; absent/`pending` until the agent reports progress. */
export type StepStatus = "pending" | "in_progress" | "completed";

/** One step of a proposed plan. `done` stays as the coarse
 *  "finished?" (== `status === "completed"`); `status` adds the in-progress
 *  state the "Step N of M" strip needs to mark the current step. */
export interface PlanStep {
  title: string;
  done: boolean;
  status?: StepStatus;
}

/** A plan an agent proposed. */
export interface Plan {
  steps: PlanStep[];
  raw?: string;
}

/** A kind of access an agent requests. */
export type AccessKind =
  | { kind: "read-path"; target: string }
  | { kind: "write-path"; target: string }
  | { kind: "execute"; target: string }
  | { kind: "network"; target: string }
  | { kind: "connector"; target: { server: string; tool: string } }
  | { kind: "remote-job"; target: string };

/** A permission card. */
export interface PermissionRequest {
  id: string;
  access: AccessKind;
  tool: string;
  detail?: string;
}

/** Permission scope. */
export type PermissionScope = "once" | "conversation" | "study" | "global";

/** A researcher's answer to a permission card. */
export type PermissionDecision =
  { decision: "allow"; scope: PermissionScope } | { decision: "deny" };

/** One selectable answer to a clarifying question. */
export interface QuestionOption {
  label: string;
  description?: string;
}

/**
 * A structured multiple-choice question an agent asked mid-turn. For
 * `claude` this rides a Lykeion-hosted MCP tool; the neutral shape is the
 * same for every adapter.
 */
export interface QuestionRequest {
  requestId: string;
  /** A short chip/label for the question (e.g. "Library"). */
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/**
 * The researcher's answer. `selected` holds the chosen option LABELS; an
 * empty array is a deliberate skip ("let the agent decide"), delivered as an
 * explicit non-answer rather than a hung turn.
 */
export interface QuestionAnswer {
  selected: string[];
}

/** One authoritative Execution Log entry. */
export interface ExecutionLogEntry {
  ts: number;
  toolUseId: string;
  tool: string;
  /**
   * A human-readable label for this call, when the adapter supplied one
   * (ACP's `ToolCallUpdateFields.title`). Absent when the adapter carries no
   * such label (e.g. the `claude` CLI's tool_use blocks never do) — a card
   * without one falls back to `tool`/`input`.
   */
  title?: string;
  input: unknown;
  /**
   * What the seam decided: "granted" | "allowed-once" | "allowed-conversation"
   * | "allowed-study" | "allowed-global" | "denied" | "cancelled" (the call was
   * still at the gate when the researcher STOPPED the turn: it was abandoned,
   * never ran, and carries no result — the stop is recorded rather than
   * dropped, so the transcript shows the step as blocked instead of losing it)
   * | "ran" (an announced call that executed without ever reaching a
   * permission gate, e.g. `Read`, `Grep`, plain `Bash` against the real CLI) |
   * "auto" (a call that DID reach a gate but mapped to no permission-engine
   * access at all, e.g. `ExitPlanMode` — genuinely no decision to make,
   * distinct from "ran") | "orphan-executed" (a result with no announcement
   * and no gate we ever saw).
   *
   * Only "denied" and "cancelled" mean the tool did NOT run; every other value
   * means it did. Consumers key presentation off that distinction, never off
   * which adapter produced the entry.
   */
  decision: string;
  result?: string;
  isError: boolean;
  /**
   * True when this call's access fell OUTSIDE the study workspace (skipped
   * from the JSON when false — so it is absent, not `false`, on records
   * written before the field existed).
   *
   * A record, not a refusal. An agent CLI can execute such an access with no
   * permission request ever reaching the seam (the `claude` CLI's plan mode
   * auto-allows its own plan-file write to `~/.claude/plans/…`), so the core
   * only learns of it from the tool announcement — too late to block, early
   * enough to say so. A consumer must therefore SHOW it: the step succeeded,
   * so it is neither an error nor blocked, but it left the workspace and must
   * not read as an ordinary successful step. It is set on GATED calls too,
   * decision and all — an attempt the researcher denied still left-the-
   * workspace as an attempt, and an audit that only saw the ungated ones
   * would miss every blocked one.
   *
   * Pure CONTAINMENT of the path in the workspace root: an absolute path
   * elsewhere, or a `..` traversal that resolves outside. The workspace root
   * itself, a `./`-prefixed path, and a traversal that resolves back inside
   * are all INSIDE; a call carrying no path at all claims nothing (absent),
   * since where it went is unknown. Never a property of which adapter
   * produced the entry, and never inferred from the tool name here.
   */
  outsideWorkspace?: boolean;
}

/**
 * One item of a turn's arrival-ordered stream: prose or a tool step. Tagged
 * on `kind`, camelCase. Reuses `ExecutionLogEntry` rather than duplicating
 * its shape.
 *
 * A `text` item is always ONE WHOLE assistant message: every `assistant-text`
 * event carries a `partial` flag stating whether it is a fragment of a
 * message still being streamed (`partial: true`) or a complete one
 * (`partial: false`), and partial fragments are reassembled before the
 * record is written. So a renderer gives each item its own paragraph and
 * never tries to infer message boundaries from the text — that inference is
 * undecidable (every rule that keeps two whole paragraphs apart also breaks
 * a real chunk seam mid-word), which is exactly why this guarantee exists.
 */
export type TurnItem =
  { kind: "text"; text: string } | { kind: "step"; entry: ExecutionLogEntry };

/**
 * Where one agent turn stands. `AwaitingPermission.plan` is optional: a gate
 * can be raised before any plan exists (exploration during `Planning`) — the
 * field is ABSENT from the JSON entirely, not `null`, when there is no plan
 * to resume.
 */
export type TurnState =
  | { state: "planning" }
  | { state: "awaiting-plan-approval"; plan: Plan }
  | { state: "executing"; plan: Plan }
  | { state: "awaiting-permission"; plan?: Plan; request: PermissionRequest }
  | { state: "awaiting-question"; plan?: Plan; request: QuestionRequest }
  | { state: "completed" }
  | { state: "failed"; reason: string };

/** A recorded run — the fields the UI shows. */
export interface RunRecord {
  runId: string;
  ts: number;
  command: string;
  status: "ok" | "failed";
  wallMs?: number;
  code: RunArtifact[];
  outputs: RunArtifact[];
  /**
   * Prose and tool steps, interleaved in arrival order. Absent on records
   * written before this field existed — an empty stream never appears in
   * the JSON either, so the UI falls back to `messages`/the Execution Log.
   */
  stream?: TurnItem[];
  logHash?: string;
}

export interface RunArtifact {
  path: string;
  hash?: string;
  size: number;
}

/**
 * A past run on a Task — one entry per turn in its chat. Empty until run
 * history is persisted and surfaced; nothing is returned yet.
 */
export interface RunSummary {
  runId: string;
  /** The prompt that started the run (the Task's title). */
  command: string;
  ts: number;
  status: "ok" | "failed";
}

/** One turn of a Task — a single run's user prompt + assistant replies. */
export interface TaskTurn {
  runId: string;
  ts: number;
  /** The researcher's prompt for this turn. */
  prompt: string;
  /** The assistant's prose replies for this turn, in arrival order. */
  messages: string[];
  /**
   * Prose and tool steps, interleaved in the order they actually arrived —
   * what the transcript renders. Absent on turns recorded before this field
   * existed; the UI falls back to `messages`.
   */
  stream?: TurnItem[];
  status: "ok" | "failed";
  code: RunArtifact[];
  outputs: RunArtifact[];
  /** Set when this turn is a delegated subagent turn (nested in the UI). */
  parentRunId?: string;
  subagent?: string;
}

/** A Task with its full transcript (turns ascending by ts). */
export interface TaskDetail {
  task: Task;
  turns: TaskTurn[];
}

/** A persona a subagent runs as — the same shape as `Agent`
 *  (customization.ts), minus `connectors`. */
export interface AgentPersona {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  tools: string[];
}

/** The compact hand-back from a completed subagent turn. */
export interface SubagentResult {
  subagent: string;
  task: string;
  status: "ok" | "failed";
  /** The child's final assistant prose (its report). */
  summary: string[];
  outputs: RunArtifact[];
  runId: string;
}

/**
 * Input to delegate a sub-task to a subagent. `taskId` is the Task whose
 * transcript the child turn nests into: the delegation happens inside a chat,
 * and the chat is a Task.
 */
export interface DelegateSubagentInput {
  studyId: string;
  taskId: string;
  parentRunId?: string;
  persona: AgentPersona;
  task: string;
  options: RunOptions;
}

/** stdout accumulated for one still-running tool. */
export interface ToolStdout {
  toolUseId: string;
  text: string;
}

/**
 * A snapshot of everything in flight.
 *
 * REPLACES its predecessor — never append these. Every field is optional
 * because an idle snapshot serializes to `{}`: every field of `LiveTurn` is
 * skipped when it's empty, so the final snapshot of a turn — the one that
 * tells a consumer nothing is in flight anymore — carries no keys at all.
 *
 * Nothing here is persisted: `thinking` and `toolStdout` are dropped when the
 * turn ends, and `TurnItem` keeps exactly two kinds.
 */
export interface LiveTurn {
  /** Partial assistant prose, accumulating. */
  text?: string;
  /** Extended thinking — a separate channel, never glued to prose. */
  thinking?: string;
  /** Keyed by `toolUseId`: tools can run concurrently. */
  toolStdout?: ToolStdout[];
}

/** An event streamed from a running turn. */
export type RunEvent =
  | { event: "state"; state: TurnState }
  | { event: "assistant-text"; text: string; partial: boolean }
  | { event: "plan-proposed"; plan: Plan }
  | { event: "permission-card"; request: PermissionRequest }
  | { event: "question-asked"; request: QuestionRequest }
  | { event: "log-entry"; entry: ExecutionLogEntry }
  | { event: "live"; live: LiveTurn }
  | { event: "reviewing" }
  | { event: "completed"; state: TurnState; run?: RunRecord };

/** A decision sent back into a running turn. */
export type RunDecision =
  | { action: "approve-plan" }
  | { action: "reject-plan"; reason?: string }
  | { action: "permission"; requestId: string; decision: PermissionDecision }
  | { action: "answer-question"; requestId: string; answer: QuestionAnswer }
  | { action: "cancel" };

/** Options for a run (the UI never sets a binary — that's test-only). */
export interface RunOptions {
  planMode: boolean;
  model?: string;
  /** The agent CLI id to route to; omitted → the core's first available. */
  agent?: string;
}

/**
 * Input to start a run. `taskId` names the Task the turn belongs to — a Task
 * is a chat, so every run is a turn in one, and there is no second kind of
 * owner to choose between. `studyId` is the workspace it runs in, which is
 * why an unfiled Task has to be filed before its first turn can start.
 */
export interface StartRunInput {
  studyId: string;
  taskId: string;
  prompt: string;
  options: RunOptions;
}

/**
 * A live run's handle. Subscribe with `onEvent`, answer with `submit`, and
 * `close` to release the subscription (and cancel an unfinished run).
 */
export interface RunHandle {
  runId: string;
  /** Subscribe; returns an unsubscribe fn. Replays no past events. */
  onEvent(cb: (e: RunEvent) => void): () => void;
  submit(decision: RunDecision): void;
  close(): void;
}

/** Re-export so `TaskStatus`/`Stage`/`Priority` are reachable from here. */
export type { Priority, Stage, TaskStatus };
