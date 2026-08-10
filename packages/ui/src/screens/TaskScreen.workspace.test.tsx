import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import App from "../App";

beforeEach(cleanup);

describe("Task notebook workspace", () => {
  it("opens, focuses, and closes the Notebook beside the conversation", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={createInMemoryApi()} />);

    await screen.findByTestId("conversation");
    expect(screen.queryByTestId("notebook-panel")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open notebook" }));
    expect(screen.getByTestId("task-workspace")).toHaveAttribute(
      "data-intent",
      "split",
    );
    expect(screen.getByTestId("conversation")).toBeInTheDocument();
    expect(await screen.findByTestId("notebook-panel")).toBeInTheDocument();
    expect(screen.getAllByTestId("notebook-panel")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Focus Notebook" }));
    expect(screen.getByTestId("task-workspace")).toHaveAttribute(
      "data-intent",
      "focus",
    );

    await user.click(screen.getByRole("button", { name: "Close Notebook" }));
    expect(screen.queryByTestId("notebook-panel")).not.toBeInTheDocument();
  });

  it("starts Conversation-only when the same focused Task remounts", async () => {
    const user = userEvent.setup();
    const route = "#/studies/s_cmp/tasks/t_3";
    window.location.hash = route;
    const api = createInMemoryApi();
    const first = render(<App api={api} />);

    await screen.findByTestId("conversation");
    await user.click(screen.getByRole("button", { name: "Open notebook" }));
    await user.click(screen.getByRole("button", { name: "Focus Notebook" }));
    expect(screen.getByTestId("task-workspace")).toHaveAttribute(
      "data-intent",
      "focus",
    );

    first.unmount();
    // RouterProvider deliberately clears the fragment it owned on unmount;
    // re-enter the same Task to model a real same-route remount.
    window.location.hash = route;
    render(<App api={api} />);

    await screen.findByTestId("conversation");
    expect(screen.getByTestId("task-workspace")).toHaveAttribute(
      "data-intent",
      "closed",
    );
    expect(screen.getByTestId("task-workspace")).toHaveAttribute(
      "data-active-surface",
      "conversation",
    );
    expect(screen.queryByTestId("notebook-panel")).not.toBeInTheDocument();
  });

  it("resets the split and console sizes after the Notebook closes and reopens", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={createInMemoryApi()} />);

    await screen.findByTestId("conversation");
    await user.click(screen.getByRole("button", { name: "Open notebook" }));

    const workspace = screen.getByTestId("task-workspace");
    const divider = screen.getByRole("separator", { name: "Resize Notebook" });
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1200,
      bottom: 800,
      width: 1200,
      height: 800,
      toJSON: () => ({}),
    });
    fireEvent.keyDown(divider, { key: "ArrowRight", shiftKey: true });
    expect(divider).toHaveAttribute("aria-valuenow", "55");

    const consoleDivider = await screen.findByRole("separator", {
      name: "Resize researcher console",
    });
    fireEvent.keyDown(consoleDivider, { key: "ArrowUp", shiftKey: true });
    expect(consoleDivider).toHaveAttribute("aria-valuenow", "192");

    await user.click(screen.getByRole("button", { name: "Close Notebook" }));
    await user.click(screen.getByRole("button", { name: "Open notebook" }));

    expect(screen.getByRole("separator", { name: "Resize Notebook" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
    expect(
      await screen.findByRole("separator", { name: "Resize researcher console" }),
    ).toHaveAttribute("aria-valuenow", "128");
  });

  it("resets to Conversation-only when navigation replaces the Task", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={createInMemoryApi()} />);

    await screen.findByTestId("conversation");
    await user.click(screen.getByRole("button", { name: "Open notebook" }));
    await user.click(screen.getByRole("button", { name: "Focus Notebook" }));
    expect(screen.getByTestId("task-workspace")).toHaveAttribute("data-intent", "focus");

    await act(async () => {
      window.location.hash = "#/studies/s_cmp/tasks/t_5";
      window.dispatchEvent(new Event("hashchange"));
    });

    await screen.findAllByText("Fit orientation tuning curves per neuron");
    expect(screen.getByTestId("task-workspace")).toHaveAttribute("data-intent", "closed");
    expect(screen.getByTestId("task-workspace")).toHaveAttribute(
      "data-active-surface",
      "conversation",
    );
    expect(screen.queryByTestId("notebook-panel")).not.toBeInTheDocument();
  });

  it("exposes sibling tabs whose active surface drives the narrow workspace intent", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={createInMemoryApi()} />);

    await screen.findByTestId("conversation");
    await user.click(screen.getByRole("button", { name: "Open notebook" }));

    // The desktop stylesheet hides these until the container is narrow; jsdom
    // cannot evaluate container queries, so assert the DOM/ARIA intent that
    // the browser's narrow rendering consumes.
    const tablist = document.querySelector<HTMLElement>(
      '[role="tablist"][aria-label="Task workspace"]',
    );
    expect(tablist).toBeInTheDocument();
    const conversationTab = within(tablist!).getByText("Conversation");
    const notebookTab = within(tablist!).getByText("Notebook");
    expect(conversationTab).toHaveAttribute("role", "tab");
    expect(notebookTab).toHaveAttribute("role", "tab");
    expect(notebookTab).toHaveAttribute("aria-selected", "true");
    expect(conversationTab).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("task-workspace")).toHaveAttribute(
      "data-active-surface",
      "notebook",
    );

    await user.click(conversationTab);
    expect(conversationTab).toHaveAttribute("aria-selected", "true");
    expect(notebookTab).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("task-workspace")).toHaveAttribute(
      "data-active-surface",
      "conversation",
    );
  });

  it("keeps Files in the inspector and uses its Notebook entry point to open the workspace", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={createInMemoryApi()} />);

    await screen.findByTestId("conversation");
    const filesToggle = screen.getByRole("button", { name: "Toggle files panel" });
    await user.click(filesToggle);
    const panel = await screen.findByTestId("artifacts-panel");
    const inspector = panel.closest(".task-rightpane");
    expect(inspector).toBeInTheDocument();
    expect(inspector?.parentElement).toHaveClass("task-columns");

    await user.click(screen.getByRole("button", { name: "Notebook" }));
    expect(screen.queryByTestId("artifacts-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("task-workspace")).toHaveAttribute(
      "data-intent",
      "split",
    );
    expect(screen.getAllByTestId("notebook-panel")).toHaveLength(1);

    await user.click(filesToggle);
    expect(await screen.findByTestId("artifacts-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("notebook-panel")).not.toBeInTheDocument();
    expect(filesToggle).toHaveFocus();
  });
});
