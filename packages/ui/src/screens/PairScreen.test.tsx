import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, encodeRequest, LykeionError, type LykeionApi } from "@lykeion/api";
import App from "../App";

// The pairing link a daemon prints when it asks a browser to approve it.
const PAIR_HASH =
  "#/pair?name=demo-machine&platform=macos-aarch64&version=0.1.0&challenge=abc&state=xyz&redirect=http%3A%2F%2F127.0.0.1%3A9999%2Fpaired";

// `window.location.assign` leaves the app for another origin — jsdom's real
// Location does not implement navigation, and its `assign` cannot be
// reconfigured in place, so the whole object is swapped for a stub that
// records what the screen tried to do and is put back afterward.
const originalLocation = window.location;
let assign: ReturnType<typeof vi.fn>;

/**
 * A working `window.localStorage`, which this environment does not otherwise
 * have — `localStorage` here is a bare object with none of Storage's methods
 * on it, which is why the suites that clear it do so inside a `try`. The
 * screen records the links it has approved through that interface, so
 * without one every read comes back empty and the guard under test can never
 * be exercised. Only the four methods the screen touches are implemented; a
 * fifth arriving should fail loudly rather than quietly answer undefined.
 */
const originalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");

function installLocalStorage(): void {
  const entries = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
      removeItem: (key: string) => void entries.delete(key),
      clear: () => entries.clear(),
    },
  });
}

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, assign },
  });
  // Fresh per case, so no test inherits another's approvals — the record is
  // meant to outlive a tab, which is exactly what makes it leak across
  // tests if it is left standing.
  installLocalStorage();
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  if (originalStorage) {
    Object.defineProperty(window, "localStorage", originalStorage);
  }
  window.history.replaceState(null, "", window.location.pathname);
});

it("shows the machine's name, platform and daemon version", async () => {
  window.location.hash = PAIR_HASH;
  render(<App api={createInMemoryApi()} />);

  expect(await screen.findByText("demo-machine")).toBeInTheDocument();
  expect(screen.getByText("macos-aarch64")).toBeInTheDocument();
  expect(screen.getByText("0.1.0")).toBeInTheDocument();
});

it("Approve calls pairMachine with exactly the parsed parameters, then sends the browser to the redirect carrying the code and state", async () => {
  const user = userEvent.setup();
  window.location.hash = PAIR_HASH;
  const pairMachine = vi.fn().mockResolvedValue({ code: "one-time-code" });
  const api: LykeionApi = { ...createInMemoryApi(), pairMachine };
  render(<App api={api} />);

  await user.click(await screen.findByRole("button", { name: /approve/i }));

  await waitFor(() => expect(pairMachine).toHaveBeenCalledTimes(1));
  expect(pairMachine).toHaveBeenCalledWith({
    name: "demo-machine",
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    challenge: "abc",
    redirect: "http://127.0.0.1:9999/paired",
  });
  await waitFor(() =>
    expect(assign).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/paired?code=one-time-code&state=xyz",
    ),
  );
});

it("Refuse tells the daemon, and mints no code doing it", async () => {
  const user = userEvent.setup();
  window.location.hash = PAIR_HASH;
  const pairMachine = vi.fn();
  const api: LykeionApi = { ...createInMemoryApi(), pairMachine };
  render(<App api={api} />);

  await user.click(await screen.findByRole("button", { name: /refuse/i }));

  // The daemon is the only party that can hear this: it is waiting on a
  // callback and nothing else would ever tell it the answer was no.
  await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
  const sent = new URL(assign.mock.calls[0]![0] as string);
  expect(sent.origin).toBe("http://127.0.0.1:9999");
  expect(sent.pathname).toBe("/paired");
  expect(sent.searchParams.get("refused")).toBe("1");
  expect(sent.searchParams.get("state")).toBe("xyz");
  // A refusal that carried a code would be an approval wearing the wrong
  // label, so the absence of one is the assertion, not an omission.
  expect(sent.searchParams.get("code")).toBeNull();
  expect(pairMachine).not.toHaveBeenCalled();
});

