import {
  LykeionError,
  type LykeionApi,
  type Research,
  type ResearchDetail,
  type ResearchEnvironmentDefault,
} from "@lykeion/api";
import type { Deps } from "./index";
import type { Row, Store } from "../store/store";
import { nextSeq } from "../store/migrations";
import { environmentSetupStore } from "../store/environment-setups";
import { dropGrantsForResearch } from "../store/sessions";
import { taskRowsToTasks } from "./tasks";

export type ResearchesApi = Pick<
  LykeionApi,
  | "listResearches" | "getResearch" | "createResearch" | "updateResearch"
  | "archiveResearch" | "restoreResearch" | "deleteResearch"
>;

const RESEARCH_COLUMNS = `id, key, title, description, agent_context, created_by, archived_ts, pinned, created_ts, updated_ts`;

/**
 * One `studies` row as the public shape, with the defaults that Research has
 * confirmed.
 *
 * The defaults are PASSED rather than read here, and that is what keeps this
 * projection honest: they live in `research_environment_defaults`, not in
 * this row, and a function that answered `[]` because it had no second table
 * in front of it would be claiming a Research has no default when what is
 * true is that nobody looked. Every caller below reads them from the one
 * table that owns them (`read`, over `defaultsForResearch`), so there is no
 * path through this family that returns a Research with a default silently
 * missing.
 *
 * No `studies` column backs any of this. A copy there would be a second
 * answer to "which environment does this Research default to", and the two
 * would disagree the first time an environment is deleted — the delete drops
 * the default row, and a column nothing swept would go on naming an
 * environment this lab no longer has.
 */
export function toResearch(
  row: Row,
  environmentDefaults: ResearchEnvironmentDefault[],
): Research {
  return {
    id: row.id as string,
    key: row.key as string,
    title: row.title as string,
    ...(row.description === null ? {} : { description: row.description as string }),
    ...(row.agent_context === null ? {} : { agentContext: row.agent_context as string }),
    createdBy: row.created_by as string,
    environmentDefaults,
    ...(row.archived_ts === null ? {} : { archivedTs: row.archived_ts as number }),
    ...(row.pinned === 1 ? { pinned: true } : {}),
    createdTs: row.created_ts as number,
    updatedTs: row.updated_ts as number,
  };
}

function requireResearch(store: Store, researchId: string): Row {
  const row = store.get(`SELECT ${RESEARCH_COLUMNS} FROM studies WHERE id = ?`, [researchId]);
  if (!row) throw new LykeionError("not-found", `no such research: ${researchId}`);
  return row;
}

