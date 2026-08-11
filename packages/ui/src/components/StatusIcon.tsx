import type { ComponentType, SVGProps } from "react";
import type { TaskStatus } from "@lykeion/api";
import { statusColor } from "./status";
import { cn } from "../lib/utils";
import "./components.css";

/**
 * Status disc: a ring whose fill advances with the task —
 * empty (Todo), half (In Progress), three-quarters (In Review — the
 * Reviewer is checking), full with a check (Done).
 */
export function StatusIcon({
  status,
  className,
}: {
  status: TaskStatus;
  /** Extra classes from wherever the disc is standing. Its size and colour
   *  are its own — the disc means the status, so neither is a caller's to
   *  set — but layout around it is not. */
  className?: string;
}) {
  const color = statusColor(status);
  return (
    <svg
      className={cn("status-icon", className)}
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

/**
 * The same disc, in the shape a menu row's icon slot takes — one bound
 * component per status, so a menu that names a status can draw it rather than
 * settling for a generic mark.
 *
 * Built once, at module scope. A component type minted inside a render is a
 * new type on every pass, and React remounts what it draws; these are read on
 * every keystroke a menu is open for.
 */
export const STATUS_MENU_ICONS: Record<
  TaskStatus,
  ComponentType<SVGProps<SVGSVGElement>>
> = {
  todo: ({ className }) => <StatusIcon status="todo" className={className} />,
  "in-progress": ({ className }) => (
    <StatusIcon status="in-progress" className={className} />
  ),
  "in-review": ({ className }) => (
    <StatusIcon status="in-review" className={className} />
  ),
  done: ({ className }) => <StatusIcon status="done" className={className} />,
};
