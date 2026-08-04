import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed, MAX_AVATAR_BYTES } from "@lykeion/api";
import { initialsOf } from "../../lib/assignee";
import App from "../../App";

afterEach(cleanup);

/** A real 1×1 PNG. jsdom cannot decode an image, so `toAvatarDataUrl` hands
 *  these bytes through unchanged — which is the path this file exercises. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

function pngFile(name = "face.png") {
  return new File([PNG], name, { type: "image/png" });
}

/** Open Settings › Workspace › Profile, where the Account section lives. */
async function openProfile(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("link", { name: /^Settings$/i }));
  await user.click(await screen.findByRole("button", { name: "Profile" }));
  return screen.findByRole("heading", { name: "Account" });
}

it("leads the Profile tab with the account, above the usage figures", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await openProfile(user);

  // Both sections are on the one tab, account first.
  const headings = screen
    .getAllByRole("heading")
    .map((h) => h.textContent)
    .filter((t) => t === "Account" || t === "Usage");
  expect(headings).toEqual(["Account", "Usage"]);
});

it("shows the reader's initials until they upload a picture", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi(emptySeed());
  const me = await api.currentUser();
  render(<App api={api} />);
  const account = await openProfile(user);
  const section = account.closest("section")!;

  // No picture yet: the circle carries initials, and the control invites one.
  expect(within(section).queryByRole("img")).toBeNull();
  expect(
    within(section).getByText(initialsOf(me.displayName)),
  ).toBeInTheDocument();
  expect(within(section).getByText("Upload a picture")).toBeInTheDocument();
});

it("uploads a picture, shows it, and persists it through the core", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi(emptySeed());
  render(<App api={api} />);
  const account = await openProfile(user);
  const section = account.closest("section")!;

  await user.upload(within(section).getByLabelText("Upload a picture"), pngFile());

  // The picture renders where the initials were…
  const face = await within(section).findByRole("img");
  expect(face.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  // …and it is really in the lab, not just in this component's state.
  expect((await api.currentUser()).avatarUrl).toBe(face.getAttribute("src"));
  // The control now offers to replace it rather than to add one.
  expect(
    await within(section).findByText("Change picture"),
  ).toBeInTheDocument();
});

it("removes a picture and falls back to the initials again", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi(emptySeed());
  render(<App api={api} />);
  const account = await openProfile(user);
  const section = account.closest("section")!;

  await user.upload(within(section).getByLabelText("Upload a picture"), pngFile());
  await within(section).findByRole("img");

  await user.click(within(section).getByRole("button", { name: "Remove" }));

  await within(section).findByText("Upload a picture");
  expect(within(section).queryByRole("img")).toBeNull();
  expect((await api.currentUser()).avatarUrl).toBeUndefined();
});

it("says why a picture the contract refuses was not saved", async () => {
  const user = userEvent.setup();
  const api = createInMemoryApi(emptySeed());
  render(<App api={api} />);
  const account = await openProfile(user);
  const section = account.closest("section")!;

  // Over the contract's cap. jsdom cannot downscale, so the oversized bytes
  // reach `setAvatar` exactly as a browser without a decoder would send them —
  // and the reader is told the size, not left with a control that did nothing.
  const huge = new File([new Uint8Array(MAX_AVATAR_BYTES)], "huge.png", {
    type: "image/png",
  });
  await user.upload(within(section).getByLabelText("Upload a picture"), huge);

  expect(await within(section).findByRole("alert")).toHaveTextContent(/KB/);
  expect(within(section).queryByRole("img")).toBeNull();
  expect((await api.currentUser()).avatarUrl).toBeUndefined();
});
