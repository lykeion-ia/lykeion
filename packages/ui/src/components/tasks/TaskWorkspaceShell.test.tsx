import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { TaskWorkspaceShell, useTaskWorkspace } from "./TaskWorkspaceShell";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Harness({ resetKey = "task-1" }: { resetKey?: string }) {
  const workspace = useTaskWorkspace(resetKey);
  return (
    <>
      <button onClick={workspace.openNotebook}>Open notebook</button>
      <TaskWorkspaceShell
        controller={workspace}
        conversation={
          <section aria-label="Conversation">Conversation body</section>
        }
        notebook={
          <section aria-label="Notebook content">Notebook body</section>
        }
      />
    </>
  );
}

function pointerEvent(type: string, pointerId: number, clientX: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

it("moves between the closed, split, and focused workspace presentations", async () => {
  const user = userEvent.setup();
  render(<Harness />);

  const workspace = screen.getByTestId("task-workspace");
  expect(workspace).toHaveAttribute("data-intent", "closed");
  expect(screen.getByLabelText("Conversation")).toBeInTheDocument();
  expect(screen.queryByLabelText("Notebook content")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Open notebook" }));
  expect(workspace).toHaveAttribute("data-intent", "split");
  expect(screen.getByLabelText("Notebook content")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Focus Notebook" }));
  expect(workspace).toHaveAttribute("data-intent", "focus");

  await user.click(screen.getByRole("button", { name: "Return to split" }));
  expect(workspace).toHaveAttribute("data-intent", "split");

  await user.click(screen.getByRole("button", { name: "Close Notebook" }));
  expect(workspace).toHaveAttribute("data-intent", "closed");
  expect(screen.queryByLabelText("Notebook content")).not.toBeInTheDocument();
});

it("switches the active surface through the workspace tabs", async () => {
  const user = userEvent.setup();
  render(<Harness />);

  await user.click(screen.getByRole("button", { name: "Open notebook" }));
  const workspace = screen.getByTestId("task-workspace");
  expect(workspace).toHaveAttribute("data-active-surface", "notebook");

  await user.click(screen.getByRole("button", { name: "Focus Notebook" }));

  await user.click(screen.getByRole("tab", { name: "Conversation" }));
  expect(workspace).toHaveAttribute("data-active-surface", "conversation");

  await user.click(screen.getByRole("tab", { name: "Notebook" }));
  expect(workspace).toHaveAttribute("data-active-surface", "notebook");
});

it("resets a transient workspace when its Task changes", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Harness />);

  await user.click(screen.getByRole("button", { name: "Open notebook" }));
  expect(screen.getByTestId("task-workspace")).toHaveAttribute(
    "data-intent",
    "split",
  );

  rerender(<Harness resetKey="task-2" />);

  await waitFor(() =>
    expect(screen.getByTestId("task-workspace")).toHaveAttribute(
      "data-intent",
      "closed",
    ),
  );
  expect(screen.queryByLabelText("Notebook content")).not.toBeInTheDocument();
});

it("moves focus into the Notebook and restores the opener when it closes", async () => {
  const user = userEvent.setup();
  render(<Harness />);

  const opener = screen.getByRole("button", { name: "Open notebook" });
  await user.click(opener);

  expect(screen.getByRole("heading", { name: "Notebook" })).toHaveFocus();

  await user.click(screen.getByRole("button", { name: "Close Notebook" }));
  await waitFor(() => expect(opener).toHaveFocus());
});

it("resizes the split with accessible keyboard increments", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const workspace = screen.getByTestId("task-workspace");
  workspace.getBoundingClientRect = () => new DOMRect(0, 0, 1200, 800);

  await user.click(screen.getByRole("button", { name: "Open notebook" }));
  const separator = screen.getByRole("separator", { name: "Resize Notebook" });

  expect(separator).toHaveAttribute("aria-orientation", "vertical");
  expect(separator).toHaveAttribute("aria-valuenow", "50");
  separator.focus();
  await user.keyboard("{ArrowLeft}");
  expect(separator).toHaveAttribute("aria-valuenow", "49");
  await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
  expect(Number(separator.getAttribute("aria-valuenow"))).toBeGreaterThan(49);
});

it("captures pointer resizing and keeps both panes above their minimum widths", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const workspace = screen.getByTestId("task-workspace");
  workspace.getBoundingClientRect = () => new DOMRect(0, 0, 1200, 800);

  await user.click(screen.getByRole("button", { name: "Open notebook" }));
  const separator = screen.getByRole("separator", { name: "Resize Notebook" });
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.assign(separator, { setPointerCapture, releasePointerCapture });

  fireEvent(separator, pointerEvent("pointerdown", 7, 600));
  expect(setPointerCapture).toHaveBeenCalledWith(7);

  fireEvent(separator, pointerEvent("pointermove", 7, -100));
  const layout = workspace.querySelector<HTMLElement>(".task-workspace-layout");
  const leftValue = layout?.style.getPropertyValue("--task-conversation-width") ?? "";
  const leftRatio = Number.parseFloat(leftValue.slice("calc(".length)) / 100;
  expect(leftRatio * 1194).toBeGreaterThanOrEqual(419.999);

  fireEvent(separator, pointerEvent("pointermove", 7, 2000));
  const rightValue = layout?.style.getPropertyValue("--task-conversation-width") ?? "";
  const rightRatio = Number.parseFloat(rightValue.slice("calc(".length)) / 100;
  expect((1 - rightRatio) * 1194).toBeGreaterThanOrEqual(479.999);

  fireEvent(separator, pointerEvent("pointerup", 7, 2000));
  expect(releasePointerCapture).toHaveBeenCalledWith(7);
});

it("reclamps a narrower wide split and enforces both rendered track minimums", async () => {
  let resizeCallback: ResizeObserverCallback | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );

  const user = userEvent.setup();
  render(<Harness />);
  const workspace = screen.getByTestId("task-workspace");
  let workspaceWidth = 1200;
  workspace.getBoundingClientRect = () =>
    new DOMRect(0, 0, workspaceWidth, 800);

  await user.click(screen.getByRole("button", { name: "Open notebook" }));
  const separator = screen.getByRole("separator", { name: "Resize Notebook" });
  Object.assign(separator, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
  fireEvent(separator, pointerEvent("pointerdown", 11, 600));
  fireEvent(separator, pointerEvent("pointermove", 11, 2000));
  fireEvent(separator, pointerEvent("pointerup", 11, 2000));

  workspaceWidth = 920;
  act(() => {
    resizeCallback?.(
      [
        {
          target: workspace,
          contentRect: new DOMRect(0, 0, workspaceWidth, 800),
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      {} as ResizeObserver,
    );
  });

  const layout = workspace.querySelector<HTMLElement>(".task-workspace-layout");
  expect(separator).toHaveAttribute("aria-valuenow", "47");
  expect(getComputedStyle(layout!).gridTemplateColumns).toContain(
    "minmax(420px",
  );
  expect(getComputedStyle(layout!).gridTemplateColumns).toContain(
    "minmax(480px",
  );
});
