import type { Priority } from "@lykeion/api";
import "./components.css";

const FILLED: Record<Priority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 3,
};

/** Priority glyph: three rising bars; urgent is an alert tile. */
export function PriorityIcon({ priority }: { priority: Priority }) {
  if (priority === "urgent") {
    return (
      <svg
        className="priority-icon"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-hidden="true"
      >
        <rect
          x="1.5"
          y="1.5"
          width="11"
          height="11"
          rx="2.5"
          fill="var(--priority-urgent)"
        />
        <path
          d="M7 4v3.4"
          stroke="var(--canvas)"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle cx="7" cy="9.9" r="0.9" fill="var(--canvas)" />
      </svg>
    );
  }

  if (priority === "none") {
    return (
      <svg
        className="priority-icon"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        aria-hidden="true"
      >
        <path
          d="M3 7h1.6M6.2 7h1.6M9.4 7h1.6"
          stroke="var(--ink-tertiary)"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  const filled = FILLED[priority];
  const bars = [
    { x: 2.5, y: 8, h: 3.5 },
    { x: 6, y: 5.5, h: 6 },
    { x: 9.5, y: 3, h: 8.5 },
  ];
  return (
    <svg
      className="priority-icon"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      {bars.map((bar, i) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="2"
          height={bar.h}
          rx="1"
          fill="var(--ink-subtle)"
          opacity={i < filled ? 1 : 0.3}
        />
      ))}
    </svg>
  );
}
