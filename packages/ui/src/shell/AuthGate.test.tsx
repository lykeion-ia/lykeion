import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LykeionError } from "@lykeion/api";
import { useSignOut } from "../api/SessionContext";
import { AuthGate } from "./AuthGate";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // `vi.stubGlobal` is not undone by `restoreAllMocks` — without this, a
  // `fetch` stub from one test would still answer requests in the next.
  vi.unstubAllGlobals();
  // Every `AuthGate` reads the hash on mount, to catch a join route — a
  // hash a join test leaves behind would make an unrelated test's gate open
  // on the join screen instead of whatever it meant to render.
  window.location.hash = "";
});

function stubFetch(handlers: Record<string, () => Response>) {
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const path = new URL(String(input), "http://lab.example").pathname;
    // The refusal the real server makes, in the fixture, because a stub that
    // answers on the path alone cannot tell a request the server would take
    // from one it would turn away — and every `/auth/` route turns away a
    // POST that is not `application/json`. A caller that sends no body sends
    // no content type either, which is the shape this catches.
    if (init?.method === "POST" && path.startsWith("/auth/")) {
      const contentType = new Headers(init.headers).get("content-type") ?? "";
      if (!contentType.includes("application/json"))
        return json(415, { error: "auth calls are application/json" });
    }
    const handler = handlers[path];
    if (!handler) throw new Error(`no stub for ${path}`);
    return handler();
  });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

it("shows the workbench once somebody is signed in", async () => {
  const currentUser = vi.fn(async () => ({
    id: "u_1", email: "ana@lab.example", displayName: "Ana", createdTs: 1,
  }));
  stubFetch({ "/auth/setup": () => json(404, { error: "owner exists" }) });
  render(
    <AuthGate currentUser={currentUser} onSignedIn={() => {}}>
      <p>the workbench</p>
    </AuthGate>,
  );
  expect(await screen.findByText("the workbench")).toBeInTheDocument();
});

it("asks for a sign-in when nobody is, and does not render the workbench", async () => {
  const currentUser = vi.fn(async () => {
    throw new LykeionError("unauthenticated", "not signed in");
  });
  stubFetch({ "/auth/setup": () => json(404, { error: "owner exists" }) });
  render(
    <AuthGate currentUser={currentUser} onSignedIn={() => {}}>
      <p>the workbench</p>
    </AuthGate>,
  );
  expect(await screen.findByRole("button", { name: /Sign in/i })).toBeInTheDocument();
  // The negative half matters as much: a gate that renders both is not a gate.
  expect(screen.queryByText("the workbench")).toBeNull();
});

it("offers to create the owner on a lab that has none", async () => {
  const currentUser = vi.fn(async () => {
    throw new LykeionError("unauthenticated", "not signed in");
  });
  stubFetch({ "/auth/setup": () => json(200, { setupRequired: true }) });
  render(
    <AuthGate currentUser={currentUser} onSignedIn={() => {}}>
      <p>the workbench</p>
    </AuthGate>,
  );
  expect(await screen.findByRole("button", { name: /Create the lab/i })).toBeInTheDocument();
});

it("shows the join screen for an invite link instead of asking for sign-in", async () => {
  // The setup probe would answer "owner exists" here, same as the plain
  // sign-in case — but reaching it at all would be the bug: this person has
  // no account yet, and the probe cannot offer them one.
  window.location.hash = "#/join/inv_abc123";
  const currentUser = vi.fn(async () => {
    throw new LykeionError("unauthenticated", "not signed in");
  });
  stubFetch({ "/auth/setup": () => json(404, { error: "owner exists" }) });
  render(
    <AuthGate currentUser={currentUser} onSignedIn={() => {}}>
      <p>the workbench</p>
    </AuthGate>,
  );
  expect(
    await screen.findByRole("heading", { name: "Join the lab" }),
  ).toBeInTheDocument();
  // The join screen carries its own way out to sign-in, so this asks for
  // the sign-in screen's own submit button by its exact name rather than
  // for anything reading "sign in".
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  expect(screen.queryByText("the workbench")).toBeNull();
});

