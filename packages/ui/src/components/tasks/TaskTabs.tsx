import { CrumbStrip } from "../ScreenCrumb";
import { AgentLabel } from "./AgentLabel";
import { cn } from "../../lib/utils";
import type { Route } from "../../router";

/**
 * The full-chat breadcrumb strip. Its geometry is `CrumbStrip`'s, shared with
 * the Study page this surface is opened from, so the trail does not move under
 * the click; what this adds is the load the strip carries — the agent the Task
 * is talking to, and the top-right menu button that toggles the Files right
 * pane.
 *
 * The strip names rather than acts. Which agent a Task is on holds for the
 * whole page, which is what earns a place at its head; the Task's own actions
 * are per-Task and live in the row menu that already holds the rest of them.
 *
 * Which Task is on screen is the sidebar's to say, and only its. The strip used
 * to carry the open ones as tabs as well, on a track of their own cut to the
 * conversation's measure — but they named the Tasks the sidebar already lists a
 * few pixels to their left, so the row is down to the trail and the two
 * controls that have nowhere else to be.
 */
export function TaskTabs({
  crumb,
  crumbTo,
  agent,
  agentName,
  statusError,
  rightPaneOpen,
  onToggleRightPane,
  divider = true,
}: {
  crumb: string;
  /** Where the crumb names — the surface this Task was opened from, which the
   *  trail links back to. */
  crumbTo?: Route;
  /** The `AgentCli.id` this Task ran on, absent until a turn has run. */
  agent?: string;
  /** What detection calls that CLI, when this machine detected it. */
  agentName?: string;
  /** A status write the core refused — the Done-gate, most of the time. The
   *  strip is where the Task surface says so, wherever the menu that asked
   *  was. */
  statusError: string | null;
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
        <AgentLabel agent={agent} name={agentName} />

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

      {statusError && (
        <p className="px-5 pb-2 text-sub text-danger" role="alert">
          {statusError}
        </p>
      )}
    </div>
  );
}

export default TaskTabs;
