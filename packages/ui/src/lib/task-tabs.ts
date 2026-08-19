/**
 * The open-Task tabs — the breadcrumb "tab strip" for the Task surface.
 * Opening a Task adds a tab; the strip persists across navigation between
 * Tasks because it lives in a module store, outside the per-Task screen —
 * which stays mounted across a Task-to-Task route change (`Shell.tsx` gives
 * it no `key`) and resets its own state itself, keyed on `taskId`, rather
 * than remounting.
 */
import { useSyncExternalStore } from "react";

export interface TaskTabEntry {
  /** The Research the tab is filed under, or absent for an unfiled Task — which
   *  has its own strip, since it shares a breadcrumb with no Research. */
  researchId?: string;
  taskId: string;
  title: string;
}

let tabs: TaskTabEntry[] = [];
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
 * Add a Task tab, or reconcile the one already open for it.
 *
 * A tab is keyed by its Task, not by the Research it was opened under, so the
 * Research is reconciled along with the title. Filing an unfiled Task — or
 * moving a Task between Researches — changes which strip its tab belongs to, and
 * a tab left under the Research it was opened in vanishes from the breadcrumb the
 * moment the surface follows the Task to its new one.
 */
export function openTaskTab(tab: TaskTabEntry): void {
  const existing = tabs.find((t) => t.taskId === tab.taskId);
  if (!existing) {
    tabs = [...tabs, tab];
    emit();
  } else if (
    existing.title !== tab.title ||
    existing.researchId !== tab.researchId
  ) {
    tabs = tabs.map((t) =>
      t.taskId === tab.taskId
        ? { ...t, researchId: tab.researchId, title: tab.title }
        : t,
    );
    emit();
  }
}

/**
 * Retitle an open tab after a rename. The active Task's tab already tracks
 * the persisted list; this keeps the *other* open tabs from showing a stale
 * title until they're reopened.
 */
export function renameTaskTab(taskId: string, title: string): void {
  if (!tabs.some((t) => t.taskId === taskId && t.title !== title)) return;
  tabs = tabs.map((t) => (t.taskId === taskId ? { ...t, title } : t));
  emit();
}

/** Close a Task tab. */
export function closeTaskTab(taskId: string): void {
  tabs = tabs.filter((t) => t.taskId !== taskId);
  emit();
}

/**
 * Close every tab belonging to a Research — what a deleted Research leaves behind.
 * Without this the breadcrumb would keep offering Tasks that no longer open.
 */
export function closeTaskTabsForResearch(researchId: string): void {
  const remaining = tabs.filter((t) => t.researchId !== researchId);
  if (remaining.length === tabs.length) return;
  tabs = remaining;
  emit();
}

/** The open Task tabs for one Research, in open order. `undefined` asks for the
 *  unfiled ones, which share a strip of their own. */
export function useTaskTabs(researchId: string | undefined): TaskTabEntry[] {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  return all.filter((t) => t.researchId === researchId);
}

/** Non-hook read of a Research's open tabs (for imperative close/navigation). */
export function taskTabsFor(researchId: string | undefined): TaskTabEntry[] {
  return tabs.filter((t) => t.researchId === researchId);
}
