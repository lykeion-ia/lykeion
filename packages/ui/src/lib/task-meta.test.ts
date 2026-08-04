import { describe, expect, it } from "vitest";
import {
  TASK_STATUS_META,
  STATUS_ORDER,
  STAGE_META,
  PRIORITY_META,
  LABELS,
  formatTargetDate,
  formatAgo,
} from "./task-meta";

describe("task-meta", () => {
  it("maps every Lykeion status; no 'failed'", () => {
    expect(STATUS_ORDER).toEqual(["todo", "in-progress", "in-review", "done"]);
    expect(TASK_STATUS_META["in-review"].label).toBe("In Review");
    expect(TASK_STATUS_META.done.dotClass).toBe("bg-success");
    expect(TASK_STATUS_META).not.toHaveProperty("failed");
  });

  it("labels the six real stages", () => {
    expect(STAGE_META.background.label).toBe("Background");
    expect(STAGE_META["future-directions"].label).toBe("Future directions");
  });

  it("orders priority high→none", () => {
    expect(PRIORITY_META.urgent.rank).toBeGreaterThan(PRIORITY_META.low.rank);
    expect(LABELS.length).toBeGreaterThan(0);
  });

  it("formats an optional target date", () => {
    expect(formatTargetDate("2026-07-22")).toBe("Jul 22");
    expect(formatTargetDate(undefined)).toBe("—");
  });

  it("formats a relative age from a seconds timestamp", () => {
    const now = 1_000_000;
    expect(formatAgo(now - 3 * 3600, now)).toBe("3h");
    expect(formatAgo(now - 2 * 86_400, now)).toBe("2d");
  });
});
