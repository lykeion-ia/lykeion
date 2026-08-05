/**
 * Stop lives in its own live-turn block while the composer remains available.
 *
 * The run line is a `role="status"` label; the only interactive control the
 * Every concurrent run needs an unambiguous Stop of its own, while Send must
 * remain present so the researcher can start a sibling turn.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";

const ROUTE = "#/studies/s_cmp/tasks/t_3";

beforeEach(cleanup);

describe("Composer Stop", () => {
  it("keeps Send in the composer and gives the live block its own Stop", async () => {
    const user = userEvent.setup();
    window.location.hash = ROUTE;
    render(<App api={createInMemoryApi()} />);

    await user.type(
      await screen.findByLabelText("Message the agent"),
      "analyze the traces",
    );
    // "Plan first" so the run parks at the plan gate below (a plain send is a
    // normal run with no gate).
    await user.click(screen.getByRole("button", { name: "Send options" }));
    await user.click(screen.getByRole("button", { name: "Plan first" }));

    // The plan gate owns its Stop. Send remains in the composer for a sibling.
    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(
      await screen.findByRole("button", { name: "Approve" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(stop).toBeEnabled();

    // Past the plan gate the run line appears — and carries no button.
    await user.click(screen.getByRole("button", { name: "Approve" }));
    // Targeted by testid, not by role: the surface now has more than one
    // `role="status"` region (the run strip reports plan progress beside this
    // line), and this assertion is about the run line itself.
    const runLine = await screen.findByTestId("run-line");
    expect(within(runLine).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    // Stop ends only this turn; the composer never left.
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(screen.getByText("Run stopped")).toBeInTheDocument(),
    );
    expect(
      await screen.findByRole("button", { name: "Send" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop" }),
    ).not.toBeInTheDocument();
  });
});
