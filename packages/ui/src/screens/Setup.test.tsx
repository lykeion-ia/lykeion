import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { LykeionApi } from "@lykeion/api";
import { SetupScreen } from "./SetupScreen";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const CHALLENGE = {
  challenge: "a-challenge",
  state: "a-state",
  redirect: "http://127.0.0.1:1421/paired",
  name: "ana-macbook",
  platform: "darwin-arm64",
  daemonVersion: "0.1.0",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Answers as the daemon in front of this page, or as a lab reached over a
 *  network — which has no such routes at all. */
/**
 * The path the transport every other screen goes through would use, derived
 * the same way rather than written out.
 *
 * This test file used to spell it `/rpc/pair_machine`, and so did the screen —
 * so the stub agreed with the bug and the suite was green while production
 * answered `no such method`. The lab was created, the machine did not join it,
 * and the deliberate never-fatal handling swallowed the 404. Naming it off the
 * contract's own method name is what makes the two impossible to disagree.
 */
const RPC_PAIR_MACHINE = `/rpc/${"pairMachine" satisfies keyof LykeionApi}`;

function stubServer(options: { coLocated: boolean; pairMachine?: Response }) {
  const calls: { url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (url === "/setup/challenge")
      return options.coLocated ? json(200, CHALLENGE) : json(404, { error: "no such route" });
    // Answers in BOTH topologies when a daemon is serving this page, which is
    // what tells this screen it is step 2 of a first run rather than a lab
    // somebody deployed and opened directly.
    if (url === "/setup/machine")
      return options.coLocated
        ? json(200, { name: "ana-macbook", platform: "macos-aarch64", daemonVersion: "0.1.0" })
        : json(404, { error: "no such route" });
    if (url === "/auth/setup") return json(200, { ok: true });
    // The RPC envelope, not a bare object. The stub used to answer
    // `{ code }` — the shape the screen was reading — so both were wrong
    // together and the suite could not tell.
    if (url === RPC_PAIR_MACHINE)
      return options.pairMachine ?? json(200, { ok: true, value: { code: "a-code" } });
    if (url === "/setup/paired") return json(200, { machineName: "ana-macbook" });
    throw new Error(`unexpected call to ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function createTheLab(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Your name"), "Ana");
  await user.type(screen.getByLabelText("Email"), "ana@lab.example");
  await user.type(screen.getByLabelText(/^Password/), "a good long password");
  await user.click(screen.getByRole("button", { name: "Create the lab" }));
}

it("names this machine for the researcher, rather than asking them to", async () => {
  stubServer({ coLocated: true });
  render(<SetupScreen onSignedIn={vi.fn()} />);
  // The machine's own name is something this computer knows about itself.
  await waitFor(() => expect(screen.getByLabelText(/^This machine/)).toHaveValue("ana-macbook"));
});

it("pairs the machine to the lab it just created, without asking twice", async () => {
  const calls = stubServer({ coLocated: true });
  const onSignedIn = vi.fn();
  render(<SetupScreen onSignedIn={onSignedIn} />);
  await waitFor(() => expect(screen.getByLabelText(/^This machine/)).toHaveValue("ana-macbook"));

  await createTheLab(userEvent.setup());

  await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  const asked = calls.find((c) => c.url === RPC_PAIR_MACHINE);
  expect(asked?.body).toEqual({
    args: [
      {
        name: "ana-macbook",
        platform: "darwin-arm64",
        daemonVersion: "0.1.0",
        challenge: "a-challenge",
        redirect: "http://127.0.0.1:1421/paired",
      },
    ],
  });
  // The code goes back to the daemon with the state it was minted for, which
  // is what the redirect would have carried.
  expect(calls.find((c) => c.url === "/setup/paired")?.body).toEqual({
    code: "a-code",
    state: "a-state",
  });
  // Nothing was approved, because there was nobody else to approve it.
  expect(calls.some((c) => c.url.includes("/connect"))).toBe(false);
});

it("carries the name the researcher chose, when they change it", async () => {
  const calls = stubServer({ coLocated: true });
  render(<SetupScreen onSignedIn={vi.fn()} />);
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByLabelText(/^This machine/)).toBeInTheDocument());
  await user.clear(screen.getByLabelText(/^This machine/));
  await user.type(screen.getByLabelText(/^This machine/), "the gpu box");

  await createTheLab(user);

  await waitFor(() => expect(calls.some((c) => c.url === RPC_PAIR_MACHINE)).toBe(true));
  const asked = calls.find((c) => c.url === RPC_PAIR_MACHINE)!;
  expect((asked.body as { args: { name: string }[] }).args[0].name).toBe("the gpu box");
});

it("asks about no machine at all when the lab is somewhere else", async () => {
  // The same screen served by a lab on another computer. This machine is not
  // joining anything, and a field naming it would be asking about a computer
  // with nothing to do with what is being created.
  const calls = stubServer({ coLocated: false });
  const onSignedIn = vi.fn();
  render(<SetupScreen onSignedIn={onSignedIn} />);
  await waitFor(() => expect(calls.some((c) => c.url === "/setup/challenge")).toBe(true));
  expect(screen.queryByLabelText(/^This machine/)).toBeNull();

  await createTheLab(userEvent.setup());

  await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  expect(calls.some((c) => c.url === RPC_PAIR_MACHINE)).toBe(false);
});

it("lets the researcher into the lab they just made even if pairing fails", async () => {
  // The lab exists and they are signed in to it by the time this runs. A
  // machine that failed to pair is one they can pair afterwards; refusing
  // them the lab they just created would be the worse answer.
  const onSignedIn = vi.fn();
  stubServer({ coLocated: true, pairMachine: json(500, { error: "the lab fell over" }) });
  render(<SetupScreen onSignedIn={onSignedIn} />);
  await waitFor(() => expect(screen.getByLabelText(/^This machine/)).toBeInTheDocument());

  await createTheLab(userEvent.setup());

  await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
});

it("goes on to the third step it promised, rather than ending on the workbench", async () => {
  // The wizard counts to three. Creating the lab is step 2, and without this
  // the flow stops here — the agents a researcher opened this to sign in to
  // are never offered, and the strip that promised a third step was wrong.
  stubServer({ coLocated: true });
  const onSignedIn = vi.fn();
  render(<SetupScreen onSignedIn={onSignedIn} />);
  const user = userEvent.setup();

  await waitFor(() => expect(screen.getByLabelText(/^This machine/)).toBeInTheDocument());
  await user.type(screen.getByLabelText(/^Your name/), "Ana");
  await user.type(screen.getByLabelText(/^Email/), "ana@uni.edu");
  await user.type(screen.getByLabelText(/^Password/), "correct-horse");
  await user.click(screen.getByRole("button", { name: /create the lab/i }));

  await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
  expect(window.location.hash).toBe("#/setup/3");
});

it("fills the wizard's column rather than sitting against its left edge", async () => {
  // Reported from a screenshot: the heading sat left of centre while the dots
  // below it centred on the column, because this shell kept its own 360px
  // measure inside the wizard's 560px one.
  //
  // Asserted on the class rather than on pixels because jsdom has no layout —
  // it computes no widths and no positions, so the misalignment that is
  // obvious on screen is invisible to every test in this suite. What this can
  // hold is the mechanism: inside the wizard, the shell imposes no measure of
  // its own and the column decides.
  stubServer({ coLocated: true });
  render(<SetupScreen onSignedIn={vi.fn()} />);

  // Waited for, not assumed: whether this screen is inside a wizard is
  // answered by a round trip, and the heading renders before that lands.
  await screen.findAllByTestId("wizard-dot");
  const block = screen.getByRole("heading", { name: /create the lab/i }).parentElement!;
  expect(block.className).toContain("w-full");
  expect(block.className).not.toContain("max-w-[360px]");
});

it("keeps its own measure when it owns the window", async () => {
  // The other half. Signing in to a lab somebody deployed is this shell alone
  // on the page, and a form stretched across a wide window is worse than one
  // held to a readable measure.
  stubServer({ coLocated: false });
  render(<SetupScreen onSignedIn={vi.fn()} />);

  const heading = await screen.findByRole("heading", { name: /create the lab/i });
  await waitFor(() => expect(screen.queryByTestId("wizard-dot")).toBeNull());
  expect(heading.parentElement!.className).toContain("max-w-[360px]");
});
