/**
 * Where the strip goes between visits.
 *
 * Two things make this more than a `JSON.stringify` round trip. What comes back
 * has been outside the program — a payload written by an older build, or edited
 * by hand — so every entry has to prove it is still a route this app has. And
 * what goes in are Task titles, which belong to whoever was signed in: they are
 * cleared on sign-out rather than left for the next person at that machine.
 */
import { hasWorkspaceServer } from "../api/select";
import { parseHash, routeHash, type Route } from "../router";
import {
  MAX_STACK,
  reserveIds,
  resetTabs,
  setTabsState,
  type Tab,
  type TabsState,
} from "./tabs";

const PREFIX = "lykeion.tabs.v1";

/**
 * `localStorage` is per-origin already, so this suffix is not what separates
 * one lab from another — it separates `pnpm dev` from `dev:lab`, which share a
 * port and would otherwise inherit each other's tabs.
 */
export function storageKey(): string {
  return `${PREFIX}:${hasWorkspaceServer() ? "lab" : "demo"}`;
}

/** Same keys, same values — a route that lost a field on the way in stringifies
 *  it as "undefined" and round-trips as if it were real. */
function sameShape(a: Route, b: Route): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k, i) =>
      kb[i] === k &&
      (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k],
  );
}

/** A route survives only if it round-trips: whatever `routeHash` writes,
 *  `parseHash` must read back as the same route — the same hash AND the same
 *  fields, since a hash can match while the fields behind it do not (a route
 *  missing a field stringifies it as the literal `"undefined"`, which then
 *  parses back as a route that merely looks the same).
 *
 * This is validation of untrusted input, not route identity — the project's
 * "never a structural deep-equal" rule governs comparisons between two live
 * routes and does not apply here.
 */
function roundTrips(route: Route): boolean {
  try {
    const hash = routeHash(route);
    const parsed = parseHash(hash);
    return routeHash(parsed) === hash && sameShape(parsed, route);
  } catch {
    return false;
  }
}

function numericSuffix(id: string): number {
  const n = Number(id.replace(/^tab_/, ""));
  return Number.isInteger(n) ? n : 0;
}

export function persistTabs(state: TabsState): void {
  try {
    window.localStorage.setItem(
      storageKey(),
      JSON.stringify({ v: 1, tabs: state.tabs, activeId: state.activeId }),
    );
  } catch {
    // Private mode, or a full quota. The strip still works for this visit;
    // refusing to navigate because it cannot be written down would be worse.
  }
}

export function clearStoredTabs(): void {
  try {
    window.localStorage.removeItem(storageKey());
  } catch {
    // Nothing to do — see persistTabs.
  }
  resetTabs();
}

export function restoreTabs(): void {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(storageKey());
  } catch {
    return;
  }
  if (raw === null) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    resetTabs();
    return;
  }

  const payload = parsed as { v?: number; tabs?: unknown; activeId?: unknown };
  if (payload.v !== 1 || !Array.isArray(payload.tabs)) {
    resetTabs();
    return;
  }

  const tabs: Tab[] = [];
  const seen = new Set<string>();
  for (const raw of payload.tabs as Tab[]) {
    if (typeof raw?.id !== "string" || !Array.isArray(raw.stack)) continue;
    // An id is how every operation names a tab, so two tabs answering to one id
    // is not a cosmetic problem: closing it removes both, and the neighbour that
    // should take over is gone with them. Keep the first, drop the rest.
    if (seen.has(raw.id)) continue;
    seen.add(raw.id);
    const filtered = raw.stack.filter(
      (e) => e && typeof e === "object" && roundTrips(e.route),
    );
    if (filtered.length === 0) continue;
    const rawIndex =
      Number.isInteger(raw.index) && raw.index >= 0 && raw.index < filtered.length
        ? raw.index
        : filtered.length - 1;
    // Enforce the same cap `navigate` does, so a payload with more than
    // MAX_STACK round-tripping entries does not restore over it and sit
    // there until the tab happens to navigate again. Dropping from the
    // front shifts `index` by the same amount, so the tab still points at
    // the entry it was on — clamped at 0 in case that entry was itself
    // among the ones dropped.
    const dropped = Math.max(0, filtered.length - MAX_STACK);
    const stack = dropped > 0 ? filtered.slice(dropped) : filtered;
    const index = Math.max(0, rawIndex - dropped);
    tabs.push({ id: raw.id, stack, index });
  }

  if (tabs.length === 0) {
    resetTabs();
    return;
  }

  reserveIds(Math.max(...tabs.map((t) => numericSuffix(t.id))));
  const activeId = tabs.some((t) => t.id === payload.activeId)
    ? (payload.activeId as string)
    : tabs[0].id;
  setTabsState({ tabs, activeId });
}

/**
 * Whether this page has already read the stored strip.
 *
 * Module state, because the question is about the page rather than about any
 * component: `App` may render many times and, on a lab build, mount its
 * workbench more than once as the identity gate opens and closes.
 *
 * Adoption of the incoming address is deliberately NOT tracked here. It is
 * once-per-MOUNT rather than once-per-page — `RouterProvider` owns it with a
 * ref, for the reasons written at that call site.
 */
let restored = false;

/** The stored strip is read once per page — a second restore would throw away
 *  whatever the reader has done since the first. */
export function restoreTabsOnce(): void {
  if (restored) return;
  restored = true;
  restoreTabs();
}

/** Test seam: forget that this page has read the stored strip, so the next
 *  `restoreTabsOnce` behaves like a fresh page load again. A real page loads
 *  exactly once; a suite that mounts `<App>` more than once per file needs
 *  this, since the flag is module state and vitest's per-file isolation clears
 *  it between files, not between `it()` blocks in the same one. */
export function resetPageLoad(): void {
  restored = false;
}
