/**
 * Tabs survive a reload, which means the strip is state that outlives the page
 * — so what it accepts back from storage is a trust boundary, not a formality.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installLocalStorage,
  restoreLocalStorage,
} from "../test/local-storage";
import {
  closeTab,
  navigate,
  openTab,
  resetTabs,
  setTabsState,
  tabsSnapshot,
} from "./tabs";
import { clearStoredTabs, restoreTabs, storageKey } from "./tabs-storage";

beforeEach(() => {
  installLocalStorage();
  resetTabs();
});

afterEach(() => {
  restoreLocalStorage();
});

describe("tab persistence", () => {
  it("brings back the tabs and the active one", () => {
    openTab({ name: "inbox" });
    navigate({ name: "machines" });
    const before = tabsSnapshot();

    // Capture BEFORE resetting: `resetTabs` writes a fresh payload over the
    // stored one, which is correct behaviour and would erase what we are
    // about to restore.
    const raw = window.localStorage.getItem(storageKey())!;
    resetTabs();
    window.localStorage.setItem(storageKey(), raw);
    restoreTabs();

    const after = tabsSnapshot();
    expect(after.tabs.map((t) => t.stack.map((e) => e.route.name))).toEqual(
      before.tabs.map((t) => t.stack.map((e) => e.route.name)),
    );
  });

  it("falls back to one Researches tab on a corrupt payload", () => {
    window.localStorage.setItem(storageKey(), "{not json");
    restoreTabs();
    expect(tabsSnapshot().tabs).toHaveLength(1);
    expect(tabsSnapshot().tabs[0].stack[0].route).toEqual({ name: "researches" });
  });

  it("drops entries whose route does not round-trip", () => {
    window.localStorage.setItem(
      storageKey(),
      JSON.stringify({
        v: 1,
        activeId: "tab_9",
        tabs: [
          {
            id: "tab_9",
            index: 1,
            stack: [
              { route: { name: "inbox" } },
              { route: { name: "not-a-route" } },
            ],
          },
        ],
      }),
    );
    restoreTabs();
    const tabs = tabsSnapshot().tabs;
    expect(tabs[0].stack.map((e) => e.route.name)).toEqual(["inbox"]);
    expect(tabs[0].index).toBe(0);
  });

  it("falls back when the stored active id names no tab", () => {
    window.localStorage.setItem(
      storageKey(),
      JSON.stringify({
        v: 1,
        activeId: "tab_gone",
        tabs: [{ id: "tab_9", index: 0, stack: [{ route: { name: "inbox" } }] }],
      }),
    );
    restoreTabs();
    expect(tabsSnapshot().activeId).toBe("tab_9");
  });

  it("does not hand the next person the last one's tabs", () => {
    navigate({ name: "task", researchId: "s_1", taskId: "t_1" });
    clearStoredTabs();

    // Cleared, not emptied: `clearStoredTabs` resets the store, and that reset
    // persists — so what is left on disk is one Researches tab, carrying nothing
    // of the last session.
    expect(tabsSnapshot().tabs[0].stack[0].route).toEqual({ name: "researches" });
    const stored = JSON.parse(window.localStorage.getItem(storageKey())!);
    expect(stored.tabs).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain("t_1");
  });

  /**
   * An id is how every operation names a tab, so two tabs answering to one id is
   * not cosmetic: `closeTab` filters by id, removes both, and then reaches for a
   * neighbour that left with them. That threw a TypeError — a white screen from a
   * payload the app never wrote, which is exactly what this validator is for.
   */
  it("drops a duplicate tab id rather than letting a close crash", () => {
    window.localStorage.setItem(
      storageKey(),
      JSON.stringify({
        v: 1,
        activeId: "tab_1",
        tabs: [
          { id: "tab_1", index: 0, stack: [{ route: { name: "researches" } }] },
          { id: "tab_1", index: 0, stack: [{ route: { name: "inbox" } }] },
        ],
      }),
    );

    restoreTabs();
    expect(tabsSnapshot().tabs).toHaveLength(1);

    // And the second line of defence, for a duplicate that reached the store by
    // any other route: closing never empties the strip.
    setTabsState({
      tabs: [
        { id: "dup", stack: [{ route: { name: "researches" } }], index: 0 },
        { id: "dup", stack: [{ route: { name: "inbox" } }], index: 0 },
      ],
      activeId: "dup",
    });
    expect(() => closeTab("dup")).not.toThrow();
    expect(tabsSnapshot().tabs.length).toBeGreaterThan(0);
  });

  it("survives storage that refuses to be written", () => {
    const setItem = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => navigate({ name: "inbox" })).not.toThrow();
    window.localStorage.setItem = setItem;
  });

  // A route missing a field stringifies that field as the literal "undefined"
  // (`routeHash({name:"task"})` builds `#/researches/undefined/tasks/undefined`)
  // and `parseHash` reads that back as `{name:"task", researchId:"undefined",
  // taskId:"undefined"}` — same hash, different route. `roundTrips` must
  // reject it on shape, not just on hash equality.
  it("rejects a stored route missing fields, even though its hash round-trips", () => {
    window.localStorage.setItem(
      storageKey(),
      JSON.stringify({
        v: 1,
        activeId: "tab_9",
        tabs: [
          {
            id: "tab_9",
            index: 1,
            stack: [{ route: { name: "inbox" } }, { route: { name: "task" } }],
          },
        ],
      }),
    );
    restoreTabs();
    const tabs = tabsSnapshot().tabs;
    expect(tabs[0].stack.map((e) => e.route.name)).toEqual(["inbox"]);
    expect(tabs[0].index).toBe(0);
  });

  it("still accepts a complete task route", () => {
    window.localStorage.setItem(
      storageKey(),
      JSON.stringify({
        v: 1,
        activeId: "tab_9",
        tabs: [
          {
            id: "tab_9",
            index: 0,
            stack: [
              { route: { name: "task", researchId: "s_1", taskId: "t_1" } },
            ],
          },
        ],
      }),
    );
    restoreTabs();
    const tabs = tabsSnapshot().tabs;
    expect(tabs[0].stack.map((e) => e.route)).toEqual([
      { name: "task", researchId: "s_1", taskId: "t_1" },
    ]);
  });

  it("caps a restored stack at 50 entries, keeping the current entry", () => {
    const stack = Array.from({ length: 60 }, (_, i) => ({
      route: { name: "agent", agentId: `a_${i}` },
    }));
    window.localStorage.setItem(
      storageKey(),
      JSON.stringify({
        v: 1,
        activeId: "tab_9",
        tabs: [{ id: "tab_9", index: 55, stack }],
      }),
    );
    restoreTabs();
    const tab = tabsSnapshot().tabs[0];
    expect(tab.stack).toHaveLength(50);
    // 60 entries in, capped to the last 50: the oldest 10 are gone, so the
    // first surviving entry is a_10 — and the entry the tab was on (a_55,
    // at index 55 before the slice) is still the one `index` points at.
    expect(tab.stack[0].route).toEqual({ name: "agent", agentId: "a_10" });
    expect(tab.stack[tab.index].route).toEqual({
      name: "agent",
      agentId: "a_55",
    });
  });
});
