/**
 * The Inbox as a messaging surface: a list of conversations about the lab's
 * work, and the open thread beside it.
 *
 * A conversation is held with colleagues and agents ABOUT a Task — it is not
 * the Task's own chat, which is the agent's transcript on the Task surface.
 * Role/text-based, agnostic to the markup.
 */

import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import App from "../App";

afterEach(cleanup);

/** Open the Inbox from the Rail. */
async function openInbox(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("link", { name: /Inbox/i }));
  return screen.findByRole("heading", { name: "Inbox", level: 1 });
}

it("lists conversations and opens one into a readable thread", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await openInbox(user);

  await user.click(await screen.findByText("Preprocess two-photon calcium traces"));

  // The thread itself: every message in it, oldest first, each named.
  const thread = await screen.findByTestId("conversation-thread");
  expect(
    within(thread).getByText(/512 is pre-filter/i),
  ).toBeInTheDocument();
  expect(within(thread).getByText(/re-run the filter/i)).toBeInTheDocument();
  // An expert speaks here alongside the people, and is marked as one.
  expect(within(thread).getByText("Reviewer")).toBeInTheDocument();
  expect(within(thread).getAllByText("Expert").length).toBeGreaterThan(0);
});

it("sets the reader's own messages against the trailing edge", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await openInbox(user);

  await user.click(await screen.findByText("Preprocess two-photon calcium traces"));
  const thread = await screen.findByTestId("conversation-thread");

  // Who is speaking is legible before a word is read: the reader's own turns
  // sit on the right, everyone else's on the left. Asserted on the row rather
  // than on a class, so the marker survives a restyle.
  const mine = await within(thread).findByText(/Traces are on disk/i);
  expect(mine.closest("li")).toHaveAttribute("data-own", "true");

  const amara = within(thread).getByText(/512 is pre-filter/i);
  expect(amara.closest("li")).not.toHaveAttribute("data-own");
  // An agent is never "you" either, whatever it is called.
  const reviewer = within(thread).getByText(/flagged the same contradiction/i);
  expect(reviewer.closest("li")).not.toHaveAttribute("data-own");
});

it("links from the thread to the Task it is about", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await openInbox(user);

  await user.click(await screen.findByText("Preprocess two-photon calcium traces"));
  // A thread is ABOUT a Task, and the code is how a researcher names that work.
  expect(
    await screen.findByRole("link", { name: /CMP-3/ }),
  ).toBeInTheDocument();
});

it("names itself in the same title row as every other section", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await user.click(await screen.findByRole("link", { name: /Inbox/i }));

  // level 1 — the `h1` only `ScreenHeader` renders, so this passes solely
  // because Inbox uses the shared title row and not some heading of its own.
  expect(
    await screen.findByRole("heading", { name: "Inbox", level: 1 }),
  ).toBeInTheDocument();
});

it("says so on a fresh install, without losing the title row", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await user.click(await screen.findByRole("link", { name: /Inbox/i }));

  expect(
    await screen.findByText(/No conversations yet — start one\./i),
  ).toBeInTheDocument();
  // The empty state replaces the list, not the screen.
  expect(
    screen.getByRole("heading", { name: "Inbox", level: 1 }),
  ).toBeInTheDocument();
});

it("posting a message appends it and re-previews the row", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await openInbox(user);

  await user.click(await screen.findByText("Quantify tuning drift after deprivation"));
  await user.type(
    await screen.findByRole("textbox", { name: "Write a message" }),
    "Filter re-run is done — 384 it is.",
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));

  const thread = await screen.findByTestId("conversation-thread");
  expect(
    await within(thread).findByText(/Filter re-run is done/i),
  ).toBeInTheDocument();
  // The list row shows what was last said, so it has to follow the thread.
  expect(
    await screen.findByText(/You: Filter re-run is done/i),
  ).toBeInTheDocument();
});

