/**
 * Deleting a Task from the Task surface's own sidebar.
 *
 * A Task is its chat here, so deleting one takes the whole conversation and
 * there is no archive to recover it from. That makes the confirmation the
 * only guard, and makes a refusal something the researcher has to be told
 * about rather than something the screen reconciles around.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type LykeionApi } from "@lykeion/api";
import App from "../App";

// A Study with several Tasks, opened on one of them, so the sidebar has rows
// and there is somewhere to land after the open Task is deleted.
const ROUTE = "#/studies/s_cmp/tasks/t_3";

beforeEach(cleanup);

/** Open the kebab on a sidebar row and choose Delete. */
async function chooseDelete(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(
    await screen.findByRole("button", { name: `Task actions for ${title}` }),
  );
  await user.click(await screen.findByRole("menuitem", { name: /Delete/ }));
}

describe("deleting a Task from the sidebar", () => {
  it("asks first, and deletes nothing until it is answered", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    const deleteTask = vi.fn(api.deleteTask.bind(api));
    window.location.hash = ROUTE;
    render(<App api={{ ...api, deleteTask } as LykeionApi} />);
    await screen.findByTestId("task-surface");

    const doomed = (await api.getStudy("s_cmp")).tasks[1]!;
    await chooseDelete(user, doomed.title);

    expect(
      await screen.findByRole("dialog", { name: /delete task/i }),
    ).toBeInTheDocument();
    expect(deleteTask).not.toHaveBeenCalled();
  });

  it("names the Task it is about to take", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    window.location.hash = ROUTE;
    render(<App api={api} />);
    await screen.findByTestId("task-surface");

    const doomed = (await api.getStudy("s_cmp")).tasks[1]!;
    await chooseDelete(user, doomed.title);

    const dialog = await screen.findByRole("dialog", { name: /delete task/i });
    expect(within(dialog).getByText(doomed.title)).toBeInTheDocument();
    expect(within(dialog).getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it("leaves the Task alone when the confirmation is dismissed", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    const deleteTask = vi.fn(api.deleteTask.bind(api));
    window.location.hash = ROUTE;
    render(<App api={{ ...api, deleteTask } as LykeionApi} />);
    await screen.findByTestId("task-surface");

    const doomed = (await api.getStudy("s_cmp")).tasks[1]!;
    const before = (await api.getStudy("s_cmp")).tasks.length;
    await chooseDelete(user, doomed.title);
    await screen.findByRole("dialog", { name: /delete task/i });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /delete task/i })).toBeNull(),
    );
    expect(deleteTask).not.toHaveBeenCalled();
    expect((await api.getStudy("s_cmp")).tasks.length).toBe(before);
  });

  it("deletes the Task once the confirmation is answered", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    window.location.hash = ROUTE;
    render(<App api={api} />);
    await screen.findByTestId("task-surface");

    const doomed = (await api.getStudy("s_cmp")).tasks[1]!;
    const before = (await api.getStudy("s_cmp")).tasks.length;
    await chooseDelete(user, doomed.title);
    const dialog = await screen.findByRole("dialog", { name: /delete task/i });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(async () =>
      expect((await api.getStudy("s_cmp")).tasks.length).toBe(before - 1),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /delete task/i })).toBeNull(),
    );
  });

  it("keeps the Task, the dialog and the tab when the core refuses", async () => {
    // The regression this case exists for: the refusal used to be swallowed
    // and the tab closed anyway, so a delete the core had rejected looked
    // exactly like one it had done — until the next read brought the Task
    // back.
    const user = userEvent.setup();
    const api = createInMemoryApi();
    const refusing: LykeionApi = {
      ...api,
      async deleteTask() {
        throw new Error("that Task is already gone");
      },
    };
    window.location.hash = ROUTE;
    render(<App api={refusing} />);
    await screen.findByTestId("task-surface");

    const doomed = (await api.getStudy("s_cmp")).tasks[1]!;
    await chooseDelete(user, doomed.title);
    const dialog = await screen.findByRole("dialog", { name: /delete task/i });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(
      await within(dialog).findByText("that Task is already gone"),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: /delete task/i })).toBeInTheDocument();
    // Still on the Task that was open, and the row is still in the sidebar.
    expect(screen.getByTestId("task-surface")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Task actions for ${doomed.title}` }),
    ).toBeInTheDocument();
  });
});
