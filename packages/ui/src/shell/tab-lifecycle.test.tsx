/**
 * A tab outlives the screen that opened it, so the events that end a thing have
 * to reach the strip. Otherwise it goes on offering places that no longer open —
 * and, on sign-out, hands the next person at this machine a list of the last
 * one's work, since a tab's label is a Task's title.
 *
 * The store's own behaviour is covered in `lib/tabs.test.ts`. What these pin is
 * the WIRING: that the delete paths call it at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";
import { openTab, resetTabs, tabsSnapshot } from "../lib/tabs";
import { resetPageLoad } from "../lib/tabs-storage";

const CMP = "s_cmp";
const CMP_TITLE = "Cross-modal plasticity in the brain";

/** Every route the strip is currently holding, at any stack depth. */
const routes = () =>
  tabsSnapshot()
    .tabs.flatMap((t) => t.stack)
    .map((e) => e.route);

beforeEach(() => {
  resetTabs();
  resetPageLoad();
  window.location.hash = "";
});

afterEach(cleanup);

describe("tab lifecycle", () => {
  it("takes a deleted Research's own tab, and its Tasks', out of the strip", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();

    // Two tabs aimed inside the Research, neither of them the one being read.
    openTab({ name: "research", researchId: CMP });
    openTab({ name: "task", researchId: CMP, taskId: "t_1" });
    window.location.hash = "#/researches";
    render(<App api={api} />);

    await user.click(
      await screen.findByRole("button", { name: `Delete ${CMP_TITLE}` }),
    );
    await user.click(
      within(
        await screen.findByRole("dialog", { name: "Delete research" }),
      ).getByRole("button", { name: "Delete" }),
    );

    // The strip cannot keep offering a Research that no longer opens.
    await vi.waitFor(() => {
      expect(
        routes().some(
          (r) =>
            (r.name === "research" && r.researchId === CMP) ||
            (r.name === "task" && r.researchId === CMP),
        ),
      ).toBe(false);
    });
  });

  it("takes a deleted Task out of the strip", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    const { tasks } = await api.getResearch(CMP);
    const doomed = tasks[0];

    openTab({ name: "task", researchId: CMP, taskId: doomed.id });
    window.location.hash = `#/researches/${CMP}`;
    render(<App api={api} />);

    // Deletion is behind the row's own kebab, then a confirm.
    await user.click(
      await screen.findByRole("button", {
        name: `Task actions for ${doomed.title}`,
      }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await user.click(
      within(
        await screen.findByRole("dialog", { name: "Delete task" }),
      ).getByRole("button", { name: "Delete" }),
    );

    await vi.waitFor(() => {
      expect(
        routes().some(
          (r) => r.name === "task" && r.taskId === doomed.id,
        ),
      ).toBe(false);
    });
  });
});
