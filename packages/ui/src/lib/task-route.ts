import type { Task } from "@lykeion/api";
import type { Route } from "../router";

/**
 * Where a Task opens. Both arms open the same surface — the Task's chat. A
 * filed Task is addressed under its own Research; an unfiled one has no Research to
 * name in an address, so it is addressed by id alone.
 *
 * The split is about ADDRESSING, not about what each screen can load: the
 * Task surface reads by `getTask(taskId)` and resolves an unfiled Task
 * perfectly well. `#/researches/:researchId/tasks/:taskId` simply has no honest
 * `:researchId` to put in it for a Task that has none.
 *
 * This is for the lists that can hold EITHER kind — the board, the Task list,
 * a Task row anywhere in the Lab. A surface already scoped to one Research
 * (`ResearchScreen`, the Inbox's Research line, the palette's per-Research entries)
 * knows every Task it lists is filed there and addresses it directly; passing
 * a Task through here would only re-derive the Research it was read from.
 */
export function taskRoute(task: Task): Route {
  return task.researchId !== undefined
    ? { name: "task", researchId: task.researchId, taskId: task.id }
    : { name: "unfiled-task", taskId: task.id };
}
