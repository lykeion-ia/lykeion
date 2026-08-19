import type { Research, Task } from "@lykeion/api";
import { BoardColumn } from "./BoardColumn";
import { STATUS_ORDER, TASK_STATUS_META } from "../../lib/task-meta";

export interface BoardProps {
  tasks: Task[];
  studyById: Record<string, Research>;
  /** Opens the New Task modal from a column's add affordance. */
  onAddTask?: () => void;
  /** Opens the Details editor for a card. */
  onEditTask?: (task: Task) => void;
}

// Always render every lane (Todo → In Progress → In Review → Done), even when a
// column is empty, so the full pipeline is visible. No "Failed" lane.
export function Board({ tasks, studyById, onAddTask, onEditTask }: BoardProps) {
  const columns = STATUS_ORDER.map((status) => ({
    status,
    title: TASK_STATUS_META[status].label,
    tasks: tasks.filter((t) => t.status === status),
  }));

  return (
    <div className="flex flex-1 gap-3 overflow-x-auto px-5 pb-5 pt-0.5">
      {columns.map((column) => (
        <BoardColumn
          key={column.status}
          status={column.status}
          title={column.title}
          tasks={column.tasks}
          studyById={studyById}
          onAddTask={onAddTask}
          onEditTask={onEditTask}
        />
      ))}
    </div>
  );
}

export default Board;
