import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * The geometry of a left-pane row, shared by the app Rail and the Task's
 * left-side pane.
 *
 * The two panes swap in the same slot around the `WorkspaceSwitcher`, so a row
 * must land on exactly the same baseline in both — otherwise toggling the pane
 * makes the whole list jump. The only way to guarantee that is one definition
 * used by both, which is what this module is.
 *
 * It exists because the Task pane used to restate the geometry in CSS
 * (`.tsb-menu-item { height: 34px }`) against the Rail's `py-1.5` rows, which
 * with the inherited `line-height: 1.5` come out at 31.5px. Every row below the
 * switcher drifted, accumulating ~12px by the group label. The height is now
 * pinned at `h-8` so both panes sit on an integral 32px grid.
 */
export const railRowClass =
  "flex h-8 items-center gap-2.5 mx-0.5 rounded-lg px-2 text-ui";

const railRowIdle = "text-fg-subtle hover:bg-surface hover:text-fg";
const railRowActive = "bg-surface-2 text-fg";

/** A rail row's full class list, in its idle or active state. */
export function railRow(active = false, extra?: string) {
  return cn(railRowClass, active ? railRowActive : railRowIdle, extra);
}

/**
 * The 16px leading icon slot. Fixed width so every label in both panes starts
 * on the same column, whatever the glyph.
 */
export function RailGlyph({ children }: { children: ReactNode }) {
  return (
    <span className="grid h-4 w-4 shrink-0 place-items-center opacity-90">
      {children}
    </span>
  );
}

/** The uppercase heading over a rail section ("Laboratory", "This week"). */
export function RailGroupLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mt-2 px-2.5 pb-[3px] pt-1.5 text-micro font-semibold uppercase tracking-[0.5px] text-fg-tertiary">
      {children}
    </div>
  );
}
