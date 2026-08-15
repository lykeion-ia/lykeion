import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WhereScreen } from "./WhereScreen";

afterEach(cleanup);

it("asks the one question that decides the shape of everything after", () => {
  render(<WhereScreen onChose={vi.fn()} />);
  expect(screen.getByRole("heading", { name: /where does the lab live/i })).toBeInTheDocument();
  expect(screen.getByText(/on this machine/i)).toBeInTheDocument();
  expect(screen.getByText(/somewhere else/i)).toBeInTheDocument();
});

it("carries the mark, because there is no doorway screen to carry it", () => {
  render(<WhereScreen onChose={vi.fn()} />);
  expect(screen.getByTestId("lykeion-mark")).toBeInTheDocument();
});

it("tells the daemon which topology was chosen", async () => {
  const onChose = vi.fn();
  render(<WhereScreen onChose={onChose} />);
  await userEvent.click(screen.getByText(/on this machine/i));
  await userEvent.click(screen.getByRole("button", { name: /continue/i }));
  expect(onChose).toHaveBeenCalledWith("here");
});

it("carries the other answer just as faithfully", async () => {
  const onChose = vi.fn();
  render(<WhereScreen onChose={onChose} />);
  await userEvent.click(screen.getByText(/somewhere else/i));
  await userEvent.click(screen.getByRole("button", { name: /continue/i }));
  expect(onChose).toHaveBeenCalledWith("elsewhere");
});

it("offers no way on until the question has an answer", () => {
  // The one question that decides the shape of everything after is not one to
  // answer on the researcher's behalf with a default they never chose, and a
  // Continue that did nothing would be worse than one that is not there yet.
  render(<WhereScreen onChose={vi.fn()} />);
  expect(screen.queryByRole("button", { name: /continue/i })).toBeNull();
});

it("is step 1 of 3, and offers no way back out of it", () => {
  render(<WhereScreen onChose={vi.fn()} />);
  expect(screen.getAllByTestId("wizard-dot")).toHaveLength(3);
  expect(screen.getAllByTestId("wizard-dot")[0]).toHaveAttribute("data-on", "true");
  expect(screen.queryByRole("button", { name: /back/i })).toBeNull();
});

it("shows which answer is currently chosen, so Continue is never a guess", async () => {
  render(<WhereScreen onChose={vi.fn()} />);
  const here = screen.getByRole("button", { name: /on this machine/i });
  const elsewhere = screen.getByRole("button", { name: /somewhere else/i });
  expect(here).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(here);
  expect(here).toHaveAttribute("aria-pressed", "true");
  expect(elsewhere).toHaveAttribute("aria-pressed", "false");
  await userEvent.click(elsewhere);
  expect(here).toHaveAttribute("aria-pressed", "false");
  expect(elsewhere).toHaveAttribute("aria-pressed", "true");
});
