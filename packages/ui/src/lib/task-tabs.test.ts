/**
 * The open-Task tab strip. A tab is keyed by its TASK, and the Research it sits
 * under is data on the entry rather than part of the key — so a Task that
 * changes Research takes its tab with it instead of leaving one behind on a strip
 * nobody is looking at.
 */
import { expect, it } from "vitest";
import { closeTaskTab, openTaskTab, taskTabsFor } from "./task-tabs";

it("moves a tab into the Research its Task is filed into", () => {
  openTaskTab({ taskId: "t_unfiled", title: "Chase the drift" });
  expect(taskTabsFor(undefined).map((t) => t.taskId)).toContain("t_unfiled");
  expect(taskTabsFor("s_cmp").map((t) => t.taskId)).not.toContain("t_unfiled");

  // Filing. The surface re-registers the same Task under its new Research; the
  // tab has to follow, or the breadcrumb the researcher is looking at loses
  // the conversation they are in the middle of.
  openTaskTab({ researchId: "s_cmp", taskId: "t_unfiled", title: "Chase the drift" });

  expect(taskTabsFor(undefined).map((t) => t.taskId)).not.toContain("t_unfiled");
  expect(taskTabsFor("s_cmp").map((t) => t.taskId)).toEqual(["t_unfiled"]);

  closeTaskTab("t_unfiled");
});

it("keeps one tab per Task when it moves between Researches", () => {
  openTaskTab({ researchId: "s_one", taskId: "t_moved", title: "Refit" });
  openTaskTab({ researchId: "s_two", taskId: "t_moved", title: "Refit" });

  expect(taskTabsFor("s_one")).toEqual([]);
  expect(taskTabsFor("s_two").map((t) => t.taskId)).toEqual(["t_moved"]);

  closeTaskTab("t_moved");
});

it("retitles an open tab without moving it", () => {
  openTaskTab({ researchId: "s_one", taskId: "t_named", title: "New task" });
  openTaskTab({ researchId: "s_one", taskId: "t_named", title: "Fit the curves" });

  expect(taskTabsFor("s_one")).toEqual([
    { researchId: "s_one", taskId: "t_named", title: "Fit the curves" },
  ]);

  closeTaskTab("t_named");
});
