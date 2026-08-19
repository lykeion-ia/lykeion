/**
 * Domain types. Field names and string encodings are the wire format exactly:
 * camelCase fields, kebab-case enums.
 */

/** Identity of the running core. */
export interface CoreInfo {
  name: string;
  version: string;
}

/** The fixed scientific stages of a Study (kebab-case on the wire). */
export type Stage =
  | "background"
  | "hypothesis"
  | "methods"
  | "results"
  | "future-directions"
  | "conclusions";

/** All stages in canonical order. */
export const STAGES: Stage[] = [
  "background",
  "hypothesis",
  "methods",
  "results",
  "future-directions",
  "conclusions",
];

/** Human labels for the stages. */
export const STAGE_LABELS: Record<Stage, string> = {
  background: "Background",
  hypothesis: "Hypothesis",
  methods: "Methods",
  results: "Results",
  "future-directions": "Future directions",
  conclusions: "Conclusions",
};

/**
 * The phases of the method spine (kebab-case on the wire).
 *
 * A procedure declares its own ordered subset. A literature summary has no
 * pre-registration and no reproducible-compute setup, and showing those greyed
 * out would assert a step that was skipped rather than one that does not apply.
 */
export type MethodPhase =
  | "frame"
  | "survey-prior-work"
  | "design-analysis"
  | "pre-register"
  | "reproducible-setup"
  | "execute"
  | "investigate-anomalies"
  | "verify"
  | "red-team"
  | "report";

/**
 * Every phase, in canonical spine order.
 *
 * A procedure's own `phases` is a subsequence of this, never a reordering: a
 * procedure that verified before it executed would describe work nobody does.
 */
export const METHOD_PHASES: MethodPhase[] = [
  "frame",
  "survey-prior-work",
  "design-analysis",
  "pre-register",
  "reproducible-setup",
  "execute",
  "investigate-anomalies",
  "verify",
  "red-team",
  "report",
];

/** Human labels for the phases. */
export const METHOD_PHASE_LABELS: Record<MethodPhase, string> = {
  frame: "Frame the question",
  "survey-prior-work": "Survey prior work",
  "design-analysis": "Design the analysis",
  "pre-register": "Pre-register",
  "reproducible-setup": "Reproducible setup",
  execute: "Execute",
  "investigate-anomalies": "Investigate anomalies",
  verify: "Verify",
  "red-team": "Red-team",
  report: "Report and archive",
};

/**
 * The Skill each phase runs on, by `Skill.name`.
 *
 * A phase carries no instructions of its own — it names a Skill that does, so
 * editing that Skill changes every procedure reaching that phase. One place
 * to write the method down.
 */
export const METHOD_PHASE_SKILL: Record<MethodPhase, string> = {
  frame: "framing-questions",
  "survey-prior-work": "surveying-prior-work",
  "design-analysis": "designing-analyses",
  "pre-register": "pre-registering-analyses",
  "reproducible-setup": "reproducible-setup",
  execute: "executing-analyses",
  "investigate-anomalies": "investigating-anomalies",
  verify: "verifying-results",
  "red-team": "red-teaming-findings",
  report: "reporting-and-archiving",
};

/** The phases that apply to any procedure at all: what a new procedure starts
 * with, and what a stored record carrying no phases reads as. */
export const CORE_PHASES: MethodPhase[] = [
  "frame",
  "design-analysis",
  "execute",
  "verify",
  "report",
];

/** Task status (kebab-case). Advances via approval +
 * Reviewer sign-off; "in-review" = the Reviewer is checking. */
export type TaskStatus = "todo" | "in-progress" | "in-review" | "done";

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "Todo",
  "in-progress": "In Progress",
  "in-review": "In Review",
  done: "Done",
};

/** Task priority (kebab-case). */
export type Priority = "none" | "low" | "medium" | "high" | "urgent";

