/**
 * A turn the researcher stopped, driven the way the app actually drives it:
 * clicking the composer's Stop button. What the transcript shows afterward
 * is distinct from a turn that failed, and the composer is released rather
 * than left pinned to Stop.
 */

import { beforeEach, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import type { LykeionApi, RunEvent, RunHandle } from "@lykeion/api";
import App from "../App";

const ROUTE = "#/researches/s_cmp/tasks/t_3";

/** A run whose subscriber count the test can watch, and whose stream the
 *  test can feed — a stop reaches the screen two ways, either from the
 *  composer's own button or as a `cancelled` frame the machine sends because
 *  something stopped the turn on its side. */
function scriptedApi() {
  const subs = new Set<(e: RunEvent) => void>();
  const api: LykeionApi = {
    ...createInMemoryApi(),
    async startRun(): Promise<RunHandle> {
      return {
        runId: "run-live",
        onEvent(cb) {
          subs.add(cb);
          queueMicrotask(() =>
            cb({
              event: "snapshot",
              snapshot: {
                runId: "run-live",
                sequence: 3,
                origin: "user",
                prompt: "which candidates responded?",
                agent: "default",
                state: { state: "planning" },
                stream: [],
                live: {},
                reviewing: false,
                lastEventSeq: 0,
              },
            }),
          );
          return () => subs.delete(cb);
        },
        submit() {},
        detach() {},
        close() {
          subs.clear();
        },
      };
    },
  };
  return { api, subs };
}

/** Send a prompt and wait until the run's stream is subscribed, then hand
 *  back `user` so the test can drive the rest of the turn through the UI —
 *  Stop included — and `emit` for the frames the machine sends on its own. */
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
  await waitFor(() => expect(subs.size).toBeGreaterThan(0));
  const emit = (event: RunEvent) => act(() => subs.forEach((cb) => cb(event)));
  return { user, emit };
}

beforeEach(cleanup);

it("clicking Stop renders the turn as stopped, not failed, and hands the composer back", async () => {
  const { user } = await renderTaskWithLiveRun();

  await user.click(screen.getByRole("button", { name: "Stop" }));

  expect(await screen.findByText("Run stopped")).toBeInTheDocument();
  expect(screen.queryByText(/failed/i)).toBeNull();
  expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
});

it("a stop the machine reports also hands the composer back", async () => {
  // Nobody clicked Stop here: the machine settled the turn itself and said
  // so on the stream. A `cancelled` the surface does not count as an ending
  // leaves the composer pinned to Stop with no way back.
  const { emit } = await renderTaskWithLiveRun();

  emit({ event: "completed", state: { state: "cancelled" } });

  expect(await screen.findByText("Run stopped")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
});

it("shows the turn actually failed, not that it stopped, when its own real ending arrives after Stop", async () => {
  // Pressing Stop is not the last word on how a turn landed: if it turns
  // out to have genuinely failed on its own terms — nothing to do with the
  // stop request — the researcher needs to see that, not a "Run stopped"
  // that hides a real error behind the click that happened to precede it.
  const { user, emit } = await renderTaskWithLiveRun();

  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByText("Run stopped")).toBeInTheDocument();

  emit({ event: "completed", state: { state: "failed", reason: "boom" } });

  expect(await screen.findByText("Run failed — boom")).toBeInTheDocument();
  expect(screen.queryByText("Run stopped")).toBeNull();
});
