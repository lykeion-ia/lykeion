import { LykeionError, type LykeionApi, type Study, type StudyDetail } from "@lykeion/api";
import type { Deps } from "./index";
import type { Row, Store } from "../store/store";
import { nextSeq } from "../store/migrations";
import { dropGrantsForStudy } from "../store/sessions";
import { taskRowsToTasks } from "./tasks";

export type StudiesApi = Pick<
  LykeionApi,
  | "listStudies" | "getStudy" | "createStudy" | "updateStudy"
  | "archiveStudy" | "restoreStudy" | "deleteStudy"
>;

const STUDY_COLUMNS = `id, key, title, description, agent_context, created_by, archived_ts, pinned, created_ts, updated_ts`;

export function toStudy(row: Row): Study {
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

function requireStudy(store: Store, studyId: string): Row {
  const row = store.get(`SELECT ${STUDY_COLUMNS} FROM studies WHERE id = ?`, [studyId]);
  if (!row) throw new LykeionError("not-found", `no such study: ${studyId}`);
  return row;
}

export function studiesApi(deps: Deps): StudiesApi {
  const { store, actor, now } = deps;
  const { record } = deps.changes;
  return {
    async listStudies(options) {
      // Newest first, insertion sequence breaking the tie. Two Studies
      // opened in one second still come back in the order they were opened.
      const where = options?.includeArchived ? "" : "WHERE archived_ts IS NULL";
      return store
        .all(`SELECT ${STUDY_COLUMNS} FROM studies ${where} ORDER BY created_ts DESC, seq DESC`)
        .map(toStudy);
    },

    async getStudy(studyId): Promise<StudyDetail> {
      const study = toStudy(requireStudy(store, studyId));
      const tasks = taskRowsToTasks(
        store,
        // Numbers are not unique within a Study — a Task filed in from
        // elsewhere keeps the number it already had — so the insertion
        // sequence is what makes this order total rather than arbitrary.
        store.all(
          `SELECT * FROM tasks WHERE study_id = ? ORDER BY number ASC, seq ASC`,
          [studyId],
        ),
      );
      return { study, tasks };
    },

    async createStudy(input) {
      const title = input.title.trim();
      if (!title) throw new LykeionError("invalid", "study title must not be empty");
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
        record("study-created", { studyId: id });
        return toStudy(requireStudy(store, id));
      });
    },

    async updateStudy(studyId, patch) {
      return store.tx(() => {
        requireStudy(store, studyId);
        if (patch.title !== undefined) {
          const title = patch.title.trim();
          if (!title) throw new LykeionError("invalid", "study title must not be empty");
          store.run(`UPDATE studies SET title = ? WHERE id = ?`, [title, studyId]);
        }
        if (patch.description !== undefined)
          store.run(`UPDATE studies SET description = ? WHERE id = ?`, [patch.description, studyId]);
        if (patch.agentContext !== undefined)
          store.run(`UPDATE studies SET agent_context = ? WHERE id = ?`, [patch.agentContext, studyId]);
        if (patch.pinned !== undefined)
          store.run(`UPDATE studies SET pinned = ? WHERE id = ?`, [patch.pinned ? 1 : 0, studyId]);
        store.run(`UPDATE studies SET updated_ts = ? WHERE id = ?`, [now(), studyId]);
        record("study-updated", { studyId });
        return toStudy(requireStudy(store, studyId));
      });
    },

    async archiveStudy(studyId) {
      return store.tx(() => {
        const row = requireStudy(store, studyId);
        // Archiving an archived Study is not an error and must not move the
        // timestamp: the operation already happened.
        if (row.archived_ts === null) {
          store.run(`UPDATE studies SET archived_ts = ? WHERE id = ?`, [now(), studyId]);
          record("study-archived", { studyId });
        }
        return toStudy(requireStudy(store, studyId));
      });
    },

    async restoreStudy(studyId) {
      return store.tx(() => {
        const row = requireStudy(store, studyId);
        if (row.archived_ts !== null) {
          store.run(`UPDATE studies SET archived_ts = NULL WHERE id = ?`, [studyId]);
          record("study-restored", { studyId });
        }
        return toStudy(requireStudy(store, studyId));
      });
    },

    async deleteStudy(studyId) {
      store.tx(() => {
        requireStudy(store, studyId);
        // Tasks cascade; the foreign key declares it, and `PRAGMA
        // foreign_keys` is on so the database performs it. `folder_grants`
        // carries no foreign key of its own, so a Study's grants are dropped
        // here rather than orphaned: a grant naming a Study that no longer
        // exists means nothing.
        dropGrantsForStudy(store, studyId);
        store.run(`DELETE FROM studies WHERE id = ?`, [studyId]);
        record("study-deleted", { studyId });
      });
    },
  };
}
