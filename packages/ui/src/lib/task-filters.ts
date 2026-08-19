import type { ComponentType, SVGProps } from "react";
import type { Assignee, Priority, Research, Task } from "@lykeion/api";
import {
  ArchiveIcon,
  CalendarIcon,
  FlaskIcon,
  NotebookIcon,
  PriorityIcon,
  TagIcon,
  TargetIcon,
  UserIcon,
} from "../components/icons";
import {
  LABELS,
  PRIORITY_META,
  PRIORITY_ORDER,
  STAGE_META,
  STAGE_ORDER,
  STATUS_ORDER,
  STATUS_SORT_RANK,
  TASK_STATUS_META,
} from "./task-meta";
import {
  assigneeAvatar,
  assigneeKey,
  directoryOf,
  displayName,
  type Directory,
} from "./assignee";
import { deriveResearchMeta } from "./research-meta";

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

// --- Dimension model ----------------------------------------------------

export interface FilterOption {
  id: string;
  label: string;
  count: number;
  swatch?: string; // bg-* dot class (status)
  color?: string; // hex dot (labels)
  gradient?: [string, string]; // assignee avatar
  priorityLevel?: Priority; // priority glyph
}

export interface FilterDimension {
  key: string;
  label: string;
  icon: IconType;
  kind: "select" | "date";
  options?: FilterOption[];
}

export interface FilterState {
  values: Record<string, string[]>; // dimension key -> selected option ids
  targetDate?: string; // ISO; "due on or before"
}

export const EMPTY_FILTERS: FilterState = { values: {} };

export function activeFilterCount(state: FilterState): number {
  const selected = Object.values(state.values).reduce(
    (acc, arr) => acc + arr.length,
    0,
  );
  return selected + (state.targetDate ? 1 : 0);
}

// Distinct assignees present in a task set → options with derived avatars.
function assigneeOptions(
  tasks: Task[],
  count: (pred: (t: Task) => boolean) => number,
  dir: Directory,
): FilterOption[] {
  const seen = new Map<string, Assignee>();
  for (const t of tasks) {
    for (const a of t.assignees ?? []) {
      const key = assigneeKey(a);
      if (!seen.has(key)) seen.set(key, a);
    }
  }
  return [...seen.entries()].map(([key, a]) => ({
    id: key,
    label: displayName(a, dir),
    count: count((t) => (t.assignees ?? []).some((x) => assigneeKey(x) === key)),
    gradient: assigneeAvatar(a, dir).gradient,
  }));
}

/**
 * The option id standing for "no Research". A sentinel is needed because the
 * filter state is a list of string ids and an unfiled Task's `researchId` is
 * absent — there is no real id to select it by.
 */
export const UNFILED_STUDY_ID = "__unfiled__";

// Task filter set: Status, Assignee, Priority, Stage, Labels, Research, Target date.
export function taskDimensions(
  tasks: Task[],
  studyById: Record<string, Research>,
  dir: Directory,
): FilterDimension[] {
  const count = (pred: (t: Task) => boolean) => tasks.filter(pred).length;
  const researchIds = [
    ...new Set(tasks.map((t) => t.researchId ?? UNFILED_STUDY_ID)),
  ];
  return [
    {
      key: "status",
      label: "Status",
      icon: TargetIcon,
      kind: "select",
      options: STATUS_ORDER.map((s) => ({
        id: s,
        label: TASK_STATUS_META[s].label,
        count: count((t) => t.status === s),
        swatch: TASK_STATUS_META[s].dotClass,
      })),
    },
    {
      key: "assignee",
      label: "Assignee",
      icon: UserIcon,
      kind: "select",
      options: assigneeOptions(tasks, count, dir),
    },
    {
      key: "priority",
      label: "Priority",
      icon: PriorityIcon,
      kind: "select",
      options: PRIORITY_ORDER.map((p) => ({
        id: p,
        label: PRIORITY_META[p].label,
        count: count((t) => t.priority === p),
        priorityLevel: p,
      })),
    },
    {
      key: "stage",
      label: "Stage",
      icon: NotebookIcon,
      kind: "select",
      options: STAGE_ORDER.map((s) => ({
        id: s,
        label: STAGE_META[s].label,
        count: count((t) => t.stage === s),
      })),
    },
    {
      key: "labels",
      label: "Labels",
      icon: TagIcon,
      kind: "select",
      options: LABELS.map((l) => ({
        id: l.id,
        label: l.name,
        count: count((t) => (t.labels ?? []).includes(l.id)),
        color: l.color,
      })),
    },
    {
      key: "research",
      label: "Research",
      icon: FlaskIcon,
      kind: "select",
      options: researchIds.map((id) => ({
        id,
        label:
          id === UNFILED_STUDY_ID ? "Unfiled" : (studyById[id]?.title ?? id),
        count: count((t) => (t.researchId ?? UNFILED_STUDY_ID) === id),
      })),
    },
    {
      key: "targetDate",
      label: "Target date",
      icon: CalendarIcon,
      kind: "date",
    },
  ];
}

export function applyTaskFilters(tasks: Task[], state: FilterState): Task[] {
  const v = state.values;
  const dueBy = state.targetDate;
  return tasks.filter((t) => {
    const status = v.status ?? [];
    const assignee = v.assignee ?? [];
    const priority = v.priority ?? [];
    const stage = v.stage ?? [];
    const labels = v.labels ?? [];
    const research = v.research ?? [];
    if (status.length && !status.includes(t.status)) return false;
    if (
      assignee.length &&
      !(t.assignees ?? []).some((a) => assignee.includes(assigneeKey(a)))
    )
      return false;
    if (priority.length && !priority.includes(t.priority)) return false;
    if (stage.length && !stage.includes(t.stage)) return false;
    if (labels.length && !(t.labels ?? []).some((l) => labels.includes(l)))
      return false;
    if (research.length && !research.includes(t.researchId ?? UNFILED_STUDY_ID))
      return false;
    if (dueBy && t.targetDate !== undefined && t.targetDate > dueBy)
      return false;
    return true;
  });
}

