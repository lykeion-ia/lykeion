import { taskCode, type Study, type Task } from "@lykeion/api";
import type { Route } from "../router";

export interface Command {
  id: string;
  label: string;
  /** Right-aligned annotation in the palette (what kind of thing this is,
   *  or which Study it belongs to). */
  hint: string;
  route: Route;
}

/** A Study's Tasks, keyed by Study id. */
export type TasksByStudy = Record<string, Task[]>;

/**
 * Navigation commands, one "Go to <study>" per study, and one per Task.
 *
 * The Task commands find a Task by code or title without first choosing where
 * it lives, so a Task is one keystroke away from anywhere in the app.
 */
export function buildCommands(
  studies: Study[],
  tasksByStudy: TasksByStudy = {},
): Command[] {
  const nav: Command[] = [
    {
      id: "nav-inbox",
      label: "Go to Inbox",
      hint: "Screen",
      route: { name: "inbox" },
    },
    {
      id: "nav-my-tasks",
      label: "Go to My Tasks",
      hint: "Screen",
      route: { name: "my-tasks" },
    },
    {
      id: "nav-research-groups",
      label: "Go to Research Groups",
      hint: "Screen",
      route: { name: "research-groups" },
    },
    {
      id: "nav-tasks",
      label: "Go to Tasks",
      hint: "Screen",
      route: { name: "tasks" },
    },
    {
      id: "nav-studies",
      label: "Go to Studies",
      hint: "Screen",
      route: { name: "studies" },
    },
    {
      id: "nav-agents",
      label: "Go to Agents",
      hint: "Screen",
      route: { name: "agents" },
    },
    {
      id: "nav-skills",
      label: "Go to Skills",
      hint: "Screen",
      route: { name: "settings", tab: "skills" },
    },
    {
      id: "nav-workflows",
      label: "Go to Workflows",
      hint: "Screen",
      route: { name: "workflows" },
    },
    {
      id: "nav-connectors",
      label: "Go to Connectors",
      hint: "Screen",
      route: { name: "settings", tab: "connectors" },
    },
    {
      id: "nav-runtimes",
      label: "Go to Runtimes",
      hint: "Screen",
      route: { name: "runtimes" },
    },
    {
      id: "nav-profile",
      label: "Go to Profile",
      hint: "Screen",
      route: { name: "settings", tab: "profile" },
    },
    {
      id: "nav-appearance",
      label: "Go to Appearance",
      hint: "Screen",
      route: { name: "settings", tab: "appearance" },
    },
    {
      id: "nav-settings",
      label: "Go to Settings",
      hint: "Screen",
      route: { name: "settings" },
    },
  ];
  const perStudy: Command[] = studies.map((study) => ({
    id: `study-${study.id}`,
    label: `Go to ${study.title}`,
    hint: study.key,
    route: { name: "study", studyId: study.id },
  }));
  // Code first so a researcher who knows "CMP-7" types it and lands on a
  // prefix match; the title carries the rest of the query surface.
  const perTask: Command[] = studies.flatMap((study) =>
    (tasksByStudy[study.id] ?? []).map((task) => ({
      id: `task-${task.id}`,
      label: `${taskCode(study, task)} · ${task.title}`,
      hint: "Task",
      route: { name: "task" as const, studyId: study.id, taskId: task.id },
    })),
  );
  return [...nav, ...perStudy, ...perTask];
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
