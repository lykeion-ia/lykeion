import { CrumbStrip } from "../ScreenCrumb";
import { TaskTabStrip } from "./TaskTabStrip";
import { cn } from "../../lib/utils";
import type { Route } from "../../router";

export type { TaskTab } from "./TaskTabStrip";
import type { TaskTab } from "./TaskTabStrip";

/**
 * The full-chat breadcrumb strip. Its geometry is `CrumbStrip`'s, shared with
 * the Study page this surface is opened from, so the trail does not move under
 * the click; what this adds is the load the strip carries — the conversation
 * tabs (+ a Files tab when open), the Task's Mark Done action, and the
 * top-right menu button that toggles the Files right pane.
 *
 * The tabs ride in `CrumbStrip`'s band rather than beside the trail, because
 * they name the conversation directly below them and so sit on ITS column.
 * `TaskTabStrip` is the band's content; `.crumb-strip--banded` in
 * screens/task.css is what puts it on the column.
 */
export function TaskTabs({
  crumb,
  crumbTo,
  tabs,
  activeId,
  onSelect,
  onClose,
  showMarkDone,
  onMarkDone,
  doneError,
  rightPaneOpen,
  onToggleRightPane,
  divider = true,
}: {
  crumb: string;
  /** Where the crumb names — the surface this Task was opened from, which the
   *  trail links back to. */
  crumbTo?: Route;
  tabs: TaskTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  showMarkDone: boolean;
  onMarkDone: () => void;
  doneError: string | null;
  rightPaneOpen: boolean;
  /** Toggle the right-hand inspector. Omit where there is nothing for it to
   *  inspect — an unfiled Task has no workspace, so no files and no kernel —
   *  and the button is left off rather than offered and dead. */
  onToggleRightPane?: () => void;
  /** The bottom rule separating the strip from the body. On by default; the
   *  Task surface passes `false` for a seamless breadcrumb-into-chat look. */
  divider?: boolean;
}) {
  return (
    <div className={cn("shrink-0", divider && "border-b border-line")}>
      <CrumbStrip
        page={crumb}
        to={crumbTo}
        band={
          <TaskTabStrip
            tabs={tabs}
            activeId={activeId}
            onSelect={onSelect}
            onClose={onClose}
          />
        }
      >
        {showMarkDone && (
          <button
            type="button"
            className="h-7 whitespace-nowrap rounded-md border border-line-strong bg-surface-2 px-2.5 text-sub text-fg-muted hover:bg-surface-3 hover:text-fg"
            onClick={onMarkDone}
          >
            Mark Done
          </button>
        )}

        {onToggleRightPane && (
          <button
            type="button"
            aria-label="Toggle files panel"
            aria-pressed={rightPaneOpen}
            onClick={onToggleRightPane}
            className={cn(
              "grid h-[30px] w-[30px] shrink-0 place-items-center rounded-lg",
              rightPaneOpen
                ? "bg-surface-2 text-accent"
                : "text-fg-subtle hover:bg-surface hover:text-fg",
            )}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <rect
                x="3.5"
                y="4.5"
                width="17"
                height="15"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.75"
              />
              <path d="M15 4.5v15" stroke="currentColor" strokeWidth="1.75" />
            </svg>
          </button>
        )}
      </CrumbStrip>

      {doneError && (
        <p className="px-5 pb-2 text-sub text-danger" role="alert">
          {doneError}
        </p>
      )}
    </div>
  );
}

export default TaskTabs;
