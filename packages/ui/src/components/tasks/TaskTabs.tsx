import { CrumbStrip } from "../ScreenCrumb";
import { cn } from "../../lib/utils";
import type { Route } from "../../router";

export interface TaskTab {
  id: string;
  label: string;
  closable?: boolean;
}

/**
 * The full-chat breadcrumb strip. Its geometry is `CrumbStrip`'s, shared with
 * the Study page this surface is opened from, so the trail does not move under
 * the click; what this adds is the load the strip carries — the conversation
 * tabs (+ a Files tab when open), the Task's Mark Done action, and the
 * top-right menu button that toggles the Files right pane.
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
      <CrumbStrip page={crumb} to={crumbTo}>
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5">
          {tabs.map((t) => {
            const active = t.id === activeId;
            return (
              <span
                key={t.id}
                className={cn(
                  "inline-flex items-center rounded-md text-[13px] transition-colors duration-[120ms]",
                  active ? "bg-surface-3 text-fg" : "text-fg-subtle",
                )}
              >
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onSelect(t.id)}
                  className={cn(
                    "h-7 rounded-md px-2.5",
                    active ? "text-fg" : "hover:text-fg",
                  )}
                >
                  {t.label}
                </button>
                {t.closable && (
                  <button
                    type="button"
                    aria-label={`Close ${t.label}`}
                    onClick={() => onClose(t.id)}
                    className="mr-1 grid h-4 w-4 place-items-center rounded text-fg-subtle hover:text-fg"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path
                        d="M2.5 2.5l5 5M7.5 2.5l-5 5"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                )}
              </span>
            );
          })}
        </div>

        <span className="flex-1" />

        {showMarkDone && (
          <button
            type="button"
            className="h-7 rounded-md border border-line-strong bg-surface-2 px-2.5 text-[12.5px] text-fg-muted hover:bg-surface-3 hover:text-fg"
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
              "grid h-[30px] w-[30px] place-items-center rounded-lg",
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
        <p className="px-5 pb-2 text-[12px] text-danger" role="alert">
          {doneError}
        </p>
      )}
    </div>
  );
}

export default TaskTabs;
