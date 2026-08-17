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
  it("offers the Studies and nothing else when there are no Tasks", () => {
    const commands = buildCommands(studies);
    expect(commands.map((c) => c.label)).toEqual([
      "Go to Cross-modal plasticity in the brain",
      "Go to Minimum-wage effects on regional employment",
    ]);
  });

  /**
   * Screens are not in the palette. Thirteen "Go to <section>" rows used to be,
   * and they crowded out what it is actually reached for — the rail is how you
   * get to a screen, and it is always on the page.
   */
  it("offers no screens", () => {
    const commands = buildCommands(studies);
    expect(commands.every((c) => c.kind === "study" || c.kind === "task")).toBe(
      true,
    );
    for (const gone of ["Go to Inbox", "Go to Settings", "Go to Machines"]) {
      expect(commands.some((c) => c.label === gone)).toBe(false);
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
    const tasks = commands.filter((c) => c.kind === "task");
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
    expect(buildCommands(studies).some((c) => c.kind === "task")).toBe(false);
  });
});

describe("filterCommands", () => {
  const commands = buildCommands(studies);

  it("returns everything for an empty query", () => {
    expect(filterCommands(commands, "")).toHaveLength(commands.length);
  });

  it("finds studies by title fragment, case-insensitively", () => {
    const results = filterCommands(commands, "cross-modal");
    expect(results[0]?.label).toBe("Go to Cross-modal plasticity in the brain");
  });

  it("returns nothing for garbage", () => {
    expect(filterCommands(commands, "zzzz qqqq")).toHaveLength(0);
  });
});

/**
 * What the palette shows beside the highlighted row.
 *
 * Built here rather than in the component, so what a preview SAYS is covered by
 * a plain test instead of a rendered one — and so this module stays the only one
 * that knows what a Task is.
 */
describe("command previews", () => {
  const study: Study = {
    id: "s_1",
    key: "CHE",
    title: "Covalent inhibitor scaffolds",
    createdBy: "u_you",
    createdTs: 0,
    updatedTs: 1000,
  };
  const task: Task = {
    id: "t_2",
    number: 2,
    studyId: "s_1",
    stage: "methods",
    title: "KRAS G12C binding assay",
    status: "in-progress",
    priority: "high",
    createdBy: "u_you",
    runCount: 0,
    createdTs: 0,
    updatedTs: 940,
  };
  // A fixed clock. A preview reading "2d" today and "3d" tomorrow would make
  // this suite fail on a Tuesday for a reason nobody could act on, which is why
  // `buildCommands` takes `now` rather than reading it.
  const NOW = 1000 + 60 * 60 * 24 * 2;

  const find = (id: string) =>
    buildCommands([study], { s_1: [task] }, NOW).find((c) => c.id === id)!;

  it("describes a Task by what a researcher needs to recognise it", () => {
    const preview = find("task-t_2").preview;
    expect(preview.title).toBe("CHE-2");
    expect(preview.subtitle).toBe("KRAS G12C binding assay");
    expect(preview.rows).toEqual([
      { label: "Study", value: "Covalent inhibitor scaffolds" },
      { label: "Status", value: "In Progress" },
      { label: "Priority", value: "High" },
      { label: "Updated", value: "2d" },
    ]);
  });

  it("describes a Study by its key and when it last moved", () => {
    const preview = find("study-s_1").preview;
    expect(preview.title).toBe("Covalent inhibitor scaffolds");
    expect(preview.subtitle).toBe("CHE");
    expect(preview.rows).toEqual([{ label: "Updated", value: "2d" }]);
  });

  it("gives every command a preview, so no row faces an empty panel", () => {
    for (const command of buildCommands([study], { s_1: [task] }, NOW)) {
      expect(command.preview.title.length).toBeGreaterThan(0);
      expect(command.preview.subtitle?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("tags each command with its kind", () => {
    expect(find("study-s_1").kind).toBe("study");
    expect(find("task-t_2").kind).toBe("task");
  });

  it("reads the clock only when nobody says what time it is", () => {
    // The default exists so callers that do not care need not pass one; the
    // parameter exists so this file can.
    const withoutNow = buildCommands([study], { s_1: [task] });
    expect(
      withoutNow.find((c) => c.id === "study-s_1")!.preview.rows,
    ).toHaveLength(1);
  });
});
