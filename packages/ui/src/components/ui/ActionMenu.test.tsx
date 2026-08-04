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
