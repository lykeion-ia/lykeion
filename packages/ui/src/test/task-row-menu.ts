import { screen } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";

type User = ReturnType<typeof userEvent.setup>;

/**
 * Drive a Task's row menu the way a researcher does.
 *
 * A Task's own actions live in the kebab on its row — in the Task surface's
 * sidebar and in the Study page's list, the same menu on both. Tests that used
 * to click a Mark Done button in the breadcrumb go through here instead; the
 * breadcrumb now names the agent rather than offering anything, and a status
 * is written from the menu's `Status` submenu.
 */
export async function openTaskRowMenu(user: User, title: string) {
  await user.click(
    await screen.findByRole("button", { name: `Task actions for ${title}` }),
  );
}

/** Open `title`'s row menu and its Status submenu, left open for the caller. */
async function openStatusSubmenu(user: User, title: string) {
  await openTaskRowMenu(user, title);
  await user.hover(await screen.findByRole("menuitem", { name: /^Status/ }));
}

/** Open `title`'s row menu and put the Task in `status`. */
export async function setTaskStatus(
  user: User,
  title: string,
  status: string,
): Promise<void> {
  await openStatusSubmenu(user, title);
  await user.click(await screen.findByRole("menuitem", { name: status }));
}

/** Open `title`'s row menu and mark the Task Done. */
export async function markTaskDone(user: User, title: string) {
  await setTaskStatus(user, title, "Done");
}

/**
 * Where `title`'s row says the Task stands — the Status entry the submenu
 * marks "Current". Opens the menu to read it and closes it again, so the
 * caller is left where it started.
 */
export async function currentTaskStatus(
  user: User,
  title: string,
): Promise<string | undefined> {
  await openStatusSubmenu(user, title);
  const current = screen
    .getAllByRole("menuitem")
    .find((el) => el.textContent?.endsWith("Current"));
  await user.keyboard("{Escape}");
  return current?.textContent?.replace(/Current$/, "");
}
