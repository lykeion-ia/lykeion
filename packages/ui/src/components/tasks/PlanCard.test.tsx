import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Plan } from "@lykeion/api";
import { PlanCard } from "./PlanCard";

// The exact plan the in-memory API scripts (`packages/api/src/memory.ts`), kept
// identical here so the extraction is proven behaviour-preserving rather than
// tested against an invented fixture — see `TaskScreen.tool-step.test.tsx`
// / `TaskRun.test.tsx`, which drove this same plan through the full screen.
const PLAN: Plan = {
  steps: [
    { title: "Load the dataset", done: false },
    { title: "Write results", done: false },
  ],
  raw: "1. Load the dataset\n2. Write results/out.csv",
};

describe("PlanCard", () => {
  it("renders every step's title", () => {
    render(
      <PlanCard
        plan={PLAN}
        pending={false}
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );
    expect(screen.getByText("Load the dataset")).toBeInTheDocument();
    expect(screen.getByText("Write results")).toBeInTheDocument();
  });

  it("renders Approve and Reject only while pending, and wires them up", async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <PlanCard
        plan={PLAN}
        pending
        onApprove={onApprove}
        onReject={onReject}
      />,
    );

    const approve = screen.getByRole("button", { name: "Approve" });
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();

    await user.click(approve);
    expect(onApprove).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("renders no Approve/Reject once the plan is no longer pending", () => {
    render(
      <PlanCard
        plan={PLAN}
        pending={false}
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("marks a done step with its checkmark", () => {
    const halfDone: Plan = {
      steps: [
        { title: "Load the dataset", done: true },
        { title: "Write results", done: false },
      ],
    };
    render(
      <PlanCard
        plan={halfDone}
        pending
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );
    const item = screen.getByText("Load the dataset").closest("li");
    expect(item).toHaveClass("is-done");
  });
});
