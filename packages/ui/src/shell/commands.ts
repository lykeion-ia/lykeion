import { taskCode, type Research, type Task } from "@lykeion/api";
import { PRIORITY_META, TASK_STATUS_META, formatAgo } from "../lib/task-meta";
import type { Route } from "../router";

export interface PreviewRow {
  label: string;
  value: string;
}

/**
 * What the palette shows beside the highlighted row — enough to recognise a
 * result before opening it, rather than opening it to find out.
 *
 * Built here rather than in the component, for two reasons. This module is the
 * only place that knows what a Task is, and it is pure — so what a preview says
 * is covered by a plain test instead of a rendered one.
 */
export interface Preview {
  title: string;
  subtitle?: string;
  rows: PreviewRow[];
}

export type CommandKind = "research" | "task";

export interface Command {
  id: string;
  label: string;
  /** Which preview shape was built, and which mark the row draws on the right. */
  kind: CommandKind;
  /**
   * The CLI a Task last ran on, when it has run at all — an `AgentCli.id`, read
   * off its newest turn. The palette draws that CLI's own brand mark for it, and
   * a chat mark for a Task nobody has run, which is the difference between work
   * an agent has touched and a conversation a person started.
   *
   * Absent on a Research, which is not a thing that runs.
   */
  agent?: string;
  preview: Preview;
  route: Route;
}

/** A Research's Tasks, keyed by Research id. */
export type TasksByResearch = Record<string, Task[]>;

function studyPreview(research: Research, now: number): Preview {
  return {
    title: research.title,
    subtitle: research.key,
    rows: [{ label: "Updated", value: formatAgo(research.updatedTs, now) }],
  };
}

/**
 * A Task, described by what tells two of them apart: which Research it belongs to,
 * where it has got to, and when it last moved.
 *
 * No assignee row, though it would belong here: naming one needs a directory of
 * lab members that the palette's index does not read, and adding that read for
 * one line of a preview would cost a round trip on every open.
 */
function taskPreview(research: Research, task: Task, now: number): Preview {
  return {
    title: taskCode(research, task),
    subtitle: task.title,
    rows: [
      { label: "Research", value: research.title },
      { label: "Status", value: TASK_STATUS_META[task.status].label },
      { label: "Priority", value: PRIORITY_META[task.priority].label },
      { label: "Updated", value: formatAgo(task.updatedTs, now) },
    ],
  };
}

/**
 * What the palette can find: every Research, and every Task in them.
 *
 * Screens are deliberately absent. They used to be here as "Go to <section>"
 * rows, thirteen of them, and they crowded out the thing the palette is actually
 * reached for — a Task or a Research by name. The rail is how you get to a screen,
 * and it is always on the page; nobody opens a search box to find the Inbox.
 *
 * A Task's row leads with its code, so a researcher who knows "CMP-7" types it
 * and lands on a prefix match, and finds it without first choosing the Research
 * that holds it.
 */
export function buildCommands(
  researches: Research[],
  tasksByResearch: TasksByResearch = {},
  /**
   * Passed in rather than read off the clock. A preview that says "2d" is a
   * function of when it was asked, and a builder that reads the time itself
   * cannot be tested for what it says.
   */
  now: number = Date.now() / 1000,
): Command[] {
  const perResearch: Command[] = researches.map((research) => ({
    id: `research-${research.id}`,
    label: `Go to ${research.title}`,
    kind: "research",
    preview: studyPreview(research, now),
    route: { name: "research", researchId: research.id },
  }));
  // Code first so a researcher who knows "CMP-7" types it and lands on a
  // prefix match; the title carries the rest of the query surface.
  const perTask: Command[] = researches.flatMap((research) =>
    (tasksByResearch[research.id] ?? []).map((task) => ({
      id: `task-${task.id}`,
      label: `${taskCode(research, task)} · ${task.title}`,
      kind: "task" as const,
      agent: task.agent,
      preview: taskPreview(research, task, now),
      route: { name: "task" as const, researchId: research.id, taskId: task.id },
    })),
  );
  return [...perResearch, ...perTask];
}

/**
 * Rank commands for a query: exact > prefix > substring (earlier is better)
 * > subsequence. Empty query returns everything in canonical order.
 */
export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands
    .map((command) => ({
      command,
      score: score(command.label.toLowerCase(), q),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.command);
}

function score(label: string, q: string): number {
  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  const at = label.indexOf(q);
  if (at >= 0) return 60 - Math.min(at, 40) / 2;
  let matched = 0;
  for (const ch of label) {
    if (ch === q[matched]) matched += 1;
    if (matched === q.length) return 10;
  }
  return 0;
}
