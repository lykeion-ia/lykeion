/**
 * Regression: the Research → Task hand-off must start the run even under
 * <React.StrictMode>'s dev double-mount (mount → simulated unmount → remount).
 *
 * `takeRun` is single-shot, so a naive hand-off effect consumes the pending run
 * on the discarded first mount; the settled remount then finds nothing (and the
 * first mount's run is torn down + orphaned by useRun's token bump), dropping
 * the researcher's first message. The existing suites miss this because they
 * render without StrictMode and only exercise in-place sends on an already-open
 * task. Role/text-based, agnostic to the markup.
 */

import { StrictMode } from "react";
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";

// The Research chat entry (no task yet). Sending here creates a Task, navigates to
// it, and hands the first prompt to TaskScreen to auto-start — the buggy path.
const STUDY = "#/researches/s_cmp";

beforeEach(cleanup);

describe("Research → Task hand-off under StrictMode", () => {
  it("starts the run from the first hero message despite the double-mount", async () => {
    const user = userEvent.setup();
    window.location.hash = STUDY;
    render(
      <StrictMode>
        <App api={createInMemoryApi()} />
      </StrictMode>,
    );

    await user.type(
      await screen.findByLabelText("Message the agent"),
      "analyze the traces",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The hand-off auto-started the run on the settled mount, so the thread
    // opens and drives to its first permission card (a plain send is a normal
    // run — no plan gate). On the buggy code (single-shot takeRun, no latch)
    // this never appears — the Task falls back to its empty hero and times out.
    expect(
      await screen.findByRole("button", {
        name: "Allow for this conversation",
      }),
    ).toBeInTheDocument();

    // The researcher's own first prompt survived and renders as the user turn.
    const conversation = await screen.findByTestId("conversation");
    expect(
      within(conversation).getByText("analyze the traces"),
    ).toBeInTheDocument();
  });
});
