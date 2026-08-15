import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JoinLabScreen } from "./JoinLabScreen";
import { SetupScreen } from "../SetupScreen";
import { PairScreen } from "../PairScreen";
import { ApiProvider } from "../../api/ApiContext";
import { createInMemoryApi } from "@lykeion/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stubDaemon(connect?: Response) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (url === "/setup/machine") return json(200, { name: "ana-macbook", platform: "darwin-arm64", daemonVersion: "0.1.0" });
      if (url === "/connect") return connect ?? json(200, { ok: true });
      if (url === "/setup/challenge") return json(404, { error: "no such route" });
      if (url === "/auth/setup") return json(200, { ok: true });
      throw new Error(`unexpected call to ${url}`);
    }),
  );
  return calls;
}

it("warns that continuing leaves this machine, which is the only warning there is", async () => {
  stubDaemon();
  render(<JoinLabScreen />);
  await waitFor(() => expect(screen.getByLabelText(/^This machine/)).toHaveValue("ana-macbook"));
  expect(screen.getByText(/opens that lab in this tab/i)).toBeInTheDocument();
});

it("is step 2 of 3 on both paths, which is the whole reason the dots have no names", async () => {
  // The load-bearing claim. `create the lab` and `which lab?` are the same
  // step wearing different content, so the count promised at step 1 survives
  // the branch. A strip that named its steps would have lied here.
  stubDaemon();
  const { unmount } = render(<JoinLabScreen />);
  await waitFor(() => expect(screen.getByLabelText(/^This machine/)).toHaveValue("ana-macbook"));
  expect(screen.getAllByTestId("wizard-dot")).toHaveLength(3);
  expect(screen.getAllByTestId("wizard-dot")[1]).toHaveAttribute("data-on", "true");
  unmount();

  render(<SetupScreen onSignedIn={vi.fn()} />);
  await waitFor(() => expect(screen.getAllByTestId("wizard-dot")).toHaveLength(3));
  expect(screen.getAllByTestId("wizard-dot")[1]).toHaveAttribute("data-on", "true");
});

it("draws no progress chrome on the lab's own approval screen", async () => {
  // A different origin rendering a different application. Dots here would
  // claim a continuity this process does not have and cannot honour — and
  // this is exactly the kind of thing a later contributor adds for
  // consistency, so it is guarded rather than merely written down.
  render(
    <ApiProvider api={createInMemoryApi()}>
      <PairScreen
        params={{
          name: "gpu-box",
          platform: "linux-x64",
          version: "0.1.0",
          challenge: "abc",
          state: "def",
          redirect: "http://127.0.0.1:1421/paired",
        }}
      />
    </ApiProvider>,
  );
  // Awaited so the screen has resolved who is signed in before this looks:
  // asserting on an absence while a render is still pending proves nothing.
  await screen.findByText("gpu-box");
  expect(screen.queryByTestId("wizard-dot")).toBeNull();
});

it("names this machine for the researcher on this branch too", async () => {
  stubDaemon();
  render(<JoinLabScreen />);
  await waitFor(() => expect(screen.getByLabelText(/^This machine/)).toHaveValue("ana-macbook"));
});

it("hands the address and the name to the route that has always done this", async () => {
  const calls = stubDaemon();
  render(<JoinLabScreen />);
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByLabelText(/^This machine/)).toHaveValue("ana-macbook"));
  await user.type(screen.getByLabelText(/^Lab address/), "https://lab.example.edu");
  await user.click(screen.getByRole("button", { name: /continue to that lab/i }));

  await waitFor(() => expect(calls.some((c) => c.url === "/connect")).toBe(true));
  expect(calls.find((c) => c.url === "/connect")?.body).toEqual({
    lab: "https://lab.example.edu",
    name: "ana-macbook",
  });
});

it("offers no way on until it has both an address and a name", async () => {
  stubDaemon();
  render(<JoinLabScreen />);
  await waitFor(() => expect(screen.getByLabelText(/^This machine/)).toHaveValue("ana-macbook"));
  // A name but no address: there is nowhere to go.
  expect(screen.getByRole("button", { name: /continue to that lab/i })).toBeDisabled();
});

