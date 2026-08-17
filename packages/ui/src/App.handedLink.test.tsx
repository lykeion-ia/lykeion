/**
 * `join`, `pair` and `setup` are not the workbench's routes to hold — see
 * `handedLink` in `router.tsx`. A `join` code and a `pair` challenge are
 * working credentials whose only copy is the fragment somebody was handed;
 * adopting either into the strip would hand `persistTabs` that credential,
 * and nothing ever clears it back out. `App`'s render-body adopt (the fix
 * for the ordering bug `App.tabs.test.tsx` pins) is the one place a cold
 * load's hash reaches the tab strip, so it is the one place this guard has
 * to hold.
 *
 * Each case gets its own file: `tabsRestored` is a one-shot module flag, and
 * vitest gives each test file a fresh module graph — a second mount inside
 * one file would find the flag already tripped, same as `App.tabs.test.tsx`
 * documents.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createInMemoryApi } from "@lykeion/api";
import App from "./App";
import { tabsSnapshot } from "./lib/tabs";
import { storageKey } from "./lib/tabs-storage";
import { installLocalStorage, restoreLocalStorage } from "./test/local-storage";

beforeEach(installLocalStorage);
afterEach(restoreLocalStorage);

// The seeded study every in-memory API starts with — see `Studies.test.tsx`,
// which uses the same anchor to prove the default screen actually rendered.
const CMP = "Cross-modal plasticity in the brain";

it("never adopts a join link into a tab, and leaves the code out of storage", async () => {
  window.location.hash = "#/join/ABC";

  render(<App api={createInMemoryApi()} />);

  // An injected `api` bypasses `AuthGate` entirely, so nothing here reads the
  // join code at all — this settles on the ordinary Studies screen. Waiting
  // for it gives React a turn to flush before the strip is read.
  expect(await screen.findByText(CMP)).toBeInTheDocument();

  const names = tabsSnapshot()
    .tabs.flatMap((t) => t.stack)
    .map((e) => e.route.name);
  expect(names).not.toContain("join");

  const stored = window.localStorage.getItem(storageKey());
  expect(stored ?? "").not.toContain("ABC");
});
