/**
 * The switcher heads both left panes, so anything sharing its row is on screen
 * on every route. That is why the ‹ › history controls live here rather than in
 * the TabBar: one set, one place, unmoved by the Rail/Task-pane swap.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import { ApiProvider } from "../api/ApiContext";
import { RouterProvider } from "../router";
import { navigate, resetTabs, tabsSnapshot } from "../lib/tabs";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

function renderSwitcher() {
  return render(
    <ApiProvider api={createInMemoryApi(emptySeed())}>
      <RouterProvider>
        <WorkspaceSwitcher />
      </RouterProvider>
    </ApiProvider>,
  );
}

/** Where the active tab is pointing. */
const here = () => {
  const state = tabsSnapshot();
  const tab = state.tabs.find((t) => t.id === state.activeId)!;
  return tab.stack[tab.index].route;
};

beforeEach(() => {
  cleanup();
  // The store is module state, so each test starts it over. No `localStorage`
  // shim is needed for that: `persistTabs` already swallows a store that
  // refuses to be written, which is exactly what jsdom's bare object does.
  resetTabs();
  // The provider adopts whatever address it mounts on; an empty one adopts
  // nothing, which is what these tests want.
  window.location.hash = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkspaceSwitcher", () => {
  it("seats the history controls on the workspace row", async () => {
    const { container } = renderSwitcher();
    const row = (await screen.findByRole("button", { name: "Workspace" }))
      .parentElement!;
    expect(container.contains(row)).toBe(true);
    for (const name of ["Back", "Forward"]) {
      const button = screen.getByRole("button", { name });
      expect(row.contains(button)).toBe(true);
    }
  });

  /**
   * The active tab's stack, not the browser's history. Those were the same
   * thing while the router pushed a history entry per navigation; they stopped
   * being the same when each tab started carrying its own, and the URL became
   * a `replaceState` mirror with no entries of its own to walk.
   */
  it("walks the active tab's history, not the browser's", async () => {
    // Asserting the destination alone would not discriminate: jsdom's own
    // `history.back()` fires `popstate`, which `sync` turns into a navigation,
    // so the old implementation lands in roughly the right place by accident.
    // What changed is the mechanism, so that is what this pins.
    const browserBack = vi.spyOn(window.history, "back");
    const browserForward = vi.spyOn(window.history, "forward");
    navigate({ name: "inbox" });
    renderSwitcher();

    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(here()).toEqual({ name: "researches" });

    await userEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(here()).toEqual({ name: "inbox" });

    expect(browserBack).not.toHaveBeenCalled();
    expect(browserForward).not.toHaveBeenCalled();
  });

  /**
   * A control with nowhere to go says so. `window.history.back()` never could:
   * it was always enabled and did nothing about half the time, which reads as
   * the app having ignored the click.
   */
  it("disables a control with nowhere to go", async () => {
    renderSwitcher();
    await screen.findByRole("button", { name: "Workspace" });

    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
  });

  it("re-enables forward only once there is something ahead", async () => {
    navigate({ name: "inbox" });
    renderSwitcher();

    expect(screen.getByRole("button", { name: "Back" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeEnabled();
  });

  it("still opens the account menu from the workspace button", async () => {
    renderSwitcher();
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Workspace" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });
});
