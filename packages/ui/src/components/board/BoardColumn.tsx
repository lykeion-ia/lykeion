import type { Research, Task, TaskStatus } from "@lykeion/api";
import { TaskCard } from "./TaskCard";
import { StatusIcon } from "../StatusIcon";
import { PlusIcon } from "../icons";

export interface BoardColumnProps {
  status: TaskStatus;
  title: string;
  tasks: Task[];
  studyById: Record<string, Research>;
  /** Opens the New Task modal; shown as the column's add affordances. */
  onAddTask?: () => void;
  /** Opens the Details editor for a card. */
  onEditTask?: (task: Task) => void;
}

export function BoardColumn({
  status,
  title,
  tasks,
  studyById,
  onAddTask,
  onEditTask,
}: BoardColumnProps) {
  return (
    <div className="flex w-[300px] min-w-[300px] shrink-0 flex-col rounded-xl border border-line-soft bg-lane p-2">
      <div className="flex items-center gap-2 px-1.5 pb-2.5 pt-1">
        <StatusIcon status={status} />
        <span className="text-sub font-semibold tracking-[-0.1px] text-fg">
          {title}
        </span>
        <span className="text-sub text-fg-tertiary">{tasks.length}</span>
        {onAddTask && (
          <button
            type="button"
            aria-label={`Add task (${title})`}
            onClick={onAddTask}
            className="ml-auto grid h-6 w-6 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface-2 hover:text-fg-subtle"
          >
            <PlusIcon width={15} height={15} />
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {/* No guard on the Research: an unfiled Task has none, and one whose
            Research is missing from the map must still show rather than
            silently leave the board. */}
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            research={
              task.researchId !== undefined ? studyById[task.researchId] : undefined
            }
            onEdit={onEditTask}
          />
        ))}

        {onAddTask && (
          <button
            type="button"
            onClick={onAddTask}
            className="flex items-center gap-1.5 self-start rounded-md px-1 py-1 text-sub text-fg-tertiary transition-colors hover:text-fg-subtle"
          >
            <PlusIcon width={14} height={14} />
            Add task
          </button>
        )}
      </div>
    </div>
  );
}

export default BoardColumn;
