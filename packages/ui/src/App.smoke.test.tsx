/**
 * The shell smoke test.
 *
 * Drives the three canonical screens (Studies · a Study · a Task) plus the
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

function renderApp() {
  return render(<App api={createInMemoryApi()} />);
}

beforeEach(cleanup);

describe("Lykeion shell", () => {
  it("Projects screen: the Rail and every project line", async () => {
    renderApp();

    // Top + Laboratory + Configure nav. "Studies" is anchored so it doesn't
    // also match "Research Groups" or similar, and "Tasks" so it doesn't also
    // match "My Tasks" — an unanchored one of either matches two links, and
    // `findByRole` throws on the ambiguity rather than picking one.
    for (const name of [
      /Inbox/i,
      /My Tasks/i,
      /^Tasks$/i,
      /^Studies$/i,
      /Settings/i,
    ]) {
      expect(await screen.findByRole("link", { name })).toBeInTheDocument();
    }
    // Remaining Laboratory + Configure nav.
    for (const label of [
      "Research Groups",
      "Agents",
      "Workflows",
      "Machines",
    ]) {
      expect(
        screen.getByRole("link", { name: new RegExp(label, "i") }),
      ).toBeInTheDocument();
    }

    // All five seeded studies are listed.
    expect(
      await screen.findByText("Cross-modal plasticity in the brain"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Single-cell atlas of KRAS-mutant tumors"),
    ).toBeInTheDocument();
    expect(screen.getByText(/marine heatwaves/i)).toBeInTheDocument();
  });

  it("a Study opens the chat entry", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(
      await screen.findByText("Cross-modal plasticity in the brain"),
    );

    // Opening a Study lands on the chat entry (not a task table).
    expect(
      await screen.findByRole("region", { name: "Start a task" }),
    ).toBeInTheDocument();
  });

  it("a Task opens the full chat interface", async () => {
    // CMP-3 is in-review, so it opens straight into the full chat.
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    renderApp();

    await screen.findByTestId("task-surface");
    // The TabBar pill ties the task to its Study via the task code.
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

    // Jump to My Tasks through the palette.
    await user.type(input, "My Tasks");
    await user.keyboard("{Enter}");

    // My Tasks now renders the real board of assigned work.
    expect(
      await screen.findByText("Quantify tuning drift after deprivation"),
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

  it("a study row is keyboard-activatable", async () => {
    const user = userEvent.setup();
    renderApp();

    const row = await screen.findByRole("link", {
      name: /Cross-modal plasticity in the brain/i,
    });
    row.focus();
    expect(row).toHaveFocus();
    await user.keyboard("{Enter}");

    // Opening the study reveals the chat entry.
    expect(
      await screen.findByRole("region", { name: "Start a task" }),
    ).toBeInTheDocument();
  });

  it("a Task created from the Rail's New task button updates that Study's row on Studies, with no navigation", async () => {
    const user = userEvent.setup();
    renderApp();

    const CMP = "Cross-modal plasticity in the brain";
    const row = await screen.findByRole("link", { name: new RegExp(CMP) });
    const before = within(row).getByText(/^\d+\/\d+$/).textContent ?? "";
    const [doneCount, totalCount] = before.split("/").map(Number);
    const after = `${doneCount}/${totalCount + 1}`;

    // The Rail's own global button — not a screen's New task/New study
    // affordance — is the one call site this defect is about.
    await user.click(screen.getByRole("button", { name: /^New Task/ }));
    const dialog = await screen.findByRole("dialog", { name: "Create task" });

    // The Study field is the dialog's first select; pin it to CMP so the row
    // being watched is the one the created Task lands in.
    const studySelect = within(dialog).getAllByRole("combobox")[0];
    await user.selectOptions(studySelect, "s_cmp");
    await user.type(
      within(dialog).getByPlaceholderText("Task title"),
      "Confirm the Rail keeps Studies live",
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

    // Still on Studies — nothing navigated — and the row's own task count
    // moved without a manual refresh.
    const updatedRow = await screen.findByRole("link", {
      name: new RegExp(CMP),
    });
    expect(within(updatedRow).getByText(after)).toBeInTheDocument();
  });
});
