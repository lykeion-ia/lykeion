/**
 * The strip is restored, and the incoming hash adopted, synchronously during
 * render rather than from an effect — `restoreTabsOnce` in
 * `lib/tabs-storage.ts` for the first, `RouterProvider`'s own render body for
 * the second. React runs effects child-first, so doing either from an effect
 * would fire only after `RouterProvider` had already rendered once against
 * whatever tab restoring (or nothing at all) left active — and, worse, the
 * provider's own mirror effect would `replaceState` that route over the
 * incoming address before the adopt ever ran, so a reload at that instant
 * would lose the link. This is the regression the ordering prevents: a cold
 * load with a hash, against a payload already in storage, must end up on the
 * hash's route with the restored tabs still present, and the address bar
 * must never have carried the restored tab's route even transiently.
 *
 * Restoring is one-shot per page (deliberately: "read once per page"), so this
 * file mounts `<App>` exactly once and does not call `resetPageLoad` — a second
 * mount would restore nothing, which would make the test assert its own setup
 * rather than the ordering it exists to pin. Adoption runs per MOUNT instead,
 * and `App.gate-hash.test.tsx` covers why it has to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createInMemoryApi } from "@lykeion/api";
import App from "./App";
import { tabsSnapshot } from "./lib/tabs";
import { storageKey } from "./lib/tabs-storage";
import { installLocalStorage, restoreLocalStorage } from "./test/local-storage";

// jsdom's own `localStorage` here is a bare object with none of Storage's
// methods on it — see `test/local-storage.ts`.
beforeEach(installLocalStorage);
afterEach(() => {
  restoreLocalStorage();
  // The `replaceState` spy below would otherwise stay installed for the rest
  // of the module's life.
  vi.restoreAllMocks();
});

describe("App restores the strip before adopting a cold-load hash", () => {
  it("keeps the restored tab and still lands on the hash's route", async () => {
    window.localStorage.setItem(
      storageKey(),
      JSON.stringify({
        v: 1,
        tabs: [
          { id: "tab_9", stack: [{ route: { name: "inbox" } }], index: 0 },
        ],
        activeId: "tab_9",
      }),
    );
    window.location.hash = "#/machines";

    // Every hash this mount's initial render pass ever pushes into the
    // address bar — recorded rather than merely inspected at the end,
    // because the defect this pins is transient: the restored tab's route
    // winning the FIRST write and being corrected by a second one looks
    // identical, by the time everything has settled, to it never having won
    // at all.
    const replaceState = vi.spyOn(window.history, "replaceState");

    render(<App api={createInMemoryApi()} />);

    expect(
      await screen.findByRole("heading", { name: "Machines" }),
    ).toBeInTheDocument();

    // (a) The restored tab's own route was never mirrored into the address
    // bar, not even for one write. Against the pre-fix, effect-based
    // ordering this fails: the first render paints the restored "inbox" tab,
    // and the mirror effect writes it out before the adopt effect has run.
    const written = replaceState.mock.calls.map((call) => call[2]);
    expect(written).not.toContain("#/inbox");

    const state = tabsSnapshot();
    // (b) The restored tab is still there, somewhere in the strip...
    expect(
      state.tabs.flatMap((t) => t.stack).map((e) => e.route),
    ).toContainEqual({ name: "inbox" });
    // ...and the hash the page was loaded with won the active slot, and the
    // final address bar.
    const active = state.tabs.find((t) => t.id === state.activeId)!;
    expect(active.stack[active.index].route).toEqual({ name: "machines" });
    expect(window.location.hash).toBe("#/machines");
  });
});
