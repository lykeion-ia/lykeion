/**
 * The per-Task kebab menu, shared by every surface that lists Tasks: Pin ·
 * Rename · Status · Move to research · Delete. Each action is only offered when
 * its handler is supplied, so a caller that can do less still gets a coherent
 * menu rather than rows that do nothing.
 */

import type { Research } from "@lykeion/api";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskRowMenu } from "./TaskRowMenu";

function st(id: string, key: string, title: string): Research {
  return {
    id,
    key,
    title,
    createdBy: "u_you",
    createdTs: 1,
    updatedTs: 1,
  };
}

const STUDIES = [
  st("s_cmp", "CMP", "Plasticity"),
  st("s_eco", "ECO", "Foraging"),
];

beforeEach(cleanup);

/** Every handler wired, unless a test says otherwise. */
function renderMenu(props: Partial<Parameters<typeof TaskRowMenu>[0]> = {}) {
  return render(
    <TaskRowMenu
      title="Fit tuning curves"
      pinned={false}
      status="in-review"
      researches={STUDIES}
      currentResearchId="s_cmp"
      onPin={vi.fn()}
      onRename={vi.fn()}
      onMove={vi.fn()}
      onDelete={vi.fn()}
      onSetStatus={vi.fn()}
      {...props}
    />,
  );
}

const open = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(
    screen.getByRole("button", { name: "Task actions for Fit tuning curves" }),
  );

describe("TaskRowMenu", () => {
  it("offers Pin · Rename · Status · Move · Delete, in that order", async () => {
    const user = userEvent.setup();
    renderMenu();
    await open(user);

    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Pin",
      "Rename",
      "Status",
      "Move to research",
      "Delete",
    ]);
  });

  /**
   * The menu writes a status in exactly one place. A "Mark Done" row beside a
   * submenu that also holds Done asked the reader which of two identical
   * things they meant, and there is no answer to that question.
   */
  it("has one way to write a status, not a Done shortcut beside a Done entry", async () => {
    const user = userEvent.setup();
    renderMenu();
    await open(user);

    expect(screen.queryByRole("menuitem", { name: /Mark Done/ })).toBeNull();
    const beforeSubmenu = screen.getAllByRole("menuitem").length;
    await user.hover(screen.getByRole("menuitem", { name: /^Status/ }));
    expect(screen.getAllByRole("menuitem", { name: /Done/ })).toHaveLength(1);
    expect(screen.getAllByRole("menuitem").length).toBe(beforeSubmenu + 4);
  });

  it("names every status in the submenu, marks the current one, and sets the rest", async () => {
    const user = userEvent.setup();
    const onSetStatus = vi.fn();
    renderMenu({ status: "in-progress", onSetStatus });
    await open(user);
    await user.hover(screen.getByRole("menuitem", { name: /^Status/ }));

    // Where the Task already is is named rather than offered — `detail` is
    // the only mark a menu item has, and it lands in the row's name.
    expect(
      screen.getByRole("menuitem", { name: /In Progress/ }).textContent,
    ).toContain("Current");
    await user.click(screen.getByRole("menuitem", { name: "Todo" }));
    expect(onSetStatus).toHaveBeenCalledWith("todo");
  });

  it("reaches Done from the submenu whatever the Task's status", async () => {
    // Including from Done itself, which is how a Task is reopened — the
    // lifecycle is a place to move around in, not a one-way street.
    for (const status of ["todo", "in-progress", "in-review"] as const) {
      const user = userEvent.setup();
      const onSetStatus = vi.fn();
      renderMenu({ status, onSetStatus });
      await open(user);
      await user.hover(screen.getByRole("menuitem", { name: /^Status/ }));

      await user.click(screen.getByRole("menuitem", { name: "Done" }));
      expect(onSetStatus).toHaveBeenCalledWith("done");
      cleanup();
    }
  });

  it("does nothing when the status the Task is already on is chosen", async () => {
    const user = userEvent.setup();
    const onSetStatus = vi.fn();
    renderMenu({ status: "todo", onSetStatus });
    await open(user);
    await user.hover(screen.getByRole("menuitem", { name: /^Status/ }));

    await user.click(screen.getByRole("menuitem", { name: /Todo/ }));
    expect(onSetStatus).not.toHaveBeenCalled();
  });

  it("drops Status when it cannot write one", async () => {
    const user = userEvent.setup();
    renderMenu({ onSetStatus: undefined });
    await open(user);

    expect(screen.queryByRole("menuitem", { name: /^Status/ })).toBeNull();
  });

  it("offers the inverse on a Task that is already pinned", async () => {
    const user = userEvent.setup();
    const onPin = vi.fn();
    renderMenu({ pinned: true, onPin });
    await open(user);

    await user.click(screen.getByRole("menuitem", { name: "Unpin" }));
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it("lists every other Research as a destination, never the one the Task is in", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    renderMenu({ onMove });
    await open(user);
    await user.hover(screen.getByRole("menuitem", { name: /Move to research/ }));

    // "Move" to where it already is would be a no-op dressed as an action.
    expect(screen.queryByRole("menuitem", { name: /Plasticity/ })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: /Foraging/ }));
    expect(onMove).toHaveBeenCalledWith("s_eco");
  });

  it("drops Move when the lab has nowhere else to put the Task", async () => {
    // A row that opens an empty flyout is worse than no row at all.
    const user = userEvent.setup();
    renderMenu({ researches: [st("s_cmp", "CMP", "Plasticity")] });
    await open(user);

    expect(screen.queryByRole("menuitem", { name: /Move to research/ })).toBeNull();
  });

  it("shows only the actions it was given a handler for", async () => {
    const user = userEvent.setup();
    renderMenu({
      onRename: undefined,
      onMove: undefined,
      onDelete: undefined,
      onSetStatus: undefined,
    });
    await open(user);

    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Pin",
    ]);
  });

  it("renders nothing at all when it has no actions to offer", () => {
    const { container } = renderMenu({
      onPin: undefined,
      onRename: undefined,
      onMove: undefined,
      onDelete: undefined,
      onSetStatus: undefined,
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("marks Delete as destructive so it does not read like the rest", async () => {
    const user = userEvent.setup();
    renderMenu();
    await open(user);

    expect(
      screen.getByRole("menuitem", { name: "Delete" }).className,
    ).toContain("text-danger");
    expect(
      screen.getByRole("menuitem", { name: "Rename" }).className,
    ).not.toContain("text-danger");
  });
});
