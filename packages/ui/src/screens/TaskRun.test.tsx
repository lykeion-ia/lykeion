/**
 * The live Task run.
 *
 * Drives a real run through the in-memory `LykeionApi`: open a Task (in-review,
 * so it lands in the full chat), send with "Plan first" (a plain send is a
 * normal run — no gate) → plan card → Approve → permission card → Allow
 * (default scope) → the produced artifact shows in the Files pane, and the run
 * terminates. A second path rejects the plan and asserts it ends cleanly with
 * no permission card. Role/text-based, agnostic to the markup.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, within, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";
import { currentTaskStatus, markTaskDone } from "../test/task-row-menu";

// CMP-3 is in-review, so it opens straight into the full chat interface.
const CMP3 = "#/studies/s_cmp/tasks/t_3";
const CMP3_TITLE = "Preprocess two-photon calcium traces";

beforeEach(cleanup);

describe("Task run surface", () => {
  it("plan → approve → permission → allow surfaces the artifact", async () => {
    const user = userEvent.setup();
    window.location.hash = CMP3;
    render(<App api={createInMemoryApi()} />);

    // Run the task in Plan mode (the per-message opt-in in the send chevron).
    await user.type(
      await screen.findByLabelText("Message the agent"),
      "analyze the traces",
    );
    await user.click(screen.getByRole("button", { name: "Send options" }));
    await user.click(screen.getByRole("button", { name: "Plan first" }));

    // The plan card appears with its Approve action.
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(screen.getByText("Load the dataset")).toBeInTheDocument();
    await user.click(approve);

    // A permission card follows: the split Allow button (default scope
    // "this conversation") + Deny.
    const allow = await screen.findByRole("button", {
      name: "Allow for this conversation",
    });
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    await user.click(allow);

    // The run terminates — its produced artifact shows in the Files pane
    // (opened from the sidebar), which only happens once the run completes.
    await user.click(screen.getByRole("button", { name: "Files" }));
    const panel = await screen.findByTestId("artifacts-panel");
    expect(await within(panel).findByText("out.csv")).toBeInTheDocument();
  });

  it("rejecting the plan ends the run with no permission card", async () => {
    const user = userEvent.setup();
    window.location.hash = CMP3;
    render(<App api={createInMemoryApi()} />);

    await user.type(await screen.findByLabelText("Message the agent"), "go");
    await user.click(screen.getByRole("button", { name: "Send options" }));
    await user.click(screen.getByRole("button", { name: "Plan first" }));

    await user.click(await screen.findByRole("button", { name: "Reject" }));

    // The run ends and no permission card is ever offered.
    await waitFor(() =>
      expect(screen.getByText(/Run failed/i)).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "Deny" }),
    ).not.toBeInTheDocument();
  });

  it("clears optimistic Done when new work starts on the same mounted Task", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    for (const finding of await api.reviewFindings("s_cmp", "t_3")) {
      await api.resolveFinding("s_cmp", "t_3", finding.id);
    }
    window.location.hash = CMP3;
    render(<App api={api} />);

    await markTaskDone(user, CMP3_TITLE);
    await waitFor(async () =>
      expect((await api.getTask("t_3")).task.status).toBe("done"),
    );

    await user.type(
      screen.getByLabelText("Message the agent"),
      "start genuinely new work",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(
      await screen.findByRole("button", { name: "Allow for this conversation" }),
    );

    await waitFor(async () =>
      expect((await api.getTask("t_3")).task.status).toBe("in-review"),
    );
    // The row menu agrees: the local Done is gone and the Task reads where the
    // new turn left it, not where the previous body of work ended.
    await waitFor(async () =>
      expect(await currentTaskStatus(user, CMP3_TITLE)).toBe("In Review"),
    );
  });
});
