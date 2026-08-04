/**
 * Regression: the Study → Task hand-off must start the first prompt EXACTLY
 * ONCE under <React.StrictMode>'s dev double-mount.
 *
 * `StudyHandoff.test.tsx` covers the other half of this — that the prompt is not
 * DROPPED — and the ref latch that fixed it over-corrected: the latched run is
 * never cleared once started, and the hand-off effect has no "already started"
 * guard, so StrictMode's second effect invocation calls `start()` a second time
 * with the same prompt. Asserting only that a run starts (as that suite does)
 * cannot see it; the count is the whole property.
 *
 * Each extra start is a whole second agent turn: it spawns its own agent
 * process, and `useRun.start`'s `teardown()` kills the first one mid-flight,
 * so the Task's transcript grows a half-run turn that no reopen can make
 * sense of.
 */

import { StrictMode } from "react";
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type LykeionApi } from "@lykeion/api";
import App from "../App";

const STUDY = "#/studies/s_cmp";

/** The in-memory API, wrapped to count `startRun` calls. */
function countingApi(): { api: LykeionApi; starts: () => number } {
  const inner = createInMemoryApi();
  let starts = 0;
  const api: LykeionApi = {
    ...inner,
    startRun: (input) => {
      starts += 1;
      return inner.startRun(input);
    },
  };
  return { api, starts: () => starts };
}

beforeEach(cleanup);

describe("Study → Task hand-off under StrictMode", () => {
  it("starts the first prompt exactly once", async () => {
    const user = userEvent.setup();
    const { api, starts } = countingApi();
    window.location.hash = STUDY;
    render(
      <StrictMode>
        <App api={api} />
      </StrictMode>,
    );

    await user.type(
      await screen.findByLabelText("Message the agent"),
      "analyze the traces",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The hand-off landed on the Task surface and ran the prompt: the run
    // reached its first permission card, so a turn is genuinely in flight.
    await screen.findByTestId("task-surface");
    await screen.findByRole("button", { name: "Allow for this conversation" });

    // …and ran it ONCE. On the buggy code this is 2: the discarded StrictMode
    // mount starts it, then the settled remount reads the still-latched run out
    // of the ref and starts it again.
    expect(starts()).toBe(1);
  });
});
