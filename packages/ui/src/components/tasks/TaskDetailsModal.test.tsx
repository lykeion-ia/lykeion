import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type Task } from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { TaskDetailsModal } from "./TaskDetailsModal";

afterEach(cleanup);

async function seed() {
  const api = createInMemoryApi();
  const [study] = await api.listStudies();
  const task = (await api.getStudy(study.id)).tasks[0];
  return { api, study, task };
}

it("edits labels + subtasks and persists them through updateTask", async () => {
  const { api, study, task } = await seed();
  const user = userEvent.setup();
  let saved: Task | null = null;

  render(
    <ApiProvider api={api}>
      <TaskDetailsModal
        task={task}
        study={study}
        onClose={() => {}}
        onSaved={(t) => (saved = t)}
      />
    </ApiProvider>,
  );

  // Toggle a label on.
  await user.click(screen.getByRole("button", { name: /Computational/i }));
  // Add a subtask.
  await user.type(screen.getByPlaceholderText("Add a subtask…"), "Write it up");
  await user.keyboard("{Enter}");

  await user.click(screen.getByRole("button", { name: /^Save$/i }));

  await waitFor(() => expect(saved).not.toBeNull());
  expect(saved!.labels).toContain("computational");
  expect(saved!.subtasks?.map((s) => s.title)).toContain("Write it up");

  // Persisted in the data layer, not just local state.
  const reloaded = (await api.getStudy(study.id)).tasks.find(
    (t) => t.id === task.id,
  );
  expect(reloaded?.labels).toContain("computational");
});
