import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Plan, StepStatus } from "@lykeion/api";
import { RunStrip } from "./RunStrip";

afterEach(cleanup);

const plan = (statuses: StepStatus[]): Plan => ({
  steps: statuses.map((status, i) => ({
    title: `step ${i}`,
    done: status === "completed",
    status,
  })),
  raw: "",
});

it("renders 'Step N of M' from the in-progress step", () => {
  render(
    <RunStrip
      plan={plan(["completed", "in_progress", "pending", "pending", "pending"])}
      reviewing={false}
    />,
  );
  expect(screen.getByTestId("run-strip")).toHaveTextContent("Step 2 of 5");
});

it("shows the Reviewing pill and opens the notebook", async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(<RunStrip plan={null} reviewing={true} onOpenNotebook={onOpen} />);
  expect(screen.getByTestId("run-strip")).toHaveTextContent("Reviewing");
  await user.click(screen.getByRole("button", { name: /notebook/i }));
  expect(onOpen).toHaveBeenCalled();
});

it("renders nothing when there is no plan and no reviewing", () => {
  const { container } = render(
    <RunStrip plan={null} reviewing={false} onOpenNotebook={() => {}} />,
  );
  expect(container).toBeEmptyDOMElement();
});