it("says what a lab refused rather than leaving the tab where it was", async () => {
  const calls = stubDaemon(json(400, { error: "that is not a lab this machine can reach" }));
  render(<JoinLabScreen />);
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByLabelText(/^This machine/)).toHaveValue("ana-macbook"));
  await user.type(screen.getByLabelText(/^Lab address/), "https://nope.example");
  await user.click(screen.getByRole("button", { name: /continue to that lab/i }));

  await waitFor(() =>
    expect(screen.getByText(/not a lab this machine can reach/i)).toBeInTheDocument(),
  );
  expect(calls.some((c) => c.url === "/connect")).toBe(true);
});

it("lets a researcher change their mind about where the lab lives", async () => {
  // Step 2 on this branch asks a question whose answer depends on step 1's.
  // Somebody who chose "somewhere else" and then realises they meant "on this
  // machine" has to be able to say so — and nothing has happened yet that
  // going back would undo: no lab was started, no account was created, and
  // the topology is a recorded preference the daemon will happily replace.
  stubDaemon();
  window.location.hash = "#/setup/2";
  render(<JoinLabScreen />);
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByLabelText(/^This machine/)).toHaveValue("ana-macbook"));

  await user.click(screen.getByRole("button", { name: "Back" }));

  expect(window.location.hash).toBe("#/setup/1");
});

it("actually leaves for the lab, which a redirect could never have made it do", async () => {
  // The bug this replaces: `/connect` answered 302 and this screen called it
  // with `fetch`. `fetch` follows a redirect ITSELF — it does not navigate the
  // tab — so the screen sat on a resolved promise holding the lab's own HTML
  // while the researcher looked at the form they had just submitted, and the
  // only thing on screen was a message saying the daemon could not be reached.
  const calls = stubDaemon(
    json(200, { redirect: "https://lab.example.edu/#/pair?name=gpu-box&challenge=abc" }),
  );
  const assign = vi.fn();
  const original = window.location;
  Object.defineProperty(window, "location", { configurable: true, value: { ...original, assign } });

  try {
    render(<JoinLabScreen />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText(/^This machine/)).toHaveValue("ana-macbook"));
    await user.type(screen.getByLabelText(/^Lab address/), "https://lab.example.edu");
    await user.click(screen.getByRole("button", { name: /continue to that lab/i }));

    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(
        "https://lab.example.edu/#/pair?name=gpu-box&challenge=abc",
      ),
    );
    expect(calls.some((c) => c.url === "/connect")).toBe(true);
  } finally {
    Object.defineProperty(window, "location", { configurable: true, value: original });
  }
});

it("wears the wizard's chrome when the trip out to the lab is part of a first run", async () => {
  // The other half of the rule above. That test renders this screen the way a
  // colleague opens a pairing link cold — no marker — and asserts no dots. A
  // researcher mid-first-run is the opposite case and is distinguishable: the
  // daemon composed the redirect and says so, so the screen it lands on can
  // keep the count going instead of dropping the researcher into what looks
  // like a different product halfway through.
  render(
    <ApiProvider api={createInMemoryApi()}>
      <PairScreen
        params={{
          name: "gpu-box",
          platform: "linux-x64",
          version: "0.1.0",
          challenge: "abc",
          state: "def",
          redirect: "http://127.0.0.1:1421/paired",
          step: "2",
        }}
      />
    </ApiProvider>,
  );

  await screen.findByText("gpu-box");
  // Step 2 of 3, because the trip out to the lab and back happens INSIDE step
  // 2 — the count promised at step 1 survives the branch.
  expect(screen.getAllByTestId("wizard-dot")).toHaveLength(3);
  expect(screen.getAllByTestId("wizard-dot")[1]).toHaveAttribute("data-on", "true");
});

it("ignores a step somebody typed into the address themselves", async () => {
  // The hash comes from outside the application. A value that is not a step
  // this build draws is not a reason to render broken chrome.
  render(
    <ApiProvider api={createInMemoryApi()}>
      <PairScreen
        params={{
          name: "gpu-box",
          platform: "linux-x64",
          version: "0.1.0",
          challenge: "abc",
          state: "def",
          redirect: "http://127.0.0.1:1421/paired",
          step: "nonsense",
        }}
      />
    </ApiProvider>,
  );

  await screen.findByText("gpu-box");
  expect(screen.queryByTestId("wizard-dot")).toBeNull();
});
