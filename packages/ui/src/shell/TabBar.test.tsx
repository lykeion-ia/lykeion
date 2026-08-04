import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { createInMemoryApi, emptySeed } from "@lykeion/api";
import { ApiProvider } from "../api/ApiContext";
import { RouterProvider } from "../router";
import { TabBar } from "./TabBar";

function renderTabBar() {
  return render(
    <ApiProvider api={createInMemoryApi(emptySeed())}>
      <RouterProvider>
        <TabBar />
      </RouterProvider>
    </ApiProvider>,
  );
}

beforeEach(cleanup);

describe("TabBar", () => {
  it("renders history controls, the active-view pill, and the add button", async () => {
    renderTabBar();
    expect(screen.getByRole("button", { name: /back/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /forward/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /open menu/i }),
    ).toBeInTheDocument();
    // Default route is Studies → the pill shows the Studies label.
    expect(await screen.findByText("Studies")).toBeInTheDocument();
  });

  it("the add button dispatches the palette shortcut", async () => {
    renderTabBar();
    const addButton = await screen.findByRole("button", {
      name: /open menu/i,
    });
    let fired = false;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") fired = true;
    };
    window.addEventListener("keydown", onKey);
    addButton.click();
    window.removeEventListener("keydown", onKey);
    expect(fired).toBe(true);
  });
});
