/**
 * The app Rail and the Task's left-side pane swap in the same slot around the
 * WorkspaceSwitcher, so their rows must land on the same baseline — otherwise
 * toggling the pane makes the list jump.
 *
 * They used to be two hand-matched definitions (Tailwind in `Rail.tsx`, CSS in
 * `task.css`) that had drifted: 34px rows against the Rail's 31.5px, plus a
 * 36px header, so every row below the switcher was progressively lower. These
 * tests pin the two panes to the ONE shared definition in `rail-chrome.tsx`.
 */

import type { Study } from "@lykeion/api";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ApiProvider } from "../api/ApiContext";
import { RouterProvider } from "../router";
import { Rail } from "./Rail";
import { TaskSidebar } from "../components/tasks/TaskSidebar";
import { railRowClass } from "./rail-chrome";

const study: Study = {
  id: "s_1",
  key: "CMP",
  title: "Plasticity",
  createdBy: "u_you",
  createdTs: 1,
  updatedTs: 1,
};

beforeEach(cleanup);

function renderRail() {
  return render(
    <ApiProvider api={createInMemoryApi(emptySeed())}>
      <RouterProvider>
        <Rail onOpenPalette={() => {}} />
      </RouterProvider>
    </ApiProvider>,
  );
}

function renderSidebar() {
  return render(
    <ApiProvider api={createInMemoryApi(emptySeed())}>
      <RouterProvider>
        <TaskSidebar
          study={study}
          filesActive={false}
          onNew={() => {}}
          onOpenFiles={() => {}}
          tasks={[]}
        />
      </RouterProvider>
    </ApiProvider>,
  );
}

/** The box classes that decide where a row sits and how tall it is. */
const boxOf = (el: Element) =>
  [...el.classList]
    .filter((c) => /^(h-|py-|px-|mx-|gap-|flex$)/.test(c))
    .sort();

const sharedBox = railRowClass
  .split(" ")
  .filter((c) => /^(h-|py-|px-|mx-|gap-|flex$)/.test(c))
  .sort();

describe("rail chrome shared by both panes", () => {
  it("gives the Rail's nav rows the shared row box", async () => {
    renderRail();
    const row = await screen.findByRole("link", { name: /^Inbox$/i });
    expect(boxOf(row)).toEqual(sharedBox);
  });

  it("gives the Task pane's menu rows the same box, not its own", async () => {
    renderSidebar();
    await screen.findByRole("button", { name: "New" });
    for (const label of ["New", "Customize", "Files"]) {
      const row = screen.getByRole("button", { name: label });
      expect(boxOf(row)).toEqual(sharedBox);
    }
  });

  it("heads both panes with the same workspace switcher", async () => {
    const rail = renderRail();
    await screen.findByRole("button", { name: "Workspace" });
    const railSwitcher = rail.container.querySelector(
      '[aria-label="Workspace"]',
    )!;
    cleanup();

    const sidebar = renderSidebar();
    await screen.findByRole("button", { name: "Workspace" });
    const paneSwitcher = sidebar.container.querySelector(
      '[aria-label="Workspace"]',
    )!;

    // Same anchor markup in both, so it stays put across the swap.
    expect(paneSwitcher.className).toBe(railSwitcher.className);
    expect(paneSwitcher.outerHTML).toBe(railSwitcher.outerHTML);
  });

  it("uses the same group label in both panes", async () => {
    renderRail();
    const railLabel = (await screen.findByText("Laboratory")).className;
    cleanup();

    renderSidebar();
    const paneLabel = (await screen.findByText("Tasks")).className;
    expect(paneLabel).toBe(railLabel);
  });
});
