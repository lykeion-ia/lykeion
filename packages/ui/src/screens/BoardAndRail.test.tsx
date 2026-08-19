/**
 *  - A research opens on the stage-sectioned Table (no board, no view toggle).
 *  - On a Task, the bottom-left FABs switch the left column between the app
 *    sidebar (Folders) and the task's own context rail (Document).
 * Role/text-based, so it's agnostic to the markup.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";
import { resetPageLoad } from "../lib/tabs-storage";

beforeEach(() => {
  cleanup();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  // `App` reads the stored strip once per page; this file mounts it fresh per
  // test. Adopting the incoming hash needs no reset — that is per-mount, in
  // `RouterProvider`.
  resetPageLoad();
});

async function openResearch(user: ReturnType<typeof userEvent.setup>) {
  render(<App api={createInMemoryApi()} />);
  await user.click(
    await screen.findByText("Cross-modal plasticity in the brain"),
  );
}

describe("Research chat entry", () => {
  it("opens a research on the centered chat entry, no board", async () => {
    const user = userEvent.setup();
    await openResearch(user);

    // Opening a research lands on the chat entry, not a task table.
    expect(
      await screen.findByRole("region", { name: "Start a task" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("research-board")).not.toBeInTheDocument();
  });
});

describe("Rail-switch FABs on a Task", () => {
  it("switches the left column between the app sidebar and the context rail", async () => {
    const user = userEvent.setup();
    // CMP-3 is in-review, so it opens straight into the full chat interface.
    window.location.hash = "#/researches/s_cmp/tasks/t_3";
    render(<App api={createInMemoryApi()} />);

    // Default: the task's context rail is shown; the app Rail is hidden.
    expect(await screen.findByTestId("context-rail")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /My Tasks/i }),
    ).not.toBeInTheDocument();

    // Folders FAB → reveal the app Rail, hide the context rail.
    await user.click(screen.getByRole("button", { name: /Show navigation/i }));
    expect(screen.queryByTestId("context-rail")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /My Tasks/i })).toBeInTheDocument();

    // Document FAB → back to the task's context rail.
    await user.click(
      screen.getByRole("button", { name: /Show task details/i }),
    );
    expect(screen.getByTestId("context-rail")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /My Tasks/i }),
    ).not.toBeInTheDocument();
  });
});
