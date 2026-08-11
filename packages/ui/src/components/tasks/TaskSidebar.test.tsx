/**
 * TaskSidebar row actions — the per-Task "…" (kebab) menu (Rename · Pin ·
 * Delete), the in-place rename editor, and the Pinned group. Each menu item is
 * only rendered when its handler is supplied, so a caller that passes none
 * keeps a read-only sidebar.
 *
 * The sidebar lists the Study's Tasks and nothing else: a Task is a chat, so
 * navigating the Study's conversations and navigating its work are one list.
 */

import type { Study, Task } from "@lykeion/api";
import { createInMemoryApi } from "@lykeion/api";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiProvider } from "../../api/ApiContext";
import { RouterProvider } from "../../router";
import { TaskSidebar } from "./TaskSidebar";

const study: Study = {
  id: "s_1",
  key: "CMP",
  title: "Plasticity",
  createdBy: "u_you",
  createdTs: 1,
  updatedTs: 1,
};

/** A Task row fixture — only the fields the sidebar reads actually matter. */
function tk(id: string, title: string, over: Partial<Task> = {}): Task {
  return {
    id,
    number: 1,
    studyId: study.id,
    stage: "methods",
    title,
    status: "todo",
    priority: "none",
    createdBy: "u_you",
    runCount: 0,
    createdTs: 1,
    updatedTs: 1,
    ...over,
  };
}

beforeEach(cleanup);

function renderSidebar(props: Partial<Parameters<typeof TaskSidebar>[0]> = {}) {
  return render(
    <ApiProvider api={createInMemoryApi()}>
      <RouterProvider>
        <TaskSidebar
          study={study}
          filesActive={false}
          onNew={() => {}}
          onOpenFiles={() => {}}
          tasks={[tk("t_a", "First task"), tk("t_b", "Second task")]}
          activeTaskId="t_a"
          {...props}
        />
      </RouterProvider>
    </ApiProvider>,
  );
}

/** Open one row's kebab menu. */
async function openMenu(user: ReturnType<typeof userEvent.setup>, row: string) {
  await user.click(
    screen.getByRole("button", {
      name: new RegExp(`Task actions for ${row}`),
    }),
  );
}

