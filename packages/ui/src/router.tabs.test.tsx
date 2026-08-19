/**
 * The router stopped owning the route when tabs started owning it. These pin
 * the four rules that decide where a navigation lands, which is the part a
 * reader cannot see from either module alone.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { RouterProvider, routeHash, useRouter } from "./router";
import { resetTabs, tabsSnapshot } from "./lib/tabs";
import { storageKey } from "./lib/tabs-storage";
import { installLocalStorage, restoreLocalStorage } from "./test/local-storage";

function Probe() {
  const { route, navigate } = useRouter();
  return (
    <button onClick={() => navigate({ name: "machines" })}>
      {routeHash(route)}
    </button>
  );
}

const renderAt = (hash: string) => {
  window.location.hash = hash;
  return render(
    <RouterProvider>
      <Probe />
    </RouterProvider>,
  );
};

beforeEach(() => {
  cleanup();
  // jsdom's own `localStorage` here is a bare object with none of Storage's
  // methods on it — see `test/local-storage.ts`. A real one is required
  // because `resetTabs()` persists through it.
  installLocalStorage();
  resetTabs();
  window.location.hash = "";
});

afterEach(() => {
  restoreLocalStorage();
});

describe("router over tabs", () => {
  it("navigates the active tab, not a new one", async () => {
    renderAt("#/inbox");
    const before = tabsSnapshot().tabs.length;

    await act(async () => {
      screen.getByRole("button").click();
    });

    expect(tabsSnapshot().tabs).toHaveLength(before);
    expect(screen.getByRole("button")).toHaveTextContent("#/machines");
  });

  it("mirrors the active tab with replaceState, leaving no history entry", async () => {
    renderAt("#/inbox");
    const depth = window.history.length;

    await act(async () => {
      screen.getByRole("button").click();
    });

    expect(window.location.hash).toBe("#/machines");
    expect(window.history.length).toBe(depth);
  });

  it("sends a hash typed into the address bar to the active tab", async () => {
    renderAt("#/inbox");
    const before = tabsSnapshot().tabs.length;

    await act(async () => {
      window.location.hash = "#/machines";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(tabsSnapshot().tabs).toHaveLength(before);
    expect(screen.getByRole("button")).toHaveTextContent("#/machines");
  });

  it("never makes a tab out of a pairing link", async () => {
    renderAt("#/pair?name=lab-mini&challenge=abc");
    expect(screen.getByRole("button")).toHaveTextContent("#/pair?");
    expect(
      tabsSnapshot().tabs.flatMap((t) => t.stack).map((e) => e.route.name),
    ).not.toContain("pair");
  });

  /**
   * A signed-in member pasting a colleague's invite link into an already-open
   * workbench — the case `AuthGate`'s own `hashchange` listener exists for.
   * The cold path refuses to adopt a handed link; this is the same refusal on
   * the warm path, and it matters more here, because reaching the store at all
   * means reaching `persistTabs`: a live invite code written to localStorage
   * that nothing ever clears.
   */
  it("ignores an invite link pasted into an open workbench, and writes none of it down", async () => {
    renderAt("#/inbox");
    const before = tabsSnapshot().tabs.length;

    await act(async () => {
      window.location.hash = "#/join/ABC";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    const routes = tabsSnapshot()
      .tabs.flatMap((t) => t.stack)
      .map((e) => e.route.name);
    expect(routes).not.toContain("join");
    expect(tabsSnapshot().tabs).toHaveLength(before);
    expect(window.localStorage.getItem(storageKey()) ?? "").not.toContain(
      "ABC",
    );
  });
});
