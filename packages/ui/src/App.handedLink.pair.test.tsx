/**
 * See the header on `App.handedLink.test.tsx` for why this is its own file
 * and what it is pinning: `pair` carries a machine's challenge — a working
 * credential this app must never let `persistTabs` write down.
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

it("never adopts a pairing link into a tab, and leaves storage empty", async () => {
  window.location.hash = "#/pair?name=x";

  render(<App api={createInMemoryApi()} />);

  // `name=x` alone is not a complete pairing request — no `challenge`, no
  // `redirect` — so `PairScreen` answers "Nothing to approve" rather than
  // the approval form. Waiting for it gives React a turn to flush before the
  // strip is read.
  expect(
    await screen.findByRole("heading", { name: "Nothing to approve" }),
  ).toBeInTheDocument();

  const names = tabsSnapshot()
    .tabs.flatMap((t) => t.stack)
    .map((e) => e.route.name);
  expect(names).not.toContain("pair");

  // `pair` was already excluded from the tab strip before this fix — the
  // route lived in the provider's `standalone` slot. What this pins is the
  // storage side: nothing about this cold load should have been persisted
  // at all.
  expect(window.localStorage.getItem(storageKey())).toBeNull();
});
