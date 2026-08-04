/**
 * The Settings modal — opened by the Task sidebar's "Customize" so
 * capabilities can be adjusted without leaving the conversation. It renders
 * the same SettingsSurface as the #/settings screen.
 */

import type { Study } from "@lykeion/api";
import { createInMemoryApi } from "@lykeion/api";
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiProvider } from "../../api/ApiContext";
import { RouterProvider } from "../../router";
import { TaskSidebar } from "../tasks/TaskSidebar";

const study: Study = {
  id: "s_1",
  key: "CMP",
  title: "Plasticity",
  createdBy: "u_you",
  createdTs: 1,
  updatedTs: 1,
};

beforeEach(cleanup);

function renderSidebar() {
  return render(
    <ApiProvider api={createInMemoryApi()}>
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

/** Click Customize and wait for the dialog. */
async function openModal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Customize" }));
  return screen.findByRole("dialog", { name: "Settings" });
}

describe("Settings modal", () => {
  it("opens from Customize with the settings nav and General tab", async () => {
    const user = userEvent.setup();
    renderSidebar();
    expect(screen.queryByRole("dialog")).toBeNull();

    const dialog = await openModal(user);
    expect(within(dialog).getByText("Capabilities")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Credentials" }),
    ).toBeInTheDocument();
    // General is the default tab.
    expect(
      await within(dialog).findByRole("heading", { name: "Model" }),
    ).toBeInTheDocument();
  });

  it("switches to the Skills tab inside the modal", async () => {
    const user = userEvent.setup();
    renderSidebar();
    const dialog = await openModal(user);

    await user.click(within(dialog).getByRole("button", { name: "Skills" }));
    // The panel renders intact — its own CTA and a seeded row.
    expect(
      await within(dialog).findByRole("button", { name: /Add skill/i }),
    ).toBeInTheDocument();
    expect(await within(dialog).findByText("rnaseq")).toBeInTheDocument();
  });

  it("closes on Escape, on the close button, and on a backdrop click", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await openModal(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    const dialog = await openModal(user);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await openModal(user);
    // The backdrop is the dialog's parent; clicking the dialog itself must not
    // close it (stopPropagation), clicking outside it must.
    await user.click(screen.getByRole("heading", { name: "Settings" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(document.querySelector(".fixed.inset-0")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