it("keeps a signed-in member in their lab when they open an invite link", async () => {
  // A link a colleague forwarded, or their own a second time. The join
  // screen has no way back to the workbench, and submitting it would build
  // them a second identity in a lab they are already in — so a live session
  // wins over the code, and the spent code leaves the address bar.
  window.location.hash = "#/join/inv_forwarded";
  const currentUser = vi.fn(async () => ({
    id: "u_1", email: "ana@lab.example", displayName: "Ana", createdTs: 1,
  }));
  stubFetch({ "/auth/setup": () => json(404, { error: "owner exists" }) });
  render(
    <AuthGate currentUser={currentUser} onSignedIn={() => {}}>
      <p>the workbench</p>
    </AuthGate>,
  );

  expect(await screen.findByText("the workbench")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Join the lab" })).toBeNull();
  await waitFor(() => expect(window.location.hash).toBe(""));
});

it("holds an invite back when the session behind the workbench has lapsed", async () => {
  // `in` is the answer to a question asked when the page opened. Somebody
  // offboarded, or whose session expired, still reads that way until
  // something asks again — and the invite they were handed is valid. Spent
  // against the stale answer, it is a working code thrown away, and the
  // address bar no longer holds it to try a second time.
  let live = true;
  const currentUser = vi.fn(async () => {
    if (!live) throw new LykeionError("unauthenticated", "not signed in");
    return { id: "u_1", email: "ana@lab.example", displayName: "Ana", createdTs: 1 };
  });
  stubFetch({ "/auth/setup": () => json(404, { error: "owner exists" }) });
  render(
    <AuthGate currentUser={currentUser} onSignedIn={() => {}}>
      <p>the workbench</p>
    </AuthGate>,
  );
  expect(await screen.findByText("the workbench")).toBeInTheDocument();

  live = false;
  window.location.hash = "#/join/inv_still_good";
  window.dispatchEvent(new Event("hashchange"));

  expect(
    await screen.findByRole("heading", { name: "Join the lab" }),
  ).toBeInTheDocument();
  expect(window.location.hash).toBe("#/join/inv_still_good");
});

it("switches to the join screen when a join link is pasted in after landing on sign-in", async () => {
  const currentUser = vi.fn(async () => {
    throw new LykeionError("unauthenticated", "not signed in");
  });
  stubFetch({ "/auth/setup": () => json(404, { error: "owner exists" }) });
  render(
    <AuthGate currentUser={currentUser} onSignedIn={() => {}}>
      <p>the workbench</p>
    </AuthGate>,
  );
  expect(await screen.findByRole("button", { name: /Sign in/i })).toBeInTheDocument();

  window.location.hash = "#/join/inv_xyz789";
  window.dispatchEvent(new Event("hashchange"));

  expect(
    await screen.findByRole("heading", { name: "Join the lab" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
});

it("shows the server's refusal rather than a generic failure", async () => {
  const user = userEvent.setup();
  const currentUser = vi.fn(async () => {
    throw new LykeionError("unauthenticated", "not signed in");
  });
  stubFetch({
    "/auth/setup": () => json(404, { error: "owner exists" }),
    "/auth/signin": () => json(401, { error: "that email and password do not match an account" }),
  });
  render(
    <AuthGate currentUser={currentUser} onSignedIn={() => {}}>
      <p>the workbench</p>
    </AuthGate>,
  );
  await user.type(await screen.findByLabelText("Email"), "ana@lab.example");
  await user.type(screen.getByLabelText("Password"), "wrong");
  await user.click(screen.getByRole("button", { name: /Sign in/i }));
  expect(
    await screen.findByText("that email and password do not match an account"),
  ).toBeInTheDocument();
});

it("tells the app the identity changed once a sign-in is accepted", async () => {
  const user = userEvent.setup();
  const onSignedIn = vi.fn();
  const currentUser = vi.fn(async () => {
    throw new LykeionError("unauthenticated", "not signed in");
  });
  stubFetch({
    "/auth/setup": () => json(404, { error: "owner exists" }),
    "/auth/signin": () => json(200, { ok: true }),
  });
  render(
    <AuthGate currentUser={currentUser} onSignedIn={onSignedIn}>
      <p>the workbench</p>
    </AuthGate>,
  );
  await user.type(await screen.findByLabelText("Email"), "ana@lab.example");
  await user.type(screen.getByLabelText("Password"), "a good long password");
  await user.click(screen.getByRole("button", { name: /Sign in/i }));
  await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
});

it("leaves a usable form behind when the check after a sign-in still refuses", async () => {
  // The server took the credentials, but the check that follows does not
  // come back signed in — a restart in between, a cookie the browser
  // declined. Landing back on the same screen must land on a fresh one: a
  // form still frozen mid-submission has no enabled control left on it, and
  // nothing short of a reload gets one back.
  const user = userEvent.setup();
  const currentUser = vi.fn(async () => {
    throw new LykeionError("unauthenticated", "not signed in");
  });
  stubFetch({
    "/auth/setup": () => json(404, { error: "owner exists" }),
    "/auth/signin": () => json(200, { ok: true }),
  });
  render(
    <AuthGate currentUser={currentUser} onSignedIn={() => {}}>
      <p>the workbench</p>
    </AuthGate>,
  );
  await user.type(await screen.findByLabelText("Email"), "ana@lab.example");
  await user.type(screen.getByLabelText("Password"), "a good long password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));

  expect(await screen.findByRole("button", { name: "Sign in" })).toBeEnabled();
});

it("still offers a way in when the setup probe cannot be made at all", async () => {
  // With no handler the stub throws, which is what a page whose server has
  // gone away between two requests actually gets. An unanswered probe must
  // not leave the gate undecided, because undecided renders nothing.
  const currentUser = vi.fn(async () => {
    throw new LykeionError("unauthenticated", "not signed in");
  });
  stubFetch({});
  render(
    <AuthGate currentUser={currentUser} onSignedIn={() => {}}>
      <p>the workbench</p>
    </AuthGate>,
  );
  expect(await screen.findByRole("button", { name: /Sign in/i })).toBeInTheDocument();
  expect(screen.queryByText("the workbench")).toBeNull();
});

function SignOutProbe() {
  const signOut = useSignOut();
  return (
    <button onClick={signOut} disabled={!signOut}>
      leave
    </button>
  );
}

it("signing out clears the workbench and returns the sign-in screen", async () => {
  const user = userEvent.setup();
  let sessionEnded = false;
  const currentUser = vi.fn(async () => {
    if (sessionEnded) throw new LykeionError("unauthenticated", "not signed in");
    return { id: "u_1", email: "ana@lab.example", displayName: "Ana", createdTs: 1 };
  });
  stubFetch({
    "/auth/setup": () => json(404, { error: "owner exists" }),
    "/auth/signout": () => {
      sessionEnded = true;
      return json(200, { ok: true });
    },
  });
  render(
    <AuthGate currentUser={currentUser} onSignedIn={() => {}}>
      <p>the workbench</p>
      <SignOutProbe />
    </AuthGate>,
  );
  expect(await screen.findByText("the workbench")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "leave" }));

  expect(await screen.findByRole("button", { name: /Sign in/i })).toBeInTheDocument();
  expect(screen.queryByText("the workbench")).toBeNull();
});

it("clears the workbench the moment sign-out is asked for, not when the server answers", async () => {
  // Three round trips separate the click from the sign-in screen, and the
  // middle one tears down the data layer underneath. Left on screen for
  // that, the workbench spends it failing to reload the work of the person
  // who is on their way out.
  const user = userEvent.setup();
  let answer: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  let sessionEnded = false;
  const currentUser = vi.fn(async () => {
    if (sessionEnded) throw new LykeionError("unauthenticated", "not signed in");
    return { id: "u_1", email: "ana@lab.example", displayName: "Ana", createdTs: 1 };
  });
  vi.stubGlobal("fetch", async (input: RequestInfo) => {
    const path = new URL(String(input), "http://lab.example").pathname;
    if (path === "/auth/setup") return json(404, { error: "owner exists" });
    if (path === "/auth/signout") {
      sessionEnded = true;
      await held;
      return json(200, { ok: true });
    }
    throw new Error(`no stub for ${path}`);
  });
  render(
    <AuthGate currentUser={currentUser} onSignedIn={() => {}}>
      <p>the workbench</p>
      <SignOutProbe />
    </AuthGate>,
  );
  expect(await screen.findByText("the workbench")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "leave" }));

  expect(screen.queryByText("the workbench")).toBeNull();

  answer();
  expect(await screen.findByRole("button", { name: /Sign in/i })).toBeInTheDocument();
});

it("re-checks who is signed in when handed a new currentUser, and drops the workbench when that check now fails", async () => {
  // Standing in for what App.tsx does on a session that lapses mid-visit:
  // it does not call anything inside AuthGate directly, it hands down a new
  // `currentUser` function. The gate's own contract is to treat that as a
  // reason to ask the server again.
  const stillSignedIn = vi.fn(async () => ({
    id: "u_1", email: "ana@lab.example", displayName: "Ana", createdTs: 1,
  }));
  const lapsed = vi.fn(async () => {
    throw new LykeionError("unauthenticated", "not signed in");
  });
  stubFetch({ "/auth/setup": () => json(404, { error: "owner exists" }) });
  const { rerender } = render(
    <AuthGate currentUser={stillSignedIn} onSignedIn={() => {}}>
      <p>the workbench</p>
    </AuthGate>,
  );
  expect(await screen.findByText("the workbench")).toBeInTheDocument();

  rerender(
    <AuthGate currentUser={lapsed} onSignedIn={() => {}}>
      <p>the workbench</p>
    </AuthGate>,
  );

  expect(await screen.findByRole("button", { name: /Sign in/i })).toBeInTheDocument();
  expect(screen.queryByText("the workbench")).toBeNull();
});
