import { describe, expect, it } from "vitest";
import { TASK_STATUS_LABELS, type TaskStatus } from "@lykeion/api";
import { STATUS_COLOR_VAR, statusColor } from "./status";

describe("status color mapping", () => {
  it("covers every task status with a distinct CSS variable", () => {
    const statuses = Object.keys(TASK_STATUS_LABELS) as TaskStatus[];
    const vars = statuses.map((s) => STATUS_COLOR_VAR[s]);
    expect(vars).toHaveLength(4);
    expect(new Set(vars).size).toBe(4);
    for (const v of vars) expect(v).toMatch(/^--status-/);
  });

  it("wraps the variable in var() for inline SVG use", () => {
    expect(statusColor("in-review")).toBe("var(--status-review)");
  });
});
