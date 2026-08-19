/**
 * A deep link that arrives while the identity gate is still up must survive
 * until there is a workbench to honour it.
 *
 * On a lab build `RouterProvider` lives inside `AuthGate`'s children, so it is
 * unmounted for as long as the gate is resolving or showing sign-in. Nothing
 * downstream can read the address during that window — so adoption happens once
 * per MOUNT of that provider, not once per page. A once-per-page flag trips on
 * the first render, while the gate is still closed and the hash is often not yet
 * the one that matters, and then never fires again: the link is dropped and the
 * mirror effect writes the previously-active tab's route over the address bar.
 *
 * `App`'s render body is not a home for it either, though it does precede the
 * provider: when the gate opens it re-renders the same `children` element, so
 * that body never runs a second time. This test is what disproved that
 * placement.
 *
 * Restoring, unlike adoption, IS once per page — see `restoreTabsOnce` in
 * `lib/tabs-storage.ts`.
 */
import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import App from "./App";
import { tabsSnapshot } from "./lib/tabs";
import { resetPageLoad } from "./lib/tabs-storage";
import { installLocalStorage, restoreLocalStorage } from "./test/local-storage";

afterEach(() => {
  cleanup();
  restoreLocalStorage();
  resetPageLoad();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.querySelector('meta[name="lykeion-workspace"]')?.remove();
  window.location.hash = "";
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** Marks the page as served by a workspace server, the way the real server
 *  stamps the document it sends — `hasWorkspaceServer()` looks for this tag,
 *  and it is what puts `AuthGate` in front of the workbench. */
function declareWorkspaceServer() {
  const meta = document.createElement("meta");
  meta.setAttribute("name", "lykeion-workspace");
  document.head.appendChild(meta);
}

/** jsdom has no `EventSource`, and App opens one as soon as it decides a
 *  workspace server is behind the page. Inert: this test is about the gate and
 *  the address, not the change channel. */
class InertEventSource {
  addEventListener(): void {}
  close(): void {}
}

it("honours a link pasted while the gate was still up", async () => {
  installLocalStorage();
  declareWorkspaceServer();
  vi.stubGlobal("EventSource", InertEventSource);

  // Held open so the gate is genuinely unresolved — and the workbench genuinely
  // unmounted — at the moment the hash changes.
  let admit: (() => void) | undefined;
  const identity = new Promise<void>((resolve) => {
    admit = resolve;
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo) => {
      const path = new URL(String(input), "http://lab.example").pathname;
      if (path === "/auth/setup") return json(404, { error: "owner exists" });
      if (path === "/rpc/currentUser") {
        await identity;
        return json(200, {
          ok: true,
          value: {
            id: "u_1",
            email: "ana@lab.example",
            displayName: "Ana",
            createdTs: 1,
          },
        });
      }
      // Everything the Machines screen and the rail read is empty — what a
      // populated lab draws is not what this pins.
      if (path.startsWith("/rpc/")) return json(200, { ok: true, value: [] });
      throw new Error(`no stub for ${path}`);
    }),
  );

  render(<App />);

  // The gate has not resolved: no workbench, so no router listening.
  expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();

  // The link arrives now, with nothing mounted that could hear it.
  window.location.hash = "#/machines";

  admit!();

  // Once the gate opens, the workbench must land on the pasted link rather
  // than on whatever tab was active. Against a one-shot adoption flag this
  // fails here: the strip opens on its default Researches tab instead.
  expect(
    await screen.findByRole("heading", { name: "Machines" }),
  ).toBeInTheDocument();

  const state = tabsSnapshot();
  const active = state.tabs.find((t) => t.id === state.activeId)!;
  expect(active.stack[active.index].route).toEqual({ name: "machines" });
  // And the address the reader was handed is still the address they have.
  expect(window.location.hash).toBe("#/machines");
});
