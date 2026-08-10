import {
  LykeionError,
  type Assignee,
  type LykeionApi,
  type Priority,
  type Stage,
  type Subtask,
  type Task,
  type TaskStatus,
} from "@lykeion/api";
import type { Deps } from "./index";
import type { Row, Store } from "../store/store";
import { nextSeq } from "../store/migrations";
import { taskTurnsForTask } from "../store/sessions";

export type TasksApi = Pick<
  LykeionApi,
  "listTasks" | "createTask" | "updateTask" | "deleteTask" | "getTask" | "myWork"
>;

/**
 * Numbers run per Study, and unfiled Tasks run on their own sequence, so
 * two unrelated series never interleave. This does not need to defend a
 * `SELECT MAX` against a concurrent `INSERT` racing it the way a
 * multi-connection database would: this store runs one caller's whole
 * transaction to completion, synchronously, before the next one starts, so
 * no two calls into `nextNumber` for the same Study ever interleave.
 *
 * It governs new Tasks only. Filing keeps a Task's number, and every Study
 * numbers from one, so a filed Task can and does land on a number the Study
 * already uses. Numbers are a reading order within a Study, not a key.
 */
function nextNumber(store: Store, studyId: string | null): number {
  const row = studyId
    ? store.get(`SELECT MAX(number) AS n FROM tasks WHERE study_id = ?`, [studyId])
    : store.get(`SELECT MAX(number) AS n FROM tasks WHERE study_id IS NULL`);
  return ((row?.n as number | null) ?? 0) + 1;
}

/** A JSON-array column (`labels`, `links`, `subtasks`) parses back to
 *  `undefined` rather than `[]` when it holds nothing: "empty" and "never
 *  set" are the same state on the wire, matching every other optional
 *  collection the contract carries. */
function nonEmpty<T>(json: string): T[] | undefined {
  const parsed = JSON.parse(json) as T[];
  return parsed.length === 0 ? undefined : parsed;
}

export function toTask(
  row: Row,
  assignees: Assignee[] | undefined,
  agent: string | undefined,
): Task {
  const labels = nonEmpty<string>(row.labels as string);
  const links = nonEmpty<string>(row.links as string);
  const subtasks = nonEmpty<Subtask>(row.subtasks as string);
  return {
    id: row.id as string,
    number: row.number as number,
    ...(row.study_id === null ? {} : { studyId: row.study_id as string }),
    stage: row.stage as Stage,
    title: row.title as string,
    ...(row.description === null ? {} : { description: row.description as string }),
    status: row.status as TaskStatus,
    priority: row.priority as Priority,
    ...(assignees && assignees.length > 0 ? { assignees } : {}),
    createdBy: row.created_by as string,
    ...(row.target_date === null ? {} : { targetDate: row.target_date as string }),
    ...(labels ? { labels } : {}),
    ...(links ? { links } : {}),
    ...(subtasks ? { subtasks } : {}),
    runCount: row.run_count as number,
    ...(row.last_run_status === null ? {} : { lastRunStatus: row.last_run_status as "ok" | "failed" }),
    ...(agent === undefined ? {} : { agent }),
    ...(row.pinned === 1 ? { pinned: true } : {}),
    ...(row.runtime_id === null ? {} : { runtimeId: row.runtime_id as string }),
    createdTs: row.created_ts as number,
    updatedTs: row.updated_ts as number,
  };
}

/**
 * The coding agent each of these Tasks is talking to: the agent of the
 * session its newest turn belongs to. Read off the session rather than the
 * turn for the same reason `taskTurnsForTask` does — a session *is* one
 * agent's conversation, and a per-turn copy would be free to drift from it.
 *
 * The newest turn, not the newest *settled* one: a Task mid-run is talking to
 * whatever is answering it right now, which is exactly what a reader of the
 * list wants named.
 */
