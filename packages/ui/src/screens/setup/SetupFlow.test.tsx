import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SetupFlow } from "./SetupFlow";
import App from "../../App";
import { createInMemoryApi } from "@lykeion/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
  delete document.documentElement.dataset.setupStep;
});

it("tells the daemon which topology was chosen, before moving on", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);

  render(<SetupFlow step={1} />);
  await userEvent.click(screen.getByText(/on this machine/i));
  await userEvent.click(screen.getByRole("button", { name: /continue/i }));

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/setup/topology");
  expect(init.method).toBe("POST");
  // Same-origin credentials: the daemon guards this route on the admission
  // cookie it set, exactly as it guards signing an agent in.
  expect(init.credentials).toBe("same-origin");
  expect(JSON.parse(String(init.body))).toEqual({ topology: "here" });
});

it("reloads from the daemon for the lab it just started, rather than changing the hash", async () => {
  // The load-bearing one, and the reason it is a RELOAD.
  //
  // This page was served before the lab existed, so it is running against its
  // own in-browser demo — the marker that says otherwise is injected into the
  // document by the daemon at serve time, and only a new document can carry
  // one. A hash change would leave the researcher creating a lab in a fake
  // one, with the real lab running behind the page they were reading.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...original, assign },
  });

  try {
    render(<SetupFlow step={1} />);
    await userEvent.click(screen.getByText(/on this machine/i));
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
  } finally {
    Object.defineProperty(window, "location", { configurable: true, value: original });
  }
});

it("goes on to step 2 here, when the lab is somewhere else", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

  render(<SetupFlow step={1} />);
  await userEvent.click(screen.getByText(/somewhere else/i));
  await userEvent.click(screen.getByRole("button", { name: /continue/i }));

  await waitFor(() => expect(window.location.hash).toBe("#/setup/2"));
});

it("draws the join screen at step 2, because the other branch never arrives here", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/setup/machine"
        ? new Response(JSON.stringify({ name: "ana-macbook", platform: "p", daemonVersion: "v" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(null, { status: 404 }),
    ),
  );

  render(<SetupFlow step={2} />);

  await waitFor(() => expect(screen.getByLabelText(/^This machine/)).toHaveValue("ana-macbook"));
  expect(screen.getByText(/opens that lab in this tab/i)).toBeInTheDocument();
});

it("stays on the question when the daemon refuses", async () => {
  // Recording `here` is what starts the lab. Moving on from a refusal would
  // put the researcher on a step whose whole subject is a lab that was never
  // started, which reads as a broken product rather than a failed request.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));

  render(<SetupFlow step={1} />);
  await userEvent.click(screen.getByText(/somewhere else/i));
  await userEvent.click(screen.getByRole("button", { name: /continue/i }));

  await waitFor(() =>
    expect(screen.getByRole("heading", { name: /where does the lab live/i })).toBeInTheDocument(),
  );
  expect(window.location.hash).not.toBe("#/setup/2");
});

it("draws nothing for a step this build does not have yet", () => {
  // The steps arrive one at a time, and a step with no screen falls through
  // to the ordinary application rather than showing an unfinished one.
  const { container } = render(<SetupFlow step={4} />);
  expect(container).toBeEmptyDOMElement();
});

it("draws the agents step at 3, which is where a lab sends a machine back to", async () => {
  // Both branches end here, and this is the address `/paired` serves the
  // application on — so a researcher returning from a lab that just approved
  // their machine lands on this step rather than at the beginning.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/agents"
        ? new Response(
            JSON.stringify({
              agents: [{ agent: "claude", name: "Claude Code", available: true, signedIn: false }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response(null, { status: 404 }),
    ),
  );

  render(<SetupFlow step={3} />);

  expect(await screen.findByText("Claude Code")).toBeInTheDocument();
  expect(screen.getAllByTestId("wizard-dot")[2]).toHaveAttribute("data-on", "true");
  // The sign-in goes to the machine's own front door, which is the only thing
  // that can start one — see `AgentsStep`.
  expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
});

it("draws no way back from step 3, because the step behind it cannot be asked again", async () => {
  // Step 2 was "which lab?" or "create the lab". By the time this renders,
  // this machine holds a token and that question is settled. A Back button
  // here used to render wired to nothing at all.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ agents: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })),
  );

  render(<SetupFlow step={3} />);

  await waitFor(() => expect(screen.getAllByTestId("wizard-dot")).toHaveLength(3));
  expect(screen.queryByRole("button", { name: /^back$/i })).toBeNull();
  // Leaving is still possible, and the screen owns that control rather than
  // the frame — Machines shows the same list with no frame at all.
  expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// The seam between the daemon and this application.
//
// A daemon hands the application out at two moments that carry a step and no
// hash to say so — the link it prints, and the callback a lab redirects to. It
// marks the document; this is what reads the mark. Both halves were tested on
// their own and the join between them was not, so the daemon emitted a step
// nothing looked at and every first run landed on the workbench instead.
// ---------------------------------------------------------------------------

it("opens on the step the daemon served the page for, with nothing in the address", async () => {
  document.documentElement.dataset.setupStep = "1";
  window.location.hash = "";
  render(<App api={createInMemoryApi()} />);

  expect(await screen.findByRole("heading", { name: /where does the lab live/i })).toBeInTheDocument();
  // Promoted into the address, so every step after this is ordinary routing —
  // and so clearing the hash is what leaves the flow.
  expect(window.location.hash).toBe("#/setup/1");
});

it("lands a machine coming back from a lab on the step that was waiting", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ agents: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })),
  );
  document.documentElement.dataset.setupStep = "3";
  window.location.hash = "";
  render(<App api={createInMemoryApi()} />);

  expect(await screen.findByRole("heading", { name: /agents on this machine/i })).toBeInTheDocument();
  expect(window.location.hash).toBe("#/setup/3");
});

