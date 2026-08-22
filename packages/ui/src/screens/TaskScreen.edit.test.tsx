/**
 * What a researcher can do to a message they already sent.
 *
 * Copy is on every bubble and confirms nothing. Edit and Revert are on the
 * newest recorded turn alone, each behind a confirmation naming what is
 * lost — the turn, the Task's files, and the agent's memory of the
 * conversation. Neither is offered while a run is in flight: a turn cannot
 * be pulled out from under one still working, and Stop is the control that
 * belongs there.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import type { LykeionApi, RunEvent, RunHandle, TaskTurn } from "@lykeion/api";
import App from "../App";

const ROUTE = "#/researches/s_cmp/tasks/t_5";

/** An API whose `startRun` records every prompt it is called with. */
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
          queueMicrotask(() =>
            cb({
              event: "snapshot",
              snapshot: {
                runId: `run-${idx}`,
                sequence: idx + 1,
                origin: "user",
                prompt: input.prompt,
                agent: input.options.agent ?? "default",
                state: { state: "planning" },
                stream: [],
                live: {},
                reviewing: false,
                lastEventSeq: 0,
              },
            }),
          );
          return () => mySubs.delete(cb);
        },
        submit() {},
        detach() {},
        close() {
          mySubs.clear();
        },
      };
    },
  };
  return { api, base, startCalls, runSubs };
}

const turn = (over: Partial<TaskTurn> & Pick<TaskTurn, "runId" | "sequence" | "prompt">): TaskTurn => ({
  origin: "user",
  ts: over.sequence,
  messages: [],
  status: "ok",
  code: [],
  outputs: [],
  ...over,
});

const OLDER = turn({
  runId: "run-older",
  sequence: 1,
  prompt: "what's in the dataset?",
  messages: ["It has 42 rows."],
  revert: { available: true },
});
const NEWEST = turn({
  runId: "run-newest",
  sequence: 2,
  prompt: "count the reads",
  messages: ["Counted."],
  revert: { available: true },
});

function apiWithHistory(turns: TaskTurn[], revertTurn?: LykeionApi["revertTurn"]) {
  const scripted = scriptedApi();
  const api: LykeionApi = {
    ...scripted.api,
    async getTask(taskId: string) {
      const detail = await scripted.base.getTask(taskId);
      return { ...detail, turns };
    },
    ...(revertTurn ? { revertTurn } : {}),
  };
  return { ...scripted, api };
}

beforeEach(cleanup);

describe("the controls a recorded message carries", () => {
  it("offers Copy on every turn, and Edit and Revert on the newest alone", async () => {
    const { api } = apiWithHistory([OLDER, NEWEST]);
    window.location.hash = ROUTE;
    render(<App api={api} />);
    await screen.findByText("Counted.");

    const stream = screen.getByTestId("conv-stream");
    // The agent's replies carry their own Copy now, so count the researcher's
    // — these are the recorded-PROMPT controls this test is about.
    const prompts = [...stream.querySelectorAll<HTMLElement>(".msg--user")];
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(
        within(prompt).getByRole("button", { name: /copy/i }),
      ).toBeInTheDocument();
    }
    expect(within(stream).getAllByRole("button", { name: /^edit$/i })).toHaveLength(1);
    expect(within(stream).getAllByRole("button", { name: /^revert$/i })).toHaveLength(1);
  });

  it("names what is lost, and discards the turn only once that is confirmed", async () => {
    const revertTurn = vi.fn(async () => {});
    const { api } = apiWithHistory([OLDER, NEWEST], revertTurn);
    const user = userEvent.setup();
    window.location.hash = ROUTE;
    render(<App api={api} />);
    await screen.findByText("Counted.");

    await user.click(screen.getByRole("button", { name: /^revert$/i }));
    const confirm = screen.getByTestId("turn-confirm");
    expect(confirm.textContent).toMatch(/files/i);
    expect(confirm.textContent).toMatch(/no memory/i);
    expect(revertTurn).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /discard the turn/i }));
    await waitFor(() => expect(revertTurn).toHaveBeenCalledWith("run-newest"));
  });

  it("sends the corrected text after discarding, so Edit is one destructive path", async () => {
    const revertTurn = vi.fn(async () => {});
    const { api, startCalls } = apiWithHistory([OLDER, NEWEST], revertTurn);
    const user = userEvent.setup();
    window.location.hash = ROUTE;
    render(<App api={api} />);
    await screen.findByText("Counted.");

    await user.click(screen.getByRole("button", { name: /^edit$/i }));
    const box = screen.getByLabelText("Corrected prompt");
    await user.clear(box);
    await user.type(box, "count the writes");
    await user.click(screen.getByRole("button", { name: /discard and resend/i }));

    await waitFor(() => expect(revertTurn).toHaveBeenCalledWith("run-newest"));
    await waitFor(() => expect(startCalls).toContain("count the writes"));
  });

  it("disables both, naming why, when no snapshot of the files was taken", async () => {
    const { api } = apiWithHistory([
      OLDER,
      turn({
        runId: "run-newest",
        sequence: 2,
        prompt: "count the reads",
        messages: ["Counted."],
        revert: { available: false, reason: "this volume cannot clone them" },
      }),
    ]);
    window.location.hash = ROUTE;
    render(<App api={api} />);
    await screen.findByText("Counted.");

    const revert = screen.getByRole("button", { name: /^revert$/i });
    expect(revert).toBeDisabled();
    expect(revert).toHaveAttribute("title", expect.stringContaining("cannot clone"));
  });
});

describe("neither is offered while a run is live", () => {
  it("shows Stop instead, on every bubble on the surface", async () => {
    const { api, runSubs } = apiWithHistory([OLDER, NEWEST]);
    const user = userEvent.setup();
    window.location.hash = ROUTE;
    render(<App api={api} />);
    await screen.findByText("Counted.");

    await user.type(screen.getByLabelText("Message the agent"), "and now?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(runSubs).toHaveLength(1));

    expect(screen.queryByRole("button", { name: /^edit$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^revert$/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });
});
