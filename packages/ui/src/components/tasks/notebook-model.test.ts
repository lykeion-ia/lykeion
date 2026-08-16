import { expect, it } from "vitest";
import type { NotebookCell, RunningKernel } from "@lykeion/api";
import {
  buildNotebookContexts,
  kernelFor,
  languagesOf,
} from "./notebook-model";

function kernel(overrides: Partial<RunningKernel>): RunningKernel {
  return {
    id: "kernel-1",
    machineId: "machine-1",
    studyId: "study-1",
    sessionId: "session-1",
    taskId: "task-1",
    name: "main",
    language: "python",
    state: "idle",
    incarnation: 1,
    executionCount: 0,
    queueDepth: 0,
    environment: "python",
    ...overrides,
  };
}

function cell(overrides: Partial<NotebookCell>): NotebookCell {
  return {
    id: "cell-1",
    kernelId: "kernel-1",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 1,
    source: "1 + 1",
    origin: { surface: "repl", by: "member-1" },
    ok: true,
    wallMs: 1,
    ts: 1,
    outputs: [],
    ...overrides,
  };
}

it("sorts contexts by name while preserving the API cell order", () => {
  const contexts = buildNotebookContexts(
    [kernel({ name: "worker" }), kernel({ name: "main", id: "kernel-2" })],
    [cell({ id: "cell-2", name: "main" }), cell({ id: "cell-1", name: "main" })],
  );

  expect(contexts.map((context) => context.name)).toEqual(["main", "worker"]);
  expect(contexts[0].cells.map((notebookCell) => notebookCell.id)).toEqual(["cell-2", "cell-1"]);
});

it("includes languages from live kernels and historical cells", () => {
  const [context] = buildNotebookContexts(
    [kernel({ language: "python" })],
    [cell({ language: "r" })],
  );

  expect(languagesOf(context)).toEqual(["python", "r"]);
});

it("does not substitute a different language for an explicit selection", () => {
  const [context] = buildNotebookContexts(
    [kernel({ language: "python" })],
    [cell({ language: "r" })],
  );

  expect(kernelFor(context, "r")).toBeUndefined();
});
