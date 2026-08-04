import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JoinScreen } from "./JoinScreen";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function fillIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Your name"), "Bo");
  await user.type(screen.getByLabelText("Email"), "bo@lab.example");
  await user.type(screen.getByLabelText(/^Password/), "a good long password");
  await user.click(screen.getByRole("button", { name: "Join the lab" }));
}

it("carries the code it was opened with rather than asking for it", async () => {
  const user = userEvent.setup();
  const sent: unknown[] = [];
  vi.stubGlobal("fetch", async (_input: RequestInfo, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return json(200, { ok: true });
  });
  render(<JoinScreen code="inv_from_the_link" onSignedIn={() => {}} onSignIn={() => {}} />);

  await fillIn(user);

  expect(sent).toHaveLength(1);
  expect((sent[0] as { code: string }).code).toBe("inv_from_the_link");
});

it("reports that the invite is spent in the lab's own words", async () => {
  // The person holding a dead link needs to know it is the link, not them.
  // Only the server knows which of the several ways a code stops working
  // this one is, so its message is the one shown.
  const user = userEvent.setup();
  vi.stubGlobal("fetch", async () => json(400, { error: "that invite has already been used" }));
  render(<JoinScreen code="inv_spent" onSignedIn={() => {}} onSignIn={() => {}} />);

  await fillIn(user);

  expect(await screen.findByText("that invite has already been used")).toBeInTheDocument();
});

it("leaves the form usable after a refusal, so a second try is possible", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", async () => json(400, { error: "that invite code is not valid" }));
  render(<JoinScreen code="inv_bad" onSignedIn={() => {}} onSignIn={() => {}} />);

  await fillIn(user);

  expect(await screen.findByRole("button", { name: "Join the lab" })).toBeEnabled();
});

it("says the server could not be reached rather than failing silently", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("network");
  });
  render(<JoinScreen code="inv_x" onSignedIn={() => {}} onSignIn={() => {}} />);

  await fillIn(user);

  expect(await screen.findByText(/could not reach this lab's server/i)).toBeInTheDocument();
});

it("survives a refusal whose body is not the JSON it expected", async () => {
  // A proxy answering 502 with an HTML page. Parsing that as JSON throws,
  // and an unhandled throw here leaves the form disabled with nothing said.
  const user = userEvent.setup();
  vi.stubGlobal("fetch", async () => new Response("<html>bad gateway</html>", { status: 502 }));
  render(<JoinScreen code="inv_x" onSignedIn={() => {}} onSignIn={() => {}} />);

  await fillIn(user);

  expect(await screen.findByText(/that invite did not work/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Join the lab" })).toBeEnabled();
});

it("reports upward once the lab has taken the new member", async () => {
  const user = userEvent.setup();
  const onSignedIn = vi.fn();
  vi.stubGlobal("fetch", async () => json(200, { ok: true }));
  render(<JoinScreen code="inv_good" onSignedIn={onSignedIn} onSignIn={() => {}} />);

  await fillIn(user);

  await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
});

it("offers a way to sign in instead, for somebody who already has an account", async () => {
  // Without it this screen is a dead end for the commonest wrong arrival:
  // a member opening a link a colleague forwarded, or their own a second
  // time. There is no other control on the page.
  const user = userEvent.setup();
  const onSignIn = vi.fn();
  render(<JoinScreen code="inv_x" onSignedIn={() => {}} onSignIn={onSignIn} />);

  await user.click(screen.getByRole("button", { name: /Already have an account/i }));

  expect(onSignIn).toHaveBeenCalled();
});
