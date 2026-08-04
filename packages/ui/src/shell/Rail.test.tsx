import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import { ApiProvider } from "../api/ApiContext";
import { RouterProvider } from "../router";
import { Rail } from "./Rail";

function renderRail() {
  return render(
    <ApiProvider api={createInMemoryApi(emptySeed())}>
      <RouterProvider>
        <Rail onOpenPalette={() => {}} />
      </RouterProvider>
    </ApiProvider>,
  );
}

beforeEach(cleanup);

describe("Rail", () => {
  it("renders every nav item as a link", async () => {
    renderRail();
    for (const label of [
      "Inbox",
      "My Tasks",
      "Research Groups",
      "Tasks",
      "Studies",
      "Agents",
      "Workflows",
      "Runtimes",
      "Settings",
    ]) {
      expect(
        await screen.findByRole("link", {
          name: new RegExp(`^${label}$`, "i"),
        }),
      ).toBeInTheDocument();
    }
  });

  it("opens the account menu from the workspace switcher and closes on Escape", async () => {
    const user = userEvent.setup();
    renderRail();
    await user.click(screen.getByRole("button", { name: /workspace/i }));
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
