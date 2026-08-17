/**
 * The strip draws the store: one tab per open place, exactly one of them
 * selected. Nothing here reads the route directly — that is the change this
 * pins, since the single pill it replaced derived itself from `useRoute()` and
 * could only ever show one thing.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import { ApiProvider } from "../api/ApiContext";
import { RouterProvider } from "../router";
import { openTab, resetTabs, tabsSnapshot } from "../lib/tabs";
import { TabBar } from "./TabBar";

function renderTabBar(onNewTab: () => void = () => {}) {
  return render(
    <ApiProvider api={createInMemoryApi(emptySeed())}>
      <RouterProvider>
        <TabBar onNewTab={onNewTab} />
      </RouterProvider>
    </ApiProvider>,
  );
}

/** The route the active tab is pointing at. */
const here = () => {
  const state = tabsSnapshot();
  const tab = state.tabs.find((t) => t.id === state.activeId)!;
  return tab.stack[tab.index].route;
};

beforeEach(() => {
  cleanup();
  // `resetTabs` persists the fresh state as it sets it, so this clears whatever
  // an earlier test left in storage as well as in memory — no separate
  // `localStorage.clear()` is needed.
  resetTabs();
  // The provider adopts the address it mounts on; an empty one adopts nothing.
  window.location.hash = "";
});

