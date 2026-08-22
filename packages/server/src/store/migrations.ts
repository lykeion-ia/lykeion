import type { SqlValue, Store } from "./store";

export interface Migration {
  version: number;
  up(store: Store): void;
}

/**
 * Every migration's `up` must run in strictly ascending version order:
 * `migrate` decides what still needs to run from `MAX(schema_version)`
 * alone, so a version out of order — or repeated — can leave a gap that
 * never gets filled once something later has already recorded a higher
 * number.
 */
export function assertAscending(migrations: Migration[]): void {
  for (let i = 1; i < migrations.length; i++) {
    if (migrations[i].version <= migrations[i - 1].version)
      throw new Error(
        `migrations must be strictly ascending: version ${migrations[i].version} ` +
          `does not follow version ${migrations[i - 1].version}`,
      );
  }
}

/**
 * Ordered, append-only. A shipped migration is never edited: a lab's
 * database has already run it, and changing it changes only what fresh
 * installs get, which is how two servers end up with different schemas
 * reporting the same version.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up(store) {
      store.run(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY)`);
      store.run(`
        CREATE TABLE users (
          id           TEXT PRIMARY KEY,
          email        TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password     TEXT NOT NULL,
          created_ts   INTEGER NOT NULL,
          seq          INTEGER NOT NULL UNIQUE
        )`);
      store.run(`
        CREATE TABLE members (
          user_id    TEXT PRIMARY KEY REFERENCES users(id),
          role       TEXT NOT NULL CHECK (role IN ('owner', 'member')),
          joined_ts  INTEGER NOT NULL,
          removed_ts INTEGER,
          seq        INTEGER NOT NULL UNIQUE
        )`);
      store.run(`
        CREATE TABLE invites (
          code        TEXT PRIMARY KEY,
          role        TEXT NOT NULL CHECK (role IN ('owner', 'member')),
          created_by  TEXT NOT NULL REFERENCES users(id),
          created_ts  INTEGER NOT NULL,
          expires_ts  INTEGER NOT NULL,
          redeemed_ts INTEGER,
          revoked_ts  INTEGER,
          seq         INTEGER NOT NULL UNIQUE
        )`);
      store.run(`
        CREATE TABLE auth_sessions (
          token      TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL REFERENCES users(id),
          created_ts INTEGER NOT NULL,
          expires_ts INTEGER NOT NULL
        )`);
      store.run(`
        CREATE TABLE user_settings (
          user_id TEXT PRIMARY KEY REFERENCES users(id),
          theme   TEXT NOT NULL
        )`);
      store.run(`
        CREATE TABLE lab_settings (
          id       INTEGER PRIMARY KEY CHECK (id = 1),
          org_name TEXT NOT NULL,
          org_id   TEXT NOT NULL
        )`);
      // The insertion sequence every ordered read tiebreaks on. One counter
      // for the whole workspace, so records written in the same second still
      // have a total order.
      store.run(`CREATE TABLE seq_counter (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)`);
      store.run(`INSERT INTO seq_counter (id, value) VALUES (1, 0)`);
    },
  },
  {
    version: 2,
    up(store) {
      store.run(`
        CREATE TABLE studies (
          id            TEXT PRIMARY KEY,
          key           TEXT NOT NULL,
          title         TEXT NOT NULL,
          description   TEXT,
          agent_context TEXT,
          created_by    TEXT NOT NULL REFERENCES users(id),
          archived_ts   INTEGER,
          created_ts    INTEGER NOT NULL,
          updated_ts    INTEGER NOT NULL,
          seq           INTEGER NOT NULL UNIQUE
        )`);
      store.run(`
        CREATE TABLE tasks (
          id              TEXT PRIMARY KEY,
          number          INTEGER NOT NULL,
          study_id        TEXT REFERENCES studies(id) ON DELETE CASCADE,
          stage           TEXT NOT NULL,
          title           TEXT NOT NULL,
          description     TEXT,
          status          TEXT NOT NULL,
          priority        TEXT NOT NULL,
          created_by      TEXT NOT NULL REFERENCES users(id),
          target_date     TEXT,
          labels          TEXT NOT NULL DEFAULT '[]',
          links           TEXT NOT NULL DEFAULT '[]',
          subtasks        TEXT NOT NULL DEFAULT '[]',
          run_count       INTEGER NOT NULL DEFAULT 0,
          last_run_status TEXT,
          pinned          INTEGER NOT NULL DEFAULT 0,
          runtime_id      TEXT,
          created_ts      INTEGER NOT NULL,
          updated_ts      INTEGER NOT NULL,
          seq             INTEGER NOT NULL UNIQUE
        )`);
      // Assignees get a table rather than a JSON column because `myWork`
      // filters on them; labels, links and subtasks are read and written
      // whole and nothing queries into them.
      store.run(`
        CREATE TABLE task_assignees (
          task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          kind     TEXT NOT NULL,
          ref      TEXT NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY (task_id, kind, ref)
        )`);
      store.run(`CREATE INDEX tasks_by_study ON tasks(study_id)`);
      store.run(`CREATE INDEX assignees_by_ref ON task_assignees(kind, ref)`);
      // Deliberately not unique. A Task keeps its number when it is filed
      // into a Research or moved between them, and every Research numbers from
      // one, so two Tasks sharing a (study_id, number) is the ordinary
      // result of filing rather than a fault to reject. What keeps a fresh
      // Task off an existing number is nextNumber inside the insert's
      // transaction; see tasks.ts. This index is here so that read, and the
      // per-Research list, do not scan the whole table.
      store.run(`CREATE INDEX tasks_number_per_study ON tasks(study_id, number)`);
      store.run(`
        CREATE TABLE change_log (
          seq      INTEGER PRIMARY KEY AUTOINCREMENT,
          ts       INTEGER NOT NULL,
          kind     TEXT NOT NULL,
          payload  TEXT NOT NULL,
          actor_id TEXT
        )`);
    },
  },
  {
    version: 3,
    up(store) {
      store.run(`
        CREATE TABLE research_groups (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          description   TEXT NOT NULL DEFAULT '',
          lead_agent    TEXT,
          member_agents TEXT NOT NULL DEFAULT '[]',
          created_ts    INTEGER NOT NULL,
          updated_ts    INTEGER NOT NULL,
          seq           INTEGER NOT NULL UNIQUE
        )`);
      store.run(`
        CREATE TABLE skills (
          name        TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          body        TEXT NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          seq         INTEGER NOT NULL UNIQUE
        )`);
      store.run(`
        CREATE TABLE agents (
          name    TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          seq     INTEGER NOT NULL UNIQUE
        )`);
      store.run(`
        CREATE TABLE workflows (
          id      TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          seq     INTEGER NOT NULL UNIQUE
        )`);
      store.run(`
        CREATE TABLE connectors (
          name            TEXT PRIMARY KEY,
          payload         TEXT NOT NULL,
          enabled         INTEGER NOT NULL DEFAULT 1,
          skip_approvals  INTEGER NOT NULL DEFAULT 0,
          seq             INTEGER NOT NULL UNIQUE
        )`);
    },
  },
  {
    version: 4,
    up(store) {
      // Pinning a Research groups the list for whoever reads it. The column
      // stores 0/1 and defaults to 0, so every Research that already exists
      // reads back unpinned — `toResearch` maps 0 to an absent key, which is
      // what the contract calls "not pinned".
      store.run(`ALTER TABLE studies ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
    },
  },
  {
    version: 5,
    up(store) {
      store.run(`
        CREATE TABLE runtimes (
          id             TEXT PRIMARY KEY,
          owner_id       TEXT NOT NULL REFERENCES users(id),
          name           TEXT NOT NULL,
          platform       TEXT NOT NULL,
          daemon_version TEXT NOT NULL,
          capabilities   TEXT NOT NULL,
          created_ts     INTEGER NOT NULL,
          last_seen_ts   INTEGER NOT NULL,
          removed_ts     INTEGER,
          seq            INTEGER NOT NULL UNIQUE
        )`);
      // Not unique: a member may pair several machines, and a unique index
      // here would answer the second one with a 500.
      store.run(`CREATE INDEX runtimes_owner ON runtimes (owner_id)`);
      store.run(`
        CREATE TABLE runtime_clis (
          runtime_id TEXT NOT NULL REFERENCES runtimes(id),
          cli_id     TEXT NOT NULL,
          name       TEXT NOT NULL,
          command    TEXT NOT NULL,
          version    TEXT NOT NULL,
          available  INTEGER NOT NULL,
          seq        INTEGER NOT NULL UNIQUE,
          PRIMARY KEY (runtime_id, cli_id)
        )`);
      store.run(`
        CREATE TABLE pair_requests (
          code_hash      TEXT PRIMARY KEY,
          challenge      TEXT NOT NULL,
          owner_id       TEXT NOT NULL REFERENCES users(id),
          name           TEXT NOT NULL,
          platform       TEXT NOT NULL,
          daemon_version TEXT NOT NULL,
          redirect       TEXT NOT NULL,
          created_ts     INTEGER NOT NULL,
          expires_ts     INTEGER NOT NULL,
          spent_ts       INTEGER,
          seq            INTEGER NOT NULL UNIQUE
        )`);
      store.run(`
        CREATE TABLE machine_tokens (
          token_hash TEXT PRIMARY KEY,
          runtime_id TEXT NOT NULL REFERENCES runtimes(id),
          owner_id   TEXT NOT NULL REFERENCES users(id),
          created_ts INTEGER NOT NULL,
          revoked_ts INTEGER,
          seq        INTEGER NOT NULL UNIQUE
        )`);
    },
  },
  {
    version: 6,
    up(store) {
      // A profile picture, as the `data:image/…` URL the contract carries on
      // `User`. Nullable with no default, so every member who already exists
      // reads back with no picture — `toUser` maps NULL to an absent key,
      // which is what the contract calls "has not set one".
      //
      // On `users` rather than `user_settings`: the roster joins `users` to
      // render a row, and a picture kept in the settings table would need a
      // second join on every list to draw a face the contract says is part of
      // the identity.
      store.run(`ALTER TABLE users ADD COLUMN avatar_url TEXT`);
    },
  },
  {
    version: 7,
    up(store) {
      // A session is the ACP conversation state living on one runtime for
      // one Research and agent. It names no Task of its own — a Task's live
      // session is found through the turn that already ties one to it,
      // which is what lets one session outlive several turns filed under
      // different Tasks in the same Research.
      store.run(`
        CREATE TABLE sessions (
          id         TEXT PRIMARY KEY,
          study_id   TEXT NOT NULL,
          runtime_id TEXT NOT NULL,
          agent      TEXT NOT NULL,
          opened_by  TEXT NOT NULL,
          opened_ts  INTEGER NOT NULL,
          ended_ts   INTEGER,
          seq        INTEGER NOT NULL UNIQUE
        )`);
      // A turn is a run: one prompt and its answer, filed against exactly
      // one Task. `text` accumulates the assistant's prose as it streams so
      // a reload mid-turn has something to show before the turn ends.
      store.run(`
        CREATE TABLE turns (
          id         TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          task_id    TEXT NOT NULL,
          prompt     TEXT NOT NULL,
          started_ts INTEGER NOT NULL,
          ended_ts   INTEGER,
          status     TEXT NOT NULL,
          text       TEXT NOT NULL DEFAULT '',
          seq        INTEGER NOT NULL UNIQUE
        )`);
      store.run(`
        CREATE TABLE turn_steps (
          id          TEXT PRIMARY KEY,
          turn_id     TEXT NOT NULL,
          ts          INTEGER NOT NULL,
          tool_use_id TEXT NOT NULL,
          tool        TEXT NOT NULL,
          title       TEXT,
          input       TEXT NOT NULL,
          decision    TEXT NOT NULL,
          result      TEXT,
          is_error    INTEGER NOT NULL,
          seq         INTEGER NOT NULL UNIQUE
        )`);
      // A standing grant is scoped to (research, runtime) rather than to the
      // Research alone: the path it names only means anything on the
      // filesystem of the machine it was granted for.
      store.run(`
        CREATE TABLE folder_grants (
          id         TEXT PRIMARY KEY,
          study_id   TEXT NOT NULL,
          runtime_id TEXT NOT NULL,
          path       TEXT NOT NULL,
          mode       TEXT NOT NULL,
          granted_by TEXT NOT NULL,
          granted_ts INTEGER NOT NULL,
          revoked_ts INTEGER,
          seq        INTEGER NOT NULL UNIQUE
        )`);
    },
  },
  {
    version: 8,
    up(store) {
      // Whether a report's CLI actually handshakes an ACP adapter, and — when
      // it does not — the adapter's own account of why. Every row already on
      // disk predates a daemon ever checking this, so the default reads back
      // as "not session-ready" rather than a claim no probe ever made.
      store.run(`ALTER TABLE runtime_clis ADD COLUMN session_ready INTEGER NOT NULL DEFAULT 0`);
      store.run(`ALTER TABLE runtime_clis ADD COLUMN session_ready_reason TEXT`);
    },
  },
  {
    version: 9,
    up(store) {
      store.run(`
        CREATE TABLE turn_items (
          id      TEXT PRIMARY KEY,
          turn_id TEXT NOT NULL,
          kind    TEXT NOT NULL CHECK (kind IN ('text', 'step')),
          text    TEXT,
          partial INTEGER,
          step_id TEXT,
          seq     INTEGER NOT NULL UNIQUE,
          CHECK (
            (kind = 'text' AND text IS NOT NULL AND partial IN (0, 1) AND step_id IS NULL)
            OR
            (kind = 'step' AND text IS NULL AND partial IS NULL AND step_id IS NOT NULL)
          )
        )`);

      // Aggregate transcripts cannot reveal how prose and tools originally
      // interleaved. Preserve the only deterministic representation they did
      // expose: prose first, followed by execution entries in insertion order.
      for (const turn of store.all(`SELECT id, text FROM turns ORDER BY seq ASC`)) {
        if (turn.text !== "") {
          const seq = nextSeq(store);
          store.run(
            `INSERT INTO turn_items (id, turn_id, kind, text, partial, seq)
             VALUES (?, ?, 'text', ?, 0, ?)`,
            [`item_${seq}`, turn.id, turn.text, seq],
          );
        }
        for (const step of store.all(
          `SELECT id FROM turn_steps WHERE turn_id = ? ORDER BY seq ASC`,
          [turn.id],
        )) {
          const seq = nextSeq(store);
          store.run(
            `INSERT INTO turn_items (id, turn_id, kind, step_id, seq)
             VALUES (?, ?, 'step', ?, ?)`,
            [`item_${seq}`, turn.id, step.id, seq],
          );
        }
      }
    },
  },
  {
    version: 10,
    up(store) {
      // Daemon frames start at one. Zero therefore names the initial turn
      // before any frame has been accepted and gives ingestion an exact
      // next sequence to require after a restart.
      store.run(`ALTER TABLE turns ADD COLUMN last_frame_seq INTEGER NOT NULL DEFAULT 0`);
      // Recovery JSON is explicitly versioned so a later shape can migrate
      // old rows rather than asking readers to guess which fields existed.
      // Existing rows retain the default until the later recovery-policy
      // migration can evaluate active turns after every prerequisite column
      // exists. Settled rows keep it as harmless historical data.
      store.run(
        `ALTER TABLE turns ADD COLUMN recovery_snapshot TEXT NOT NULL DEFAULT
         '{"version":1,"state":{"state":"planning"},"stream":[],"live":{},"reviewing":false}'`,
      );
    },
  },
  {
    version: 11,
    up(store) {
      // Provenance is optional on the wire: NULL means an older step made no
      // claim, while 1 preserves the explicit fact that access escaped the
      // Research workspace. False is represented by absence, as on the contract.
      store.run(`ALTER TABLE turn_steps ADD COLUMN outside_workspace INTEGER`);
    },
  },
  {
    version: 12,
    up(store) {
      const streamFor = (turnId: SqlValue): Array<Record<string, unknown>> => {
        const stream: Array<Record<string, unknown>> = [];
        let joiningPartial = false;
        for (const item of store.all(
          `SELECT i.kind, i.text, i.partial,
                  s.ts, s.tool_use_id, s.tool, s.title, s.input, s.decision, s.result, s.is_error,
                  s.outside_workspace
             FROM turn_items i
             LEFT JOIN turn_steps s ON s.id = i.step_id
            WHERE i.turn_id = ?
            ORDER BY i.seq ASC`,
          [turnId],
        )) {
          if (item.kind === "text") {
            if (item.partial === 1 && joiningPartial) {
              const previous = stream.at(-1);
              if (previous?.kind === "text")
                previous.text = `${previous.text as string}${item.text as string}`;
            } else {
              stream.push({ kind: "text", text: item.text as string });
            }
            joiningPartial = item.partial === 1;
            continue;
          }

          joiningPartial = false;
          stream.push({
            kind: "step",
            entry: {
              ts: item.ts as number,
              toolUseId: item.tool_use_id as string,
              tool: item.tool as string,
              ...(item.title === null ? {} : { title: item.title as string }),
              input: JSON.parse(item.input as string) as unknown,
              decision: item.decision as string,
              ...(item.result === null ? {} : { result: item.result as string }),
              isError: item.is_error === 1,
              ...(item.outside_workspace === 1 ? { outsideWorkspace: true } : {}),
            },
          });
        }
        return stream;
      };

      // Servers through v9 had no durable daemon-frame cursor or recoverable
      // control snapshot. An active turn crossing that upgrade boundary
      // cannot safely continue: accepting its next non-one sequence would
      // conceal missing frames, while resetting it to planning would conceal
      // any pending gate. Preserve the complete transcript and provenance,
      // but terminally fail the execution and end its session.
      const failedAt = Math.floor(Date.now() / 1000);
      const reason = "This turn was active during a server upgrade and could not be safely resumed.";
      const legacySettledTurns = store.all(
        `SELECT id, status, task_id FROM turns
          WHERE ended_ts IS NOT NULL
            AND last_frame_seq = 0
          ORDER BY seq ASC`,
      );
      const legacyActiveTurns = store.all(
        `SELECT id, session_id, task_id FROM turns
          WHERE ended_ts IS NULL
            AND last_frame_seq = 0
          ORDER BY seq ASC`,
      );
      const activeTaskIds = new Set(legacyActiveTurns.map((turn) => turn.task_id as string));
      for (const turn of legacyActiveTurns) {
        const stream = streamFor(turn.id);

        store.run(
          `UPDATE turns
              SET ended_ts = ?, status = 'failed', recovery_snapshot = ?
            WHERE id = ?`,
          [
            failedAt,
            JSON.stringify({
              version: 1,
              state: { state: "failed", reason },
              stream,
              live: {},
              reviewing: false,
            }),
            turn.id,
          ],
        );
        store.run(
          `UPDATE sessions SET ended_ts = ? WHERE id = ? AND ended_ts IS NULL`,
          [failedAt, turn.session_id],
        );
      }

      // The same default planning snapshot also sits on every pre-v10 turn
      // that was already settled. Repair only that recovery projection so a
      // direct terminal run stream closes immediately; settlement timestamps,
      // sessions, and Task rollups are already authoritative and unchanged.
      const legacyFailureReason =
        "This failed turn predates durable recovery state; its transcript was preserved.";
      for (const turn of legacySettledTurns) {
        const status = turn.status as string;
        const state =
          status === "ok"
            ? { state: "completed" }
            : status === "cancelled" || status === "cancelled-unacknowledged"
              ? {
                  state: "cancelled",
                  ...(status === "cancelled-unacknowledged" ? { unacknowledged: true } : {}),
                }
              : { state: "failed", reason: legacyFailureReason };
        store.run(`UPDATE turns SET recovery_snapshot = ? WHERE id = ?`, [
          JSON.stringify({
            version: 1,
            state,
            stream: streamFor(turn.id),
            live: {},
            reviewing: false,
          }),
          turn.id,
        ]);
      }

      // Task rollups did not exist for every turn written before this
      // migration, including v10/v11 rows whose durable frame cursor is above
      // zero. Recompute them once from the authoritative settled set. Only a
      // Task whose active turn was terminalized above receives a fresh
      // updated_ts; repairing already-settled history must not make an old
      // Task look new. Deliberately leave Task status untouched: the schema
      // cannot distinguish the historical default `todo` from a researcher
      // intentionally resetting a completed Task to `todo` later.
      const touchedTaskIds = new Set(
        store
          .all(`SELECT DISTINCT task_id FROM turns WHERE ended_ts IS NOT NULL`)
          .map((turn) => turn.task_id as string),
      );
      for (const taskId of touchedTaskIds) {
        const settled = store.get(
          `SELECT COUNT(*) AS run_count FROM turns
            WHERE task_id = ? AND ended_ts IS NOT NULL`,
          [taskId],
        )!;
        const latestStatus = store.get(
          `SELECT status FROM turns
            WHERE task_id = ? AND ended_ts IS NOT NULL
            ORDER BY seq DESC LIMIT 1`,
          [taskId],
        )?.status as string | undefined;
        if (activeTaskIds.has(taskId)) {
          store.run(
            `UPDATE tasks
                SET run_count = ?, last_run_status = ?, updated_ts = ?
              WHERE id = ?`,
            [settled.run_count, latestStatus === "ok" ? "ok" : "failed", failedAt, taskId],
          );
        } else {
          store.run(
            `UPDATE tasks SET run_count = ?, last_run_status = ? WHERE id = ?`,
            [settled.run_count, latestStatus === "ok" ? "ok" : "failed", taskId],
          );
        }
      }
    },
  },
  {
    version: 13,
    up(store) {
      // Legacy rows deliberately remain NULL: readers render them as ordinary
      // prose rather than guessing a thought/final boundary that was never
      // recorded. New rows carry the provider-visible block role explicitly.
      store.run(`ALTER TABLE turn_items ADD COLUMN block TEXT`);
    },
  },
  {
    version: 14,
    up(store) {
      // v12 still allowed several unfinished turns for one Task. Keep the
      // highest-sequence turn recoverable and settle every older sibling
      // deterministically before installing the durable constraint.
      const failedAt = Math.floor(Date.now() / 1000);
      const reason =
        "This turn was superseded while upgrading to one active run per Task.";
      const superseded = store.all(
        `SELECT t.id, t.session_id, t.task_id, t.recovery_snapshot
           FROM turns t
          WHERE t.ended_ts IS NULL
            AND EXISTS (
              SELECT 1 FROM turns newer
               WHERE newer.task_id = t.task_id
                 AND newer.ended_ts IS NULL
                 AND newer.seq > t.seq
            )
          ORDER BY t.seq ASC`,
      );
      const touchedTaskIds = new Set<string>();
      for (const turn of superseded) {
        const recovery = JSON.parse(
          turn.recovery_snapshot as string,
        ) as Record<string, unknown>;
        store.run(
          `UPDATE turns
              SET ended_ts = ?, status = 'failed', recovery_snapshot = ?
            WHERE id = ?`,
          [
            failedAt,
            JSON.stringify({
              ...recovery,
              state: { state: "failed", reason },
              live: {},
              reviewing: false,
            }),
            turn.id,
          ],
        );
        store.run(
          `UPDATE sessions SET ended_ts = ?
            WHERE id = ? AND ended_ts IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM turns WHERE session_id = ? AND ended_ts IS NULL
              )`,
          [failedAt, turn.session_id, turn.session_id],
        );
        touchedTaskIds.add(turn.task_id as string);
      }
      for (const taskId of touchedTaskIds) {
        const settled = store.get(
          `SELECT COUNT(*) AS run_count
             FROM turns WHERE task_id = ? AND ended_ts IS NOT NULL`,
          [taskId],
        )!;
        const latestStatus = store.get(
          `SELECT status FROM turns
            WHERE task_id = ? AND ended_ts IS NOT NULL
            ORDER BY seq DESC LIMIT 1`,
          [taskId],
        )?.status as string | undefined;
        store.run(
          `UPDATE tasks
              SET run_count = ?, last_run_status = ?, updated_ts = ?
            WHERE id = ?`,
          [
            settled.run_count,
            latestStatus === "ok" ? "ok" : "failed",
            failedAt,
            taskId,
          ],
        );
      }
      store.run(
        `CREATE UNIQUE INDEX one_active_turn_per_task
             ON turns(task_id) WHERE ended_ts IS NULL`,
      );
    },
  },
  {
    version: 15,
    up(store) {
      // `result` holds an output that is entirely text. An output carrying a
      // piece that is not text — a diff, a terminal, a reference to a
      // resource — is held here as JSON instead, in its own column so the two
      // can never be confused for one another: a text result that happens to
      // read like JSON is still a text result. Exactly one of the two is ever
      // set, and both NULL is the distinct fact that no output was reported.
      store.run(`ALTER TABLE turn_steps ADD COLUMN result_parts TEXT`);
    },
  },
  {
    version: 16,
    up(store) {
      // Whether the machine took a snapshot of this turn's working directory
      // before the turn started, and when it did not, why. NULL is a turn
      // recorded before a snapshot was taken at all: the control is not
      // offered rather than offered and unable to restore anything.
      store.run(`ALTER TABLE turns ADD COLUMN snapshot_taken INTEGER`);
      store.run(`ALTER TABLE turns ADD COLUMN snapshot_reason TEXT`);
    },
  },
  {
    version: 17,
    up(store) {
      // What an agent advertised when a session was opened with it, as JSON.
      // NULL is a CLI no session could be opened to ask, which is a
      // different fact from one that advertised nothing and is never
      // rendered as the first.
      store.run(`ALTER TABLE runtime_clis ADD COLUMN options TEXT`);
    },
  },
  {
    version: 18,
    up(store) {
      // A Task may now hold several turns at once: one running and the rest
      // waiting behind it, which is what lets a researcher say the next thing
      // while they are still thinking it rather than waiting for the agent.
      //
      // They queue rather than run together — every turn on a Task lands on
      // the session already open for it, and a session runs one turn at a
      // time — so what this index was protecting, two agents writing one
      // Task's directory at once, is still not something that can happen.
      store.run(`DROP INDEX IF EXISTS one_active_turn_per_task`);
    },
  },
  {
    version: 19,
    up(store) {
      // The block role `thought` is now `thinking`, matching the live channel
      // that has always been called that. The value is STORED, not derived, so
      // every transcript recorded before the rename still carries the old
      // string — and a block that no longer matches the check is not a
      // cosmetic problem: it stops being routed into the thinking channel,
      // renders as ordinary prose, and gets copied to the clipboard as though
      // it were the agent's answer. That channel exists precisely so thinking
      // cannot be taken for the answer.
      store.run(`UPDATE turn_items SET block = 'thinking' WHERE block = 'thought'`);

      // `turns.recovery_snapshot` holds a JSON copy of the same stream, kept
      // as a derived cache (`recovery.stream = turnStream(...)` after every
      // frame). A settled turn takes no more frames, so nothing would ever
      // rebuild it — the rows above would say `thinking` while the snapshot
      // any reader actually loads still said `thought`.
      //
      // Replacing the serialized pair is exact rather than approximate: a
      // quote inside a JSON string is written `\"`, so this unescaped byte
      // sequence cannot occur inside a message's text. It only ever matches a
      // real key and value.
      store.run(
        `UPDATE turns
            SET recovery_snapshot = REPLACE(
                  recovery_snapshot, '"block":"thought"', '"block":"thinking"')
          WHERE recovery_snapshot LIKE '%"block":"thought"%'`,
      );
    },
  },
  {
    version: 20,
    up(store) {
      // A cell is durable and the directory it ran in is not: a Task's
      // workspace is swept, and what was computed in it has to outlive that.
      store.run(`
        CREATE TABLE cells (
          id              TEXT PRIMARY KEY,
          task_id         TEXT NOT NULL,
          session_id      TEXT NOT NULL,
          kernel_id       TEXT NOT NULL,
          name            TEXT NOT NULL,
          language        TEXT NOT NULL,
          environment     TEXT NOT NULL,
          execution_count INTEGER NOT NULL,
          source          TEXT NOT NULL,
          origin_surface  TEXT NOT NULL CHECK (origin_surface IN ('agent', 'repl')),
          origin_by       TEXT NOT NULL,
          ok              INTEGER NOT NULL,
          wall_ms         INTEGER NOT NULL,
          ts              INTEGER NOT NULL,
          outputs         TEXT NOT NULL,
          tool_use_id     TEXT,
          seq             INTEGER NOT NULL UNIQUE
        )`);
      store.run(`CREATE INDEX cells_by_task ON cells(task_id, seq)`);
    },
  },
  {
    version: 21,
    up(store) {
      // Which Tasks a session has actually taken a turn for is now asked on
      // the way in, of every kernel a machine reports and of every cell it
      // posts — a Notebook rail open on one Task asks it once per kernel
      // every poll. `turns` is the widest table this workspace has, holding
      // a recovery snapshot and a frame cursor per row, so the same question
      // answered by a scan is the whole of that table read to answer
      // something two columns already say.
      store.run(`CREATE INDEX turns_by_session_task ON turns(session_id, task_id)`);
    },
  },
  {
    version: 22,
    up(store) {
      // What a machine now says about each agent beyond whether it can run:
      // whether the CLI is signed in, as whom, why it is held back when
      // nothing the researcher does would change that, and who published the
      // adapter it would be run through.
      //
      // `signed_in` is nullable rather than defaulted, and that is the whole
      // point of the column. NULL is "nothing asked" — not installed, no
      // adapter, an isolation that could not be demonstrated — and 0 is a CLI
      // that was asked and said no. Only the second earns a sign-in control;
      // a default would turn every unasked row into a button that spawns
      // nothing.
      store.run(`ALTER TABLE runtime_clis ADD COLUMN signed_in INTEGER`);
      store.run(`ALTER TABLE runtime_clis ADD COLUMN account TEXT`);
      store.run(`ALTER TABLE runtime_clis ADD COLUMN held_back_reason TEXT`);
      store.run(`ALTER TABLE runtime_clis ADD COLUMN adapter_provenance TEXT`);
    },
  },
  {
    version: 23,
    up(store) {
      // Nullable with no default, deliberately: a machine whose daemon
      // predates this report has not said "zero cores" or "no memory" — it
      // has said nothing, and NULL is what lets the read path tell the two
      // apart.
      store.run(`ALTER TABLE runtimes ADD COLUMN total_memory_bytes INTEGER`);
      store.run(`ALTER TABLE runtimes ADD COLUMN cores INTEGER`);
    },
  },
  {
    version: 24,
    up(store) {
      // `kernels_ready` follows `signed_in`'s own rule: NULL is "never
      // checked" — a daemon too old to probe the floor at all — 0 is
      // "checked and failed", and only the second is a claim this machine
      // cannot host a kernel. A default of 0 here would tell every machine
      // paired before this shipped that it had already failed a check that
      // never ran.
      store.run(`ALTER TABLE runtimes ADD COLUMN kernels_ready INTEGER`);
      // Set only alongside kernels_ready = 0 — see `probeKernelFloor`, whose
      // `reason` is never present when `ready` is true.
      store.run(`ALTER TABLE runtimes ADD COLUMN kernels_reason TEXT`);
      // Which process-visibility rule this machine's own platform applies,
      // as the machine itself reported it — never derived here from
      // `platform`, which two machines can share while owing a researcher
      // different answers (a Linux box mounted with hidepid and one without).
      store.run(`ALTER TABLE runtimes ADD COLUMN process_visibility TEXT`);
    },
  },
  {
    version: 25,
    up(store) {
      // The declaration: what an environment IS, lab-wide. Deliberately
      // holds no path and no build state — those are facts about one
      // machine, and a machine can hold a build for a declaration this
      // table has already removed.
      //
      // Deleting one is a hard delete, not a tombstone: nothing anywhere
      // consumes "this name used to exist" as distinct from "this name was
      // never declared", and an UPSERT that resurrected a soft-deleted row
      // would risk reviving its old `lock_revision` — a machine holding the
      // OLD build would then read as current, which is the exact silent
      // wrong-version failure this phase exists to prevent.
      store.run(`
        CREATE TABLE kernel_envs (
          name          TEXT PRIMARY KEY,
          language      TEXT NOT NULL CHECK (language IN ('python', 'r')),
          manager       TEXT NOT NULL CHECK (manager IN ('uv', 'conda')),
          packages      TEXT NOT NULL,
          -- Nullable (R14): absent means Lykeion declared it, not a person.
          -- The python starter is seeded on a fresh lab, before any user
          -- exists to own it -- SQLite's own foreign-key check does not
          -- apply to a NULL value, so this is compatible with
          -- foreign_keys = ON on a lab with nobody signed up yet.
          created_by    TEXT REFERENCES users(id),
          created_ts    INTEGER NOT NULL,
          lock_revision INTEGER NOT NULL DEFAULT 0
        )`);
      // Every revision kept, never just the newest. A machine reports the
      // revision it built from, and "one behind" is only readable if the
      // older one is still here to be named.
      store.run(`
        CREATE TABLE kernel_env_locks (
          name       TEXT NOT NULL REFERENCES kernel_envs(name),
          revision   INTEGER NOT NULL,
          lockfile   TEXT NOT NULL,
          written_ts INTEGER NOT NULL,
          PRIMARY KEY (name, revision)
        )`);
    },
  },
  {
    version: 26,
    up(store) {
      // What a machine last reported holding, one JSON-encoded
      // `KernelEnvStatus[]` per row, written by `/daemon/report` alongside
      // `total_memory_bytes`/`cores`/`kernels_ready` — the same "machine's
      // regular report" mechanism, not a live per-poll fan-out. NULL is
      // "never reported" and stays NULL until a report actually carries the
      // field, the same three-valued discipline `kernels_ready` already
      // follows: a daemon too old to report this, and a machine that
      // reported holding nothing, must not read alike.
      //
      // Persisted rather than asked live (the way `listRunningKernels` asks
      // for kernels on every poll) so an OFFLINE machine still says what it
      // holds: kernels change every cell and are worth re-asking, but an
      // environment changes on the order of minutes-to-never, and D2's "the
      // lab's list is the truth about what exists; each machine's report is
      // the truth about what is built" only holds for an offline machine if
      // that report is remembered rather than re-asked.
      store.run(`ALTER TABLE runtimes ADD COLUMN environments TEXT`);
    },
  },
  {
    version: 27,
    up(store) {
      // Repairs a database that ran an EARLIER draft of version 25, in which
      // `created_by` was `NOT NULL`. Version 25 was edited in place while
      // this feature was still unmerged — legitimate for a migration no lab
      // has shipped — but a developer who ran the lab locally mid-branch has
      // the old shape, and `seedLabContent` declares the starter with no
      // creator (R14). Against `NOT NULL` that throws inside `startServer`
      // and the server never finishes booting.
      //
      // SQLite cannot relax a column's nullability in place, so this is the
      // create-copy-drop-rename dance. It is a destructive rebuild, so it
      // runs only where the broken shape is actually on disk: `PRAGMA
      // table_info` says whether `created_by` is still NOT NULL, and a
      // database that already has the nullable column — every fresh install,
      // which gets 25's final text — is left alone entirely.
      const createdBy = store
        .all(`PRAGMA table_info(kernel_envs)`)
        .find((column) => column.name === "created_by");
      // Already nullable — the shape this migration exists to produce.
      if (createdBy === undefined || createdBy.notnull === 0) return;

      // No PRAGMA can help here. `migrate` runs every migration inside
      // `store.tx()`, which issues BEGIN (`sqlite.ts:62`), and `PRAGMA
      // foreign_keys` is a documented no-op inside a transaction — so
      // enforcement stays ON however this asks for it, and `DROP TABLE
      // kernel_envs` performs an implicit DELETE that `kernel_env_locks.name
      // REFERENCES kernel_envs(name)` refuses the moment a single pin
      // exists. `defer_foreign_keys` does not rescue it either.
      //
      // The ORDERING does the work the PRAGMA appeared to: drop the CHILD
      // first, so the parent's drop has no referencing table left to
      // violate, and carry the pins through the gap in a holding pen of
      // their own. `ALTER TABLE ... RENAME TO` also has nothing to rewrite
      // by then, since no table references `kernel_envs_rebuilt`.
      store.run(`
        CREATE TABLE kernel_envs_rebuilt (
          name          TEXT PRIMARY KEY,
          language      TEXT NOT NULL CHECK (language IN ('python', 'r')),
          manager       TEXT NOT NULL CHECK (manager IN ('uv', 'conda')),
          packages      TEXT NOT NULL,
          created_by    TEXT REFERENCES users(id),
          created_ts    INTEGER NOT NULL,
          lock_revision INTEGER NOT NULL DEFAULT 0
        )`);
      store.run(`
        INSERT INTO kernel_envs_rebuilt
          (name, language, manager, packages, created_by, created_ts, lock_revision)
        SELECT name, language, manager, packages, created_by, created_ts, lock_revision
          FROM kernel_envs`);

      // A holding pen with no foreign key of its own, so the pins survive the
      // window in which their parent table does not exist.
      store.run(`
        CREATE TABLE kernel_env_locks_carried (
          name       TEXT NOT NULL,
          revision   INTEGER NOT NULL,
          lockfile   TEXT NOT NULL,
          written_ts INTEGER NOT NULL,
          PRIMARY KEY (name, revision)
        )`);
      store.run(`
        INSERT INTO kernel_env_locks_carried (name, revision, lockfile, written_ts)
        SELECT name, revision, lockfile, written_ts FROM kernel_env_locks`);

      // Child first: dropping a referencing table never violates anything.
      store.run(`DROP TABLE kernel_env_locks`);
      // Now parentless, so the implicit DELETE has no constraint left to break.
      store.run(`DROP TABLE kernel_envs`);
      store.run(`ALTER TABLE kernel_envs_rebuilt RENAME TO kernel_envs`);

      // Recreated with its foreign key intact, against a parent that now holds
      // every row it did before.
      store.run(`
        CREATE TABLE kernel_env_locks (
          name       TEXT NOT NULL REFERENCES kernel_envs(name),
          revision   INTEGER NOT NULL,
          lockfile   TEXT NOT NULL,
          written_ts INTEGER NOT NULL,
          PRIMARY KEY (name, revision)
        )`);
      store.run(`
        INSERT INTO kernel_env_locks (name, revision, lockfile, written_ts)
        SELECT name, revision, lockfile, written_ts FROM kernel_env_locks_carried`);
      store.run(`DROP TABLE kernel_env_locks_carried`);
    },
  },
  {
    version: 28,
    up(store) {
      // The package list this lab actually asked a machine to RESOLVE this
      // lockfile from, JSON-encoded, so that "is this pin still the pin for
      // what the declaration now says" is DERIVED rather than flagged.
      //
      // A "needs resolve" flag would be a second source of truth about the
      // declaration, and it drifts from the declaration the first time
      // anything writes one without the other. This column cannot drift: it
      // is what was sent, written beside the lockfile it produced, and
      // the setup plan compares it against the declaration's `packages` as
      // they stand right now.
      //
      // NULL is "this lab cannot name what that pin was resolved from" — a
      // row written before this column existed. Not "resolved from nothing",
      // which is what an invented `'[]'` here would claim, and which would
      // have a machine replay a lockfile against a declaration this lab has
      // no evidence matches. See `planFor` for why the absence widens to a
      // resolve instead.
      store.run(`ALTER TABLE kernel_env_locks ADD COLUMN requested_packages TEXT`);
    },
  },
  {
    version: 29,
    up(store) {
      // What a cell installed into the kernel that ran it and nowhere else,
      // JSON-encoded. A `pip install` inside a cell lands in a
      // per-incarnation overlay under the Task's own directory: it works, and
      // it is gone the next time that kernel restarts — so the cell is the
      // only place the fact can be kept at all, and it is also exactly where
      // a researcher scrolling back next week goes looking for it.
      //
      // NULL is "this cell installed nothing", and it is also every cell
      // recorded before this column existed. Both read the same way to a
      // reader — there is nothing to show here — which is why they can share
      // a spelling, and why the spelling is NULL rather than `'[]'`: an
      // empty array is a claim that this lab looked and found none, made
      // about rows nobody ever looked at.
      store.run(`ALTER TABLE cells ADD COLUMN installed TEXT`);
    },
  },
  {
    version: 30,
    up(store) {
      // Workflows are gone from the product. The table goes with them rather
      // than being left unread: a table nothing writes and nothing reads is
      // one the next person has to work out the status of before they can
      // touch anything near it. Nothing referenced `workflows` by foreign
      // key, so this drops cleanly and needs no rebuild.
      store.run(`DROP TABLE IF EXISTS workflows`);
    },
  },
  {
    version: 31,
    up(store) {
      // A Group holds colleagues as well as Experts now. A plain add, not a
      // rebuild: nothing about the existing columns changes, and the default
      // gives every group written before this an honest empty list rather
      // than a NULL that every reader would have to decode.
      store.run(
        `ALTER TABLE research_groups ADD COLUMN member_users TEXT NOT NULL DEFAULT '[]'`,
      );
    },
  },
  {
    version: 32,
    up(store) {
      // Nullable, and optional on the contract beside it: every cell already
      // in this table ran before anything wrote an envelope, and a default
      // here would be this lab inventing a record for them.
      store.run(`ALTER TABLE cells ADD COLUMN provenance_id TEXT`);
      // The body is kept whole, in the canonical form its id is the hash of.
      // A form rebuilt out of columns could not be verified against that id,
      // and a later version of the envelope stores here unchanged rather
      // than needing a migration to hold new fields.
      store.run(`
        CREATE TABLE provenance_envelopes (
          id         TEXT PRIMARY KEY,
          version    TEXT NOT NULL,
          body       TEXT NOT NULL,
          task_id    TEXT NOT NULL,
          session_id TEXT NOT NULL,
          ts         INTEGER NOT NULL,
          seq        INTEGER NOT NULL UNIQUE
        )`);
      store.run(`CREATE INDEX provenance_by_task ON provenance_envelopes(task_id, seq)`);
    },
  },
  {
    version: 33,
    up(store) {
      store.run(
        `ALTER TABLE turns ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'
          CHECK (origin IN ('user', 'system'))`,
      );
      store.run(`ALTER TABLE turns ADD COLUMN continuation TEXT`);
      store.run(`
        CREATE TABLE kernel_env_setup_jobs (
          id                TEXT PRIMARY KEY,
          runtime_id        TEXT NOT NULL REFERENCES runtimes(id),
          environment_name  TEXT NOT NULL,
          language          TEXT NOT NULL CHECK (language IN ('python', 'r')),
          manager           TEXT NOT NULL CHECK (manager IN ('uv', 'conda')),
          lock_revision     INTEGER NOT NULL,
          request_id        TEXT NOT NULL UNIQUE,
          resolved_from     TEXT,
          reason            TEXT,
          state             TEXT NOT NULL CHECK (state IN ('requested', 'building', 'ready', 'failed')),
          stage             TEXT NOT NULL CHECK (stage IN ('waiting-for-machine', 'resolving', 'installing', 'finalizing')),
          error_summary     TEXT,
          log               TEXT NOT NULL DEFAULT '[]',
          requested_ts      INTEGER NOT NULL,
          started_ts        INTEGER,
          finished_ts       INTEGER,
          updated_ts        INTEGER NOT NULL,
          seq               INTEGER NOT NULL UNIQUE
        )`);
      store.run(`
        CREATE UNIQUE INDEX one_active_environment_build
          ON kernel_env_setup_jobs(runtime_id, environment_name, lock_revision)
          WHERE state IN ('requested', 'building')`);
      store.run(`
        CREATE TABLE kernel_env_setup_interests (
          job_id       TEXT NOT NULL REFERENCES kernel_env_setup_jobs(id) ON DELETE CASCADE,
          study_id     TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
          task_id      TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          requested_by TEXT NOT NULL REFERENCES users(id),
          requested_ts INTEGER NOT NULL,
          PRIMARY KEY (job_id, task_id)
        )`);
      // A structured requirement exists before a researcher chooses Set up,
      // so job_id is intentionally nullable until an exact physical attempt
      // is requested. The source/environment/runtime uniqueness keeps that
      // unattached requirement idempotent.
      store.run(`
        CREATE TABLE task_env_setup_waiters (
          id                   TEXT PRIMARY KEY,
          job_id               TEXT REFERENCES kernel_env_setup_jobs(id) ON DELETE CASCADE,
          study_id             TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
          task_id              TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          session_id           TEXT NOT NULL REFERENCES sessions(id),
          source_turn_id       TEXT NOT NULL REFERENCES turns(id),
          source_run_id        TEXT NOT NULL,
          language             TEXT NOT NULL CHECK (language IN ('python', 'r')),
          environment_name     TEXT NOT NULL,
          runtime_id           TEXT NOT NULL REFERENCES runtimes(id),
          state                TEXT NOT NULL CHECK (state IN ('waiting', 'queued', 'resumed', 'cancelled')),
          continuation_turn_id TEXT UNIQUE REFERENCES turns(id),
          cancelled_reason     TEXT,
          created_ts           INTEGER NOT NULL,
          updated_ts           INTEGER NOT NULL,
          seq                  INTEGER NOT NULL UNIQUE,
          UNIQUE (source_turn_id, environment_name, runtime_id)
        )`);
      store.run(`
        CREATE TABLE research_environment_defaults (
          study_id         TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
          language         TEXT NOT NULL CHECK (language IN ('python', 'r')),
          environment_name TEXT NOT NULL,
          set_by           TEXT NOT NULL REFERENCES users(id),
          set_ts           INTEGER NOT NULL,
          PRIMARY KEY (study_id, language)
        )`);
      store.run(`
        CREATE TABLE environment_default_suggestions (
          id               TEXT PRIMARY KEY,
          job_id           TEXT NOT NULL REFERENCES kernel_env_setup_jobs(id) ON DELETE CASCADE,
          study_id         TEXT NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
          task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          language         TEXT NOT NULL CHECK (language IN ('python', 'r')),
          environment_name TEXT NOT NULL,
          state            TEXT NOT NULL CHECK (state IN ('pending', 'accepted', 'declined')),
          created_ts       INTEGER NOT NULL,
          answered_ts      INTEGER,
          answered_by      TEXT REFERENCES users(id),
          seq              INTEGER NOT NULL UNIQUE,
          UNIQUE (job_id, study_id, language)
        )`);
      store.run(`
        CREATE TABLE session_permission_grants (
          session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          capability  TEXT NOT NULL CHECK (capability = 'environment-mutation'),
          target      TEXT NOT NULL,
          granted_by  TEXT NOT NULL REFERENCES users(id),
          granted_ts  INTEGER NOT NULL,
          PRIMARY KEY (session_id, capability, target)
        )`);
    },
  },
  {
    version: 34,
    up(store) {
      // An early Task 2 build could ask the same Research/language question
      // once per ready physical attempt. Preserve the oldest visible question
      // and discard only its still-unanswered duplicates before installing the
      // invariant that prevents another race.
      store.run(`
        DELETE FROM environment_default_suggestions AS duplicate
         WHERE duplicate.state = 'pending'
           AND EXISTS (
             SELECT 1 FROM environment_default_suggestions earlier
              WHERE earlier.study_id = duplicate.study_id
                AND earlier.language = duplicate.language
                AND earlier.state = 'pending'
                AND earlier.seq < duplicate.seq
           )`);
      store.run(`
        CREATE UNIQUE INDEX one_pending_environment_default_suggestion
          ON environment_default_suggestions(study_id, language)
          WHERE state = 'pending'`);
    },
  },
  {
    version: 35,
    up(store) {
      // A coalesced physical attempt can serve several Tasks that arrived
      // against different declaration snapshots. The job-wide resolve input
      // cannot say which package set each Task is owed, so each append-only
      // interest keeps the request it first joined with. Existing interests
      // predate that distinction and honestly require no named packages.
      store.run(
        `ALTER TABLE kernel_env_setup_interests
           ADD COLUMN requested_packages TEXT NOT NULL DEFAULT '[]'`,
      );
    },
  },
  {
    version: 36,
    up(store) {
      // Coverage follow-ups are separate durable attempts, linked so a
      // restart cannot forget how many declaration changes one request has
      // already absorbed. Retry is deliberately unrelated and starts again
      // at round one; only an automatic coverage round names a predecessor.
      store.run(
        `ALTER TABLE kernel_env_setup_jobs
           ADD COLUMN previous_job_id TEXT REFERENCES kernel_env_setup_jobs(id)`,
      );
      store.run(
        `ALTER TABLE kernel_env_setup_jobs
           ADD COLUMN round INTEGER NOT NULL DEFAULT 1 CHECK (round BETWEEN 1 AND 4)`,
      );
    },
  },
  {
    version: 37,
    up(store) {
      // Automatic declaration coverage belongs to each Task interest, not
      // to the physical build it happens to share. Explicit requests reset
      // only their own budget; transfers advance only the interests moved.
      store.run(
        `ALTER TABLE kernel_env_setup_interests
           ADD COLUMN coverage_round INTEGER NOT NULL DEFAULT 1
           CHECK (coverage_round BETWEEN 1 AND 4)`,
      );
      // A lock revision can advance while a resolving build is still active.
      // Physical exclusivity therefore binds the directory, not the revision
      // it happened to have when resolution started. A server which raced
      // before that invariant shipped can already have one active row at the
      // old revision and another at the new one. Reconcile those rows before
      // installing the stronger index.
      const activeScopes = store.all(`
        SELECT runtime_id, environment_name
          FROM kernel_env_setup_jobs
         WHERE state IN ('requested', 'building')
         GROUP BY runtime_id, environment_name
         ORDER BY runtime_id, environment_name`);
      const terminalize = (ids: string[], diagnostic: string, repairTs: number): void => {
        if (ids.length === 0) return;
        const placeholders = ids.map(() => "?").join(", ");
        store.run(
          `UPDATE kernel_env_setup_jobs
              SET state = 'failed', error_summary = ?, finished_ts = ?, updated_ts = ?
            WHERE id IN (${placeholders})`,
          [diagnostic.slice(0, 4_096), repairTs, repairTs, ...ids],
        );
      };
      const samePackages = (left: string[], right: string[]): boolean => {
        if (left.length !== right.length) return false;
        const expected = [...right].sort();
        return [...left].sort().every((entry, index) => entry === expected[index]);
      };

      for (const scope of activeScopes) {
        const jobs = store.all(
          `SELECT id, language, manager, lock_revision, state, requested_ts, updated_ts, seq
             FROM kernel_env_setup_jobs
            WHERE runtime_id = ? AND environment_name = ?
              AND state IN ('requested', 'building')
            ORDER BY seq ASC`,
          [scope.runtime_id, scope.environment_name],
        );
        if (jobs.length === 0) continue;
        const repairTs = Math.max(...jobs.map(({ updated_ts }) => updated_ts as number));
        const declaration = store.get(
          `SELECT language, manager, packages, created_ts, lock_revision
             FROM kernel_envs WHERE name = ?`,
          [scope.environment_name],
        );
        const currentGeneration = declaration === undefined
          ? []
          : jobs.filter(
              ({ language, manager, requested_ts, lock_revision }) =>
                language === declaration.language &&
                manager === declaration.manager &&
                // v36 records only second-resolution timestamps and no
                // declaration-generation identity. Equality is ambiguous: an
                // old request and the replacement declaration's first request
                // can share the same pair, revision zero, and tick. Treat it
                // as historical so recovery never replays possibly stale work;
                // preserved waiters provide the explicit retry path.
                (requested_ts as number) > (declaration.created_ts as number) &&
                (lock_revision as number) <= (declaration.lock_revision as number),
            );
        const historical = jobs.filter((job) => !currentGeneration.includes(job));
        const needsRepair = jobs.length > 1 || historical.length > 0;
        if (!needsRepair) continue;

        if (historical.length > 0) {
          const reason = declaration === undefined
            ? "there is no current declaration with that name"
            : historical.some(
                  ({ language, manager }) =>
                    language !== declaration.language || manager !== declaration.manager,
                )
              ? `the current declaration is ${declaration.language as string}/${declaration.manager as string}`
              : `it belongs to a historical declaration generation`;
          terminalize(
            historical.map(({ id }) => id as string),
            `Migration 37 terminalized this active environment setup because ${reason}; ` +
              `its generation-specific Task interests and waiters were preserved.`,
            repairTs,
          );
        }
        if (currentGeneration.length === 0 || !declaration) continue;

        // A historical `building` identity may still be running on the
        // daemon even after its durable row is terminal. Starting a merely
        // requested current-generation identity beside it would recreate the
        // same physical collision this migration is repairing. If the daemon
        // has already acknowledged a current-generation request, preserving
        // that exact request id is safe: recovery is deduplicated by id.
        const historicalBuildExists = historical.some(({ state }) => state === "building");
        const currentBuildExists = currentGeneration.some(({ state }) => state === "building");
        if (historicalBuildExists && !currentBuildExists) {
          terminalize(
            currentGeneration.map(({ id }) => id as string),
            `Migration 37 could not safely recover this environment setup because ` +
              `a historical generation may still be building on the daemon; its Task ` +
              `interests and waiters were preserved.`,
            repairTs,
          );
          continue;
        }

        // A `building` request id has demonstrably reached the daemon. Keep
        // that identity so recovery replay is suppressed by daemon-side
        // request-id deduplication. Among several building rows, prefer the
        // highest revision and newest sequence deterministically; only when
        // none started may a requested row become canonical.
        currentGeneration.sort((left, right) => {
          if (left.state !== right.state) return left.state === "building" ? -1 : 1;
          if (left.lock_revision !== right.lock_revision)
            return (right.lock_revision as number) - (left.lock_revision as number);
          return (right.seq as number) - (left.seq as number);
        });
        const survivor = currentGeneration[0]!;
        const ids = currentGeneration.map(({ id }) => id as string);
        const redundantIds = ids.filter((id) => id !== survivor.id);
        const placeholders = ids.map(() => "?").join(", ");

        const declarationPackages = JSON.parse(declaration.packages as string) as string[];
        const currentRevision = declaration.lock_revision as number;
        let resolvedFrom: string | null = JSON.stringify(declarationPackages);
        if (currentRevision > 0) {
          const lock = store.get(
            `SELECT lockfile, requested_packages
               FROM kernel_env_locks WHERE name = ? AND revision = ?`,
            [scope.environment_name, currentRevision],
          );
          if (!lock) {
            terminalize(
              ids,
              `Migration 37 could not recover this active environment setup because ` +
                `the current declaration's lock revision ${currentRevision} is missing; ` +
                `its Task interests and waiters were preserved.`,
              repairTs,
            );
            continue;
          }
          if (lock.requested_packages !== null) {
            const lockedPackages = JSON.parse(lock.requested_packages as string) as string[];
            if (samePackages(lockedPackages, declarationPackages)) resolvedFrom = null;
          }
        }

        const merged = new Map<
          string,
          {
            studyId: string;
            requestedBy: string;
            requestedTs: number;
            requestedPackages: string[];
          }
        >();
        const interests = store.all(
          `SELECT i.study_id, i.task_id, i.requested_by, i.requested_ts,
                  i.requested_packages, j.seq AS job_seq
             FROM kernel_env_setup_interests i
             JOIN kernel_env_setup_jobs j ON j.id = i.job_id
            WHERE i.job_id IN (${placeholders})
            ORDER BY i.requested_ts ASC, j.seq ASC, i.task_id ASC`,
          ids,
        );
        for (const interest of interests) {
          const taskId = interest.task_id as string;
          const packages = JSON.parse(interest.requested_packages as string) as string[];
          const existing = merged.get(taskId);
          if (!existing) {
            merged.set(taskId, {
              studyId: interest.study_id as string,
              requestedBy: interest.requested_by as string,
              requestedTs: interest.requested_ts as number,
              requestedPackages: [...new Set(packages)],
            });
            continue;
          }
          for (const requestedPackage of packages) {
            if (!existing.requestedPackages.includes(requestedPackage))
              existing.requestedPackages.push(requestedPackage);
          }
        }

        // Delete and recreate only these interests so a Task present on both
        // attempts becomes one earliest-provenance interest with a stable
        // package union. All v36 interests start with the new per-Task budget.
        store.run(
          `DELETE FROM kernel_env_setup_interests WHERE job_id IN (${placeholders})`,
          ids,
        );
        for (const [taskId, interest] of merged) {
          store.run(
            `INSERT INTO kernel_env_setup_interests
               (job_id, study_id, task_id, requested_by, requested_ts,
                requested_packages, coverage_round)
             VALUES (?, ?, ?, ?, ?, ?, 1)`,
            [
              survivor.id,
              interest.studyId,
              taskId,
              interest.requestedBy,
              interest.requestedTs,
              JSON.stringify(interest.requestedPackages),
            ],
          );
        }

        if (redundantIds.length > 0) {
          const redundantPlaceholders = redundantIds.map(() => "?").join(", ");
          store.run(
            `UPDATE task_env_setup_waiters
                SET job_id = ?, updated_ts = ?
              WHERE job_id IN (${redundantPlaceholders})`,
            [survivor.id, repairTs, ...redundantIds],
          );
          const diagnostic =
            `Migration 37 consolidated this duplicate active environment setup into ` +
            `${survivor.id as string}; its Task interests and waiters were preserved.`;
          terminalize(redundantIds, diagnostic, repairTs);
        }

        // Recovery dispatches only requested rows. Reset transient execution
        // fields on the canonical row and bind its preserved request id to the
        // current declaration's exact replay-or-resolve plan.
        store.run(
          `UPDATE kernel_env_setup_jobs
              SET state = 'requested', stage = 'waiting-for-machine',
                  language = ?, manager = ?, lock_revision = ?, resolved_from = ?,
                  error_summary = NULL, started_ts = NULL, finished_ts = NULL,
                  updated_ts = ?
            WHERE id = ?`,
          [
            declaration.language,
            declaration.manager,
            currentRevision,
            resolvedFrom,
            repairTs,
            survivor.id,
          ],
        );
      }
      store.run(`DROP INDEX one_active_environment_build`);
      store.run(`
        CREATE UNIQUE INDEX one_active_environment_build
          ON kernel_env_setup_jobs(runtime_id, environment_name)
          WHERE state IN ('requested', 'building')`);
    },
  },
  {
    version: 38,
    up(store) {
      // Revision zero is reusable after delete/redeclare, so it cannot name a
      // build generation by itself. This append-only nullable column keeps
      // old rows readable while backfilling only jobs provably requested
      // after the exact current declaration was created. Same-tick and
      // historical rows remain non-authoritative rather than guessed.
      store.run(
        `ALTER TABLE kernel_env_setup_jobs
           ADD COLUMN declaration_created_ts INTEGER`,
      );
      store.run(`
        UPDATE kernel_env_setup_jobs AS job
           SET declaration_created_ts = (
             SELECT env.created_ts FROM kernel_envs env
              WHERE env.name = job.environment_name
                AND env.language = job.language
                AND env.manager = job.manager
                AND env.lock_revision = job.lock_revision
                AND job.requested_ts > env.created_ts
           )
         WHERE EXISTS (
             SELECT 1 FROM kernel_envs env
              WHERE env.name = job.environment_name
                AND env.language = job.language
                AND env.manager = job.manager
                AND env.lock_revision = job.lock_revision
                AND job.requested_ts > env.created_ts
           )`);
    },
  },
  {
    version: 39,
    up(store) {
      // Timestamps are evidence, not identity: two declarations can be
      // deleted and recreated within the same persisted second. Every
      // declaration that exists at migration time receives a fresh opaque
      // generation, and every future declaration mints one in the store.
      store.run(`ALTER TABLE kernel_envs ADD COLUMN declaration_generation_id TEXT`);
      store.run(
        `UPDATE kernel_envs
            SET declaration_generation_id = 'envgen_' || lower(hex(randomblob(16)))`,
      );
      store.run(
        `CREATE UNIQUE INDEX kernel_env_declaration_generation
           ON kernel_envs(declaration_generation_id)
         WHERE declaration_generation_id IS NOT NULL`,
      );

      // No legacy job can be proven to belong to the newly-minted token.
      // Migration 37 normalized its chosen `building` survivor back to
      // `requested` and cleared `started_ts`; after that shipped write, a v38
      // requested row no longer proves that no daemon build is running.
      // Therefore every null-token active row remains the physical singleton
      // quarantine until that exact old request settles (or an operator
      // explicitly terminalizes it). Recovery refuses to dispatch it, and a
      // current-generation request must not clear this hold implicitly.
      store.run(
        `ALTER TABLE kernel_env_setup_jobs
           ADD COLUMN declaration_generation_id TEXT`,
      );
      const migratedTs = Math.floor(Date.now() / 1000);
      store.run(
        `UPDATE kernel_env_setup_jobs
            SET error_summary = ?, updated_ts = ?
          WHERE state IN ('requested', 'building')
            AND declaration_generation_id IS NULL`,
        [
          `Migration 39 quarantined this active legacy environment setup because ` +
            `the durable store cannot prove whether its exact daemon request already began; ` +
            `its physical singleton, Task interests and waiters remain held until that request settles.`,
          migratedTs,
        ],
      );
    },
  },
  {
    version: 40,
    up(store) {
      // Nullable is intentional. Terminal rows from an older server have no
      // canonical daemon result to hash, so duplicate POSTs against them
      // must fail closed instead of blessing whichever replay arrives first.
      store.run(
        `ALTER TABLE kernel_env_setup_jobs
           ADD COLUMN terminal_outcome_fingerprint TEXT`,
      );
    },
  },
];

assertAscending(MIGRATIONS);

/**
 * The next value of the workspace-wide insertion sequence, produced by one
 * statement rather than an UPDATE followed by a separate SELECT. Two
 * statements leave a window between them: one caller's read can land after
 * a second caller's write to the same row, and both walk away with the
 * same "next" value even though the counter only advanced once. RETURNING
 * closes that window by making the increment and the read the same
 * operation.
 */
export function nextSeq(store: Store): number {
  return store.get(
    `UPDATE seq_counter SET value = value + 1 WHERE id = 1 RETURNING value`,
  )!.value as number;
}

/**
 * Bring a database up to the current schema. Applied in order, each inside
 * its own transaction, so a migration that fails leaves the database at the
 * last version that succeeded rather than half-way through one.
 */
export function migrate(store: Store): void {
  const hasVersionTable = store.get(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`,
  );
  const current = hasVersionTable
    ? ((store.get(`SELECT MAX(version) AS v FROM schema_version`)?.v as number | null) ?? 0)
    : 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    store.tx(() => {
      migration.up(store);
      store.run(`INSERT INTO schema_version (version) VALUES (?)`, [migration.version]);
    });
  }
}
