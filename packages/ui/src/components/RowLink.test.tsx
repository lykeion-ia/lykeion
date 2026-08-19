/**
 * ⌘-click has meant nothing here since this component was written: it calls
 * `preventDefault` unconditionally, so the modifier was swallowed and the row
 * navigated in place like any other click. It opens a tab now — in THIS app,
 * not a second copy of it in the browser, which is what following the `href`
 * would have done.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RouterProvider } from "../router";
import { activateTab, resetTabs, tabsSnapshot } from "../lib/tabs";
import { RowLink } from "./RowLink";

function renderLink() {
  return render(
    <RouterProvider>
      <RowLink to={{ name: "machines" }}>Machines</RowLink>
    </RouterProvider>,
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
  resetTabs();
  // The provider adopts the address it mounts on; an empty one adopts nothing.
  window.location.hash = "";
});

describe("RowLink", () => {
  it("navigates the active tab on a plain click", async () => {
    renderLink();
    await userEvent.click(screen.getByRole("link"));

    expect(tabsSnapshot().tabs).toHaveLength(1);
    expect(here()).toEqual({ name: "machines" });
  });

  it("opens a new tab on ⌘-click, leaving the old one where it was", async () => {
    // One `user` for the whole gesture: a held modifier lives on the instance,
    // so the bare `userEvent.click` helper — a fresh instance each call — would
    // drop it and land an ordinary click.
    const user = userEvent.setup();
    renderLink();
    await user.keyboard("{Meta>}");
    await user.click(screen.getByRole("link"));
    await user.keyboard("{/Meta}");

    const state = tabsSnapshot();
    expect(state.tabs).toHaveLength(2);
    expect(here()).toEqual({ name: "machines" });
    // The tab that was active before is untouched — that is the whole point of
    // a modifier click: it adds somewhere without leaving where you are.
    expect(state.tabs[0].stack[state.tabs[0].index].route).toEqual({
      name: "researches",
    });
  });

  it("opens a new tab on Ctrl-click, for the same reason", async () => {
    const user = userEvent.setup();
    renderLink();
    await user.keyboard("{Control>}");
    await user.click(screen.getByRole("link"));
    await user.keyboard("{/Control}");

    expect(tabsSnapshot().tabs).toHaveLength(2);
    expect(here()).toEqual({ name: "machines" });
  });

  it("opens a new tab on middle click", async () => {
    renderLink();
    await userEvent.pointer({
      target: screen.getByRole("link"),
      keys: "[MouseMiddle]",
    });

    expect(tabsSnapshot().tabs).toHaveLength(2);
    expect(here()).toEqual({ name: "machines" });
  });

  /**
   * A rail section is a place you keep open, so it gets a tab of its own rather
   * than spending the one you are reading — and going back to it activates that
   * tab rather than opening a second Inbox.
   */
  describe("a row that owns its tab", () => {
    function renderOwnTab() {
      return render(
        <RouterProvider>
          <RowLink to={{ name: "machines" }} ownTab>
            Machines
          </RowLink>
        </RouterProvider>,
      );
    }

    it("opens its own tab instead of spending the current one", async () => {
      renderOwnTab();
      await userEvent.click(screen.getByRole("link"));

      const state = tabsSnapshot();
      expect(state.tabs).toHaveLength(2);
      expect(here()).toEqual({ name: "machines" });
      // The tab that was active is untouched.
      expect(state.tabs[0].stack[state.tabs[0].index].route).toEqual({
        name: "researches",
      });
    });

    it("goes back to that tab rather than opening a second one", async () => {
      renderOwnTab();
      await userEvent.click(screen.getByRole("link"));
      const opened = tabsSnapshot().activeId;

      // Leave, then come back the same way.
      activateTab(tabsSnapshot().tabs[0].id);
      await userEvent.click(screen.getByRole("link"));

      expect(tabsSnapshot().tabs).toHaveLength(2);
      expect(tabsSnapshot().activeId).toBe(opened);
    });

    it("still opens a genuinely new tab on ⌘-click", async () => {
      const user = userEvent.setup();
      renderOwnTab();
      await user.click(screen.getByRole("link"));

      await user.keyboard("{Meta>}");
      await user.click(screen.getByRole("link"));
      await user.keyboard("{/Meta}");

      // Three: the original, the section's own, and the one forced open.
      expect(tabsSnapshot().tabs).toHaveLength(3);
    });
  });

  it("keeps the real href, so the row is still a link", () => {
    renderLink();
    // The anchor is the navigation primitive precisely because it is a real
    // link: focusable, announced as one, and copyable as an address.
    expect(screen.getByRole("link")).toHaveAttribute("href", "#/machines");
  });
});
