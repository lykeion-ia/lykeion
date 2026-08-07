/** Stop replaces Send in the Task composer while that Task owns a live run. */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type LykeionApi, type RunDecision } from "@lykeion/api";
import App from "../App";

const ROUTE = "#/studies/s_cmp/tasks/t_3";

beforeEach(cleanup);

describe("Composer Stop", () => {
  it("replaces Send with the Task run's Stop and restores Send after settlement", async () => {
    const user = userEvent.setup();
    const base = createInMemoryApi();
    const submitted: RunDecision[] = [];
    const startRun = vi.fn(async (input) => {
      const handle = await base.startRun(input);
      return {
        ...handle,
        submit(decision: RunDecision) {
          submitted.push(decision);
          handle.submit(decision);
        },
      };
    });
    const api: LykeionApi = { ...base, startRun };
    window.location.hash = ROUTE;
    render(<App api={api} />);

    await user.type(
      await screen.findByLabelText("Message the agent"),
      "analyze the traces",
    );
    // "Plan first" so the run parks at the plan gate below (a plain send is a
    // normal run with no gate).
    await user.click(screen.getByRole("button", { name: "Send options" }));
    await user.click(screen.getByRole("button", { name: "Plan first" }));

    const stop = await screen.findByRole("button", { name: "Stop" });
    // Send stays: a researcher may say the next thing while this turn runs,
    // and it waits its place rather than being refused.
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(within(await screen.findByTestId("live-turn"))
      .queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Approve" })).toBeInTheDocument();

    await user.click(stop);
    await waitFor(() =>
      expect(startRun).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "t_3" }),
      ),
    );
    expect(submitted).toEqual([{ action: "cancel" }]);
    expect(await screen.findByText("Run stopped")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Send" })).toBeInTheDocument();
  });
});
