/**
 * See the header on `App.handedLink.test.tsx` for the family this belongs
 * to. This one is the case the finding calls out separately: a `setup`
 * fragment whose step this build does not draw. `App` only bails to
 * `<SetupFlow>` above the gate for a step it recognizes — an unrecognized
 * one leaves `setupStep` null, so `RouterProvider` mounts after all, with
 * `#/setup/99` still sitting in the hash. That is the one path where the
 * pre-fix adopt guard (which excluded only `pair` and the empty hash) used
 * to reach `adoptRoute` for a `setup` fragment.
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

const CMP = "Cross-modal plasticity in the brain";

it("never adopts an unresolved setup step into a tab, and leaves storage empty", async () => {
  window.location.hash = "#/setup/99";

  render(<App api={createInMemoryApi()} />);

  // Step 99 draws nothing, so `App` falls through to the ordinary workbench
  // rather than `<SetupFlow>` — which is exactly what puts `RouterProvider`
  // in play for this hash. Waiting for Researches proves the strip landed on
  // its ordinary default rather than on a `setup` tab `Shell` has no case
  // for (and so would render blank).
  expect(await screen.findByText(CMP)).toBeInTheDocument();

  const names = tabsSnapshot()
    .tabs.flatMap((t) => t.stack)
    .map((e) => e.route.name);
  expect(names).not.toContain("setup");

  expect(window.localStorage.getItem(storageKey())).toBeNull();
});