export const PRIORITY_LABELS: Record<Priority, string> = {
  none: "No priority",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

/**
 * Who a Task is on: a person, or an agent queued to do it. One list holds
 * both, because "Amara owns this and the statistician should run it" is a
 * single fact about one Task.
 *
 * An agent arm keys on `Agent.name` — agents are name-keyed throughout this
 * contract and have no id.
 */
export type Assignee =
  | { kind: "user"; userId: string }
  | { kind: "agent"; name: string };

/** One research line. */
export interface Study {
  id: string;
  /** Short prefix used to build task numbers, e.g. "CMP" for "CMP-12". */
  key: string;
  title: string;
  description?: string;
  /** Context injected into every agent's system prompt for this Study. */
  agentContext?: string;
  /** The `User.id` of whoever opened this research line. */
  createdBy: string;
  /**
   * Set when the Study was archived. An archived Study keeps every Task and
   * its transcript; it only leaves the list.
   */
  archivedTs?: number;
  /**
   * Pinned to the top of the Studies list. Presentation only — it groups the
   * list for whoever reads it and changes nothing about the Study. Absent
   * rather than `false` when unpinned, so "not pinned" is one state.
   */
  pinned?: boolean;
  createdTs: number;
  updatedTs: number;
}

/** A checklist item on a Task; progress = done / total. */
export interface Subtask {
  title: string;
  done: boolean;
}

/** One agent-runnable unit of work inside a stage. */
export interface Task {
  id: string;
  /**
   * Sequential per Study, or per Lab when unfiled. Displays as
   * "<study.key>-<number>", or "TSK-<number>" with no Study.
   */
  number: number;
  /**
   * The Study this Task sits in. Absent when the Task is unfiled: it belongs
   * to the Lab rather than to a research line, and lives in Tasks. An unfiled
   * Task has no workspace to run in, so the first send files it — the
   * composer asks which Study and files the Task as it starts the run.
   * Filing keeps the Task's `number`, so its code changes with it.
   */
  studyId?: string;
  stage: Stage;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: Priority;
  /**
   * Who this Task is on. Absent when nobody is. Assigning an agent expresses
   * intent and fills that agent's queue; it never starts work, which a
   * person always does.
   */
  assignees?: Assignee[];
  /**
   * The `User.id` of whoever wrote this Task. Always present, so who is
   * answerable for a Task is answerable even when nobody is assigned.
   */
  createdBy: string;
  /** Optional due date (ISO `YYYY-MM-DD`); real-data-ready, unset today. */
  targetDate?: string;
  /** Optional label ids (see UI `lib/task-meta` LABELS); unset today. */
  labels?: string[];
  /** External links (URLs) attached to the task; omitted when empty. */
  links?: string[];
  /** Checklist subtasks; progress = done / total. Omitted when empty. */
  subtasks?: Subtask[];
  /** Turns recorded against this Task. `0` until one lands. */
  runCount: number;
  /** The latest turn's outcome. Absent until a turn has finished. */
  lastRunStatus?: "ok" | "failed";
  /**
   * The coding agent this Task is talking to — an `AgentCli.id`, read off its
   * newest turn. A Task is one continuous conversation with one agent, so the
   * newest turn is the one that says which; a list of Tasks can therefore
   * name each one's agent without opening every transcript to find out.
   * Absent until a turn has run: a Task nobody has spoken in is on nothing.
   */
  agent?: string;
  /** Pinned to the top of the Study's Task list. */
  pinned?: boolean;
  /** Which machine ran it. Absent until a machine records one. */
  machineId?: string;
  createdTs: number;
  updatedTs: number;
}

/** A Study plus its tasks. */
export interface StudyDetail {
  study: Study;
  /** All tasks, ascending by number. */
  tasks: Task[];
}

/** The display code for a task, e.g. "CMP-12" — or "TSK-7" when unfiled. */
export function taskCode(study: Study | undefined, task: Task): string {
  return study ? `${study.key}-${task.number}` : `TSK-${task.number}`;
}
