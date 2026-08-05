/**
 * The stop banner is not always "Run stopped": once a stop's grace window
 * ends with no confirmation from the agent, `useRun.ts`'s `cancel` lands the
 * turn `{ state: "cancelled", unacknowledged: true }` — see
 * `useRun.test.tsx` for that timing. This file is the rendering half: given
 * that shape reaches the surface, the researcher must be told plainly, not
 * left reading the same "Run stopped" an ordinary, confirmed stop shows.
 */

import { beforeEach, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import type { LykeionApi, RunEvent, RunHandle } from "@lykeion/api";
import App from "../App";

const ROUTE = "#/studies/s_cmp/tasks/t_3";

/** A run whose frames the test emits by hand — the same shape
 *  `TaskScreen.cancel.test.tsx` scripts a machine-reported ending with. */
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
        close() {
          subs.clear();
        },
      };
    },
  };
  return { api, subs };
}

async function renderTaskWithLiveRun() {
  const { api, subs } = scriptedApi();
  const user = userEvent.setup();
  window.location.hash = ROUTE;
  render(<App api={api} />);
  await user.type(
    await screen.findByLabelText("Message the agent"),
    "which candidates responded?",
  );
  await user.click(screen.getByRole("button", { name: "Send" }));
  await act(() => new Promise((r) => setTimeout(r, 0)));
  const emit = (event: RunEvent) => act(() => subs.forEach((cb) => cb(event)));
  return { emit };
}

beforeEach(cleanup);

it("says the agent has not confirmed the stop when a turn lands cancelled and unacknowledged", async () => {
  const { emit } = await renderTaskWithLiveRun();

  emit({
    event: "completed",
    state: { state: "cancelled", unacknowledged: true },
  });

  expect(
    await screen.findByText(
      "The agent has not confirmed it stopped — it may still be running.",
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText("Run stopped")).not.toBeInTheDocument();
});

it("reads a plain 'Run stopped', not the unacknowledged banner, for an ordinary confirmed stop", async () => {
  const { emit } = await renderTaskWithLiveRun();

  emit({ event: "completed", state: { state: "cancelled" } });

  expect(await screen.findByText("Run stopped")).toBeInTheDocument();
  expect(screen.queryByText(/has not confirmed/)).not.toBeInTheDocument();
});
