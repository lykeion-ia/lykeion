/**
 * See the header on `App.handedLink.test.tsx` for why this is its own file
 * and what it is pinning: a `setup` fragment was composed outside this app —
 * by a daemon, or a redirect it sent someone on — and is not this router's
 * to turn into a tab either.
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

it("never adopts a setup step into a tab, and leaves storage empty", async () => {
  window.location.hash = "#/setup/2";

  render(<App api={createInMemoryApi()} />);

  // Step 2 is drawn above the auth gate entirely — `App` returns
  // `<SetupFlow>` before `RouterProvider` ever mounts. Waiting for its
  // heading gives React a turn to flush before the strip is read.
  expect(
    await screen.findByRole("heading", { name: "Which lab?" }),
  ).toBeInTheDocument();

  const names = tabsSnapshot()
    .tabs.flatMap((t) => t.stack)
    .map((e) => e.route.name);
  expect(names).not.toContain("setup");

  expect(window.localStorage.getItem(storageKey())).toBeNull();
});
