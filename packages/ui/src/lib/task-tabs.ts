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
  /** The Study the tab is filed under, or absent for an unfiled Task — which
   *  has its own strip, since it shares a breadcrumb with no Study. */
  studyId?: string;
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
 * A tab is keyed by its Task, not by the Study it was opened under, so the
 * Study is reconciled along with the title. Filing an unfiled Task — or
 * moving a Task between Studies — changes which strip its tab belongs to, and
 * a tab left under the Study it was opened in vanishes from the breadcrumb the
 * moment the surface follows the Task to its new one.
 */
export function openTaskTab(tab: TaskTabEntry): void {
  const existing = tabs.find((t) => t.taskId === tab.taskId);
  if (!existing) {
    tabs = [...tabs, tab];
    emit();
  } else if (
    existing.title !== tab.title ||
    existing.studyId !== tab.studyId
  ) {
    tabs = tabs.map((t) =>
      t.taskId === tab.taskId
        ? { ...t, studyId: tab.studyId, title: tab.title }
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
 * Close every tab belonging to a Study — what a deleted Study leaves behind.
 * Without this the breadcrumb would keep offering Tasks that no longer open.
 */
export function closeTaskTabsForStudy(studyId: string): void {
  const remaining = tabs.filter((t) => t.studyId !== studyId);
  if (remaining.length === tabs.length) return;
  tabs = remaining;
  emit();
}

/** The open Task tabs for one Study, in open order. `undefined` asks for the
 *  unfiled ones, which share a strip of their own. */
export function useTaskTabs(studyId: string | undefined): TaskTabEntry[] {
  const all = useSyncExternalStore(subscribe, snapshot, snapshot);
  return all.filter((t) => t.studyId === studyId);
}

/** Non-hook read of a Study's open tabs (for imperative close/navigation). */
export function taskTabsFor(studyId: string | undefined): TaskTabEntry[] {
  return tabs.filter((t) => t.studyId === studyId);
}