it("answers a refused link that is opened again, rather than offering to approve it", async () => {
  const user = userEvent.setup();
  window.location.hash = PAIR_HASH;
  const api: LykeionApi = { ...createInMemoryApi(), pairMachine: vi.fn() };
  render(<App api={api} />);
  await user.click(await screen.findByRole("button", { name: /refuse/i }));
  cleanup();

  // The same link, in the same browser, the way a back button or a second
  // click on it arrives. A live Approve here would undo a decision the
  // researcher has already made.
  window.location.hash = PAIR_HASH;
  render(<App api={api} />);

  expect(
    await screen.findByRole("heading", { name: /already been used/i }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
});

it("shows the server's own refusal rather than failing silently", async () => {
  const user = userEvent.setup();
  window.location.hash = PAIR_HASH;
  const pairMachine = vi
    .fn()
    .mockRejectedValue(
      new LykeionError("invalid", "pairing must redirect to a loopback address"),
    );
  const api: LykeionApi = { ...createInMemoryApi(), pairMachine };
  render(<App api={api} />);

  await user.click(await screen.findByRole("button", { name: /approve/i }));

  expect(
    await screen.findByText(/pairing must redirect to a loopback address/i),
  ).toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
});

it("explains a challenge the lab refuses as spent, rather than printing the refusal under an Approve button that cannot work", async () => {
  const user = userEvent.setup();
  window.location.hash = PAIR_HASH;
  // What a second browser gets: it approved nothing, so it has no record of
  // its own, and the lab is the only thing that knows the challenge is done.
  const pairMachine = vi
    .fn()
    .mockRejectedValue(
      new LykeionError(
        "conflict",
        "a pairing link is good for exactly one approval, and this one is spent",
      ),
    );
  const api: LykeionApi = { ...createInMemoryApi(), pairMachine };
  render(<App api={api} />);

  await user.click(await screen.findByRole("button", { name: /approve/i }));

  // Waited for, not assumed: the refusal screen is on the page before
  // anything below reads what is missing from it, so a form that is gone is
  // a form that was replaced rather than one still on its way.
  expect(
    await screen.findByText(/that link has already been used/i),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /approve/i }),
  ).not.toBeInTheDocument();
  // And it says what to do about it. A lab that refuses in its own words
  // says why, not what to go and do on a machine it cannot see.
  expect(screen.getByText(/restart its daemon/i)).toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
});

it("holds a challenge the lab refused, so a reload answers without asking it to refuse the same link again", async () => {
  const user = userEvent.setup();
  window.location.hash = PAIR_HASH;
  const pairMachine = vi
    .fn()
    .mockRejectedValue(new LykeionError("conflict", "and this one is spent"));
  const api: LykeionApi = { ...createInMemoryApi(), pairMachine };

  render(<App api={api} />);
  await user.click(await screen.findByRole("button", { name: /approve/i }));
  await waitFor(() => expect(pairMachine).toHaveBeenCalledTimes(1));

  cleanup();
  render(<App api={api} />);

  expect(
    await screen.findByText(/that link has already been used/i),
  ).toBeInTheDocument();
  expect(pairMachine).toHaveBeenCalledTimes(1);
});

it("refuses a link it has already turned into a code, instead of offering a form that cannot reach the machine", async () => {
  const user = userEvent.setup();
  window.location.hash = PAIR_HASH;
  const pairMachine = vi.fn().mockResolvedValue({ code: "one-time-code" });
  const api: LykeionApi = { ...createInMemoryApi(), pairMachine };

  render(<App api={api} />);
  await user.click(await screen.findByRole("button", { name: /approve/i }));
  // The first approval has to have actually gone through, or everything
  // below is asserting against a link that was never spent.
  await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));

  // A fresh mount on the same URL: Back, a reload, a bookmark. The daemon
  // settled this request when the link was first used, so there is nothing
  // here left to approve.
  cleanup();
  render(<App api={api} />);

  expect(
    await screen.findByText(/that link has already been used/i),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /approve/i }),
  ).not.toBeInTheDocument();
  // And no second code was minted. `pairMachine` answers every time it is
  // asked, so a replayed approval leaves a live credential in the lab and in
  // this browser's history for a machine that is no longer waiting on one.
  expect(pairMachine).toHaveBeenCalledTimes(1);
});

