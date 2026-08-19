/**
 * The open-Notebook tabs. Scoped by Research rather than by Task, because that is
 * the point of them: a notebook opened from one Task stays reachable while the
 * researcher reads another Task in the same Research.
 *
 * The store is a module singleton with no reset export, so each test closes
 * what it opened — the same bargain `task-tabs.test.ts` makes.
 */
import { expect, it } from "vitest";
import {
  closeNotebookTab,
  closeNotebookTabsForResearch,
  notebookTabsFor,
  openNotebookTab,
} from "./notebook-tabs";

it("keeps a notebook from every Task of the Research, in open order", () => {
  openNotebookTab({ researchId: "s_one", taskId: "t_fit" });
  openNotebookTab({ researchId: "s_one", taskId: "t_sweep" });

  expect(notebookTabsFor("s_one").map((t) => t.taskId)).toEqual([
    "t_fit",
    "t_sweep",
  ]);

  closeNotebookTab("t_fit");
  closeNotebookTab("t_sweep");
});

it("opens one tab per Task however many times it is asked", () => {
  openNotebookTab({ researchId: "s_one", taskId: "t_fit" });
  openNotebookTab({ researchId: "s_one", taskId: "t_fit" });

  expect(notebookTabsFor("s_one")).toEqual([
    { researchId: "s_one", taskId: "t_fit" },
  ]);

  closeNotebookTab("t_fit");
});

it("keeps each Research's notebooks off the others' strips", () => {
  openNotebookTab({ researchId: "s_one", taskId: "t_fit" });
  openNotebookTab({ researchId: "s_two", taskId: "t_other" });

  expect(notebookTabsFor("s_one").map((t) => t.taskId)).toEqual(["t_fit"]);
  expect(notebookTabsFor("s_two").map((t) => t.taskId)).toEqual(["t_other"]);

  closeNotebookTab("t_fit");
  closeNotebookTab("t_other");
});

it("closes every notebook of a deleted Research and leaves the rest", () => {
  openNotebookTab({ researchId: "s_gone", taskId: "t_a" });
  openNotebookTab({ researchId: "s_gone", taskId: "t_b" });
  openNotebookTab({ researchId: "s_kept", taskId: "t_c" });

  closeNotebookTabsForResearch("s_gone");

  expect(notebookTabsFor("s_gone")).toEqual([]);
  expect(notebookTabsFor("s_kept").map((t) => t.taskId)).toEqual(["t_c"]);

  closeNotebookTab("t_c");
});
