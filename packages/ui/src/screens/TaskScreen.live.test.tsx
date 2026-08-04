/**
 * The LIVE turn: what the Task transcript shows while the run is still
 * going, before any record has landed.
 *
 * Every assertion here is MID-TURN, on purpose. The last snapshot of every turn
 * is `{}` (each `LiveTurn` field is skipped when empty), and `completed`
 * replaces the whole live surface with the run's own `stream` — so
 * a test that only checks the tail is eventually gone would pass no matter what
 * happened while the turn was running. Nothing here waits for the end of the
 * turn except the two tests that are explicitly about the end of the turn.
 *
 * The run's event stream is driven BY THE TEST, one event at a time, because
 * that is the only way to observe an intermediate state at all.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import type {
  ExecutionLogEntry,
  LykeionApi,
  RunEvent,
  RunHandle,
} from "@lykeion/api";
import App from "../App";

const ROUTE = "#/studies/s_cmp/tasks/t_3";

/** A run whose events the test emits by hand — no scripted timeline, so every
 *  assertion below lands at a chosen point INSIDE the turn. */
function scriptedApi() {
  const subs = new Set<(e: RunEvent) => void>();
  const api: LykeionApi = {
    ...createInMemoryApi(),
    async startRun(): Promise<RunHandle> {
      return {
        runId: "run-live",
        onEvent(cb) {
          subs.add(cb);
          return () => subs.delete(cb);
        },
        submit() {},
        // What `teardown()` calls: a closed handle delivers nothing more.
        close() {
          subs.clear();
        },
      };
    },
  };
  const emit = (e: RunEvent) =>
    act(() => {
      for (const cb of [...subs]) cb(e);
    });
  return { api, emit, subs };
}

/** Send a prompt and wait until the run's stream is subscribed — from here on
 *  the turn is IN FLIGHT and nothing ends it until the test says so. */
async function startTurn() {
  const { api, emit, subs } = scriptedApi();
  const user = userEvent.setup();
  window.location.hash = ROUTE;
  render(<App api={api} />);
  await user.type(
    await screen.findByLabelText("Message the agent"),
    "which candidates responded?",
  );
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(subs.size).toBeGreaterThan(0));
  return { emit, user };
}

/**
 * An Execution Log entry as it arrives LIVE. The entry is announced once, at
 * entry creation — never again when the result merges — so a live entry
 * carries no `result` at all.
 */
const readEntry = (path: string, toolUseId = "tu-read"): ExecutionLogEntry => ({
  ts: 1,
  toolUseId,
  tool: "Read",
  input: { file_path: path },
  decision: "ran",
  isError: false,
});

const bashEntry = (command: string, toolUseId: string): ExecutionLogEntry => ({
  ts: 1,
  toolUseId,
  tool: "Bash",
  input: { command },
  decision: "ran",
  isError: false,
});

/** The run is still going: the run line is drawn and Stop still holds the
 *  composer. Asserted alongside the live content so no test below can be
 *  satisfied by end-of-turn state. */
function expectStillRunning() {
  expect(screen.getByRole("status")).toHaveTextContent(/Planning|Running/);
  expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  expect(screen.queryByText(/Run complete|Run failed/)).toBeNull();
}

beforeEach(cleanup);

