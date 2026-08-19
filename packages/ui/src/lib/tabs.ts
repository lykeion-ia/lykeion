/**
 * The app's open tabs — one per place the researcher has open, each with its
 * own history.
 *
 * A module store rather than React state, for the same reason `task-tabs.ts`
 * is one: this outlives every screen that writes to it, and `RouterProvider`
 * reads it to answer `useRoute()`. Keeping it outside React also makes it
 * testable as plain logic, which is most of what it is.
 *
 * Route identity here is always `routeHash(route)`. It is the canonical string
 * for a route, it is pure, and it is already tested — a structural deep-equal
 * would be a second definition of the same thing, free to drift from the first.
 */
import { useSyncExternalStore } from "react";
import { routeHash, type Route } from "../router";
import { persistTabs } from "./tabs-storage";

export interface TabEntry {
  route: Route;
  /**
   * Only for routes whose name is data — `research` and `task`. Static routes are
   * named by `routeLabel()` and store nothing, so a renamed nav item cannot
   * leave stale copies of its old name in storage.
   */
  label?: string;
}

/**
 * A note on what this store does NOT enforce.
 *
 * `join`, `pair` and `setup` must never become tabs: each carries something the
 * workbench has no screen for, and two of them carry a working credential whose
 * only copy is the fragment somebody was handed. That rule lives in `router.tsx`
 * — `handedLink`, checked at every point a route arrives from outside — and not
 * here, because this module cannot tell an adopted address from a deliberate
 * one. Anything reaching `openTab`, `navigate` or `adoptRoute` is taken at its
 * word and written to storage, so a new caller has to honour the rule itself.
 */

export interface Tab {
  id: string;
  stack: TabEntry[];
  index: number;
}

export interface TabsState {
  tabs: Tab[];
  activeId: string;
}

/** Longest a tab's stack grows before the oldest entry is dropped. A long
 *  session must not be able to grow the persisted payload without bound —
 *  `tabs-storage.ts` enforces the same cap on the way in, since a stack that
 *  arrived over the cap would otherwise sit there until it next navigated. */
export const MAX_STACK = 50;

const HOME: Route = { name: "researches" };

let nextId = 1;
const newId = () => `tab_${nextId++}`;

/** Lets a restore continue the id sequence instead of colliding with it. */
export function reserveIds(above: number): void {
  nextId = Math.max(nextId, above + 1);
}

function freshState(): TabsState {
  const id = newId();
  return { tabs: [{ id, stack: [{ route: HOME }], index: 0 }], activeId: id };
}

let state: TabsState = freshState();

const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
const snapshot = () => state;

/** Non-hook read, for imperative callers and tests. */
export function tabsSnapshot(): TabsState {
  return state;
}

/** Replace the whole state. The one write path, so persistence has exactly one
 *  place to hook (see `tabs-storage.ts`). */
export function setTabsState(next: TabsState): void {
  state = next;
  persistTabs(next);
  emit();
}

/** Back to a single Researches tab. Sign-out and a corrupt payload both land
 *  here, and so does every test's `beforeEach`. */
export function resetTabs(): void {
  setTabsState(freshState());
}

function activeOf(s: TabsState): Tab {
  return s.tabs.find((t) => t.id === s.activeId) ?? s.tabs[0];
}

function mapTab(s: TabsState, id: string, fn: (t: Tab) => Tab): TabsState {
  return { ...s, tabs: s.tabs.map((t) => (t.id === id ? fn(t) : t)) };
}

/**
 * Go somewhere in the active tab: drop whatever was ahead, push, advance.
 *
 * Navigating to where you already are is not history — clicking the rail item
 * you are already on would otherwise stack duplicates that `back` then has to
 * walk through one by one. A better label for the same place is still worth
 * taking, which is the one thing that case writes.
 */
export function navigate(route: Route, label?: string): void {
  const tab = activeOf(state);
  const current = tab.stack[tab.index];
  if (current && routeHash(current.route) === routeHash(route)) {
    if (label === undefined || current.label === label) return;
    setTabsState(
      mapTab(state, tab.id, (t) => ({
        ...t,
        stack: t.stack.map((e, i) => (i === t.index ? { ...e, label } : e)),
      })),
    );
    return;
  }
  const kept = [...tab.stack.slice(0, tab.index + 1), { route, label }];
  const stack = kept.length > MAX_STACK ? kept.slice(kept.length - MAX_STACK) : kept;
  setTabsState(
    mapTab(state, tab.id, (t) => ({ ...t, stack, index: stack.length - 1 })),
  );
}

/**
 * Open a tab at the end of the strip and go to it — ⌘-click, middle-click, `+`,
 * a rail section.
 *
 * At the END, not beside the tab that opened it. A browser inserts next to the
 * opener, but the strip here is read as a list of what is open, in the order it
 * was opened: something appearing in the middle of that list moves everything
 * after it along, and the reader has to find where their other tabs went. Last
 * is the one position that disturbs nothing already on screen.
 */
export function openTab(route: Route, label?: string): void {
  const id = newId();
  setTabsState({
    tabs: [...state.tabs, { id, stack: [{ route, label }], index: 0 }],
    activeId: id,
  });
}

