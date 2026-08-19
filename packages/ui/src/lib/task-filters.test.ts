import { describe, expect, it } from "vitest";
import type { Member, Research, Task } from "@lykeion/api";
import { deriveResearchMeta } from "./research-meta";
import { assigneeKey, directoryOf } from "./assignee";
import {
  activeFilterCount,
  applyResearchFilters,
  applyTaskFilters,
  EMPTY_FILTERS,
  taskDimensions,
  sortTasks,
  studyDimensions,
} from "./task-filters";

const research: Research = {
  id: "s1",
  key: "AAA",
  title: "Alpha research",
  createdBy: "u_you",
  createdTs: 1000,
  updatedTs: 2000,
};

const members: Member[] = [
  {
    user: { id: "u_you", email: "you@lab.example", displayName: "You", createdTs: 0 },
    role: "owner",
    joinedTs: 0,
  },
  {
    user: {
      id: "u_amara",
      email: "amara@lab.example",
      displayName: "Amara",
      createdTs: 0,
    },
    role: "member",
    joinedTs: 0,
  },
];
const dir = directoryOf(members);

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
    createdTs: 100,
    updatedTs: 200,
    ...over,
  };
}

const tasks: Task[] = [
  tk({
    id: "t1",
    number: 1,
    status: "in-progress",
    priority: "high",
    assignees: [{ kind: "user", userId: "u_you" }],
    stage: "methods",
  }),
  tk({
    id: "t2",
    number: 2,
    status: "todo",
    priority: "low",
    assignees: [{ kind: "user", userId: "u_amara" }],
    stage: "results",
  }),
  tk({
    id: "t3",
    number: 3,
    status: "done",
    priority: "urgent",
    assignees: [{ kind: "user", userId: "u_you" }],
    stage: "results",
  }),
];
const studyById: Record<string, Research> = { s1: research };

describe("task-filters", () => {
  it("builds My Tasks dimensions with real counts", () => {
    const dims = taskDimensions(tasks, studyById, dir);
    const status = dims.find((d) => d.key === "status");
    expect(status?.options?.find((o) => o.id === "todo")?.count).toBe(1);
    const assignee = dims.find((d) => d.key === "assignee");
    expect(assignee?.options?.map((o) => o.label).sort()).toEqual([
      "Amara",
      "You",
    ]);
    expect(dims.some((d) => d.key === "stage")).toBe(true);
  });

  it("narrows by status and assignee", () => {
    const byStatus = applyTaskFilters(tasks, { values: { status: ["todo"] } });
    expect(byStatus.map((t) => t.id)).toEqual(["t2"]);
    const byAssignee = applyTaskFilters(tasks, {
      values: { assignee: [assigneeKey({ kind: "user", userId: "u_you" })] },
    });
    expect(byAssignee.map((t) => t.id).sort()).toEqual(["t1", "t3"]);
  });

  it("does not crash on undefined labels/targetDate", () => {
    expect(
      applyTaskFilters(tasks, { values: { labels: ["wet-lab"] } }),
    ).toEqual([]);
    expect(
      applyTaskFilters(tasks, { values: {}, targetDate: "2026-01-01" }),
    ).toHaveLength(3);
  });

  it("sorts by priority high→low", () => {
    const sorted = sortTasks(tasks, "priority");
    expect(sorted[0].priority).toBe("urgent");
  });

  it("EMPTY_FILTERS is inert", () => {
    expect(applyTaskFilters(tasks, EMPTY_FILTERS)).toHaveLength(3);
  });
});

describe("research-meta", () => {
  it("rolls up status/priority/lead/progress from tasks", () => {
    const meta = deriveResearchMeta(research, tasks, dir);
    expect(meta.statusLabel).toBe("In Progress"); // some in-progress
    expect(meta.totalCount).toBe(3);
    expect(meta.doneCount).toBe(1);
    expect(meta.priorityLabel).toBe("Urgent"); // highest present
    expect(meta.lead?.label).toBe("You"); // most-frequent assignee
  });

  it("empty research → Backlog / no lead", () => {
    const meta = deriveResearchMeta(research, [], dir);
    expect(meta.statusLabel).toBe("Backlog");
    expect(meta.lead).toBeNull();
    expect(meta.totalCount).toBe(0);
  });

  it("research filters narrow on derived meta", () => {
    const dims = studyDimensions([research], { s1: tasks });
    expect(dims.some((d) => d.key === "stage")).toBe(true);
    const shown = applyResearchFilters(
      [research],
      { values: { status: ["In Progress"] } },
      { s1: tasks },
    );
    expect(shown).toHaveLength(1);
    const none = applyResearchFilters(
      [research],
      { values: { status: ["Done"] } },
      { s1: tasks },
    );
    expect(none).toHaveLength(0);
  });
});

describe("the archived dimension", () => {
  const archived: Research = { ...research, id: "s2", key: "BBB", title: "Shelved", archivedTs: 3000 };
  const both = [research, archived];
  const byResearch = { s1: tasks, s2: [] };

  it("counts each side of the shelf", () => {
    const dim = studyDimensions(both, byResearch).find((d) => d.key === "archived");
    expect(dim?.options).toEqual([
      expect.objectContaining({ id: "active", label: "Active", count: 1 }),
      expect.objectContaining({ id: "archived", label: "Archived", count: 1 }),
    ]);
  });

  it("hides the archived when nothing is selected", () => {
    expect(applyResearchFilters(both, EMPTY_FILTERS, byResearch).map((s) => s.id)).toEqual([
      "s1",
    ]);
  });

  it("shows only the archived when Archived is selected", () => {
    const shown = applyResearchFilters(
      both,
      { values: { archived: ["archived"] } },
      byResearch,
    );
    expect(shown.map((s) => s.id)).toEqual(["s2"]);
  });

  it("shows both when both are selected", () => {
    const shown = applyResearchFilters(
      both,
      { values: { archived: ["active", "archived"] } },
      byResearch,
    );
    expect(shown.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("counts a lone Archived selection as one active filter", () => {
    expect(activeFilterCount({ values: { archived: ["archived"] } })).toBe(1);
  });
});