describe("the live turn", () => {
  it("renders a tool card while the turn is still running", async () => {
    const { emit } = await startTurn();
    emit({ event: "log-entry", entry: readEntry("data.csv") });

    const card = await screen.findByTestId("tool-step");
    expect(within(card).getByText("Read data.csv")).toBeInTheDocument();
    // No `result` has merged yet, and none is invented: the summary column
    // falls back to the tool name and no output disclosure is offered.
    expect(within(card).getByText("Read")).toHaveClass("tool-step-summary");
    expect(
      within(card).queryByRole("button", { name: /show output/i }),
    ).toBeNull();
    expectStillRunning();
  });

  it("streams prose into the live turn", async () => {
    const { emit } = await startTurn();
    emit({ event: "live", live: { text: "Strong candidates" } });

    const text = await screen.findByTestId("live-text");
    expect(text).toHaveTextContent("Strong candidates");
    expectStillRunning();
  });

  it("renders thinking in its own channel, never as prose", async () => {
    const { emit } = await startTurn();
    emit({
      event: "live",
      live: {
        thinking: "Let me check the responder column",
        text: "Strong candidates",
      },
    });

    const thinking = await screen.findByTestId("live-thinking");
    expect(thinking).toHaveTextContent("Let me check the responder column");
    // The prose column must not have absorbed it — separate node, separate
    // text, and not dressed as an assistant message bubble either.
    const text = screen.getByTestId("live-text");
    expect(text).toHaveTextContent(/^Strong candidates$/);
    expect(text).not.toHaveTextContent("Let me check");
    expect(thinking).not.toHaveClass("msg--assistant");
    expect(thinking.contains(text)).toBe(false);
    expectStillRunning();
  });

  it("a later snapshot REPLACES the earlier one", async () => {
    const { emit } = await startTurn();
    emit({
      event: "live",
      live: { text: "Strong cand", thinking: "Let me check" },
    });
    expect(await screen.findByTestId("live-thinking")).toHaveTextContent(
      "Let me check",
    );

    // One snapshot is the WHOLE in-flight state: the prose grew and the
    // thinking channel closed. Appending would leave "Strong candStrong
    // candidates"; merging field-wise would leave the closed thinking channel
    // on screen for the rest of the turn.
    emit({ event: "live", live: { text: "Strong candidates" } });

    const text = await screen.findByTestId("live-text");
    expect(text).toHaveTextContent(/^Strong candidates$/);
    expect(screen.getAllByText(/Strong candidates/)).toHaveLength(1);
    expect(screen.queryByText("Strong cand")).not.toBeInTheDocument();
    expect(screen.queryByTestId("live-thinking")).not.toBeInTheDocument();
    expectStillRunning();
  });

  it("routes a running tool's stdout to its own card, by toolUseId", async () => {
    // Two tools in flight at once — the shape `toolStdout` is a keyed LIST
    // for. Attaching the buffer to whichever card is at hand would put one
    // tool's output under the other's label.
    const { emit } = await startTurn();
    emit({ event: "log-entry", entry: bashEntry("wc -l a.csv", "tu-a") });
    emit({ event: "log-entry", entry: bashEntry("wc -l b.csv", "tu-b") });
    emit({
      event: "live",
      live: { toolStdout: [{ toolUseId: "tu-b", text: "42 b.csv" }] },
    });

    await screen.findByText("Ran: wc -l b.csv");
    const cardFor = (command: string) =>
      screen
        .getAllByTestId("tool-step")
        .find((c) => c.textContent?.includes(command))!;
    expect(
      within(cardFor("wc -l b.csv")).getByTestId("step-stdout"),
    ).toHaveTextContent("42 b.csv");
    expect(
      within(cardFor("wc -l a.csv")).queryByTestId("step-stdout"),
    ).toBeNull();

    // The next snapshot replaces the previous one wholesale: b's tool finished
    // and left the live channel, a's started producing. A stale tail under b
    // would be output attributed to a tool that is no longer producing any.
    emit({
      event: "live",
      live: { toolStdout: [{ toolUseId: "tu-a", text: "12 a.csv" }] },
    });
    expect(
      within(cardFor("wc -l a.csv")).getByTestId("step-stdout"),
    ).toHaveTextContent("12 a.csv");
    expect(
      within(cardFor("wc -l b.csv")).queryByTestId("step-stdout"),
    ).toBeNull();
    expectStillRunning();
  });

  it("drops the in-flight tail on the idle snapshot, and keeps the cards", async () => {
    const { emit } = await startTurn();
    emit({ event: "log-entry", entry: readEntry("data.csv") });
    emit({
      event: "live",
      live: { text: "Strong cand", thinking: "Let me check" },
    });
    // Mid-turn: the tail IS on screen. Without this the assertion below would
    // hold for a surface that never rendered a tail at all.
    expect(await screen.findByTestId("live-text")).toBeInTheDocument();
    expect(screen.getByTestId("live-thinking")).toBeInTheDocument();

    // The tail became a whole message and the channels emptied — the exact
    // payload the runner flushes at every channel boundary.
    emit({
      event: "assistant-text",
      text: "Strong candidates: 12 of 42.",
      partial: false,
    });
    emit({ event: "live", live: {} });

    expect(screen.queryByTestId("live-text")).not.toBeInTheDocument();
    expect(screen.queryByTestId("live-thinking")).not.toBeInTheDocument();
    // The message it became renders exactly once, and the card is untouched.
    expect(screen.getAllByText("Strong candidates: 12 of 42.")).toHaveLength(1);
    expect(screen.getByText("Read data.csv")).toBeInTheDocument();
    expectStillRunning();
  });

  it("renders nothing extra when the adapter sends no deltas (degrade path)", async () => {
    // `caps.partial_text === false` ⇒ no `live` event ever arrives. Whole
    // messages and whole steps render exactly as they do today; no channel is
    // drawn empty, and no adapter is named anywhere to make that happen.
    const { emit } = await startTurn();
    // The step first: a whole message immediately BEFORE a step is a tier-2
    // narration and becomes that card's title (`blocksOf`) — the same fold the
    // reopened view uses, and not what this test is about.
    emit({ event: "log-entry", entry: readEntry("data.csv") });
    emit({ event: "assistant-text", text: "Whole message", partial: false });

    // The text now lands inside a markdown `<p>` (`AssistantMessage`), one
    // level under the bubble itself — assert against the bubble ancestor,
    // not the exact node `findByText` resolves to.
    const bubble = await screen.findByText("Whole message");
    expect(bubble.closest(".msg--assistant")).not.toBeNull();
    expect(screen.getByText("Read data.csv")).toBeInTheDocument();
    expect(screen.queryByTestId("live-text")).not.toBeInTheDocument();
    expect(screen.queryByTestId("live-thinking")).not.toBeInTheDocument();
    expect(screen.queryByTestId("step-stdout")).not.toBeInTheDocument();
    expectStillRunning();
  });

  it("keeps already-started cards on screen when the researcher stops the run", async () => {
    const { emit, user } = await startTurn();
    emit({ event: "log-entry", entry: readEntry("data.csv") });
    expect(await screen.findByText("Read data.csv")).toBeInTheDocument();

    // Stop lives in the composer, in Send's place (see ComposerStop.test.tsx).
    await user.click(screen.getByRole("button", { name: "Stop" }));

    // `cancel()` runs `teardown()` synchronously — the cards must survive it.
    // A stopped turn lands no record here (the stream is simply cut), so
    // nothing else can put them back on screen.
    expect(await screen.findByText(/Run failed/)).toBeInTheDocument();
    expect(screen.getByText("Read data.csv")).toBeInTheDocument();
  });

  it("carries a stopped turn's cards into the transcript when the researcher continues", async () => {
    const { emit, user } = await startTurn();
    emit({ event: "log-entry", entry: readEntry("data.csv") });
    expect(await screen.findByText("Read data.csv")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));

    await user.type(screen.getByLabelText("Message the agent"), "try again");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The stopped turn graduates into the view. It has no landed record, so
    // its cards can only come from what the live turn accumulated — and the
    // NEW turn starts empty, so there is exactly one.
    expect(screen.getAllByText("Read data.csv")).toHaveLength(1);
    expect(screen.getAllByTestId("tool-step")).toHaveLength(1);
  });
});

