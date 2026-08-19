/**
 * The open-Notebook tabs — the inspector's own breadcrumb, one entry per Task
 * whose notebook has been opened.
 *
 * A notebook belongs to a Task, but it is read against a Research: the Tasks of
 * one Research share a workspace, and the work one of them ran is the context for
 * what the next one runs. So a notebook opened from Task A stays reachable from
 * Task B, and selecting it there shows A's ledger beside B's conversation
 * rather than navigating away from it. That is the whole difference from
 * `task-tabs.ts`, whose tabs are places to GO; these are things to LOOK AT.
 *
 * Like the Task tabs, the strip persists across navigation between Tasks
 * because it lives in a module store, outside the per-Task screen — which stays
 * mounted across a Task-to-Task route change (`Shell.tsx` gives it no `key`).
 */
import { useSyncExternalStore } from "react";

export interface NotebookTabEntry {
  /** The Research the notebook is read under. Required, unlike a Task tab's:
   *  the inspector exists only for a filed Task, so an unfiled Task has no
   *  notebook tab and there is no unfiled strip to model. */
  researchId: string;
  /** The Task that owns the notebook. There is exactly one notebook per Task,
   *  identified by the Task alone — no path, no notebook id — so this is both
   *  the identity of the tab and the argument `NotebookPanel` needs. */
  taskId: string;
}

let tabs: NotebookTabEntry[] = [];
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
const snapshot = () => tabs;

/**
 * Add a notebook tab, or leave the one already open for it alone.
 *
 * There is nothing to reconcile — an entry is two ids, and a Task's notebook
 * cannot change which Task owns it. So a repeat open is a no-op that emits
 * nothing, which is what makes this safe to call from the same handler that
 * opens the pane, on every click, without churning the strip.
 *
 * A Task moved to another Research is not reconciled here either: its notebook
 * leaves this strip with the Task, and `closeNotebookTab` at the move is what
 * takes it off.
 */
export function openNotebookTab(tab: NotebookTabEntry): void {
  if (tabs.some((t) => t.taskId === tab.taskId)) return;
  tabs = [...tabs, tab];
  emit();
}

/** Close a notebook tab. */
export function closeNotebookTab(taskId: string): void {
  const remaining = tabs.filter((t) => t.taskId !== taskId);
  if (remaining.length === tabs.length) return;
  tabs = remaining;
  emit();
}

/**
 * Close every notebook belonging to a Research — what a deleted Research leaves
 * behind. Without this the inspector would keep offering ledgers whose Research no
 * longer exists to read them against.
 */
export function closeNotebookTabsForResearch(researchId: string): void {
  const remaining = tabs.filter((t) => t.researchId !== researchId);
  if (remaining.length === tabs.length) return;
  tabs = remaining;
  emit();
}

/** The open notebooks for one Research, in open order. `undefined` is the unfiled
 *  Task, which has no workspace to inspect and so never has any — taken rather
 *  than refused, so the Task surface can call this before it knows whether the
 *  Task it is on is filed. */
export function useNotebookTabs(
  researchId: string | undefined,
): NotebookTabEntry[] {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  return researchId === undefined ? [] : all.filter((t) => t.researchId === researchId);
}

/** Non-hook read of a Research's open notebooks (for imperative close). */
export function notebookTabsFor(researchId: string): NotebookTabEntry[] {
  return tabs.filter((t) => t.researchId === researchId);
}
