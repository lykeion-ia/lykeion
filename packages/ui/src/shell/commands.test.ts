import { describe, expect, it } from "vitest";
import type { Study, Task } from "@lykeion/api";
import { buildCommands, filterCommands } from "./commands";

const studies: Study[] = [
  {
    id: "s_cmp",
    key: "CMP",
    title: "Cross-modal plasticity in the brain",
    createdBy: "u_you",
    createdTs: 0,
    updatedTs: 0,
  },
  {
    id: "s_eco",
    key: "ECO",
    title: "Minimum-wage effects on regional employment",
    createdBy: "u_you",
    createdTs: 0,
    updatedTs: 0,
  },
];

describe("buildCommands", () => {
  it("has all thirteen navigation commands plus one per study", () => {
    const commands = buildCommands(studies);
    expect(commands).toHaveLength(15);
    for (const label of [
      "Go to Inbox",
      "Go to My Tasks",
      "Go to Research Groups",
      "Go to Tasks",
      "Go to Studies",
      "Go to Agents",
      "Go to Skills",
      "Go to Workflows",
      "Go to Connectors",
      "Go to Machines",
      "Go to Profile",
      "Go to Appearance",
      "Go to Settings",
      "Go to Cross-modal plasticity in the brain",
    ]) {
      expect(commands.some((c) => c.label === label)).toBe(true);
    }
  });
});

const task = (id: string, number: number, studyId: string, title: string): Task => ({
  id,
  number,
  studyId,
  stage: "methods",
  title,
  status: "todo",
  priority: "none",
  createdBy: "u_you",
  runCount: 0,
  createdTs: 0,
  updatedTs: 0,
});

describe("buildCommands, indexing Tasks", () => {
  const tasksByStudy = {
    s_cmp: [
      task("t_3", 3, "s_cmp", "Preprocess two-photon calcium traces"),
      task("t_7", 7, "s_cmp", "Draft a chemogenetic follow-up"),
    ],
    s_eco: [task("t_12", 12, "s_eco", "Assemble the county-panel wage dataset")],
  };

  it("emits one command per Task, coded and titled, routed to the Task", () => {
    const commands = buildCommands(studies, tasksByStudy);
    const tasks = commands.filter((c) => c.hint === "Task");
    expect(tasks.map((c) => c.label)).toEqual([
      "CMP-3 · Preprocess two-photon calcium traces",
      "CMP-7 · Draft a chemogenetic follow-up",
      "ECO-12 · Assemble the county-panel wage dataset",
    ]);
    expect(tasks.map((c) => c.route)).toEqual([
      { name: "task", studyId: "s_cmp", taskId: "t_3" },
      { name: "task", studyId: "s_cmp", taskId: "t_7" },
      { name: "task", studyId: "s_eco", taskId: "t_12" },
    ]);
  });

  it("finds a Task by a fragment of its title, over the Studies and screens", () => {
    const commands = buildCommands(studies, tasksByStudy);
    const results = filterCommands(commands, "chemogenetic");
    expect(results).toHaveLength(1);
    expect(results[0].route).toEqual({
      name: "task",
      studyId: "s_cmp",
      taskId: "t_7",
    });
  });

  it("finds a Task by its code", () => {
    const commands = buildCommands(studies, tasksByStudy);
    expect(filterCommands(commands, "ECO-12")[0]?.route).toEqual({
      name: "task",
      studyId: "s_eco",
      taskId: "t_12",
    });
  });

  it("emits no Task commands when it is given none", () => {
    expect(buildCommands(studies).some((c) => c.hint === "Task")).toBe(false);
  });
});

describe("filterCommands", () => {
  const commands = buildCommands(studies);

  it("returns everything for an empty query", () => {
    expect(filterCommands(commands, "")).toHaveLength(commands.length);
  });

  it("ranks 'Go to My Tasks' first for 'My Tasks'", () => {
    const results = filterCommands(commands, "My Tasks");
    expect(results[0]?.label).toBe("Go to My Tasks");
  });

  it("finds studies by title fragment, case-insensitively", () => {
    const results = filterCommands(commands, "cross-modal");
    expect(results[0]?.label).toBe("Go to Cross-modal plasticity in the brain");
  });

  it("returns nothing for garbage", () => {
    expect(filterCommands(commands, "zzzz qqqq")).toHaveLength(0);
  });
});
