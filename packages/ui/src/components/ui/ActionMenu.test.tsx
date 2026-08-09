import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActionMenu } from "./ActionMenu";
import { PlusIcon, TrashIcon } from "../icons";

afterEach(cleanup);

it("opens on the trigger, fires onSelect, and closes", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(
    <ActionMenu
      items={[{ id: "a", icon: PlusIcon, label: "Add thing", onSelect }]}
    >
      {({ toggle }) => (
        <button type="button" onClick={toggle}>
          Open
        </button>
      )}
    </ActionMenu>,
  );
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.click(screen.getByRole("menuitem", { name: /Add thing/i }));
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("marks a destructive item so it does not read like the rest", async () => {
  // An irreversible action sitting in the same grey as "Edit" is a mis-click
  // waiting to happen, so the flag has to reach the rendered item.
  const user = userEvent.setup();
  render(
    <ActionMenu
      items={[
        { id: "edit", icon: PlusIcon, label: "Edit thing" },
        { id: "del", icon: TrashIcon, label: "Delete thing", danger: true },
      ]}
    >
      {({ toggle }) => (
        <button type="button" onClick={toggle}>
          Open
        </button>
      )}
    </ActionMenu>,
  );
  await user.click(screen.getByRole("button", { name: "Open" }));

  const destructive = screen.getByRole("menuitem", { name: /Delete thing/i });
  const ordinary = screen.getByRole("menuitem", { name: /Edit thing/i });
  expect(destructive.className).toContain("text-danger");
  expect(ordinary.className).not.toContain("text-danger");
});

/** A menu whose one row owns a second level. */
function renderWithSubmenu(onSelect: () => void) {
  return render(
    <ActionMenu
      align="end"
      items={[
        {
          id: "move",
          icon: PlusIcon,
          label: "Move to study",
          submenu: [{ id: "s1", icon: PlusIcon, label: "Plasticity", onSelect }],
        },
      ]}
    >
      {({ toggle }) => (
        <button type="button" onClick={toggle}>
          Open
        </button>
      )}
    </ActionMenu>,
  );
}

it("opens a submenu on hover and fires its nested item, closing both levels", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  renderWithSubmenu(onSelect);
  await user.click(screen.getByRole("button", { name: "Open" }));

  // The row announces the second level and keeps it shut until asked, so a
  // reader scanning the menu is not handed a list they did not open.
  const parent = screen.getByRole("menuitem", { name: /Move to study/ });
  expect(parent).toHaveAttribute("aria-haspopup", "menu");
  expect(parent).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("menuitem", { name: /Plasticity/ })).toBeNull();

  await user.hover(parent);
  expect(parent).toHaveAttribute("aria-expanded", "true");

  await user.click(screen.getByRole("menuitem", { name: /Plasticity/ }));
  expect(onSelect).toHaveBeenCalledTimes(1);
  // Choosing a destination finishes the errand: the whole menu goes.
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
});

it("opens a submenu from the keyboard, so the flyout is not hover-only", async () => {
  // A second level reachable only by pointer is one a keyboard cannot use,
  // and these menus hang off rows the list navigates with the arrow keys.
  const user = userEvent.setup();
  const onSelect = vi.fn();
  renderWithSubmenu(onSelect);
  await user.click(screen.getByRole("button", { name: "Open" }));

  screen.getByRole("menuitem", { name: /Move to study/ }).focus();
  await user.keyboard("{ArrowRight}");

  // Focus follows the flyout open — otherwise the next key would go to the
  // row behind it.
  const nested = screen.getByRole("menuitem", { name: /Plasticity/ });
  expect(nested).toHaveFocus();

  await user.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledTimes(1);
});

it("opens an end-aligned menu's submenu to the right", async () => {
  const user = userEvent.setup();
  renderWithSubmenu(vi.fn());
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.hover(screen.getByRole("menuitem", { name: /Move to study/ }));

  // `align` anchors the first panel to its trigger; it does not reverse the
  // flyout, which opens rightward until the viewport's right edge runs out.
  const [, submenu] = screen.getAllByRole("menu");
  expect(submenu).toHaveAttribute("data-side", "right");
});

it("floats its panels free of the pane they open in", async () => {
  // These menus hang off rows inside scrolling panes, and a scroll container
  // clips on BOTH axes — an absolutely positioned panel wider than its pane
  // lost its leading edge, icons and all, and a flyout opening past the pane
  // was shaved to a sliver. Fixed panels answer to the viewport instead, so
  // no ancestor's overflow can reach them.
  const user = userEvent.setup();
  renderWithSubmenu(vi.fn());
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.hover(screen.getByRole("menuitem", { name: /Move to study/ }));

  for (const panel of screen.getAllByRole("menu"))
    expect(panel.className).toContain("fixed");
});

it("portals its panels out of the trigger's tree", async () => {
  // `fixed` only answers to the viewport while no ancestor is a containing
  // block, and one `-translate-y-1/2` on any wrapper quietly makes one. Out of
  // the tree, nothing upstream can move the panel.
  const user = userEvent.setup();
  const { container } = renderWithSubmenu(vi.fn());
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.hover(screen.getByRole("menuitem", { name: /Move to study/ }));

  for (const panel of screen.getAllByRole("menu")) {
    expect(container).not.toContainElement(panel);
    expect(panel.parentElement).toBe(document.body);
  }
});

it("selects through a portaled panel instead of dismissing itself", async () => {
  // The outside-click check runs on mousedown and the selection on click. Once
  // the panel is out of the tree, containment calls every press inside it an
  // outside one — so the press would tear the menu down before its own click
  // landed, and every selection would be swallowed.
  const user = userEvent.setup();
  const onSelect = vi.fn();
  renderWithSubmenu(onSelect);
  await user.click(screen.getByRole("button", { name: "Open" }));
  await user.hover(screen.getByRole("menuitem", { name: /Move to study/ }));
  await user.click(screen.getByRole("menuitem", { name: /Plasticity/ }));

  expect(onSelect).toHaveBeenCalledTimes(1);
});

it("leaves focus on the trigger, which is what keeps a hover-only one visible", async () => {
  // Rows hide their kebab until hovered and hold it open with `:focus-within`
  // (see `.tsb-task-actions`). That reads the trigger's own focus, not the
  // panel's — so it survives the portal only while opening does not move focus
  // into the menu.
  const user = userEvent.setup();
  render(
    <ActionMenu items={[{ id: "a", icon: PlusIcon, label: "Add thing" }]}>
      {({ toggle }) => (
        <button type="button" onClick={toggle}>
          Open
        </button>
      )}
    </ActionMenu>,
  );
  const trigger = screen.getByRole("button", { name: "Open" });
  await user.click(trigger);

  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
