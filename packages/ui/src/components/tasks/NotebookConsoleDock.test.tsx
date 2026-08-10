import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RunningKernel } from "@lykeion/api";
import {
  CONSOLE_MAX_PX,
  CONSOLE_MIN_PX,
  NotebookConsoleDock,
} from "./NotebookConsoleDock";

function kernel(overrides: Partial<RunningKernel> = {}): RunningKernel {
  return {
    id: "kernel_1",
    runtimeId: "runtime_1",
    studyId: "study_1",
    sessionId: "session_1",
    taskId: "task_1",
    name: "main",
    language: "python",
    state: "idle",
    incarnation: 1,
    executionCount: 0,
    queueDepth: 0,
    environment: "python",
    ...overrides,
  };
}

function renderDock(overrides: Partial<React.ComponentProps<typeof NotebookConsoleDock>> = {}) {
  const props: React.ComponentProps<typeof NotebookConsoleDock> = {
    kernel: undefined,
    language: null,
    contextName: null,
    code: "",
    busy: false,
    error: null,
    onCodeChange: vi.fn(),
    onRun: vi.fn(),
    onInterrupt: vi.fn(),
    onRestart: vi.fn(),
    ...overrides,
  };
  return { ...render(<NotebookConsoleDock {...props} />), props };
}

it("does not claim a kernel when no Task kernel is confirmed", () => {
  renderDock();

  expect(screen.getByText("Nothing has run code on this Task yet.")).toBeVisible();
  expect(screen.getByLabelText("Run code on this kernel")).toBeDisabled();
  expect(screen.getByRole("button", { name: "Run" })).toBeDisabled();
  expect(screen.queryByText("shared with the agent")).not.toBeInTheDocument();
});

it("describes the selected idle kernel and its shared namespace", () => {
  renderDock({ kernel: kernel(), language: "python", contextName: "main" });

  const strip = screen.getByTestId("notebook-strip");
  expect(strip).toHaveTextContent("Python kernel");
  expect(strip).toHaveTextContent("Main agent");
  expect(strip).toHaveTextContent("shared with the agent");
  expect(strip).toHaveTextContent("idle");
  expect(screen.getByText(/Connected to the agent.s live kernel/)).toBeVisible();
});

it("switches the prompt control to Interrupt while the kernel is running", () => {
  renderDock({ kernel: kernel({ state: "running" }), language: "python", contextName: "main" });

  expect(screen.getByRole("button", { name: "Interrupt" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
});

it("keeps the destructive restart consequence in the kernel menu and closes it with Escape", async () => {
  const user = userEvent.setup();
  renderDock({ kernel: kernel(), language: "python", contextName: "main" });

  const trigger = screen.getByRole("button", { name: "Kernel actions" });
  await user.click(trigger);
  expect(screen.getByRole("menuitem", { name: /Restart/ })).toHaveTextContent(
    "clears every variable",
  );
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("resizes from the horizontal separator with keyboard steps", async () => {
  const user = userEvent.setup();
  renderDock({ kernel: kernel(), language: "python", contextName: "main" });

  const separator = screen.getByRole("separator", {
    name: "Resize researcher console",
  });
  expect(separator).toHaveAttribute("aria-orientation", "horizontal");
  expect(separator).toHaveAttribute("aria-valuenow", "128");
  separator.focus();
  await user.keyboard("{ArrowUp}");
  expect(Number(separator.getAttribute("aria-valuenow"))).toBeGreaterThan(96);
  await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
  expect(Number(separator.getAttribute("aria-valuenow"))).toBeGreaterThanOrEqual(96);
});

it("clamps pointer resizing between the console height limits", () => {
  const { container } = renderDock({ kernel: kernel(), language: "python", contextName: "main" });
  const dock = container.querySelector(".nbp-console-dock") as HTMLDivElement;
  vi.spyOn(dock, "getBoundingClientRect").mockReturnValue({
    bottom: 500,
  } as DOMRect);
  const separator = screen.getByRole("separator", {
    name: "Resize researcher console",
  });

  fireEvent.pointerDown(separator, { pointerId: 1, clientY: 0 });
  fireEvent(window, new MouseEvent("pointermove", { clientY: 0 }));
  fireEvent.pointerUp(window, { pointerId: 1, clientY: 0 });
  expect(separator).toHaveAttribute("aria-valuenow", String(CONSOLE_MAX_PX));

  fireEvent.pointerDown(separator, { pointerId: 2, clientY: 1000 });
  fireEvent(window, new MouseEvent("pointermove", { clientY: 1000 }));
  fireEvent.pointerUp(window, { pointerId: 2, clientY: 1000 });
  expect(separator).toHaveAttribute("aria-valuenow", String(CONSOLE_MIN_PX));
});

it("stops resizing when a pointer drag is cancelled", () => {
  const { container } = renderDock({ kernel: kernel(), language: "python", contextName: "main" });
  const dock = container.querySelector(".nbp-console-dock") as HTMLDivElement;
  vi.spyOn(dock, "getBoundingClientRect").mockReturnValue({
    bottom: 500,
  } as DOMRect);
  const separator = screen.getByRole("separator", {
    name: "Resize researcher console",
  });

  fireEvent.pointerDown(separator, { pointerId: 1, clientY: 372 });
  fireEvent.pointerCancel(window, { pointerId: 1 });
  fireEvent(window, new MouseEvent("pointermove", { clientY: 0 }));

  expect(separator).toHaveAttribute("aria-valuenow", "128");
});