it("reading a conversation clears its unread count and the Rail badge", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);

  // The seed has exactly one thread with something unread in it, so the badge
  // counts THREADS waiting rather than messages — 2 unread messages, badge 1.
  const railLink = await screen.findByRole("link", { name: /Inbox/i });
  const badge = within(railLink).getByText("1");
  expect(badge).toHaveAttribute("aria-label", "1 unread conversations");

  await user.click(railLink);
  const row = await screen.findByText("Preprocess two-photon calcium traces");
  expect(await screen.findByLabelText("2 unread")).toBeInTheDocument();

  await user.click(row);

  // Opening IS reading: the pill goes, and the badge with it.
  await screen.findByTestId("conversation-thread");
  expect(screen.queryByLabelText("2 unread")).not.toBeInTheDocument();
  expect(
    within(await screen.findByRole("link", { name: /Inbox/i })).queryByText("1"),
  ).not.toBeInTheDocument();
});

it("narrows by chip and by search, and says so when nothing matches", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await openInbox(user);

  const traces = "Preprocess two-photon calcium traces";
  const drift = "Quantify tuning drift after deprivation";
  await screen.findByText(traces);

  // Unread: only the CMP-3 thread has anything waiting in it.
  await user.click(screen.getByRole("button", { name: "Unread" }));
  expect(screen.getByRole("button", { name: "Unread" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByText(traces)).toBeInTheDocument();
  expect(screen.queryByText(drift)).not.toBeInTheDocument();

  // One chip at a time: picking All releases Unread.
  await user.click(screen.getByRole("button", { name: "All" }));
  expect(screen.getByRole("button", { name: "Unread" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  expect(screen.getByText(drift)).toBeInTheDocument();

  // Search runs over the same list, matched on the title the row prints.
  await user.type(screen.getByRole("textbox", { name: /search/i }), "drift");
  expect(screen.getByText(drift)).toBeInTheDocument();
  expect(screen.queryByText(traces)).not.toBeInTheDocument();

  // A list a query has emptied is NOT a caught-up Inbox, and must not say so.
  await user.clear(screen.getByRole("textbox", { name: /search/i }));
  await user.type(screen.getByRole("textbox", { name: /search/i }), "zzzz");
  expect(await screen.findByText(/No conversations match/i)).toBeInTheDocument();
  expect(screen.queryByText(/No conversations yet/i)).not.toBeInTheDocument();
});

it("keeps an open thread open when a search hides its row", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await openInbox(user);

  await user.click(await screen.findByText("Preprocess two-photon calcium traces"));
  await screen.findByTestId("conversation-thread");

  // Typing a query that excludes the open thread empties the list beside it,
  // but the thread stays put — a search must not blank what is being read.
  await user.type(screen.getByRole("textbox", { name: /search/i }), "10x lanes");
  expect(screen.getByTestId("conversation-thread")).toBeInTheDocument();
});

it("the compose button starts a chat, not a task", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi()} />);
  await openInbox(user);

  // The Rail's "New Task" is on screen too. This screen's control is a
  // different act with a different name, which is the whole point.
  const compose = await screen.findByRole("button", { name: "New chat" });
  await user.click(compose);

  expect(
    await screen.findByRole("dialog", { name: "Start a conversation" }),
  ).toBeInTheDocument();
  // Emphatically not the task form.
  expect(screen.queryByLabelText("Create task")).not.toBeInTheDocument();
});

it("offers a way to start something even when there is nothing to read", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await user.click(await screen.findByRole("link", { name: /Inbox/i }));

  await screen.findByText(/No conversations yet — start one\./i);
  expect(screen.getByRole("button", { name: "New chat" })).toBeInTheDocument();
});

it("offers nothing to filter on an empty Inbox", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await user.click(await screen.findByRole("link", { name: /Inbox/i }));

  await screen.findByText(/No conversations yet — start one\./i);
  // A search field over a list that does not exist is furniture.
  expect(screen.queryByRole("textbox", { name: /search/i })).toBeNull();
  expect(screen.queryByRole("button", { name: "Unread" })).toBeNull();
});
