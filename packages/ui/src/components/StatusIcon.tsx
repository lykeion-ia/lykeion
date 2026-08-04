import type { TaskStatus } from "@lykeion/api";
import { statusColor } from "./status";
import "./components.css";

/**
 * Status disc: a ring whose fill advances with the task —
 * empty (Todo), half (In Progress), three-quarters (In Review — the
 * Reviewer is checking), full with a check (Done).
 */
export function StatusIcon({ status }: { status: TaskStatus }) {
  const color = statusColor(status);
  return (
    <svg
      className="status-icon"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      <circle
        cx="7"
        cy="7"
        r="5"
        fill={status === "done" ? color : "none"}
        stroke={color}
        strokeWidth="1.4"
      />
      {status === "in-progress" && (
        <path d="M7 7 L7 4.4 A2.6 2.6 0 0 1 7 9.6 Z" fill={color} />
      )}
      {status === "in-review" && (
        <path d="M7 7 L7 4.4 A2.6 2.6 0 1 1 4.4 7 Z" fill={color} />
      )}
      {status === "done" && (
        <path
          d="M4.6 7.2 6.2 8.8 9.5 5.4"
          fill="none"
          stroke="var(--canvas)"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
