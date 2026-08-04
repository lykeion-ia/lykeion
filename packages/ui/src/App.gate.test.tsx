/**
 * Where App.tsx wires the workspace server's transport into AuthGate. The
 * unit-level gate tests in shell/AuthGate.test.tsx cover the gate's own
 * contract; this covers the thing only the full wiring can prove — that a
 * 401 arriving mid-visit, on a call the gate itself did not make, still
 * reaches the sign-in screen rather than leaving the caller stuck in a
 * shell that keeps failing silently.
 */
import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.querySelector('meta[name="lykeion-workspace"]')?.remove();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * Marks the page as served by a workspace server, the way the real server
 * stamps the document it sends — `hasWorkspaceServer()` looks for exactly
 * this tag.
 */
function declareWorkspaceServer() {
  const meta = document.createElement("meta");
  meta.setAttribute("name", "lykeion-workspace");
  document.head.appendChild(meta);
}

/**
 * jsdom has no `EventSource`. App.tsx opens one for the change channel as
 * soon as it decides a workspace server is behind the page, so this stub
 * has to exist before render or that construction throws. This test is
 * about the identity gate, not the channel, so the stub never fires
 * anything.
 */
class InertEventSource {
  addEventListener(): void {}
  close(): void {}
}

it("a session that lapses mid-visit lands on the sign-in screen, not a shell stuck failing silently", async () => {
  const user = userEvent.setup();
  declareWorkspaceServer();
  vi.stubGlobal("EventSource", InertEventSource);

  let lapsed = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo) => {
    const path = new URL(String(input), "http://lab.example").pathname;
    if (path === "/auth/setup") return json(404, { error: "owner exists" });
    if (path.startsWith("/rpc/")) {
      if (lapsed) return json(401, {});
      const method = path.slice("/rpc/".length);
      if (method === "currentUser") {
        return json(200, {
          ok: true,
          value: { id: "u_1", email: "ana@lab.example", displayName: "Ana", createdTs: 1 },
        });
      }
      // Everything else the shell reads on its default screen (member list,
      // studies, inbox) is empty — the point of this test is the identity
      // check, not what a populated lab renders.
      return json(200, { ok: true, value: [] });
    }
    throw new Error(`no stub for ${path}`);
  }));

  render(<App />);

  // Confirms the gate resolved "in" and the real shell — not a sign-in
  // screen — is what is on screen before the lapse.
  expect(await screen.findByRole("button", { name: "Workspace" })).toBeInTheDocument();

  lapsed = true;
  // Navigating mounts InboxScreen fresh, which makes RPC calls AuthGate
  // itself never makes — this is what a 401 on "some unrelated call" means
  // concretely, and it is the case App.tsx has to route back to the gate.
  await user.click(screen.getByRole("link", { name: /Inbox/i }));

  expect(await screen.findByRole("button", { name: /Sign in/i })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
});
