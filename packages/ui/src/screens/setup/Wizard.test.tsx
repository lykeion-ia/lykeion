import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Wizard } from "./Wizard";

afterEach(cleanup);

it("marks where you are without naming what is left", () => {
  render(
    <Wizard step={2} total={3} onContinue={() => {}}>
      body
    </Wizard>,
  );
  const dots = screen.getAllByTestId("wizard-dot");
  expect(dots).toHaveLength(3);
  expect(dots[1]).toHaveAttribute("data-on", "true");
  // Dots and not titles: the join branch swaps what step 2 *is*, and a strip
  // promising names would have lied about it.
  expect(screen.queryByText(/agents/i)).toBeNull();
});

it("offers no way back from the first step, because there is nowhere behind it", () => {
  render(
    <Wizard step={1} total={3} onContinue={() => {}}>
      body
    </Wizard>,
  );
  expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
});

it("carries a caller's own word for going on", () => {
  render(
    <Wizard step={3} total={3} onContinue={() => {}} backLabel="Skip">
      body
    </Wizard>,
  );
  expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
});

it("says Continue when a caller has no word of its own", () => {
  render(
    <Wizard step={1} total={3} onContinue={() => {}}>
      body
    </Wizard>,
  );
  expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
});

it("hands the caller its own two decisions, and nothing else", async () => {
  const onBack = vi.fn();
  const onContinue = vi.fn();
  render(
    <Wizard step={2} total={3} onBack={onBack} onContinue={onContinue}>
      body
    </Wizard>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Back" }));
  await userEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(onContinue).toHaveBeenCalledTimes(1);
});

it("still shows the step it is on when a caller offers no way forward", () => {
  // A screen can own its own forward control — the branch screen commits on a
  // card, not on a footer button — and the strip is the one thing every step
  // shares. Losing it because `onContinue` was absent would take the count
  // away from exactly the screens that introduce it.
  render(
    <Wizard step={1} total={3}>
      body
    </Wizard>,
  );
  expect(screen.getAllByTestId("wizard-dot")).toHaveLength(3);
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
});
