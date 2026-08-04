import {
  PRIORITY_LABELS,
  STAGE_LABELS,
  STAGES,
  type Priority,
  type Stage,
  type TaskStatus,
} from "@lykeion/api";

// Dependency-free attribute metadata for the filterable Task fields. Both the
// display components and the filter logic import from here (no import cycle).

// Board-wide status meta keyed by Lykeion's real TaskStatus. Colors reuse the
// Tailwind bridge tokens (fg-tertiary/accent/warn/success) for the status
// chip palette. No "failed": failure is a run/Reviewer state, not a status.
export interface TaskStatusMeta {
  label: string;
  dotClass: string; // bg-*
  textClass: string; // text-*
}

export const TASK_STATUS_META: Record<TaskStatus, TaskStatusMeta> = {
  todo: {
    label: "Todo",
    dotClass: "bg-fg-tertiary",
    textClass: "text-fg-tertiary",
  },
  "in-progress": {
    label: "In Progress",
    dotClass: "bg-accent",
    textClass: "text-accent",
  },
  "in-review": {
    label: "In Review",
    dotClass: "bg-warn",
    textClass: "text-warn",
  },
  done: { label: "Done", dotClass: "bg-success", textClass: "text-success" },
};

export const STATUS_ORDER: TaskStatus[] = [
  "todo",
  "in-progress",
  "in-review",
  "done",
];

export const STATUS_SORT_RANK: Record<TaskStatus, number> = {
  "in-progress": 0,
  "in-review": 1,
  todo: 2,
  done: 3,
};

// Stage badge meta. Labels from the contract; each of the six real Stages
// gets a border/text color from the bridge tokens.
export interface StageMeta {
  label: string;
  badgeClass: string;
}

export const STAGE_META: Record<Stage, StageMeta> = {
  background: {
    label: STAGE_LABELS.background,
    badgeClass: "border-accent/40 text-accent",
  },
  hypothesis: {
    label: STAGE_LABELS.hypothesis,
    badgeClass: "border-iris/40 text-iris",
  },
  methods: {
    label: STAGE_LABELS.methods,
    badgeClass: "border-success/40 text-success",
  },
  results: {
    label: STAGE_LABELS.results,
    badgeClass: "border-warn/40 text-warn",
  },
  "future-directions": {
    label: STAGE_LABELS["future-directions"],
    badgeClass: "border-iris/40 text-iris",
  },
  conclusions: {
    label: STAGE_LABELS.conclusions,
    badgeClass: "border-fg-subtle/40 text-fg-subtle",
  },
};

export const STAGE_ORDER: Stage[] = STAGES;

export interface PriorityMeta {
  label: string;
  rank: number;
}

export const PRIORITY_META: Record<Priority, PriorityMeta> = {
  none: { label: PRIORITY_LABELS.none, rank: 0 },
  low: { label: PRIORITY_LABELS.low, rank: 1 },
  medium: { label: PRIORITY_LABELS.medium, rank: 2 },
  high: { label: PRIORITY_LABELS.high, rank: 3 },
  urgent: { label: PRIORITY_LABELS.urgent, rank: 4 },
};

// Sorted urgent → none by descending rank; unset priority carries the
// lowest rank of the five, so it always sorts last.
export const PRIORITY_ORDER: Priority[] = [
  "urgent",
  "high",
  "medium",
  "low",
  "none",
];

// Task label catalog — a small science taxonomy (color-dot chips). Task.labels
// (optional, real-data-ready) references these ids; empty until populated.
export interface LabelMeta {
  id: string;
  name: string;
  color: string; // hex
}

export const LABELS: LabelMeta[] = [
  { id: "wet-lab", name: "Wet lab", color: "#4BA3E3" },
  { id: "computational", name: "Computational", color: "#8a86d8" },
  { id: "analysis", name: "Analysis", color: "#27a644" },
  { id: "writing", name: "Writing", color: "#d9a441" },
  { id: "reproducibility", name: "Reproducibility", color: "#e5705b" },
];

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// "Jul 22"-style label for an optional target-date ISO string.
export function formatTargetDate(iso?: string): string {
  if (!iso) return "—";
  const [, m, d] = iso.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

// Compact "3h" / "2d" relative label from a unix-SECONDS timestamp (Lykeion's
// createdTs/updatedTs/ts are seconds). `now` defaults to the current time;
// tests pass an explicit `now` for determinism.
export function formatAgo(ts: number, now: number = Date.now() / 1000): string {
  const secs = Math.max(0, now - ts);
  const mins = Math.floor(secs / 60);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}