export function researchesApi(deps: Deps): ResearchesApi {
  const { store, actor, now, runs, coordinator } = deps;
  const { record } = deps.changes;
  const setups = environmentSetupStore(store);
  /** One row, read together with the defaults that Research has confirmed —
   *  the single expression every read path below goes through, so a new one
   *  cannot be added that forgets them. One indexed lookup per Research on
   *  the list path, which is what a lab's own SQLite file costs. */
  const read = (row: Row): Research =>
    toResearch(row, setups.defaultsForResearch(row.id as string));
  return {
    async listResearches(options) {
      // Newest first, insertion sequence breaking the tie. Two Researches
      // opened in one second still come back in the order they were opened.
      const where = options?.includeArchived ? "" : "WHERE archived_ts IS NULL";
      return store
        .all(`SELECT ${RESEARCH_COLUMNS} FROM studies ${where} ORDER BY created_ts DESC, seq DESC`)
        .map(read);
    },

    async getResearch(researchId): Promise<ResearchDetail> {
      const research = read(requireResearch(store, researchId));
      const tasks = taskRowsToTasks(
        store,
        // Numbers are not unique within a Research — a Task filed in from
        // elsewhere keeps the number it already had — so the insertion
        // sequence is what makes this order total rather than arbitrary.
        store.all(
          `SELECT * FROM tasks WHERE study_id = ? ORDER BY number ASC, seq ASC`,
          [researchId],
        ),
      );
      return { research, tasks };
    },

    async createResearch(input) {
      const title = input.title.trim();
      if (!title) throw new LykeionError("invalid", "research title must not be empty");
      const ts = now();
      // One sequence number serves both the id and the seq column: calling
      // nextSeq twice (once for each) would burn a value nothing reads, and
      // would do it outside this transaction, so a rollback couldn't even
      // reclaim it.
      return store.tx(() => {
        const seq = nextSeq(store);
        const id = `s_${seq}`;
        store.run(
          `INSERT INTO studies (id, key, title, description, agent_context, created_by, created_ts, updated_ts, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, input.key, title, input.description ?? null,
            input.agentContext ?? null, actor.userId, ts, ts, seq,
          ],
        );
        record("research-created", { researchId: id });
        return read(requireResearch(store, id));
      });
    },

    async updateResearch(researchId, patch) {
      return store.tx(() => {
        requireResearch(store, researchId);
        if (patch.title !== undefined) {
          const title = patch.title.trim();
          if (!title) throw new LykeionError("invalid", "research title must not be empty");
          store.run(`UPDATE studies SET title = ? WHERE id = ?`, [title, researchId]);
        }
        if (patch.description !== undefined)
          store.run(`UPDATE studies SET description = ? WHERE id = ?`, [patch.description, researchId]);
        if (patch.agentContext !== undefined)
          store.run(`UPDATE studies SET agent_context = ? WHERE id = ?`, [patch.agentContext, researchId]);
        if (patch.pinned !== undefined)
          store.run(`UPDATE studies SET pinned = ? WHERE id = ?`, [patch.pinned ? 1 : 0, researchId]);
        store.run(`UPDATE studies SET updated_ts = ? WHERE id = ?`, [now(), researchId]);
        record("research-updated", { researchId });
        return read(requireResearch(store, researchId));
      });
    },

    async archiveResearch(researchId) {
      return store.tx(() => {
        const row = requireResearch(store, researchId);
        // Archiving an archived Research is not an error and must not move the
        // timestamp: the operation already happened.
        if (row.archived_ts === null) {
          store.run(`UPDATE studies SET archived_ts = ? WHERE id = ?`, [now(), researchId]);
          record("research-archived", { researchId });
        }
        return read(requireResearch(store, researchId));
      });
    },

    async restoreResearch(researchId) {
      return store.tx(() => {
        const row = requireResearch(store, researchId);
        if (row.archived_ts !== null) {
          store.run(`UPDATE studies SET archived_ts = NULL WHERE id = ?`, [researchId]);
          record("research-restored", { researchId });
        }
        return read(requireResearch(store, researchId));
      });
    },

    async deleteResearch(researchId) {
      const { cancellations } = store.tx(() => {
        requireResearch(store, researchId);
        // Before the DELETE, because the DELETE is what takes these away: a
        // waiter cascades on `task_env_setup_waiters.study_id` and again on
        // its Task, so reading them afterwards finds nothing.
        //
        // The cascade alone is not enough, and the difference is a turn —
        // exactly as it is one level down in `deleteTask`. A `queued` waiter
        // owns a durable system-origin continuation whose `start-run` is
        // already on a machine, and neither `turns` nor `sessions` carries a
        // foreign key to `studies`, so that turn survives its Research and
        // would go on working — writing into the workspace — for a Research
        // that no longer exists, with nothing left in this lab that could
        // ever settle it. The coordinator finishes it and names the run to
        // recall, in this same transaction; the recall itself is dispatched
        // once it has committed.
        const cancelled = coordinator.cancelForDeletedResearch(researchId);
        // Tasks cascade; the foreign key declares it, and `PRAGMA
        // foreign_keys` is on so the database performs it. `folder_grants`
        // carries no foreign key of its own, so a Research's grants are dropped
        // here rather than orphaned: a grant naming a Research that no longer
        // exists means nothing.
        dropGrantsForResearch(store, researchId);
        store.run(`DELETE FROM studies WHERE id = ?`, [researchId]);
        record("research-deleted", { researchId });
        return cancelled;
      });
      // Outside the transaction: a machine told to stop a run that a
      // rolled-back delete would have left running is a command this lab
      // cannot take back.
      for (const cancellation of cancellations)
        runs.enqueue(cancellation.machineId, {
          type: "cancel",
          runId: cancellation.runId,
        });
    },
  };
}
