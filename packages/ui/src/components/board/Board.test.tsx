import { expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { createInMemoryApi, type Research, type Task } from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { RouterProvider } from "../../router";
import { Board } from "./Board";

afterEach(cleanup);

const research: Research = {
  id: "s1",
  key: "AAA",
  title: "Alpha",
  createdBy: "u_you",
  createdTs: 1,
  updatedTs: 2,
};
function tk(over: Partial<Task>): Task {
  return {
    id: "t",
    number: 1,
    researchId: "s1",
    stage: "methods",
    title: "T",
    status: "todo",
    priority: "medium",
    assignees: [{ kind: "user", userId: "u_you" }],
    createdBy: "u_you",
    runCount: 0,
    createdTs: 1,
    updatedTs: 2,
    ...over,
  };
}

it("renders the four status columns and a card", async () => {
  const tasks = [
    tk({
      id: "t1",
      number: 3,
      status: "in-review",
      title: "Preprocess traces",
    }),
    tk({ id: "t2", number: 4, status: "todo", title: "Fit curves" }),
  ];
  render(
    <ApiProvider api={createInMemoryApi()}>
      <RouterProvider>
        <Board tasks={tasks} studyById={{ s1: research }} />
      </RouterProvider>
    </ApiProvider>,
  );
  await screen.findByText("AAA-3");
  for (const col of ["Todo", "In Progress", "In Review", "Done"]) {
    // getAllByText: a non-empty column's own card(s) repeat the status label
    // in their status chip, so the column heading is not always unique text.
    expect(screen.getAllByText(col).length).toBeGreaterThan(0);
  }
  expect(screen.getByText("AAA-3")).toBeInTheDocument();
  expect(screen.getByText("Preprocess traces")).toBeInTheDocument();
  expect(screen.queryByText("Failed")).not.toBeInTheDocument();
});
