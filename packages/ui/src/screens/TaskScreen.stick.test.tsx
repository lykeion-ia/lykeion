/**
 * The Task transcript sticks to the bottom while a reply
 * streams in, and gives ground the moment the researcher scrolls away.
 *
 * Two things are pinned here:
 *  1. `aria-live` scope — ONLY the in-flight turn is a polite log region.
 *     Putting it on `.conv-stream` itself would re-announce the whole
 *     transcript every time a Task is reopened, so the historic turns
 *     (rendered from the persisted `getTask` transcript) must carry
 *     neither `aria-live` nor `role="log"`.
 *  2. The "Jump to latest" pill — hidden while pinned, revealed by a scroll
 *     that leaves the ~40px slack at the bottom, and clicking it re-pins
 *     and hides it again. `useStickToBottom.test.tsx` covers the hook's own
 *     pin/unpin math directly; this file covers the wiring: the real
 *     `.conv-stream` element, the real pill, the real aria-live wrapper.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import type {
  LykeionApi,
  RunEvent,
  RunHandle,
  TaskTurn,
} from "@lykeion/api";
import App from "../App";

const TASK = "t_3";
const ROUTE = `#/studies/s_cmp/tasks/${TASK}`;

/** One persisted turn — the historic transcript a reopened Task replays. */
const HISTORIC_TURN: TaskTurn = {
  runId: "run-historic",
  ts: 1,
  prompt: "what's in the dataset?",
  messages: ["It has 42 rows."],
  status: "ok",
  code: [],
  outputs: [],
};

/** An API that serves `HISTORIC_TURN` on reopen and lets the test drive a
 *  live turn's events by hand. */
function scriptedApi() {
  const subs = new Set<(e: RunEvent) => void>();
  const base = createInMemoryApi();
  const api: LykeionApi = {
    ...base,
    async getTask(taskId: string) {
      const detail = await base.getTask(taskId);
      return { ...detail, turns: [HISTORIC_TURN] };
    },
    async startRun(): Promise<RunHandle> {
      return {
        runId: "run-live",
        onEvent(cb) {
          subs.add(cb);
          return () => subs.delete(cb);
        },
        submit() {},
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

/** Reopen the Task (historic turn loaded) and send a new prompt — from
 *  here on a live turn is in flight. */
async function startTurn() {
  const { api, emit, subs } = scriptedApi();
  const user = userEvent.setup();
  window.location.hash = ROUTE;
  render(<App api={api} />);
  await screen.findByText("It has 42 rows.");
  await user.type(
    await screen.findByLabelText("Message the agent"),
    "and now?",
  );
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(subs.size).toBeGreaterThan(0));
  return { emit, user };
}

/** Feed synthetic layout to a jsdom node — real `scrollHeight`/`clientHeight`
 *  never move past 0, so the pin/unpin math has to be driven by hand. */
function stubLayout(
  el: HTMLElement,
  {
    scrollHeight,
    clientHeight,
  }: { scrollHeight: number; clientHeight: number },
) {
  Object.defineProperty(el, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
}

beforeEach(cleanup);

describe("the live region is scoped to the in-flight turn", () => {
  it("gives the live turn aria-live/aria-atomic/role=log, and gives the historic transcript none of it", async () => {
    const { emit } = await startTurn();
    emit({ event: "live", live: { text: "Strong candidates" } });
    await screen.findByTestId("live-text");

    const live = screen.getByTestId("live-region");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveAttribute("aria-atomic", "false");
    expect(live).toHaveAttribute("role", "log");

    // The persisted turn sits outside the live region entirely — reopening a
    // Task must not re-announce the whole transcript.
    const historic = screen.getByText("It has 42 rows.");
    expect(live.contains(historic)).toBe(false);
    expect(historic.closest("[aria-live]")).toBeNull();
    expect(historic.closest('[role="log"]')).toBeNull();
  });
});

describe("the Jump to latest pill", () => {
  it("stays hidden while pinned", async () => {
    window.location.hash = ROUTE;
    render(<App api={createInMemoryApi()} />);
    await screen.findByTestId("conv-stream");
    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
  });

  it("appears once a scroll leaves the ~40px slack at the bottom, with a real aria-label", async () => {
    window.location.hash = ROUTE;
    render(<App api={createInMemoryApi()} />);
    const stream = await screen.findByTestId("conv-stream");
    stubLayout(stream, { scrollHeight: 800, clientHeight: 200 });

    // distance = 800 - 300 - 200 = 300, well past the slack.
    stream.scrollTop = 300;
    fireEvent.scroll(stream);

    const pill = await screen.findByRole("button", { name: "Jump to latest" });
    expect(pill).toHaveAttribute("aria-label", "Jump to latest");

    // The pill is positioned `absolute; bottom: 100%` in CSS, so it needs
    // `.composer-dock` (the nearest `position: relative` ancestor) to be its
    // containing block — otherwise it anchors to the viewport instead of
    // sitting flush above the composer. Pin that DOM relationship down here,
    // since jsdom has no layout engine to catch the visual break itself.
    expect(pill.closest(".composer-dock")).not.toBeNull();
  });

  it("re-pins and hides itself when clicked, snapping the stream back to the bottom", async () => {
    const user = userEvent.setup();
    window.location.hash = ROUTE;
    render(<App api={createInMemoryApi()} />);
    const stream = await screen.findByTestId("conv-stream");
    stubLayout(stream, { scrollHeight: 800, clientHeight: 200 });
    stream.scrollTop = 300;
    fireEvent.scroll(stream);

    const pill = await screen.findByRole("button", { name: "Jump to latest" });
    await user.click(pill);

    expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
    expect(stream.scrollTop).toBe(600);
  });
});
