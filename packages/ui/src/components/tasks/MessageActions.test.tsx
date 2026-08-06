import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UserBubble } from "./TaskTranscript";

afterEach(cleanup);

function writeText() {
  const write = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText: write } });
  return write;
}

it("offers Copy on every prompt, with nothing to confirm", async () => {
  const write = writeText();
  render(<UserBubble prompt="count the reads" />);
  await userEvent.click(screen.getByRole("button", { name: /copy/i }));
  expect(write).toHaveBeenCalledWith("count the reads");
  expect(screen.queryByTestId("turn-confirm")).toBeNull();
});

it("offers neither Edit nor Revert on a turn that is not the newest", () => {
  render(<UserBubble prompt="count the reads" />);
  expect(screen.queryByRole("button", { name: /^edit$/i })).toBeNull();
  expect(screen.queryByRole("button", { name: /^revert$/i })).toBeNull();
});

it("names what a revert loses before it does anything", async () => {
  const onRevert = vi.fn(async () => {});
  render(<UserBubble prompt="count the reads" revert={{ available: true, onRevert }} />);

  await userEvent.click(screen.getByRole("button", { name: /^revert$/i }));
  const confirm = screen.getByTestId("turn-confirm");
  expect(confirm.textContent).toMatch(/files/i);
  expect(confirm.textContent).toMatch(/no memory|fresh conversation/i);
  expect(confirm.textContent).toMatch(/granted/i);
  expect(onRevert).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: /discard the turn/i }));
  expect(onRevert).toHaveBeenCalledTimes(1);
});

it("lets a confirmation be dismissed without doing anything", async () => {
  const onRevert = vi.fn(async () => {});
  render(<UserBubble prompt="count the reads" revert={{ available: true, onRevert }} />);
  await userEvent.click(screen.getByRole("button", { name: /^revert$/i }));
  await userEvent.click(screen.getByRole("button", { name: /keep it/i }));
  expect(screen.queryByTestId("turn-confirm")).toBeNull();
  expect(onRevert).not.toHaveBeenCalled();
});

it("hands the corrected text back only once the edit is confirmed", async () => {
  const onEdit = vi.fn(async () => {});
  render(<UserBubble prompt="count the reads" revert={{ available: true, onEdit }} />);

  await userEvent.click(screen.getByRole("button", { name: /^edit$/i }));
  const box = screen.getByRole("textbox");
  await userEvent.clear(box);
  await userEvent.type(box, "count the writes");
  expect(onEdit).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: /discard and resend/i }));
  expect(onEdit).toHaveBeenCalledWith("count the writes");
});

it("disables Revert when there is nothing to restore, and names the reason", async () => {
  const onRevert = vi.fn(async () => {});
  render(
    <UserBubble
      prompt="count the reads"
      revert={{ available: false, reason: "this volume cannot clone", onRevert }}
    />,
  );
  const revert = screen.getByRole("button", { name: /^revert$/i });
  expect(revert).toBeDisabled();
  expect(revert).toHaveAttribute("title", expect.stringContaining("cannot clone"));
  expect(screen.getByRole("button", { name: /^edit$/i })).toBeDisabled();
});

it("shows what went wrong when a revert is refused, and keeps the turn", async () => {
  const onRevert = vi.fn(async () => {
    throw new Error("the snapshot could not be read back");
  });
  render(<UserBubble prompt="count the reads" revert={{ available: true, onRevert }} />);
  await userEvent.click(screen.getByRole("button", { name: /^revert$/i }));
  await userEvent.click(screen.getByRole("button", { name: /discard the turn/i }));
  expect(await screen.findByRole("alert")).toHaveTextContent(/could not be read back/);
});
