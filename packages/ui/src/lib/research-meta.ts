import type { Assignee, LykeionApi, Research, Task } from "@lykeion/api";
import {
  assigneeAvatar,
  assigneeKey,
  type AssigneeAvatar,
  type Directory,
} from "./assignee";
import { formatAgo, PRIORITY_META } from "./task-meta";

// Research has no status/priority/lead of its own — aggregate from its real tasks.
export interface ResearchMeta {
  statusLabel: string;
  statusDotClass: string; // bg-*
  statusTextClass: string; // text-*
  priorityLabel: string;
  doneCount: number;
  totalCount: number;
  lead: AssigneeAvatar | null;
  startedAgo: string;
}

/** Derive a short key from a title (initials, prefix fallback). */
export function deriveResearchKey(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const initials = words
    .map((w) => w[0])
    .join("")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
  const base =
    initials.length >= 2
      ? initials
      : title.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return base.slice(0, 5) || "PRJ";
}

/** The three fields a person types to open a research line; the `key` is
 *  derived rather than asked for. Lives here, beside the derivation and the
 *  create call that consume it, so the form collecting it stays a detail of
 *  the UI rather than something the data path depends on. */
export interface NewResearchInput {
  title: string;
  description: string;
  agentContext: string;
}

/** Turn a submitted {@link NewResearchInput} into a created Research. Every surface
 *  that offers Research creation calls this — one implementation of the key
 *  derivation and optional-field trimming, not one copy per host. */
export function createResearchFromInput(
  api: LykeionApi,
  { title, description, agentContext }: NewResearchInput,
): Promise<Research> {
  return api.createResearch({
    title,
    key: deriveResearchKey(title),
    description: description || undefined,
    agentContext: agentContext || undefined,
  });
}

export function deriveResearchMeta(
  research: Research,
  tasks: Task[],
  dir: Directory,
): ResearchMeta {
  const totalCount = tasks.length;
  const doneCount = tasks.filter((t) => t.status === "done").length;

  let statusLabel: string;
  let statusDotClass: string;
  let statusTextClass: string;
  if (totalCount === 0) {
    statusLabel = "Backlog";
    statusDotClass = "bg-fg-tertiary";
    statusTextClass = "text-fg-tertiary";
  } else if (tasks.some((t) => t.status === "in-progress")) {
    statusLabel = "In Progress";
    statusDotClass = "bg-accent";
    statusTextClass = "text-accent";
  } else if (tasks.some((t) => t.status === "in-review")) {
    statusLabel = "In Review";
    statusDotClass = "bg-warn";
    statusTextClass = "text-warn";
  } else if (doneCount === totalCount) {
    statusLabel = "Done";
    statusDotClass = "bg-success";
    statusTextClass = "text-success";
  } else {
    statusLabel = "Todo";
    statusDotClass = "bg-fg-tertiary";
    statusTextClass = "text-fg-tertiary";
  }

  // Highest-rank priority actually present among the tasks (real, not invented).
  const topPriority = tasks.reduce<Task["priority"]>(
    (best, t) =>
      PRIORITY_META[t.priority].rank > PRIORITY_META[best].rank
        ? t.priority
        : best,
    "none",
  );
  const priorityLabel = PRIORITY_META[topPriority].label;

  // Lead = the most-frequent assignee among the tasks.
  const counts = new Map<string, { assignee: Assignee; count: number }>();
  for (const t of tasks) {
    for (const a of t.assignees ?? []) {
      const key = assigneeKey(a);
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { assignee: a, count: 1 });
    }
  }
  let lead: AssigneeAvatar | null = null;
  let bestCount = 0;
  for (const { assignee, count } of counts.values()) {
    if (count > bestCount) {
      bestCount = count;
      lead = assigneeAvatar(assignee, dir);
    }
  }

  return {
    statusLabel,
    statusDotClass,
    statusTextClass,
    priorityLabel,
    doneCount,
    totalCount,
    lead,
    startedAgo: formatAgo(research.createdTs),
  };
}
