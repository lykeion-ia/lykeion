/**
 * Stop lives in the composer, in Send's place — not in the run line.
 *
 * The run line is a `role="status"` label; the only interactive control the
 * researcher needs while a run holds the surface is Stop, and it belongs where
 * they are already looking (and already reaching) — the composer's primary
 * button. Three things are pinned here:
 *  1. While the run is live, the composer offers Stop and NOT Send — including
 *     at the plan gate, where `useRun.running` is true but the run line isn't
 *     drawn at all (that state used to have no Stop anywhere).
 *  2. The run line carries no button of its own.
 *  3. Stop ends the turn and hands the composer back as Send.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";

const ROUTE = "#/studies/s_cmp/tasks/t_3";

beforeEach(cleanup);

describe("Composer Stop", () => {
  it("replaces Send while the run is live, and releases it on stop", async () => {
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

    // The plan gate: the run is live, so Send is gone and Stop stands in its
    // place — enabled, even though the rest of the composer is disabled.
    const stop = await screen.findByRole("button", { name: "Stop" });
    expect(
      await screen.findByRole("button", { name: "Approve" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send" }),
    ).not.toBeInTheDocument();
    expect(stop).toBeEnabled();

    // Past the plan gate the run line appears — and carries no button.
    await user.click(screen.getByRole("button", { name: "Approve" }));
    // Targeted by testid, not by role: the surface now has more than one
    // `role="status"` region (the run strip reports plan progress beside this
    // line), and this assertion is about the run line itself.
    const runLine = await screen.findByTestId("run-line");
    expect(within(runLine).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    // Stop ends the turn and hands the composer back.
    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Run stopped")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Send" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Stop" }),
    ).not.toBeInTheDocument();
  });
});
