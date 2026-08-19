/**
 * The Reviewer, end-to-end in the UI.
 *
 * Opens CMP-3 (in-review, with a seeded high-severity finding) straight into
 * the full chat; the Reviewer's findings render inline in the conversation.
 * Clicking Resolve flips a finding to resolved. The Done-gate is exercised too:
 * Mark Done (in the Task's row menu) is blocked while the high finding is open,
 * then succeeds after resolve — and the refusal is reported at the head of the
 * Task surface, wherever the menu that asked was. Role/text-based, agnostic to
 * the markup.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";
import { markTaskDone } from "../test/task-row-menu";

const CMP3 = "#/researches/s_cmp/tasks/t_3";
const CMP3_TITLE = "Preprocess two-photon calcium traces";

beforeEach(cleanup);

describe("Review", () => {
  it("shows the seeded CMP-3 finding with its claim and evidence", async () => {
    window.location.hash = CMP3;
    render(<App api={createInMemoryApi()} />);

    // The high value-contradicts-source finding: class label, claim, evidence.
    expect(
      await screen.findByText("Reported value contradicts its source file"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/The dataset contains 512 neurons\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/384, not 512/)).toBeInTheDocument();
  });

  it("Resolve flips a finding to a resolved state", async () => {
    const user = userEvent.setup();
    window.location.hash = CMP3;
    render(<App api={createInMemoryApi()} />);

    const resolveButtons = await screen.findAllByRole("button", {
      name: "Resolve",
    });
    expect(resolveButtons.length).toBeGreaterThan(0);
    await user.click(resolveButtons[0]);

    // The first (high) finding now reads Resolved and offers no Resolve button.
    expect(await screen.findByText("Resolved")).toBeInTheDocument();
  });

  it("Done-gate blocks Mark Done while a high finding is open, then clears", async () => {
    const user = userEvent.setup();
    window.location.hash = CMP3;
    render(<App api={createInMemoryApi()} />);

    // CMP-3 is In Review, so its row menu offers Mark Done.
    await markTaskDone(user, CMP3_TITLE);

    // The gate blocks with the count message.
    expect(
      await screen.findByText(/unresolved high-severity Reviewer finding/i),
    ).toBeInTheDocument();

    // Resolve the high finding inline.
    const resolveButtons = await screen.findAllByRole("button", {
      name: "Resolve",
    });
    await user.click(resolveButtons[0]);
    await screen.findByText("Resolved");

    // Now Mark Done succeeds — the block message is gone.
    await markTaskDone(user, CMP3_TITLE);
    expect(
      screen.queryByText(/unresolved high-severity Reviewer finding/i),
    ).not.toBeInTheDocument();
  });
});
