/**
 * The shell smoke test.
 *
 * Drives the three canonical screens (Researches · a Research · a Task) plus the
 * command palette, Inbox, and My Tasks, using only visible text / roles and
 * keyboard, so it is agnostic to the routing implementation. Runs headless
 * (jsdom) against the in-memory API — this is the "e2e smoke" for CI.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  render,
  screen,
  within,
  cleanup,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "./App";
import { resetPageLoad } from "./lib/tabs-storage";
import { resetTabs } from "./lib/tabs";

function renderApp() {
  return render(<App api={createInMemoryApi()} />);
}

beforeEach(() => {
  cleanup();
  // The tab strip is a module store, not component state — it outlives any
  // one test's render the way it is meant to outlive a screen. Left alone
  // here, a test that does not set its own hash would inherit whichever
  // route the previous test's navigation happened to leave the active tab
  // on, rather than the blank-hash default every one of these otherwise
  // assumes it starts from.
  resetTabs();
  window.location.hash = "";
  // `App` reads the stored strip once per page, which this file's repeated
  // `<App>` mounts would otherwise only get on the very first test. Adopting
  // the incoming hash needs no reset: that is per-mount, in `RouterProvider`.
  resetPageLoad();
});

describe("Lykeion shell", () => {
  it("Projects screen: the Rail and every project line", async () => {
    renderApp();

    // Top + Laboratory + Configure nav. "Tasks" is anchored so it doesn't also
    // match "My Tasks", and "Researches" is anchored against the same hazard — an
    // unanchored one of either matches two links, and `findByRole` throws on
    // the ambiguity rather than picking one.
    for (const name of [
      /Inbox/i,
      /My Tasks/i,
      /^Tasks$/i,
      /^Researches$/i,
      /Settings/i,
    ]) {
      expect(await screen.findByRole("link", { name })).toBeInTheDocument();
    }
    // Remaining Laboratory + Configure nav.
    for (const label of [
      "Groups",
      "Experts",
      "Machines",
    ]) {
      expect(
        screen.getByRole("link", { name: new RegExp(label, "i") }),
      ).toBeInTheDocument();
    }

    // All five seeded researches are listed.
    expect(
      await screen.findByText("Cross-modal plasticity in the brain"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Single-cell atlas of KRAS-mutant tumors"),
    ).toBeInTheDocument();
    expect(screen.getByText(/marine heatwaves/i)).toBeInTheDocument();
  });

  it("a Research opens the chat entry", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(
      await screen.findByText("Cross-modal plasticity in the brain"),
    );

    // Opening a Research lands on the chat entry (not a task table).
    expect(
      await screen.findByRole("region", { name: "Start a task" }),
    ).toBeInTheDocument();
  });

  it("a Task opens the full chat interface", async () => {
    // CMP-3 is in-review, so it opens straight into the full chat.
    window.location.hash = "#/researches/s_cmp/tasks/t_3";
    renderApp();

    await screen.findByTestId("task-surface");
    // The TabBar pill ties the task to its Research via the task code.
    expect(
      await screen.findByText(/CMP-3: Preprocess two-photon calcium traces/i),
    ).toBeVisible();

    // The full chat interface: the left-side pane and the conversation.
    expect(await screen.findByTestId("context-rail")).toBeInTheDocument();
    expect(screen.getByTestId("conversation")).toBeInTheDocument();
  });

  it("command palette opens with the keyboard and navigates", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText("Cross-modal plasticity in the brain");

    // Cmd/Ctrl-K opens the palette (keyboard-first).
    await user.keyboard("{Meta>}k{/Meta}");
    const palette = await screen.findByRole("dialog", { name: /command/i });
    const input = within(palette).getByRole("combobox");

    // Jump to a Task through the palette, by its code. Screens are not in here
    // — the rail is how you reach those — so what the palette navigates to is a
    // Research or a Task.
    await user.type(input, "CMP-7");
    await user.keyboard("{Enter}");

    expect(await screen.findByTestId("task-surface")).toBeInTheDocument();
    expect(
      await screen.findByText(/CMP-7: Draft a chemogenetic follow-up/i),
    ).toBeInTheDocument();
  });

  it("command palette closes on Escape", async () => {
    const user = userEvent.setup();
    renderApp();
    await screen.findByText("Cross-modal plasticity in the brain");

    await user.keyboard("{Meta>}k{/Meta}");
    expect(
      await screen.findByRole("dialog", { name: /command/i }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: /command/i }),
    ).not.toBeInTheDocument();
  });

  it("Inbox lists the lab's conversations", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("link", { name: /Inbox/i }));
    expect(
      await screen.findByText("Preprocess two-photon calcium traces"),
    ).toBeInTheDocument();
  });

  it("a research row is keyboard-activatable", async () => {
    const user = userEvent.setup();
    renderApp();

    const row = await screen.findByRole("link", {
      name: /Cross-modal plasticity in the brain/i,
    });
    row.focus();
    expect(row).toHaveFocus();
    await user.keyboard("{Enter}");

    // Opening the research reveals the chat entry.
    expect(
      await screen.findByRole("region", { name: "Start a task" }),
    ).toBeInTheDocument();
  });

  it("a Task created from the Rail's New task button updates that Research's row on Researches, with no navigation", async () => {
    const user = userEvent.setup();
    renderApp();

    const CMP = "Cross-modal plasticity in the brain";
    const row = await screen.findByRole("link", { name: new RegExp(CMP) });
    const before = within(row).getByText(/^\d+\/\d+$/).textContent ?? "";
    const [doneCount, totalCount] = before.split("/").map(Number);
    const after = `${doneCount}/${totalCount + 1}`;

    // The Rail's own global button — not a screen's New task/New research
    // affordance — is the one call site this defect is about.
    await user.click(screen.getByRole("button", { name: /^New Task/ }));
    const dialog = await screen.findByRole("dialog", { name: "Create task" });

    // The Research field is the dialog's first select; pin it to CMP so the row
    // being watched is the one the created Task lands in.
    const studySelect = within(dialog).getAllByRole("combobox")[0];
    await user.selectOptions(studySelect, "s_cmp");
    await user.type(
      within(dialog).getByPlaceholderText("Task title"),
      "Confirm the Rail keeps Researches live",
    );

    const createBtn = within(dialog).getByRole("button", {
      name: /Create task/i,
    });
    await waitFor(() => expect(createBtn).toBeEnabled());
    await user.click(createBtn);

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Create task" }),
      ).not.toBeInTheDocument(),
    );

    // Still on Researches — nothing navigated — and the row's own task count
    // moved without a manual refresh.
    const updatedRow = await screen.findByRole("link", {
      name: new RegExp(CMP),
    });
    expect(within(updatedRow).getByText(after)).toBeInTheDocument();
  });
});
