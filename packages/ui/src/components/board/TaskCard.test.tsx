import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, type Research, type Task } from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { RouterProvider } from "../../router";
import { TaskCard } from "./TaskCard";

afterEach(cleanup);

const research: Research = {
  id: "s1",
  key: "AAA",
  title: "Alpha",
  environmentDefaults: [],
  createdBy: "u_you",
  createdTs: 1,
  updatedTs: 2,
};

function tk(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    number: 3,
    researchId: "s1",
    stage: "methods",
    title: "Preprocess traces",
    status: "in-progress",
    priority: "high",
    assignees: [
      { kind: "user", userId: "u_you" },
      { kind: "user", userId: "u_amara" },
    ],
    createdBy: "u_you",
    runCount: 0,
    labels: ["computational"],
    links: ["https://example.com/a", "https://example.com/b"],
    subtasks: [
      { title: "load", done: true },
      { title: "denoise", done: false },
    ],
    targetDate: "2026-08-01",
    createdTs: 1,
    updatedTs: 2,
    ...over,
  };
}

it("renders code, title, label, links count, date and subtask progress", async () => {
  render(
    <ApiProvider api={createInMemoryApi()}>
      <RouterProvider>
        <TaskCard task={tk()} research={research} />
      </RouterProvider>
    </ApiProvider>,
  );
  expect(await screen.findByText("AAA-3")).toBeInTheDocument();
  expect(screen.getByText("Preprocess traces")).toBeInTheDocument();
  expect(screen.getByText("Computational")).toBeInTheDocument();
  expect(screen.getByText("Aug 1")).toBeInTheDocument();
  expect(screen.getByText("2")).toBeInTheDocument(); // links count
  expect(screen.getByText("1/2")).toBeInTheDocument(); // subtask progress
});

it("omits the footer when a task has no metadata", async () => {
  render(
    <ApiProvider api={createInMemoryApi()}>
      <RouterProvider>
        <TaskCard
          task={tk({
            assignees: [],
            labels: [],
            links: [],
            subtasks: [],
            targetDate: undefined,
          })}
          research={research}
        />
      </RouterProvider>
    </ApiProvider>,
  );
  await screen.findByText("Preprocess traces");
  expect(screen.queryByText("1/2")).not.toBeInTheDocument();
});

it("fires onEdit without navigating", async () => {
  const user = userEvent.setup();
  let editedId: string | null = null;
  render(
    <ApiProvider api={createInMemoryApi()}>
      <RouterProvider>
        <TaskCard
          task={tk()}
          research={research}
          onEdit={(t) => (editedId = t.id)}
        />
      </RouterProvider>
    </ApiProvider>,
  );
  await user.click(screen.getByRole("button", { name: /Edit task details/i }));
  expect(editedId).toBe("t1");
  // The route didn't change (the card is a link, but edit stops navigation).
  expect(window.location.hash).not.toContain("/task/");
});
