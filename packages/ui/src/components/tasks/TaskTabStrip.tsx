import { useTabBand } from "../../hooks/useTabBand";
import { cn } from "../../lib/utils";

export interface TaskTab {
  id: string;
  label: string;
  closable?: boolean;
}

/**
 * The open-Task tabs, as a band clipped to the conversation's own column.
 *
 * A Study holds any number of Tasks and every open one is a tab, so this row
 * has to be able to outrun its own width. It scrolls rather than squeezing,
 * and it stops at the column's right edge rather than shoving the Task's
 * actions along in front of it — `.crumb-strip--banded` in screens/task.css is
 * what puts it on that column, and the comment there is where the geometry is
 * argued.
 *
 * The clipping itself — the faded edge, and scrolling an off-clip tab back into
 * view when it is activated — is `useTabBand`, which the inspector's own tab
 * strip shares. What is left here is the load the band carries: a tab per open
 * Task, named after the conversation, closable down to the last one.
 */
export function TaskTabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
}: {
  tabs: TaskTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const { ref, overflow } = useTabBand(activeId, tabs);

  return (
    <div
      ref={ref}
      className="tab-band crumb-band"
      data-overflow={overflow}
      data-testid="task-tab-band"
    >
      {/* No box around the group and no fill under the active tab: these sit
          on the same line as the crumb trail and name the same things at the
          same level, so a container drawn around them read as a control of
          its own. Selection and hover are carried by ink alone. */}
      {tabs.map((t) => {
        const active = t.id === activeId;
        return (
          <span
            key={t.id}
            data-tab-id={t.id}
            className={cn(
              // Matches `CrumbTrail`'s size — the tabs and the trail sit on
              // one line in `CrumbStrip`, naming the same thing at the same
              // level, and reading them at two sizes made the row look like
              // two strips that happened to collide.
              //
              // Capped: a tab is named after the message that started the
              // chat, which can run to a paragraph. Left free, that label
              // wrapped inside a fixed-height row and the second line was
              // drawn straight over the transcript beneath it. One line,
              // ellipsised, is the whole of the fix — the full name stays
              // reachable in the `title` tooltip.
              "inline-flex max-w-[240px] items-center rounded-md text-read transition-colors duration-[120ms]",
              active ? "text-fg" : "text-fg-subtle",
            )}
          >
            <button
              type="button"
              aria-pressed={active}
              title={t.label}
              onClick={() => onSelect(t.id)}
              className={cn(
                "h-7 min-w-0 truncate rounded-md px-2.5",
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
                className="mr-1 grid h-4 w-4 shrink-0 place-items-center rounded text-fg-subtle hover:text-fg"
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
  );
}

export default TaskTabStrip;
