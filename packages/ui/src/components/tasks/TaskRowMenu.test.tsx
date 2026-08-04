/**
 * The per-Task kebab menu, shared by every surface that lists Tasks: Pin ·
 * Rename · Move to study · Delete. Each action is only offered when its
 * handler is supplied, so a caller that can do less still gets a coherent
 * menu rather than rows that do nothing.
 */

import type { Study } from "@lykeion/api";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskRowMenu } from "./TaskRowMenu";

function st(id: string, key: string, title: string): Study {
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
      studies={STUDIES}
      currentStudyId="s_cmp"
      onPin={vi.fn()}
      onRename={vi.fn()}
      onMove={vi.fn()}
      onDelete={vi.fn()}
      {...props}
    />,
  );
}

const open = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(
    screen.getByRole("button", { name: "Task actions for Fit tuning curves" }),
  );

describe("TaskRowMenu", () => {
  it("offers Pin · Rename · Move · Delete, in that order", async () => {
    const user = userEvent.setup();
    renderMenu();
    await open(user);

    expect(screen.getAllByRole("menuitem").map((el) => el.textContent)).toEqual([
      "Pin",
      "Rename",
      "Move to study",
      "Delete",
    ]);
  });

  it("offers the inverse on a Task that is already pinned", async () => {
    const user = userEvent.setup();
    const onPin = vi.fn();
    renderMenu({ pinned: true, onPin });
    await open(user);

    await user.click(screen.getByRole("menuitem", { name: "Unpin" }));
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it("lists every other Study as a destination, never the one the Task is in", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    renderMenu({ onMove });
    await open(user);
    await user.hover(screen.getByRole("menuitem", { name: /Move to study/ }));

    // "Move" to where it already is would be a no-op dressed as an action.
    expect(screen.queryByRole("menuitem", { name: /Plasticity/ })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: /Foraging/ }));
    expect(onMove).toHaveBeenCalledWith("s_eco");
  });

  it("drops Move when the lab has nowhere else to put the Task", async () => {
    // A row that opens an empty flyout is worse than no row at all.
    const user = userEvent.setup();
    renderMenu({ studies: [st("s_cmp", "CMP", "Plasticity")] });
    await open(user);

    expect(screen.queryByRole("menuitem", { name: /Move to study/ })).toBeNull();
  });

  it("shows only the actions it was given a handler for", async () => {
    const user = userEvent.setup();
    renderMenu({ onRename: undefined, onMove: undefined, onDelete: undefined });
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