it("still offers a machine whose link it has not seen, once another has been spent", async () => {
  const user = userEvent.setup();
  window.location.hash = PAIR_HASH;
  const pairMachine = vi.fn().mockResolvedValue({ code: "one-time-code" });
  const api: LykeionApi = { ...createInMemoryApi(), pairMachine };

  render(<App api={api} />);
  await user.click(await screen.findByRole("button", { name: /approve/i }));
  await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));

  cleanup();
  // A second daemon, mid-pairing, with a challenge of its own. What is
  // remembered is one link, not pairing in general.
  window.location.hash = PAIR_HASH.replace("challenge=abc", "challenge=xyzzy")
    .replace("name=demo-machine", "name=other-machine");
  render(<App api={api} />);

  expect(await screen.findByText("other-machine")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /approve/i })).toBeEnabled();
  expect(screen.queryByText(/already been used/i)).toBeNull();
});

it("says so plainly, rather than rendering an empty form, when the hash carries only part of a request", async () => {
  // A link that was truncated by a chat window or edited by hand. It is not
  // an invitation to paste — the researcher already opened something that
  // was meant to work — so it says what went wrong with the thing they have
  // rather than offering a different way in.
  window.location.hash = "#/pair?name=demo-machine&platform=macos-aarch64";
  render(<App api={createInMemoryApi()} />);

  expect(
    await screen.findByText(/nothing to approve|no machine|no pairing/i),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

// ---------------------------------------------------------------------------
// A machine with no browser, and no way back to its own loopback address.
//
// Same handshake, same three facts, same two answers. What changes is that a
// person carries the request in and the code back out, so this screen is
// reached with an empty hash and leaves for nowhere at the end of it.
// ---------------------------------------------------------------------------

const PASTED = encodeRequest({
  name: "gpu-box",
  platform: "linux-x64",
  version: "0.1.0",
  challenge: "pasted-challenge",
  state: "pasted-state",
  redirect: "http://127.0.0.1:1421/paired",
});

it("offers somewhere to paste, when the hash carries nothing at all", async () => {
  window.location.hash = "#/pair";
  render(<App api={createInMemoryApi()} />);

  expect(await screen.findByRole("textbox")).toBeInTheDocument();
  // Nothing to approve yet: there is no machine on this page until a request
  // has been read, and an Approve standing over an empty box would be a
  // button for a decision nobody has been shown.
  expect(screen.queryByRole("button", { name: /^approve/i })).not.toBeInTheDocument();
});

it("shows a pasted request as the same three facts the link shows", async () => {
  const user = userEvent.setup();
  window.location.hash = "#/pair";
  render(<App api={createInMemoryApi()} />);

  await user.type(await screen.findByRole("textbox"), PASTED);
  await user.click(screen.getByRole("button", { name: /read it/i }));

  expect(await screen.findByText("gpu-box")).toBeInTheDocument();
  expect(screen.getByText("linux-x64")).toBeInTheDocument();
  expect(screen.getByText("0.1.0")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^approve/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /refuse/i })).toBeInTheDocument();
});

it("shows the code instead of leaving, because there is no browser on the far end", async () => {
  const user = userEvent.setup();
  window.location.hash = "#/pair";
  const pairMachine = vi.fn().mockResolvedValue({ code: "carry-me-back" });
  const api: LykeionApi = { ...createInMemoryApi(), pairMachine };
  render(<App api={api} />);

  await user.type(await screen.findByRole("textbox"), PASTED);
  await user.click(screen.getByRole("button", { name: /read it/i }));
  await user.click(await screen.findByRole("button", { name: /^approve/i }));

  // Exactly the call the link path makes. The transport changed; the
  // handshake did not.
  await waitFor(() => expect(pairMachine).toHaveBeenCalledTimes(1));
  expect(pairMachine).toHaveBeenCalledWith({
    name: "gpu-box",
    platform: "linux-x64",
    daemonVersion: "0.1.0",
    challenge: "pasted-challenge",
    redirect: "http://127.0.0.1:1421/paired",
  });

  expect(await screen.findByText("carry-me-back")).toBeInTheDocument();
  // The redirect in a pasted request is a loopback address on somebody
  // else's machine. Going there would land this browser on nothing, and
  // lose the code on the way.
  expect(assign).not.toHaveBeenCalled();
});

it("says how to carry the code back, since typing it somewhere is the whole rest of the job", async () => {
  const user = userEvent.setup();
  window.location.hash = "#/pair";
  const api: LykeionApi = {
    ...createInMemoryApi(),
    pairMachine: vi.fn().mockResolvedValue({ code: "carry-me-back" }),
  };
  render(<App api={api} />);

  await user.type(await screen.findByRole("textbox"), PASTED);
  await user.click(screen.getByRole("button", { name: /read it/i }));
  await user.click(await screen.findByRole("button", { name: /^approve/i }));

  expect(await screen.findByText(/lykeion pair --code/i)).toBeInTheDocument();
});

it("refuses without leaving either, and mints no code doing it", async () => {
  const user = userEvent.setup();
  window.location.hash = "#/pair";
  const pairMachine = vi.fn();
  const api: LykeionApi = { ...createInMemoryApi(), pairMachine };
  render(<App api={api} />);

  await user.type(await screen.findByRole("textbox"), PASTED);
  await user.click(screen.getByRole("button", { name: /read it/i }));
  await user.click(await screen.findByRole("button", { name: /refuse/i }));

  // There is no callback to send a refusal to: the daemon is not reachable
  // from this browser, which is why the request came in by hand. It hears
  // nothing, and its request stands until it is stopped.
  expect(await screen.findByRole("heading", { name: /refused/i })).toBeInTheDocument();
  expect(assign).not.toHaveBeenCalled();
  expect(pairMachine).not.toHaveBeenCalled();
});

it("says what a line that is not a request is, and keeps what was typed", async () => {
  const user = userEvent.setup();
  window.location.hash = "#/pair";
  render(<App api={createInMemoryApi()} />);

  const box = await screen.findByRole("textbox");
  await user.type(box, "LYK1.definitely-not-a-request");
  await user.click(screen.getByRole("button", { name: /read it/i }));

  expect(await screen.findByText(/not a request/i)).toBeInTheDocument();
  // Kept, not cleared. A researcher who pasted the wrong half of a wrapped
  // line needs to see what they pasted to work out which half it was.
  expect(box).toHaveValue("LYK1.definitely-not-a-request");
});

it("holds a pasted challenge it has already spent, the same way it holds a link's", async () => {
  const user = userEvent.setup();
  window.location.hash = "#/pair";
  const pairMachine = vi.fn().mockResolvedValue({ code: "carry-me-back" });
  const api: LykeionApi = { ...createInMemoryApi(), pairMachine };

  render(<App api={api} />);
  await user.type(await screen.findByRole("textbox"), PASTED);
  await user.click(screen.getByRole("button", { name: /read it/i }));
  await user.click(await screen.findByRole("button", { name: /^approve/i }));
  await waitFor(() => expect(pairMachine).toHaveBeenCalledTimes(1));

  // The same blob again, in the same browser — a researcher who lost the
  // code and went back for it. The daemon settled this request when the
  // first code was minted, so there is nothing here left to approve.
  cleanup();
  render(<App api={api} />);
  await user.type(await screen.findByRole("textbox"), PASTED);
  await user.click(screen.getByRole("button", { name: /read it/i }));

  expect(await screen.findByText(/already been used/i)).toBeInTheDocument();
  expect(pairMachine).toHaveBeenCalledTimes(1);
});
