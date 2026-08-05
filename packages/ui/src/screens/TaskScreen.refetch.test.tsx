/**
 * A write of the surface's OWN must not blank the conversation.
 *
 * Mark Done, a rename and filing each re-read the Task, and a re-read that
 * clears what it had first takes the whole page down with it for a commit: the
 * transcript unmounts, the scroll position goes, and the `role="log"` region
 * is built again from scratch — which is a fresh live region for a screen
 * reader. The surface holds the last record it read so the next one replaces
 * it in place; only the FIRST load has nothing to show.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";

const STUDY = "s_cmp";
// The seeded Task that IS a conversation: two turns, and In Review, which is
// the state Mark Done is offered from.
const TASK = "t_3";

beforeEach(cleanup);

describe("re-reading the open Task", () => {
  it("keeps the transcript across a mark-done", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    // Clear the Done-gate first: this is about the re-read that FOLLOWS a
    // successful write, not about the gate itself.
    for (const f of await api.reviewFindings(STUDY, TASK)) {
      await api.resolveFinding(STUDY, TASK, f.id);
    }

    window.location.hash = `#/studies/${STUDY}/tasks/${TASK}`;
    render(<App api={api} />);

    const stream = await screen.findByTestId("conv-stream");
    const turn = await screen.findByText(
      /Motion-correct the deprivation cohort/i,
    );

    await user.click(await screen.findByRole("button", { name: "Mark Done" }));

    await waitFor(async () =>
      expect((await api.getTask(TASK)).task.status).toBe("done"),
    );

    // The very same nodes, not equal-looking replacements: an unmount would
    // hand back new ones, and take the researcher's scroll position with it.
    expect(screen.getByTestId("conv-stream")).toBe(stream);
    expect(
      screen.getByText(/Motion-correct the deprivation cohort/i),
    ).toBe(turn);
  });

  it("keeps them across a rename of the Task on screen", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    window.location.hash = `#/studies/${STUDY}/tasks/${TASK}`;
    render(<App api={api} />);

    const stream = await screen.findByTestId("conv-stream");
    const title = (await api.getTask(TASK)).task.title;

    await user.click(
      await screen.findByRole("button", { name: `Task actions for ${title}` }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const field = await screen.findByRole("textbox", {
      name: `Rename ${title}`,
    });
    await user.clear(field);
    await user.type(field, "Preprocessing, revisited{Enter}");

    await waitFor(async () =>
      expect((await api.getTask(TASK)).task.title).toBe(
        "Preprocessing, revisited",
      ),
    );
    expect(screen.getByTestId("conv-stream")).toBe(stream);
  });
});