describe("TabBar", () => {
  it("draws one tab per open place", async () => {
    openTab({ name: "inbox" });
    openTab({ name: "machines" });
    renderTabBar();

    expect(await screen.findByRole("tab", { name: /Studies/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Inbox/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Machines/ })).toBeInTheDocument();
  });

  it("marks exactly one tab selected", async () => {
    openTab({ name: "inbox" });
    renderTabBar();

    const selected = (await screen.findAllByRole("tab")).filter(
      (t) => t.getAttribute("aria-selected") === "true",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent("Inbox");
  });

  it("goes to a tab when it is clicked", async () => {
    openTab({ name: "inbox" });
    renderTabBar();

    await userEvent.click(screen.getByRole("tab", { name: /Studies/ }));
    expect(here()).toEqual({ name: "studies" });
  });

  it("closes a tab from its own control", async () => {
    openTab({ name: "inbox" });
    renderTabBar();

    await userEvent.click(screen.getByRole("button", { name: "Close Inbox" }));
    expect(tabsSnapshot().tabs).toHaveLength(1);
  });

  /**
   * Named for what it closes. A strip of identically-labelled "Close" controls
   * gives a screen reader no way to tell which tab it is about to shut.
   */
  it("names each close control after its own tab", async () => {
    openTab({ name: "inbox" });
    openTab({ name: "machines" });
    renderTabBar();

    expect(
      await screen.findByRole("button", { name: "Close Inbox" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Close Machines" }),
    ).toBeInTheDocument();
  });

  it("offers no close on the last tab, which cannot go", async () => {
    renderTabBar();
    await screen.findByRole("tab");
    expect(screen.queryByRole("button", { name: /^Close / })).toBeNull();
  });

  /**
   * The plus asks where to go; it does not decide. Opening a tab on a fixed
   * screen made it read as "duplicate what I am looking at", which is what it
   * looked like from the outside — the button in this position opened the
   * palette before the strip existed.
   */
  it("asks the plus's question rather than answering it with a tab", async () => {
    const onNewTab = vi.fn();
    renderTabBar(onNewTab);
    await userEvent.click(screen.getByRole("button", { name: "New tab" }));

    expect(onNewTab).toHaveBeenCalledTimes(1);
    expect(tabsSnapshot().tabs).toHaveLength(1);
  });

  /**
   * `role="tablist"` promises arrow-key movement between tabs, and a screen
   * reader announces it. These pin the promise: without them the roles claim a
   * keyboard contract the strip does not honour.
   */
  describe("keyboard", () => {
    it("moves along the row with the arrow keys, activating as it goes", async () => {
      openTab({ name: "inbox" });
      openTab({ name: "machines" });
      renderTabBar();
      const tabs = await screen.findAllByRole("tab");

      tabs[2].focus();
      await userEvent.keyboard("{ArrowLeft}");
      expect(tabs[1]).toHaveFocus();
      expect(here()).toEqual({ name: "inbox" });

      await userEvent.keyboard("{ArrowRight}");
      expect(tabs[2]).toHaveFocus();
      expect(here()).toEqual({ name: "machines" });
    });

    it("wraps at both ends, the way a strip with no edges would", async () => {
      openTab({ name: "inbox" });
      renderTabBar();
      const tabs = await screen.findAllByRole("tab");

      tabs[0].focus();
      await userEvent.keyboard("{ArrowLeft}");
      expect(tabs[1]).toHaveFocus();

      await userEvent.keyboard("{ArrowRight}");
      expect(tabs[0]).toHaveFocus();
    });

    it("jumps to the first and last tab with Home and End", async () => {
      openTab({ name: "inbox" });
      openTab({ name: "machines" });
      renderTabBar();
      const tabs = await screen.findAllByRole("tab");

      tabs[1].focus();
      await userEvent.keyboard("{Home}");
      expect(tabs[0]).toHaveFocus();

      await userEvent.keyboard("{End}");
      expect(tabs[2]).toHaveFocus();
    });

    /**
     * Focus can be inside a pill without being on its tab — the close control
     * is the other thing in there. An arrow from that position moves relative to
     * the ACTIVE tab, which is the only sensible answer: there is no "current"
     * tab under the cursor to move from.
     */
    it("moves relative to the active tab when focus is on a close control", async () => {
      openTab({ name: "inbox" });
      openTab({ name: "machines" });
      renderTabBar();
      const tabs = await screen.findAllByRole("tab");

      // Machines is active and last; its close control has focus.
      screen.getByRole("button", { name: "Close Machines" }).focus();
      await userEvent.keyboard("{ArrowLeft}");

      expect(tabs[1]).toHaveFocus();
      expect(here()).toEqual({ name: "inbox" });
    });

    /**
     * ⌥1–⌥9 reach a tab from anywhere, not just from inside the strip. ⌘T, ⌘W
     * and ⌘1–9 belong to the browser and cannot be intercepted from a page, so
     * the app does not pretend to own them.
     */
    it("goes to the nth tab on ⌥n, from anywhere", async () => {
      openTab({ name: "inbox" });
      openTab({ name: "machines" });
      renderTabBar();
      await screen.findAllByRole("tab");

      await userEvent.keyboard("{Alt>}1{/Alt}");
      expect(here()).toEqual({ name: "studies" });

      await userEvent.keyboard("{Alt>}2{/Alt}");
      expect(here()).toEqual({ name: "inbox" });
    });

    it("ignores ⌥n past the end of the row", async () => {
      openTab({ name: "inbox" });
      renderTabBar();
      await screen.findAllByRole("tab");
      const before = tabsSnapshot().activeId;

      await userEvent.keyboard("{Alt>}7{/Alt}");
      expect(tabsSnapshot().activeId).toBe(before);
    });

    /**
     * A roving tabindex: the strip is ONE stop on the way through the page, not
     * one per open tab. Tab reaches the strip, arrows move inside it.
     */
    it("puts only the active tab in the tab order", async () => {
      openTab({ name: "inbox" });
      openTab({ name: "machines" });
      renderTabBar();
      const tabs = await screen.findAllByRole("tab");

      expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual([
        "-1",
        "-1",
        "0",
      ]);
    });
  });

  /**
   * The label comes from the entry, not from a read. A Task entry carrying a
   * title shows it; one that has never been opened shows the generic name of
   * its kind rather than nothing.
   */
  it("shows a stored label, and the kind's name when there is none", async () => {
    openTab({ name: "task", studyId: "s_1", taskId: "t_1" }, "CMP-7: Plasticity");
    openTab({ name: "task", studyId: "s_1", taskId: "t_2" });
    renderTabBar();

    expect(
      await screen.findByRole("tab", { name: /CMP-7: Plasticity/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Task$/ })).toBeInTheDocument();
  });
});