it("lets the address override the page it was served on", async () => {
  // Somebody who kept a link, or who moved inside the flow, has said something
  // more specific than the page they were handed.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/setup/machine"
        ? new Response(JSON.stringify({ name: "ana-macbook", platform: "p", daemonVersion: "v" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(null, { status: 404 }),
    ),
  );
  document.documentElement.dataset.setupStep = "1";
  window.location.hash = "#/setup/2";
  render(<App api={createInMemoryApi()} />);

  expect(await screen.findByRole("heading", { name: /which lab/i })).toBeInTheDocument();
});

it("does not drag an ordinary page load into setup", async () => {
  // No mark, no hash: the workbench, exactly as before any of this existed.
  delete document.documentElement.dataset.setupStep;
  window.location.hash = "";
  render(<App api={createInMemoryApi()} />);

  await waitFor(() =>
    expect(screen.queryByRole("heading", { name: /where does the lab live/i })).toBeNull(),
  );
});

it("does not take a pairing link's place, on a daemon whose page is marked", async () => {
  // The collision that made this rule "any address wins" rather than "any
  // setup address wins". A paired daemon serves its own page marked step 3,
  // and that is the same origin a lab redirects to when somebody approves a
  // second machine — arriving with `#/pair?…` in hand.
  document.documentElement.dataset.setupStep = "3";
  window.location.hash =
    "#/pair?name=gpu-box&platform=linux-x64&version=0.1.0&challenge=abc&state=xyz&redirect=http%3A%2F%2F127.0.0.1%3A9999%2Fpaired";
  render(<App api={createInMemoryApi()} />);

  expect(await screen.findByText("gpu-box")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: /agents on this machine/i })).toBeNull();
});

it("counts every agent the daemon lists, which is every agent the lab lists", async () => {
  // The two screens disagreed: the first run counted the agents it could ask
  // a sign-in question about, and the workbench a moment later counted the
  // whole catalogue — about the same computer.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/agents"
        ? new Response(
            JSON.stringify({
              agents: [
                { agent: "claude", name: "Claude Code", available: true, signedIn: false },
                { agent: "kiro", name: "Kiro", available: false },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )
        : new Response(null, { status: 404 }),
    ),
  );

  render(<SetupFlow step={3} />);

  expect(await screen.findByRole("button", { name: "All 2" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Installed 1" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Not installed 1" })).toBeInTheDocument();
  // The one that was asked gets its control; the one nothing could ask does
  // not, because pressing it would spawn nothing.
  expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  expect(within(screen.getByTestId("row-kiro")).queryByRole("button")).toBeNull();
});

it("says the page went stale rather than leaving a Continue that does nothing", async () => {
  // The belt to the heartbeat's braces. A tab that was asleep, or reopened
  // from history, has not been saying it is still there — so the request can
  // still have been replaced, and this is what the researcher gets instead of
  // a button that quietly does nothing.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));

  render(<SetupFlow step={1} />);
  await userEvent.click(screen.getByText(/on this machine/i));
  await userEvent.click(screen.getByRole("button", { name: /continue/i }));

  const said = await screen.findByRole("alert");
  expect(said).toHaveTextContent(/open too long/i);
  // And it names the way back, which is the part nobody can guess.
  expect(said).toHaveTextContent(/lykeion open/i);
});

it("says something different when the daemon is simply not there", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

  render(<SetupFlow step={1} />);
  await userEvent.click(screen.getByText(/somewhere else/i));
  await userEvent.click(screen.getByRole("button", { name: /continue/i }));

  expect(await screen.findByRole("alert")).toHaveTextContent(/check the terminal/i);
});