function agentsForTasks(store: Store, ids: string[]): Map<string, string> {
  const placeholders = ids.map(() => "?").join(", ");
  const byTask = new Map<string, string>();
  for (const row of store.all(
    `SELECT t.task_id AS task_id, s.agent AS agent
       FROM turns t
       JOIN sessions s ON s.id = t.session_id
       JOIN (
         SELECT task_id, MAX(seq) AS seq FROM turns
          WHERE task_id IN (${placeholders})
          GROUP BY task_id
       ) newest ON newest.task_id = t.task_id AND newest.seq = t.seq`,
    ids,
  ))
    byTask.set(row.task_id as string, row.agent as string);
  return byTask;
}

/** Hydrate task rows with their assignees and their agent in two extra
 *  queries rather than two per row: a lab-wide list is otherwise N+1 round
 *  trips to the file, twice over. */
export function taskRowsToTasks(store: Store, rows: Row[]): Task[] {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id as string);
  const placeholders = ids.map(() => "?").join(", ");
  const byTask = new Map<string, Assignee[]>();
  for (const row of store.all(
    `SELECT task_id, kind, ref FROM task_assignees
      WHERE task_id IN (${placeholders}) ORDER BY position ASC`,
    ids,
  )) {
    const list = byTask.get(row.task_id as string) ?? [];
    list.push(
      row.kind === "user"
        ? { kind: "user", userId: row.ref as string }
        : { kind: "agent", name: row.ref as string },
    );
    byTask.set(row.task_id as string, list);
  }
  const agents = agentsForTasks(store, ids);
  return rows.map((row) =>
    toTask(row, byTask.get(row.id as string), agents.get(row.id as string)),
  );
}

