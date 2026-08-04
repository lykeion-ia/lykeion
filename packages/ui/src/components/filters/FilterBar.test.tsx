import { afterEach, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EMPTY_FILTERS, type FilterDimension } from "../../lib/task-filters";
import { FilterBar } from "./FilterBar";
import { TargetIcon } from "../icons";

afterEach(cleanup);

const dimensions: FilterDimension[] = [
  {
    key: "status",
    label: "Status",
    icon: TargetIcon,
    kind: "select",
    options: [
      { id: "todo", label: "Todo", count: 2, swatch: "bg-fg-tertiary" },
      { id: "done", label: "Done", count: 1, swatch: "bg-success" },
    ],
  },
];

it("opens, drills into a dimension, and toggles an option", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <FilterBar
      dimensions={dimensions}
      state={EMPTY_FILTERS}
      onChange={onChange}
    />,
  );

  await user.click(screen.getByRole("button", { name: /Filter/i }));
  await user.click(screen.getByRole("button", { name: /Status/i }));
  await user.click(screen.getByRole("button", { name: /Todo/i }));

  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ values: { status: ["todo"] } }),
  );
});
