import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { createInMemoryApi, type Research, type Task } from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { RouterProvider } from "../../router";
import { TaskList } from "./TaskList";

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
const tasks: Task[] = [
  {
    id: "t1",
    number: 3,
    researchId: "s1",
    stage: "methods",
    title: "Preprocess traces",
    status: "in-review",
    priority: "high",
    assignees: [{ kind: "user", userId: "u_you" }],
    createdBy: "u_you",
    runCount: 0,
    createdTs: 1,
    updatedTs: 2,
  },
];

it("renders a task row with code, title, and assignee", async () => {
  render(
    <ApiProvider api={createInMemoryApi()}>
      <RouterProvider>
        <TaskList tasks={tasks} studyById={{ s1: research }} showResearch />
      </RouterProvider>
    </ApiProvider>,
  );
  expect(screen.getByText("AAA-3")).toBeInTheDocument();
  expect(screen.getByText("Preprocess traces")).toBeInTheDocument();
  expect(await screen.findByText("You")).toBeInTheDocument();
});

it("shows the empty label when there are no tasks", async () => {
  render(
    <ApiProvider api={createInMemoryApi()}>
      <RouterProvider>
        <TaskList tasks={[]} studyById={{}} emptyLabel="No tasks match" />
      </RouterProvider>
    </ApiProvider>,
  );
  expect(await screen.findByText("No tasks match")).toBeInTheDocument();
});