export function tasksApi(deps: Deps): TasksApi {
  const { store, actor, now } = deps;
  const { record } = deps.changes;
  return {
    async listTasks(options) {
      // Filed Tasks first by number, then the unfiled ones on their own run,
      // so two unrelated number sequences do not interleave.
      const where = options?.includeDone ? "" : "WHERE status != 'done'";
      const rows = store.all(
        `SELECT * FROM tasks ${where}
          ORDER BY (study_id IS NULL) ASC, number ASC, seq ASC`,
      );
      return taskRowsToTasks(store, rows);
    },

    async createTask(input) {
      const title = input.title.trim();
      if (!title) throw new LykeionError("invalid", "task title must not be empty");
      const ts = now();
      return store.tx(() => {
        if (input.studyId !== undefined && !store.get(`SELECT id FROM studies WHERE id = ?`, [input.studyId]))
          throw new LykeionError("not-found", `no such study: ${input.studyId}`);

        // One sequence number serves both the id and the seq column, for
        // the same reason createStudy uses only one: a second nextSeq call
        // would burn a value nothing reads.
        const seq = nextSeq(store);
        const id = `t_${seq}`;
        const number = nextNumber(store, input.studyId ?? null);
        store.run(
          `INSERT INTO tasks (
             id, number, study_id, stage, title, description, status, priority,
             created_by, target_date, labels, links, subtasks, created_ts, updated_ts, seq
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, number, input.studyId ?? null, input.stage, title,
            input.description ?? null, "todo", input.priority ?? "none",
            actor.userId, null, "[]", "[]", "[]", ts, ts, seq,
          ],
        );
        (input.assignees ?? []).forEach((a, position) => {
          store.run(
            `INSERT INTO task_assignees (task_id, kind, ref, position) VALUES (?, ?, ?, ?)`,
            [id, a.kind, a.kind === "user" ? a.userId : a.name, position],
          );
        });
        record("task-created", { taskId: id });
        return taskRowsToTasks(store, [store.get(`SELECT * FROM tasks WHERE id = ?`, [id])!])[0];
      });
    },

    async updateTask(taskId, patch) {
      return store.tx(() => {
        const existing = store.get(`SELECT id FROM tasks WHERE id = ?`, [taskId]);
        if (!existing) throw new LykeionError("not-found", `no such task: ${taskId}`);

        if (patch.title !== undefined) {
          const title = patch.title.trim();
          if (!title) throw new LykeionError("invalid", "task title must not be empty");
          store.run(`UPDATE tasks SET title = ? WHERE id = ?`, [title, taskId]);
        }
        if (patch.studyId !== undefined) {
          if (!store.get(`SELECT id FROM studies WHERE id = ?`, [patch.studyId]))
            throw new LykeionError("not-found", `no such study: ${patch.studyId}`);
          store.run(`UPDATE tasks SET study_id = ? WHERE id = ?`, [patch.studyId, taskId]);
        }
        if (patch.description !== undefined)
          store.run(`UPDATE tasks SET description = ? WHERE id = ?`, [patch.description, taskId]);
        if (patch.stage !== undefined)
          store.run(`UPDATE tasks SET stage = ? WHERE id = ?`, [patch.stage, taskId]);
        if (patch.status !== undefined)
          store.run(`UPDATE tasks SET status = ? WHERE id = ?`, [patch.status, taskId]);
        if (patch.priority !== undefined)
          store.run(`UPDATE tasks SET priority = ? WHERE id = ?`, [patch.priority, taskId]);
        if (patch.pinned !== undefined)
          store.run(`UPDATE tasks SET pinned = ? WHERE id = ?`, [patch.pinned ? 1 : 0, taskId]);
        // `null` clears the date; absent leaves it. The contract distinguishes
        // the two, so the handler has to as well.
        if (patch.targetDate !== undefined)
          store.run(`UPDATE tasks SET target_date = ? WHERE id = ?`, [patch.targetDate, taskId]);
        for (const [field, column] of [
          ["labels", "labels"],
          ["links", "links"],
          ["subtasks", "subtasks"],
        ] as const) {
          const value = patch[field];
          if (value !== undefined)
            store.run(`UPDATE tasks SET ${column} = ? WHERE id = ?`, [JSON.stringify(value), taskId]);
        }
        if (patch.assignees !== undefined) {
          // Replaced whole, never merged: the contract says an array
          // replaces the collection and an empty one clears it.
          store.run(`DELETE FROM task_assignees WHERE task_id = ?`, [taskId]);
          patch.assignees.forEach((a, position) => {
            store.run(
              `INSERT INTO task_assignees (task_id, kind, ref, position) VALUES (?, ?, ?, ?)`,
              [taskId, a.kind, a.kind === "user" ? a.userId : a.name, position],
            );
          });
        }

        store.run(`UPDATE tasks SET updated_ts = ? WHERE id = ?`, [now(), taskId]);
        record("task-updated", { taskId });
        return taskRowsToTasks(store, [store.get(`SELECT * FROM tasks WHERE id = ?`, [taskId])!])[0];
      });
    },

    async deleteTask(taskId) {
      store.tx(() => {
        if (!store.get(`SELECT id FROM tasks WHERE id = ?`, [taskId]))
          throw new LykeionError("not-found", `no such task: ${taskId}`);
        // Assignee rows cascade on the foreign key.
        store.run(`DELETE FROM tasks WHERE id = ?`, [taskId]);
        record("task-deleted", { taskId });
      });
    },

    async getTask(taskId) {
      const row = store.get(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
      if (!row) throw new LykeionError("not-found", `no such task: ${taskId}`);
      return { task: taskRowsToTasks(store, [row])[0], turns: taskTurnsForTask(store, taskId) };
    },

    async myWork() {
      const rows = store.all(
        `SELECT t.* FROM tasks t
           JOIN task_assignees a ON a.task_id = t.id
          WHERE a.kind = 'user' AND a.ref = ? AND t.status != 'done'
          ORDER BY t.number ASC, t.seq ASC`,
        [actor.userId],
      );
      return taskRowsToTasks(store, rows);
    },
  };
}