describe("the live channels are styled apart", () => {
  // jsdom neither lays out nor applies the app's CSS, so this reads the
  // stylesheet source — the same approach `TaskScreen.tool-step.test.tsx`
  // uses for `.msg--assistant`'s `pre-wrap`.
  const css = () =>
    readFileSync(resolve(process.cwd(), "src/screens/task.css"), "utf8");

  it("gives thinking a visually distinct treatment from prose", () => {
    const thinking = css().match(/\.live-thinking\s*\{[^}]*\}/)?.[0] ?? "";
    // Thinking is not the answer: it reads as an aside (italic, its own rule
    // down the leading edge), never as the assistant's prose. It renders raw
    // text (not markdown), so it keeps its own newlines with `pre-wrap`.
    expect(thinking).toMatch(/font-style:\s*italic/);
    expect(thinking).toMatch(/border-inline-start/);
    expect(thinking).toMatch(/white-space:\s*pre-wrap/);

    // `.live-text` wraps an `<AssistantMessage live />`, which renders
    // `.msg .msg--assistant` — the SAME markup the landed bubble does — so it
    // carries no typography of its own, and specifically no `white-space`:
    // that property inherits, and a `pre-wrap` here would reach the child's
    // markdown output while the landed bubble (no such wrapper) stays
    // `normal`, reflowing visibly the instant the turn lands.
    const text = css().match(/\.live-text\s*\{[^}]*\}/)?.[0] ?? "";
    expect(text).not.toMatch(/font-style:\s*italic/);
    expect(text).not.toMatch(/white-space/);
  });
});
