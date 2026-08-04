/**
 * Edit a past prompt back into the composer.
 *
 * Edit refills the composer with a turn's prompt and hands focus back without
 * touching the transcript: the recorded turn stays exactly where it is. It is
 * offered on historic/graduated turns AND on the turn that just finished (the
 * one still drawn by the live-region bubble), but never while a run is in
 * flight — a live run's (disabled) composer must not be fought over.
 */

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
  LykeionApi,
  RunEvent,
  RunRecord,
  RunHandle,
  TaskTurn,
} from "@lykeion/api";
import App from "../App";

// A fresh Task in CMP — nobody has spoken in it, so each test says
// exactly what its transcript holds.
const ROUTE = "#/studies/s_cmp/tasks/t_5";

/**
 * An API whose `startRun` records every prompt it is called with (indexed by
 * call order) and whose events the test drives by hand.
 */
function scriptedApi() {
  const startCalls: string[] = [];
  const runSubs: Set<(e: RunEvent) => void>[] = [];
  const base = createInMemoryApi();

  const api: LykeionApi = {
    ...base,
    async startRun(input): Promise<RunHandle> {
      startCalls.push(input.prompt);
      const mySubs = new Set<(e: RunEvent) => void>();
      const idx = runSubs.push(mySubs) - 1;
      return {
        runId: `run-${idx}`,
        onEvent(cb) {
          mySubs.add(cb);
          return () => mySubs.delete(cb);
        },
        submit() {},
        close() {
          mySubs.clear();
        },
      };
    },
  };

  /** Emit an event on the `i`th `startRun` call's subscribers. */
  const emit = (i: number, e: RunEvent) =>
    act(() => {
      for (const cb of [...runSubs[i]]) cb(e);
    });

  return { api, base, startCalls, runSubs, emit };
}

const runRecord = (command: string, text: string): RunRecord => ({
  runId: "run-x",
  ts: 1,
  command,
  status: "ok",
  code: [],
  outputs: [],
  stream: [{ kind: "text", text }],
});

beforeEach(cleanup);

describe("edit refills the composer without touching the transcript", () => {
  const HISTORIC: TaskTurn = {
    runId: "run-historic",
    ts: 1,
    prompt: "what's in the dataset?",
    messages: ["It has 42 rows."],
    status: "ok",
    code: [],
    outputs: [],
  };

  function apiWithHistory() {
    const scripted = scriptedApi();
    const api: LykeionApi = {
      ...scripted.api,
      async getTask(taskId: string) {
        // The real Task, with a transcript this test dictates.
        const detail = await scripted.base.getTask(taskId);
        return { ...detail, turns: [HISTORIC] };
      },
    };
    return { ...scripted, api };
  }

  it("fills the composer with the bubble's prompt and focuses it, leaving the transcript untouched", async () => {
    const { api } = apiWithHistory();
    const user = userEvent.setup();
    window.location.hash = ROUTE;
    render(<App api={api} />);
    await screen.findByText("It has 42 rows.");

    const composer = screen.getByLabelText(
      "Message the agent",
    ) as HTMLTextAreaElement;
    expect(composer.value).toBe("");

    await user.click(
      await screen.findByRole("button", { name: "Edit prompt" }),
    );

    expect(composer.value).toBe(HISTORIC.prompt);
    expect(composer).toHaveFocus();

    // Nothing about the recorded turn moved: the same prompt bubble and the
    // same reply are still exactly where they were — Edit only refills the
    // composer, it never deletes or rewrites the turn. Scoped to the
    // transcript stream specifically (excluding the composer dock, which now
    // legitimately echoes the same text, and the sidebar’s Task row).
    const stream = screen.getByTestId("conv-stream");
    expect(within(stream).getByText(HISTORIC.prompt)).toBeInTheDocument();
    expect(within(stream).getByText("It has 42 rows.")).toBeInTheDocument();
    expect(within(stream).getAllByText(HISTORIC.prompt)).toHaveLength(1);
  });
});

describe("edit stays off the surface while a run is live", () => {
  const HISTORIC: TaskTurn = {
    runId: "run-historic",
    ts: 1,
    prompt: "what's in the dataset?",
    messages: ["It has 42 rows."],
    status: "ok",
    code: [],
    outputs: [],
  };

  function apiWithHistory() {
    const scripted = scriptedApi();
    const api: LykeionApi = {
      ...scripted.api,
      async getTask(taskId: string) {
        // The real Task, with a transcript this test dictates.
        const detail = await scripted.base.getTask(taskId);
        return { ...detail, turns: [HISTORIC] };
      },
    };
    return { ...scripted, api };
  }

  it("shows no Edit affordance once a new turn is in flight", async () => {
    const { api, runSubs } = apiWithHistory();
    const user = userEvent.setup();
    window.location.hash = ROUTE;
    render(<App api={api} />);
    await screen.findByText("It has 42 rows.");

    await user.type(screen.getByLabelText("Message the agent"), "and now?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(runSubs).toHaveLength(1));

    // Mid-run: Edit is not offered anywhere on the surface, not even on the
    // now-historic bubble that would offer it once idle.
    expect(screen.queryByRole("button", { name: "Edit prompt" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });
});

/**
 * The review gap this guards against: Edit was wired onto historic/graduated
 * turns (via `TurnView`'s `onEditPrompt`) but NOT onto the turn that JUST
 * finished — the one still drawn by the live-region bubble. Without the fix,
 * the turn can't be edited until some other action (e.g. sending the next
 * message) graduates it into `viewTurns` — past the moment the researcher
 * wanted it.
 */
describe("edit reaches the turn that just finished, in place", () => {
  it("offers Edit on the live bubble once a run completes, refilling the composer without graduating the turn", async () => {
    const { api, emit } = scriptedApi();
    const user = userEvent.setup();
    window.location.hash = ROUTE;
    render(<App api={api} />);

    const typed = "how many rows are there?";
    await user.type(await screen.findByLabelText("Message the agent"), typed);
    await user.click(screen.getByRole("button", { name: "Send" }));

    emit(0, {
      event: "assistant-text",
      text: "There are 42 rows.",
      partial: false,
    });
    emit(0, {
      event: "completed",
      state: { state: "completed" },
      run: runRecord(typed, "There are 42 rows."),
    });
    await screen.findByText("Run complete");

    const composer = screen.getByLabelText(
      "Message the agent",
    ) as HTMLTextAreaElement;
    // The composer was cleared on send — Edit is the only thing that refills it.
    expect(composer.value).toBe("");

    // The just-finished turn's OWN bubble — still in the live region, not yet
    // graduated into `viewTurns` — now offers Edit.
    await user.click(
      await screen.findByRole("button", { name: "Edit prompt" }),
    );

    expect(composer.value).toBe(typed);
    expect(composer).toHaveFocus();

    // Nothing graduated: still exactly one bubble with the typed text, and
    // the turn's own reply is still on screen — Edit only refilled the
    // composer, it never moved the turn or left a second copy of it. Scoped
    // to the transcript stream specifically (excluding the composer dock,
    // which now legitimately echoes the same text).
    const stream = screen.getByTestId("conv-stream");
    expect(within(stream).getAllByText(typed)).toHaveLength(1);
    expect(within(stream).getByText("There are 42 rows.")).toBeInTheDocument();
  });
});
