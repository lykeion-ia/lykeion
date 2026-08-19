/**
 * The confirmation mechanism, tested once here so that the three dialogs
 * built on it — deleting a Research, removing a machine, deleting a Task — are
 * free to test only the thing each of them guards.
 */

import { describe, expect, it, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmModal } from "./ConfirmModal";

beforeEach(cleanup);

function renderModal(
  overrides: Partial<Parameters<typeof ConfirmModal>[0]> = {},
) {
  const props = {
    label: "Delete thing",
    heading: "Delete thing?",
    subject: <p>The thing</p>,
    body: <p>It does not come back.</p>,
    confirmLabel: "Delete",
    onClose: vi.fn(),
    onConfirm: vi.fn(async () => {}),
    ...overrides,
  };
  render(<ConfirmModal {...props} />);
  return props;
}

describe("ConfirmModal", () => {
  it("names itself from the caller, so each action is distinguishable", () => {
    renderModal({ label: "Remove machine" });
    expect(
      screen.getByRole("dialog", { name: "Remove machine" }),
    ).toBeInTheDocument();
  });

  it("closes on Escape without acting", async () => {
    const user = userEvent.setup();
    const { onClose, onConfirm } = renderModal();

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("closes on a click outside without acting", async () => {
    const user = userEvent.setup();
    const { onClose, onConfirm } = renderModal();

    // The overlay, not the dialog: clicking the dialog itself must not close.
    await user.click(screen.getByRole("dialog").parentElement!);

    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("acts once, however many times the button is pressed", async () => {
    const user = userEvent.setup();
    // A confirmation that never settles, so the second click lands while the
    // first is still in flight — which is exactly when a double-press does
    // damage on an action that cannot be taken back.
    const onConfirm = vi.fn(() => new Promise<void>(() => {}));
    renderModal({ onConfirm });

    const confirm = screen.getByRole("button", { name: "Delete" });
    await user.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("stays open and says why when the action is refused", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(async () => {
      throw new Error("that Task is already gone");
    });
    const { onClose } = renderModal({ onConfirm });

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("that Task is already gone")).toBeInTheDocument();
    // Closing here would report an action the core refused as done.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // And it can be tried again: the button is live, not stuck disabled.
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });
});
