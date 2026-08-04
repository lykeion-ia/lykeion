import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toggle } from "./Toggle";

afterEach(cleanup);

it("is a switch; controlled mode reflects `on` and calls onToggle", async () => {
  const user = userEvent.setup();
  const onToggle = vi.fn();
  render(<Toggle on onToggle={onToggle} ariaLabel="Disable rnaseq" />);
  const sw = screen.getByRole("switch", { name: "Disable rnaseq" });
  expect(sw).toBeChecked();
  await user.click(sw);
  expect(onToggle).toHaveBeenCalledWith(false);
});

it("uncontrolled mode flips its own state", async () => {
  const user = userEvent.setup();
  render(<Toggle on={false} />);
  const sw = screen.getByRole("switch");
  expect(sw).not.toBeChecked();
  await user.click(sw);
  expect(sw).toBeChecked();
});
