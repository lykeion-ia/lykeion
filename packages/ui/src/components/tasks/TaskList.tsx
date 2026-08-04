import { taskCode, type Study, type Task } from "@lykeion/api";
import { CalendarIcon, PriorityIcon } from "../icons";
import { RowLink } from "../RowLink";
import { AssigneeStack } from "../AssigneeStack";
import { displayName } from "../../lib/assignee";
import { useDirectory } from "../../hooks/useDirectory";
import {
  PRIORITY_META,
  STAGE_META,
  TASK_STATUS_META,
  formatAgo,
  formatTargetDate,
} from "../../lib/task-meta";
import { taskRoute } from "../../lib/task-route";
import { cn } from "../../lib/utils";

export interface TaskListProps {
  tasks: Task[];
  studyById: Record<string, Study>;
  // Show the "Study" column (true for cross-study lists like My Tasks).
  showStudy?: boolean;
  emptyLabel?: string;
}

export function TaskList({
  tasks,
  studyById,
  showStudy = true,
  emptyLabel = "No tasks in this view",
}: TaskListProps) {
  const dir = useDirectory();
  const gridCols = showStudy
    ? "grid-cols-[minmax(0,1fr)_150px_120px_150px_90px]"
    : "grid-cols-[minmax(0,1fr)_120px_150px_90px]";

  if (tasks.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-fg-subtle">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto px-5 pb-5">
      <div
        className={cn(
          "grid items-center gap-3 border-b border-line px-3 py-2 text-[11px] font-medium uppercase tracking-[0.4px] text-fg-tertiary",
          gridCols,
        )}
      >
        <span>Task</span>
        {showStudy && <span>Study</span>}
        <span>Status</span>
        <span>Assignee</span>
        <span>Updated</span>
      </div>

      {tasks.map((task) => {
        // Deliberately unguarded: an unfiled Task has no Study, and one whose
        // Study is missing from the map still has to render. Dropping the row
        // would take assigned work off the screen while the filter counts
        // above still include it.
        const study =
          task.studyId !== undefined ? studyById[task.studyId] : undefined;
        const meta = TASK_STATUS_META[task.status];
        const assignees = task.assignees ?? [];
        const stage = STAGE_META[task.stage];

        return (
          <RowLink
            key={task.id}
            to={taskRoute(task)}
            className={cn(
              "grid items-center gap-3 border-b border-line-soft px-3 py-2.5 text-[13px] hover:bg-surface-2",
              gridCols,
            )}
          >
            <span className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 font-mono text-[11px] text-fg-tertiary">
                  {taskCode(study, task)}
                </span>
                <span className="truncate font-medium text-fg">
                  {task.title}
                </span>
              </span>
              {task.description && (
                <span className="truncate text-[12px] text-fg-subtle">
                  {task.description}
                </span>
              )}
              <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-subtle">
                <span
                  className={cn(
                    "rounded border px-1.5 py-0.5",
                    stage.badgeClass,
                  )}
                >
                  {stage.label}
                </span>
                {task.priority !== "none" && (
                  <span className="inline-flex items-center gap-1">
                    <PriorityIcon width={11} height={11} />
                    {PRIORITY_META[task.priority].label}
                  </span>
                )}
                {task.targetDate && (
                  <span className="inline-flex items-center gap-1">
                    <CalendarIcon width={11} height={11} />
                    {formatTargetDate(task.targetDate)}
                  </span>
                )}
              </span>
            </span>

            {showStudy && (
              <span className="truncate text-fg-muted">
                {study ? (
                  study.title
                ) : (
                  <span className="text-fg-tertiary">Unfiled</span>
                )}
              </span>
            )}

            <span
              className={cn("inline-flex items-center gap-1.5", meta.textClass)}
            >
              <span
                className={cn("h-2 w-2 shrink-0 rounded-full", meta.dotClass)}
              />
              {meta.label}
            </span>

            <span className="flex items-center gap-1.5 text-fg-muted">
              {assignees.length > 0 ? (
                <>
                  <AssigneeStack
                    assignees={assignees}
                    size={16}
                    ringClass="ring-canvas"
                  />
                  {assignees.length === 1 && (
                    <span className="truncate">
                      {displayName(assignees[0], dir)}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-fg-tertiary">Unassigned</span>
              )}
            </span>

            <span className="truncate text-fg-tertiary">
              {formatAgo(task.updatedTs)}
            </span>
          </RowLink>
        );
      })}
    </div>
  );
}

export default TaskList;
