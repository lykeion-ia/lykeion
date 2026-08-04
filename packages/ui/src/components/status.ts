import type { TaskStatus } from "@lykeion/api";

/**
 * The CSS custom property carrying each status's indicator color.
 * Semantic status colors are deliberately distinct from the lavender
 * accent (`--primary`), which is reserved for brand / focus / the one
 * primary action.
 */
export const STATUS_COLOR_VAR: Record<TaskStatus, string> = {
  todo: "--status-todo",
  "in-progress": "--status-progress",
  "in-review": "--status-review",
  done: "--status-done",
};

export function statusColor(status: TaskStatus): string {
  return `var(${STATUS_COLOR_VAR[status]})`;
}
