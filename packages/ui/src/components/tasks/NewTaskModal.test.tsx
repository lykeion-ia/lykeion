import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed, type Task } from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { NewTaskModal } from "./NewTaskModal";

afterEach(cleanup);

it("creates a real task assigned to me and reports it via onCreated", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  let created: Task | null = null;

  render(
    <ApiProvider api={api}>
      <NewTaskModal onClose={() => {}} onCreated={(t) => (created = t)} />
    </ApiProvider>,
  );

  await user.type(
    await screen.findByPlaceholderText("Task title"),
    "Draft the methods",
  );

  const createBtn = screen.getByRole("button", { name: /Create task/i });
  // Enabled once both the Study and the creating member's identity load.
  await waitFor(() => expect(createBtn).toBeEnabled());
  await user.click(createBtn);

  await waitFor(() => expect(created).not.toBeNull());
  expect(created!.title).toBe("Draft the methods");
  expect(created!.assignees).toEqual([{ kind: "user", userId: "u_you" }]);

  // It is now real in the data layer.
  const mine = await api.myWork();
  expect(mine.some((t) => t.id === created!.id)).toBe(true);
});

it("removing the default assignee keeps the Task unassigned", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  let created: Task | null = null;

  render(
    <ApiProvider api={api}>
      <NewTaskModal onClose={() => {}} onCreated={(t) => (created = t)} />
    </ApiProvider>,
  );

  await user.type(
    await screen.findByPlaceholderText("Task title"),
    "Nobody owns this yet",
  );

  const removeBtn = await screen.findByRole("button", { name: /Remove You/i });
  await user.click(removeBtn);
  expect(
    screen.queryByRole("button", { name: /Remove You/i }),
  ).not.toBeInTheDocument();

  const createBtn = screen.getByRole("button", { name: /Create task/i });
  await waitFor(() => expect(createBtn).toBeEnabled());
  await user.click(createBtn);

  await waitFor(() => expect(created).not.toBeNull());
  expect(created!.assignees).toBeUndefined();
});

it("removes the default assignee while the picker is open", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi();
  let created: Task | null = null;

  render(
    <ApiProvider api={api}>
      <NewTaskModal onClose={() => {}} onCreated={(t) => (created = t)} />
    </ApiProvider>,
  );

  await user.type(
    await screen.findByPlaceholderText("Task title"),
    "Nobody owns this either",
  );

  // The chip sits outside the picker, so removing from it also dismisses the
  // popover. The dismissal must not swallow the removal.
  await user.click(screen.getByRole("button", { name: "Assignees" }));
  expect(await screen.findByRole("listbox")).toBeInTheDocument();

  await user.click(await screen.findByRole("button", { name: /Remove You/i }));
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(
    screen.queryByRole("button", { name: /Remove You/i }),
  ).not.toBeInTheDocument();

  const createBtn = screen.getByRole("button", { name: /Create task/i });
  await waitFor(() => expect(createBtn).toBeEnabled());
  await user.click(createBtn);

  await waitFor(() => expect(created).not.toBeNull());
  expect(created!.assignees).toBeUndefined();
});

it("on a fresh install with no Study to file into, still captures the Task, unfiled", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi(emptySeed());
  let created: Task | null = null;

  render(
    <ApiProvider api={api}>
      <NewTaskModal onClose={() => {}} onCreated={(t) => (created = t)} />
    </ApiProvider>,
  );

  await user.type(
    await screen.findByPlaceholderText("Task title"),
    "Ask the core facility about scope time",
  );

  // Nothing to file into, and that is not a reason to refuse the capture.
  const createBtn = screen.getByRole("button", { name: /Create task/i });
  await waitFor(() => expect(createBtn).toBeEnabled());
  await user.click(createBtn);

  // The end state, not the button state: a real Task in the data layer,
  // belonging to no Study. Asserting only that Create was enabled would pass
  // against a modal that enabled it and then failed the write.
  await waitFor(() => expect(created).not.toBeNull());
  expect(created!.studyId).toBeUndefined();
  const all = await api.listTasks();
  expect(all.map((t) => t.id)).toEqual([created!.id]);
  expect(await api.listStudies()).toEqual([]);
});
