import { afterEach, expect, it } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed, type LykeionApi } from "@lykeion/api";
import App from "../App";

afterEach(cleanup);

// An in-memory API with a specific signed-in identity (a test double, not
// shipped mock data). This drives the menu's real `currentUser()` wiring.
function apiWithUser(): LykeionApi {
  const api = createInMemoryApi(emptySeed());
  return {
    ...api,
    currentUser: async () => ({
      id: "u_ada",
      email: "ada@lab.test",
      displayName: "Ada",
      createdTs: 0,
    }),
  };
}

it("opens the account menu populated from currentUser()", async () => {
  const user = userEvent.setup();
  render(<App api={apiWithUser()} />);
  await user.click(await screen.findByRole("button", { name: /Workspace/i }));

  const menu = await screen.findByRole("menu");
  expect(await within(menu).findByText("Ada")).toBeInTheDocument();
  expect(within(menu).getByText("ada@lab.test")).toBeInTheDocument();
  expect(within(menu).getByText("Lykeion")).toBeInTheDocument();
});

it("shows the seeded owner identity on a fresh core", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await user.click(await screen.findByRole("button", { name: /Workspace/i }));

  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText("You")).toBeInTheDocument();
  expect(within(menu).getByText("you@lab.example")).toBeInTheDocument();
});

it("account menu Settings navigates to the settings screen", async () => {
  const user = userEvent.setup();
  render(<App api={createInMemoryApi(emptySeed())} />);
  await user.click(await screen.findByRole("button", { name: /Workspace/i }));
  await user.click(await screen.findByRole("menuitem", { name: /Settings/i }));

  expect(await screen.findByText("Capabilities")).toBeInTheDocument();
});