describe("TaskSidebar row actions", () => {
  /**
   * The row names the Task and stops there. Confirming belongs to the screen
   * above it, and not by preference: `ActionMenu` closes on select, so a
   * dialog raised from inside the menu would unmount with the menu that
   * raised it. See `TaskScreen.delete.test.tsx` for the confirmation itself.
   */
  it("asks the screen to delete a Task, and leaves the confirming to it", async () => {
    const user = userEvent.setup();
    const onDeleteTask = vi.fn();
    renderSidebar({ onDeleteTask });

    await openMenu(user, "Second task");
    await user.click(screen.getByRole("menuitem", { name: /Delete/ }));

    expect(onDeleteTask).toHaveBeenCalledWith("t_b");
    expect(onDeleteTask).toHaveBeenCalledTimes(1);
  });

  it("omits the actions menu when no handlers are given", async () => {
    renderSidebar({
      onDeleteTask: undefined,
      onRenameTask: undefined,
      onPinTask: undefined,
    });
    await screen.findByText("Second task");
    expect(
      screen.queryByRole("button", { name: /Task actions/ }),
    ).toBeNull();
  });

  it("orders the menu Pin · Rename · Delete", async () => {
    const user = userEvent.setup();
    renderSidebar({
      onPinTask: vi.fn(),
      onRenameTask: vi.fn(),
      onDeleteTask: vi.fn(),
    });

    await openMenu(user, "Second task");
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["Pin", "Rename", "Delete"]);
  });

  it("moves the row's own Task along its lifecycle", async () => {
    const user = userEvent.setup();
    const onSetTaskStatus = vi.fn();
    renderSidebar({
      tasks: [
        tk("t_a", "First task"),
        tk("t_b", "Second task", { status: "in-review" }),
      ],
      onSetTaskStatus,
    });

    await openMenu(user, "Second task");
    await user.hover(screen.getByRole("menuitem", { name: /^Status/ }));
    await user.click(screen.getByRole("menuitem", { name: "Done" }));

    expect(onSetTaskStatus).toHaveBeenCalledWith("t_b", "done");
  });

  it("marks each row with the status that row's own Task is on", async () => {
    const user = userEvent.setup();
    renderSidebar({
      tasks: [
        tk("t_a", "First task", { status: "todo" }),
        tk("t_b", "Second task", { status: "in-review" }),
      ],
      onSetTaskStatus: vi.fn(),
    });

    await openMenu(user, "Second task");
    await user.hover(screen.getByRole("menuitem", { name: /^Status/ }));
    expect(
      screen.getByRole("menuitem", { name: /In Review/ }).textContent,
    ).toContain("Current");
  });

  it("shows only the actions it was given a handler for", async () => {
    const user = userEvent.setup();
    renderSidebar({ onPinTask: vi.fn() });

    await openMenu(user, "Second task");
    expect(screen.getByRole("menuitem", { name: /Pin/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Rename/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Delete/ })).toBeNull();
  });

  it("pins an unpinned row and unpins a pinned one", async () => {
    const user = userEvent.setup();
    const onPinTask = vi.fn();
    renderSidebar({
      onPinTask,
      tasks: [
        tk("t_a", "First task", { pinned: true }),
        tk("t_b", "Second task"),
      ],
    });

    await openMenu(user, "Second task");
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(onPinTask).toHaveBeenCalledWith("t_b", true);

    // The pinned row offers the inverse.
    await openMenu(user, "First task");
    await user.click(screen.getByRole("menuitem", { name: "Unpin" }));
    expect(onPinTask).toHaveBeenCalledWith("t_a", false);
  });

  it("groups pinned Tasks above the rest", async () => {
    const { container } = renderSidebar({
      onPinTask: vi.fn(),
      tasks: [
        tk("t_a", "Starred one", { pinned: true }),
        tk("t_b", "Recent one"),
      ],
    });
    await screen.findByText("Starred one");

    // Read the list in DOM order: each eyebrow followed by its own rows.
    const list = container.querySelector(".tsb-tasks")!;
    const order = [...list.children].map((el) => el.textContent);
    expect(order).toEqual(["Pinned", "Starred one", "Tasks", "Recent one"]);
  });

  it("lists the Study's Tasks, and says so when it holds none", async () => {
    const { container, unmount } = renderSidebar({
      tasks: [tk("t_a", "Preprocess traces"), tk("t_b", "Fit tuning curves")],
    });
    const list = container.querySelector(".tsb-tasks")!;
    expect([...list.children].map((el) => el.textContent)).toEqual([
      "Tasks",
      "Preprocess traces",
      "Fit tuning curves",
    ]);
    unmount();

    // A Study nobody has started work in says exactly that — there is no
    // second list left to explain the empty one away.
    renderSidebar({ tasks: [] });
    expect(await screen.findByText("No tasks yet")).toBeTruthy();
  });

  it("shows no Pinned group when nothing is pinned", async () => {
    renderSidebar({ onPinTask: vi.fn() });
    expect(await screen.findByText("Tasks")).toBeTruthy();
    expect(screen.queryByText("Pinned")).toBeNull();
  });

  it("renames a Task in place on Enter", async () => {
    const user = userEvent.setup();
    const onRenameTask = vi.fn();
    renderSidebar({ onRenameTask });

    await openMenu(user, "Second task");
    await user.click(screen.getByRole("menuitem", { name: /Rename/ }));

    const input = screen.getByRole("textbox", {
      name: /Rename Second task/,
    });
    await user.clear(input);
    await user.type(input, "Model routing spike{Enter}");

    expect(onRenameTask).toHaveBeenCalledWith("t_b", "Model routing spike");
    // The editor closes and the row is a button again.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("cancels a rename on Escape without calling the handler", async () => {
    const user = userEvent.setup();
    const onRenameTask = vi.fn();
    renderSidebar({ onRenameTask });

    await openMenu(user, "Second task");
    await user.click(screen.getByRole("menuitem", { name: /Rename/ }));
    const input = screen.getByRole("textbox", {
      name: /Rename Second task/,
    });
    await user.clear(input);
    await user.type(input, "discarded{Escape}");

    expect(onRenameTask).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Second task")).toBeTruthy();
  });

  it("treats a blank rename as a cancel", async () => {
    const user = userEvent.setup();
    const onRenameTask = vi.fn();
    renderSidebar({ onRenameTask });

    await openMenu(user, "Second task");
    await user.click(screen.getByRole("menuitem", { name: /Rename/ }));
    const input = screen.getByRole("textbox", {
      name: /Rename Second task/,
    });
    await user.clear(input);
    await user.type(input, "   {Enter}");

    expect(onRenameTask).not.toHaveBeenCalled();
    expect(screen.getByText("Second task")).toBeTruthy();
  });

  it("does not fire a rename when the title is unchanged", async () => {
    const user = userEvent.setup();
    const onRenameTask = vi.fn();
    renderSidebar({ onRenameTask });

    await openMenu(user, "Second task");
    await user.click(screen.getByRole("menuitem", { name: /Rename/ }));
    await user.type(
      screen.getByRole("textbox", { name: /Rename Second task/ }),
      "{Enter}",
    );

    expect(onRenameTask).not.toHaveBeenCalled();
  });

  it("edits only the row whose Rename was clicked", async () => {
    const user = userEvent.setup();
    renderSidebar({ onRenameTask: vi.fn() });

    await openMenu(user, "Second task");
    await user.click(screen.getByRole("menuitem", { name: /Rename/ }));

    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    const list = screen.getByTestId("context-rail");
    expect(within(list).getByText("First task")).toBeTruthy();
  });
});