// --- Sorting ------------------------------------------------------------

export type SortKey = "updated" | "priority" | "targetDate" | "status";

export const SORT_OPTIONS: { id: SortKey; label: string }[] = [
  { id: "updated", label: "Updated" },
  { id: "priority", label: "Priority" },
  { id: "targetDate", label: "Target date" },
  { id: "status", label: "Status" },
];

export function sortTasks(tasks: Task[], key: SortKey): Task[] {
  const arr = [...tasks];
  switch (key) {
    case "priority":
      arr.sort(
        (a, b) =>
          PRIORITY_META[b.priority].rank - PRIORITY_META[a.priority].rank,
      );
      break;
    case "targetDate":
      arr.sort((a, b) =>
        (a.targetDate ?? "9999-99-99").localeCompare(
          b.targetDate ?? "9999-99-99",
        ),
      );
      break;
    case "status":
      arr.sort(
        (a, b) => STATUS_SORT_RANK[a.status] - STATUS_SORT_RANK[b.status],
      );
      break;
    case "updated":
    default:
      arr.sort((a, b) => b.updatedTs - a.updatedTs);
      break;
  }
  return arr;
}

// --- Research dimensions + apply (derived from tasks, no new Research fields) ---

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/**
 * Which shelf a Research sits on. Archived is a dimension like any other, except
 * for its default: selecting nothing means "active only" rather than "both",
 * because a Lab's archive is meant to stay out of the way until asked for.
 * `ARCHIVED_DEFAULT` is that default, applied in `applyResearchFilters`.
 */
export const ARCHIVED_OPTIONS = [
  { id: "active", label: "Active" },
  { id: "archived", label: "Archived" },
] as const;

export const ARCHIVED_DEFAULT = ["active"];

function shelfOf(research: Research): string {
  return research.archivedTs === undefined ? "active" : "archived";
}

// Researches filter set: Stage, Priority, Status, Archived, Target date.
// Priority/Status use the derived research meta (what the table shows);
// Stage/Target date match over the research's tasks; Archived reads the Research's
// own `archivedTs`. No dimension surfaces a lead avatar, so an empty directory
// is always correct for this `deriveResearchMeta` call.
export function studyDimensions(
  researches: Research[],
  tasksByResearch: Record<string, Task[]>,
): FilterDimension[] {
  const metas = researches.map((s) =>
    deriveResearchMeta(s, tasksByResearch[s.id] ?? [], directoryOf([])),
  );
  const studyTasks = researches.map((s) => tasksByResearch[s.id] ?? []);
  return [
    {
      key: "stage",
      label: "Stage",
      icon: NotebookIcon,
      kind: "select",
      options: STAGE_ORDER.map((st) => ({
        id: st,
        label: STAGE_META[st].label,
        count: studyTasks.filter((ts) => ts.some((t) => t.stage === st)).length,
      })),
    },
    {
      key: "priority",
      label: "Priority",
      icon: PriorityIcon,
      kind: "select",
      options: uniq(metas.map((m) => m.priorityLabel)).map((label) => ({
        id: label,
        label,
        count: metas.filter((m) => m.priorityLabel === label).length,
      })),
    },
    {
      key: "status",
      label: "Status",
      icon: TargetIcon,
      kind: "select",
      options: uniq(metas.map((m) => m.statusLabel)).map((label) => ({
        id: label,
        label,
        count: metas.filter((m) => m.statusLabel === label).length,
        swatch: metas.find((m) => m.statusLabel === label)?.statusDotClass,
      })),
    },
    {
      key: "archived",
      label: "Archived",
      icon: ArchiveIcon,
      kind: "select",
      options: ARCHIVED_OPTIONS.map((o) => ({
        id: o.id,
        label: o.label,
        count: researches.filter((s) => shelfOf(s) === o.id).length,
      })),
    },
    {
      key: "targetDate",
      label: "Target date",
      icon: CalendarIcon,
      kind: "date",
    },
  ];
}

export function applyResearchFilters(
  researches: Research[],
  state: FilterState,
  tasksByResearch: Record<string, Task[]>,
): Research[] {
  const v = state.values;
  const dueBy = state.targetDate;
  return researches.filter((s) => {
    const tasks = tasksByResearch[s.id] ?? [];
    // No lead avatar is read here either — same empty directory as above.
    const m = deriveResearchMeta(s, tasks, directoryOf([]));
    const status = v.status ?? [];
    const priority = v.priority ?? [];
    const stage = v.stage ?? [];
    // The one dimension whose empty selection is not "everything" — see
    // ARCHIVED_DEFAULT.
    const shelves = v.archived?.length ? v.archived : ARCHIVED_DEFAULT;
    if (!shelves.includes(shelfOf(s))) return false;
    if (status.length && !status.includes(m.statusLabel)) return false;
    if (priority.length && !priority.includes(m.priorityLabel)) return false;
    if (stage.length && !tasks.some((t) => stage.includes(t.stage)))
      return false;
    if (
      dueBy &&
      !tasks.some((t) => t.targetDate !== undefined && t.targetDate <= dueBy)
    )
      return false;
    return true;
  });
}
