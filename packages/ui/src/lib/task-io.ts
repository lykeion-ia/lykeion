import {
  STAGES,
  taskCode,
  type Assignee,
  type NewTask,
  type Priority,
  type Study,
  type Subtask,
  type Task,
  type TaskPatch,
} from "@lykeion/api";

/**
 * Import / Export for the task boards — pure (de)serialization, no DOM. The
 * toolbar wires these to a download link and a file input. Export captures the
 * REAL task fields; import maps each row to a create + patch pair so the extra
 * fields (labels, links, subtasks, status, target date) round-trip through
 * `createTask` + `updateTask`. Malformed rows are skipped, never thrown.
 */

export const TASKS_FILE_KIND = "lykeion.tasks";
export const TASKS_FILE_VERSION = 1;

const PRIORITIES: readonly Priority[] = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
];

/** One serialized task row (a superset of what `createTask` accepts). */
export interface ExportedTask {
  code: string;
  /** Absent for an unfiled Task; a row without one re-imports as unfiled. */
  studyId?: string;
  stage: Task["stage"];
  title: string;
  description?: string;
  status: Task["status"];
  priority: Priority;
  assignees?: Assignee[];
  labels?: string[];
  links?: string[];
  targetDate?: string;
  subtasks?: Subtask[];
}

/** A parsed row split into the create call and the follow-up patch. */
export interface ImportedTask {
  create: NewTask;
  patch: TaskPatch;
}

export interface ParseResult {
  tasks: ImportedTask[];
  /** Rows that were dropped because they were malformed. */
  skipped: number;
}

/** Serialize the given tasks to a pretty JSON document string. */
export function exportTasksJson(
  tasks: Task[],
  studyById: Record<string, Study>,
): string {
  const rows: ExportedTask[] = tasks.map((t) => {
    const study = t.studyId !== undefined ? studyById[t.studyId] : undefined;
    const row: ExportedTask = {
      // `taskCode` covers both the unfiled case and a real Study; the fallback
      // is only for a filed Task whose Study is missing from the map.
      code:
        study || t.studyId === undefined
          ? taskCode(study, t)
          : `${t.studyId}-${t.number}`,
      stage: t.stage,
      title: t.title,
      status: t.status,
      priority: t.priority,
    };
    if (t.studyId !== undefined) row.studyId = t.studyId;
    if (t.description) row.description = t.description;
    if (t.assignees?.length) row.assignees = [...t.assignees];
    if (t.labels?.length) row.labels = [...t.labels];
    if (t.links?.length) row.links = [...t.links];
    if (t.targetDate) row.targetDate = t.targetDate;
    if (t.subtasks?.length) row.subtasks = t.subtasks.map((s) => ({ ...s }));
    return row;
  });
  const doc = {
    kind: TASKS_FILE_KIND,
    version: TASKS_FILE_VERSION,
    exportedCount: rows.length,
    tasks: rows,
  };
  return JSON.stringify(doc, null, 2);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter(isNonEmptyString);
  return out.length ? out : undefined;
}

function isAssignee(v: unknown): v is Assignee {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  if (a.kind === "user") return isNonEmptyString(a.userId);
  if (a.kind === "agent") return isNonEmptyString(a.name);
  return false;
}

function assigneeArray(v: unknown): Assignee[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter(isAssignee);
  return out.length ? out : undefined;
}

function parseSubtasks(v: unknown): Subtask[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Subtask[] = [];
  for (const s of v) {
    if (s && typeof s === "object" && isNonEmptyString((s as Subtask).title)) {
      out.push({
        title: (s as Subtask).title,
        done: Boolean((s as Subtask).done),
      });
    }
  }
  return out.length ? out : undefined;
}

function parseRow(raw: unknown): ImportedTask | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // A missing `studyId` is an unfiled Task, not a malformed row. Only the
  // title and stage are structurally required.
  if (!isNonEmptyString(r.title)) return null;
  if (r.studyId !== undefined && !isNonEmptyString(r.studyId)) return null;
  if (!STAGES.includes(r.stage as Task["stage"])) return null;
  const priority = PRIORITIES.includes(r.priority as Priority)
    ? (r.priority as Priority)
    : "none";

  const assignees = assigneeArray(r.assignees);
  const create: NewTask = {
    stage: r.stage as Task["stage"],
    title: r.title,
    priority,
  };
  if (isNonEmptyString(r.studyId)) create.studyId = r.studyId;
  if (isNonEmptyString(r.description)) create.description = r.description;
  if (assignees) create.assignees = assignees;

  // Everything createTask can't set goes into the follow-up patch.
  const patch: TaskPatch = {};
  const labels = stringArray(r.labels);
  const links = stringArray(r.links);
  const subtasks = parseSubtasks(r.subtasks);
  if (labels) patch.labels = labels;
  if (links) patch.links = links;
  if (subtasks) patch.subtasks = subtasks;
  if (isNonEmptyString(r.targetDate)) patch.targetDate = r.targetDate;
  if (
    r.status === "in-progress" ||
    r.status === "in-review" ||
    r.status === "done"
  ) {
    patch.status = r.status;
  }

  return { create, patch };
}

/**
 * Parse an exported document (or a bare array of rows) into create/patch pairs.
 * Never throws: invalid JSON yields an empty result; malformed rows are counted
 * in `skipped`.
 */
export function parseTasksJson(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { tasks: [], skipped: 0 };
  }
  const rows: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { tasks?: unknown }).tasks)
      ? (data as { tasks: unknown[] }).tasks
      : [];

  const tasks: ImportedTask[] = [];
  let skipped = 0;
  for (const row of rows) {
    const parsed = parseRow(row);
    if (parsed) tasks.push(parsed);
    else skipped++;
  }
  return { tasks, skipped };
}

/** True when the patch carries any field (i.e. an `updateTask` is worthwhile). */
export function patchHasFields(patch: TaskPatch): boolean {
  return Object.keys(patch).length > 0;
}
