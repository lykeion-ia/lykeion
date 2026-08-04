import {
  PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  taskCode,
  type Study,
  type Task,
} from "@lykeion/api";
import { RowLink } from "./RowLink";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { Avatar } from "./Avatar";
import { useDirectory } from "../hooks/useDirectory";
import { taskRoute } from "../lib/task-route";
import "./components.css";

interface TaskRowProps {
  /** The Task's Study, or undefined when it is unfiled. */
  study?: Study;
  task: Task;
  active?: boolean;
  rowRef?: (el: HTMLAnchorElement | null) => void;
  onFocus?: () => void;
}

/** One dense task line: status disc · code · title · priority · assignee. */
export function TaskRow({
  study,
  task,
  active,
  rowRef,
  onFocus,
}: TaskRowProps) {
  const dir = useDirectory();
  return (
    <RowLink
      to={taskRoute(task)}
      className={`row task-row${active ? " is-active" : ""}`}
      rowRef={rowRef}
      onFocus={onFocus}
    >
      <span className="task-status" title={TASK_STATUS_LABELS[task.status]}>
        <StatusIcon status={task.status} />
      </span>
      <span className="task-code">{taskCode(study, task)}</span>
      <span className="row-title">{task.title}</span>
      <span className="task-priority" title={PRIORITY_LABELS[task.priority]}>
        <PriorityIcon priority={task.priority} />
      </span>
      {task.assignees && task.assignees.length > 0 ? (
        <Avatar assignee={task.assignees[0]} dir={dir} />
      ) : (
        <span className="avatar avatar--empty" title="Unassigned" />
      )}
    </RowLink>
  );
}
