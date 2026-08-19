import { LykeionError, type LykeionApi, type Research, type ResearchDetail } from "@lykeion/api";
import type { Deps } from "./index";
import type { Row, Store } from "../store/store";
import { nextSeq } from "../store/migrations";
import { dropGrantsForResearch } from "../store/sessions";
import { taskRowsToTasks } from "./tasks";

export type ResearchesApi = Pick<
  LykeionApi,
  | "listResearches" | "getResearch" | "createResearch" | "updateResearch"
  | "archiveResearch" | "restoreResearch" | "deleteResearch"
>;

const RESEARCH_COLUMNS = `id, key, title, description, agent_context, created_by, archived_ts, pinned, created_ts, updated_ts`;

export function toResearch(row: Row): Research {
  return {
    id: row.id as string,
    key: row.key as string,
    title: row.title as string,
    ...(row.description === null ? {} : { description: row.description as string }),
    ...(row.agent_context === null ? {} : { agentContext: row.agent_context as string }),
    createdBy: row.created_by as string,
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
  const { store, actor, now } = deps;
  const { record } = deps.changes;
  return {
    async listResearches(options) {
      // Newest first, insertion sequence breaking the tie. Two Researches
      // opened in one second still come back in the order they were opened.
      const where = options?.includeArchived ? "" : "WHERE archived_ts IS NULL";
      return store
        .all(`SELECT ${RESEARCH_COLUMNS} FROM studies ${where} ORDER BY created_ts DESC, seq DESC`)
        .map(toResearch);
    },

    async getResearch(researchId): Promise<ResearchDetail> {
      const research = toResearch(requireResearch(store, researchId));
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
        return toResearch(requireResearch(store, id));
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
        return toResearch(requireResearch(store, researchId));
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
        return toResearch(requireResearch(store, researchId));
      });
    },

    async restoreResearch(researchId) {
      return store.tx(() => {
        const row = requireResearch(store, researchId);
        if (row.archived_ts !== null) {
          store.run(`UPDATE studies SET archived_ts = NULL WHERE id = ?`, [researchId]);
          record("research-restored", { researchId });
        }
        return toResearch(requireResearch(store, researchId));
      });
    },

    async deleteResearch(researchId) {
      store.tx(() => {
        requireResearch(store, researchId);
        // Tasks cascade; the foreign key declares it, and `PRAGMA
        // foreign_keys` is on so the database performs it. `folder_grants`
        // carries no foreign key of its own, so a Research's grants are dropped
        // here rather than orphaned: a grant naming a Research that no longer
        // exists means nothing.
        dropGrantsForResearch(store, researchId);
        store.run(`DELETE FROM studies WHERE id = ?`, [researchId]);
        record("research-deleted", { researchId });
      });
    },
  };
}
