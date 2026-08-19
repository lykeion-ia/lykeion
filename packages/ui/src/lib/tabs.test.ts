/**
 * The tab store is the app's navigation state: which places are open, and
 * where each of them has been. It is pure and synchronous, so it is tested as
 * plain logic rather than through a rendered strip.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  activateTab,
  adoptRoute,
  back,
  closeTab,
  closeTabsForRoute,
  closeTabsForResearch,
  forward,
  navigate,
  openTab,
  reconcileLabel,
  resetTabs,
  tabsSnapshot,
} from "./tabs";

const active = () => {
  const s = tabsSnapshot();
  return s.tabs.find((t) => t.id === s.activeId)!;
};
const here = () => active().stack[active().index].route;

beforeEach(() => resetTabs());

describe("tab store", () => {
  it("starts on one Researches tab", () => {
    expect(tabsSnapshot().tabs).toHaveLength(1);
    expect(here()).toEqual({ name: "researches" });
  });

  it("pushes onto the active tab and walks back and forward", () => {
    navigate({ name: "inbox" });
    navigate({ name: "machines" });
    expect(active().stack).toHaveLength(3);

    back();
    expect(here()).toEqual({ name: "inbox" });
    back();
    expect(here()).toEqual({ name: "researches" });
    forward();
    expect(here()).toEqual({ name: "inbox" });
  });

  it("stops at the ends instead of wrapping", () => {
    back();
    back();
    expect(here()).toEqual({ name: "researches" });
    forward();
    forward();
    expect(here()).toEqual({ name: "researches" });
  });

  it("drops the forward entries when you navigate after going back", () => {
    navigate({ name: "inbox" });
    navigate({ name: "machines" });
    back();
    navigate({ name: "agents" });

    expect(active().stack.map((e) => e.route.name)).toEqual([
      "researches",
      "inbox",
      "agents",
    ]);
  });

  it("treats navigating to where you already are as no news", () => {
    navigate({ name: "inbox" });
    navigate({ name: "inbox" });
    expect(active().stack).toHaveLength(2);
  });

  it("opens a new tab and activates it", () => {
    openTab({ name: "inbox" });
    const s = tabsSnapshot();
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs[1].id).toBe(s.activeId);
    expect(here()).toEqual({ name: "inbox" });
  });

  /**
   * At the end of the strip, not beside the tab that opened it. Inserting in the
   * middle shifts everything after it along, so a reader who opened a section
   * from the second of four tabs would have to find where the rest went.
   */
  it("opens at the end even when the active tab is not the last", () => {
    openTab({ name: "inbox" });
    openTab({ name: "machines" });
    const middle = tabsSnapshot().tabs[1];
    activateTab(middle.id);

    openTab({ name: "agents" });

    const s = tabsSnapshot();
    expect(s.tabs.map((t) => t.stack[t.index].route.name)).toEqual([
      "researches",
      "inbox",
      "machines",
      "agents",
    ]);
    expect(s.tabs[3].id).toBe(s.activeId);
  });

  it("activates the right neighbour on close, then the left", () => {
    openTab({ name: "inbox" });
    openTab({ name: "machines" });
    const [first, second, third] = tabsSnapshot().tabs;

    activateTab(second.id);
    closeTab(second.id);
    expect(tabsSnapshot().activeId).toBe(third.id);

    closeTab(third.id);
    expect(tabsSnapshot().activeId).toBe(first.id);
  });

  it("refuses to close the last tab", () => {
    closeTab(tabsSnapshot().activeId);
    expect(tabsSnapshot().tabs).toHaveLength(1);
  });

  it("activates a tab already on a route rather than duplicating it", () => {
    openTab({ name: "inbox" });
    const inboxTab = tabsSnapshot().activeId;
    openTab({ name: "machines" });

    adoptRoute({ name: "inbox" });
    expect(tabsSnapshot().tabs).toHaveLength(3);
    expect(tabsSnapshot().activeId).toBe(inboxTab);
  });

  it("relabels every copy of a route, in any tab at any depth", () => {
    const task = { name: "task", researchId: "s_1", taskId: "t_1" } as const;
    navigate(task, "CMP-1: old");
    navigate({ name: "inbox" });
    openTab(task, "CMP-1: old");

    reconcileLabel(task, "CMP-1: new");

    const labels = tabsSnapshot()
      .tabs.flatMap((t) => t.stack)
      .filter((e) => e.route.name === "task")
      .map((e) => e.label);
    expect(labels).toEqual(["CMP-1: new", "CMP-1: new"]);
  });

  it("cuts a deleted Research's entries out of every stack", () => {
    navigate({ name: "research", researchId: "s_1" });
    navigate({ name: "task", researchId: "s_1", taskId: "t_1" });
    navigate({ name: "machines" });

    closeTabsForResearch("s_1");

    expect(active().stack.map((e) => e.route.name)).toEqual([
      "researches",
      "machines",
    ]);
    expect(here()).toEqual({ name: "machines" });
  });

  it("keeps one tab when a deleted Research emptied them all", () => {
    resetTabs();
    openTab({ name: "research", researchId: "s_1" });
    closeTab(tabsSnapshot().tabs[0].id);

    closeTabsForResearch("s_1");

    expect(tabsSnapshot().tabs).toHaveLength(1);
    expect(here()).toEqual({ name: "researches" });
  });

  it("cuts a deleted Task's entries out", () => {
    const task = { name: "task", researchId: "s_1", taskId: "t_1" } as const;
    navigate(task);
    navigate({ name: "inbox" });

    closeTabsForRoute(task);

    expect(active().stack.map((e) => e.route.name)).toEqual([
      "researches",
      "inbox",
    ]);
  });

  it("falls back behind the cut entry, never ahead of it", () => {
    navigate({ name: "inbox" });
    navigate({ name: "research", researchId: "s_1" });
    navigate({ name: "agents" });
    back(); // sitting on the Research itself

    closeTabsForResearch("s_1");

    expect(here()).toEqual({ name: "inbox" });
  });

  it("caps a stack at 50 entries, dropping the oldest", () => {
    for (let i = 0; i < 60; i += 1) {
      navigate({ name: "agent", agentId: `a_${i}` });
    }
    const stack = active().stack;
    expect(stack).toHaveLength(50);
    expect(stack[0].route).toEqual({ name: "agent", agentId: "a_10" });
    expect(stack[49].route).toEqual({ name: "agent", agentId: "a_59" });
  });
});