/**
 * Take a route that arrived from outside — a cold deep link — into the strip.
 * A tab already sitting on it is activated rather than duplicated: two tabs on
 * one Task because a link was opened twice is a worse answer than going to the
 * one that is already there.
 */
export function adoptRoute(route: Route, label?: string): void {
  const hash = routeHash(route);
  const existing = state.tabs.find(
    (t) => routeHash(t.stack[t.index].route) === hash,
  );
  if (existing) {
    activateTab(existing.id);
    return;
  }
  openTab(route, label);
}

/** Close a tab, activating its right neighbour — or its left, at the end of
 *  the row. The last tab does not close: there is no such thing as no app. */
export function closeTab(id: string): void {
  if (state.tabs.length <= 1) return;
  const at = state.tabs.findIndex((t) => t.id === id);
  if (at === -1) return;
  const tabs = state.tabs.filter((t) => t.id !== id);
  // Closing by id can remove more than one tab, if a payload written outside
  // this app carried the same id twice — `tabs-storage` drops those on the way
  // in, and this is the second line: never leave the strip with nothing in it.
  if (tabs.length === 0) {
    resetTabs();
    return;
  }
  // Ask whether the active tab SURVIVED rather than whether it was the target,
  // for the same reason: with a duplicate id, the tab being closed and the tab
  // that was active can both be `id` and one of them can still be standing.
  const activeId = tabs.some((t) => t.id === state.activeId)
    ? state.activeId
    : (tabs[at] ?? tabs[tabs.length - 1]).id;
  setTabsState({ tabs, activeId });
}

/** Switch tabs. Deliberately not a history entry — see the spec. */
export function activateTab(id: string): void {
  if (state.activeId === id || !state.tabs.some((t) => t.id === id)) return;
  setTabsState({ ...state, activeId: id });
}

function step(delta: number): void {
  const tab = activeOf(state);
  const index = tab.index + delta;
  if (index < 0 || index >= tab.stack.length) return;
  setTabsState(mapTab(state, tab.id, (t) => ({ ...t, index })));
}

export function back(): void {
  step(-1);
}

export function forward(): void {
  step(1);
}

/**
 * Give a route its real name, everywhere it appears.
 *
 * Every copy, in any tab at any stack depth — a Task open in two tabs is one
 * Task, and a rename that fixed only the one being read would leave the other
 * tab naming something that no longer exists.
 */
export function reconcileLabel(route: Route, label: string): void {
  const hash = routeHash(route);
  let changed = false;
  const tabs = state.tabs.map((t) => ({
    ...t,
    stack: t.stack.map((e) => {
      if (routeHash(e.route) !== hash || e.label === label) return e;
      changed = true;
      return { ...e, label };
    }),
  }));
  if (!changed) return;
  setTabsState({ ...state, tabs });
}

/**
 * Cut entries out of every stack, keeping each tab pointed at the entry it was
 * on when that entry survived. Deleting something must not leave a tab offering
 * a place that no longer opens.
 */
function cutEntries(keep: (route: Route) => boolean): void {
  const tabs: Tab[] = [];
  let changed = false;
  for (const t of state.tabs) {
    const stack = t.stack.filter((e) => keep(e.route));
    if (stack.length !== t.stack.length) changed = true;
    if (stack.length === 0) continue;
    const current = t.stack[t.index];
    const at = stack.indexOf(current);
    // The entry being read survived: follow it. It did not: fall back to the
    // nearest survivor BEHIND it, because losing where you are should move you
    // back the way ‹ does, never forward onto somewhere you had not reached.
    const keptBefore = t.stack
      .slice(0, t.index)
      .filter((e) => keep(e.route)).length;
    tabs.push({
      ...t,
      stack,
      index: at >= 0 ? at : Math.max(0, keptBefore - 1),
    });
  }
  if (!changed) return;
  if (tabs.length === 0) {
    resetTabs();
    return;
  }
  const activeId = tabs.some((t) => t.id === state.activeId)
    ? state.activeId
    : tabs[0].id;
  setTabsState({ tabs, activeId });
}

/** What a deleted Research leaves behind: its own screen, and every Task in it. */
export function closeTabsForResearch(researchId: string): void {
  cutEntries(
    (r) =>
      !(
        (r.name === "research" && r.researchId === researchId) ||
        (r.name === "task" && r.researchId === researchId)
      ),
  );
}

/** What a deleted Task leaves behind. */
export function closeTabsForRoute(route: Route): void {
  const hash = routeHash(route);
  cutEntries((r) => routeHash(r) !== hash);
}

export function useTabs(): TabsState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Whether the ‹ › controls have anywhere to go, so they render disabled at the
 *  ends of a tab's history rather than claiming a move they cannot make. */
export function useHistoryState(): {
  canGoBack: boolean;
  canGoForward: boolean;
} {
  const s = useTabs();
  const tab = activeOf(s);
  return {
    canGoBack: tab.index > 0,
    canGoForward: tab.index < tab.stack.length - 1,
  };
}
