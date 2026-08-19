import { taskCode, type Research, type Task } from "@lykeion/api";
import { CalendarIcon, LinkIcon, PencilIcon } from "../icons";
import { RowLink } from "../RowLink";
import { StatusIcon } from "../StatusIcon";
import { PriorityIcon } from "../PriorityIcon";
import { ProgressRing } from "../ProgressRing";
import { AssigneeStack } from "../AssigneeStack";
import { LABELS, formatTargetDate } from "../../lib/task-meta";
import { taskRoute } from "../../lib/task-route";

export interface TaskCardProps {
  task: Task;
  /** The Task's Research, or undefined when it is unfiled. */
  research?: Research;
  /** Opens the Details editor without navigating to the task. */
  onEdit?: (task: Task) => void;
}

const LABEL_BY_ID = new Map(LABELS.map((l) => [l.id, l]));

/** A single bordered metadata chip in the card's footer. */
function MetaChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-3 px-1.5 py-[3px] text-meta text-fg-subtle">
      {children}
    </span>
  );
}

/**
 * Board task card — a top section (status chip · title · priority ·
 * description · label pills) and a dashed-divided footer of metadata chips
 * (date · links · subtask progress) with a right-aligned assignee stack.
 * Every field is real Task data.
 */
export function TaskCard({ task, research, onEdit }: TaskCardProps) {
  const labels = (task.labels ?? [])
    .map((id) => LABEL_BY_ID.get(id))
    .filter((l): l is (typeof LABELS)[number] => Boolean(l));
  const links = task.links ?? [];
  const subtasks = task.subtasks ?? [];
  const doneCount = subtasks.filter((s) => s.done).length;
  const assignees = task.assignees ?? [];
  const hasFooter =
    task.targetDate ||
    links.length > 0 ||
    subtasks.length > 0 ||
    assignees.length > 0;

  return (
    <RowLink
      to={taskRoute(task)}
      className="group relative block overflow-hidden rounded-lg border border-line bg-surface-2 transition-colors duration-[120ms] hover:border-line-strong hover:bg-surface-3"
    >
      {onEdit && (
        <button
          type="button"
          aria-label="Edit task details"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onEdit(task);
          }}
          className="absolute right-1.5 top-1.5 z-10 grid h-6 w-6 place-items-center rounded-md bg-surface-3 text-fg-subtle opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
        >
          <PencilIcon width={13} height={13} />
        </button>
      )}
      <div className="px-3 py-2.5">
        <div className="mb-1.5 flex items-start gap-2">
          <span className="mt-[1px] grid h-5 w-5 shrink-0 place-items-center rounded-[5px] bg-surface-3">
            <StatusIcon status={task.status} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-mono text-micro leading-none text-fg-tertiary">
              {taskCode(research, task)}
            </span>
            <span className="mt-1 block text-ui font-medium leading-snug text-fg">
              {task.title}
            </span>
          </span>
          {task.priority !== "none" && (
            <span
              className="mt-[1px] shrink-0"
              title={`Priority: ${task.priority}`}
            >
              <PriorityIcon priority={task.priority} />
            </span>
          )}
        </div>

        {task.description && (
          <p className="mb-2 line-clamp-2 text-sub leading-relaxed text-fg-subtle">
            {task.description}
          </p>
        )}

        {labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {labels.map((label) => (
              <span
                key={label.id}
                className="inline-flex items-center gap-1 rounded border border-line bg-surface-3 px-1.5 py-0.5 text-micro font-medium text-fg-subtle"
              >
                <span
                  className="h-[6px] w-[6px] shrink-0 rounded-full"
                  style={{ backgroundColor: label.color }}
                />
                {label.name}
              </span>
            ))}
          </div>
        )}
      </div>

      {hasFooter && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-dashed border-line px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            {task.targetDate && (
              <MetaChip>
                <CalendarIcon width={12} height={12} />
                {formatTargetDate(task.targetDate)}
              </MetaChip>
            )}
            {links.length > 0 && (
              <MetaChip>
                <LinkIcon width={12} height={12} />
                {links.length}
              </MetaChip>
            )}
            {subtasks.length > 0 && (
              <MetaChip>
                <ProgressRing done={doneCount} total={subtasks.length} />
                <span className="tabular-nums">
                  {doneCount}/{subtasks.length}
                </span>
              </MetaChip>
            )}
          </div>
          {assignees.length > 0 && (
            <AssigneeStack
              assignees={assignees}
              size={18}
              ringClass="ring-surface-2"
            />
          )}
        </div>
      )}
    </RowLink>
  );
}

export default TaskCard;
