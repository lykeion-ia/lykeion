import { describe, expect, it } from "vitest";
import type { Research, Task } from "@lykeion/api";
import { exportTasksJson, parseTasksJson, patchHasFields } from "./task-io";

const research: Research = {
  id: "s_1",
  key: "CMP",
  title: "Cross-modal plasticity",
  environmentDefaults: [],
  createdBy: "u_you",
  createdTs: 1,
  updatedTs: 1,
};
const studyById = { [research.id]: research };

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t_1",
    number: 3,
    researchId: "s_1",
    stage: "methods",
    title: "Preprocess calcium traces",
    description: "Denoise and align the two-photon stacks.",
    status: "in-progress",
    priority: "high",
    assignees: [
      { kind: "user", userId: "u_you" },
      { kind: "user", userId: "u_ada" },
    ],
    createdBy: "u_you",
    runCount: 0,
    labels: ["computational"],
    links: ["https://doi.org/10.1/x"],
    targetDate: "2026-08-01",
    subtasks: [
      { title: "load", done: true },
      { title: "denoise", done: false },
    ],
    createdTs: 10,
    updatedTs: 20,
    ...overrides,
  };
}

describe("task-io", () => {
  it("round-trips a task's real fields through export → parse", () => {
    const t = task();
    const json = exportTasksJson([t], studyById);
    const { tasks, skipped } = parseTasksJson(json);

    expect(skipped).toBe(0);
    expect(tasks).toHaveLength(1);

    const { create, patch } = tasks[0];
    // createTask-able subset
    expect(create.researchId).toBe(t.researchId);
    expect(create.stage).toBe(t.stage);
    expect(create.title).toBe(t.title);
    expect(create.description).toBe(t.description);
    expect(create.priority).toBe(t.priority);
    expect(create.assignees).toEqual(t.assignees);
    // patch (fields createTask can't set)
    expect(patch.status).toBe(t.status);
    expect(patch.labels).toEqual(t.labels);
    expect(patch.links).toEqual(t.links);
    expect(patch.targetDate).toBe(t.targetDate);
    expect(patch.subtasks).toEqual(t.subtasks);
    expect(patchHasFields(patch)).toBe(true);
  });

  it("embeds the task code and a version header", () => {
    const json = exportTasksJson([task()], studyById);
    const doc = JSON.parse(json);
    expect(doc.kind).toBe("lykeion.tasks");
    expect(doc.version).toBe(1);
    expect(doc.tasks[0].code).toBe("CMP-3");
  });

  it("skips malformed rows without throwing", () => {
    const doc = JSON.stringify({
      tasks: [
        { researchId: "s_1", stage: "methods", title: "ok" },
        { researchId: "s_1", stage: "not-a-stage", title: "bad stage" },
        { researchId: "s_1", title: "missing stage" },
        { title: "missing research" },
        "totally wrong",
      ],
    });
    const { tasks, skipped } = parseTasksJson(doc);
    expect(tasks).toHaveLength(1);
    expect(skipped).toBe(4);
  });

  it("accepts a bare array and defaults an unknown priority to none", () => {
    const { tasks } = parseTasksJson(
      JSON.stringify([
        { researchId: "s_1", stage: "results", title: "x", priority: "bogus" },
      ]),
    );
    expect(tasks).toHaveLength(1);
    expect(tasks[0].create.priority).toBe("none");
  });

  it("returns empty on invalid JSON", () => {
    expect(parseTasksJson("{not json")).toEqual({ tasks: [], skipped: 0 });
  });

  it("omits empty collections from the export", () => {
    const json = exportTasksJson(
      [
        task({
          assignees: undefined,
          labels: [],
          links: undefined,
          subtasks: [],
          targetDate: undefined,
        }),
      ],
      studyById,
    );
    const row = JSON.parse(json).tasks[0];
    expect(row.assignees).toBeUndefined();
    expect(row.labels).toBeUndefined();
    expect(row.links).toBeUndefined();
    expect(row.subtasks).toBeUndefined();
    expect(row.targetDate).toBeUndefined();
  });
});
