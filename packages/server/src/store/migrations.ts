import type { Store } from "./store";

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
      // into a Study or moved between them, and every Study numbers from
      // one, so two Tasks sharing a (study_id, number) is the ordinary
      // result of filing rather than a fault to reject. What keeps a fresh
      // Task off an existing number is nextNumber inside the insert's
      // transaction; see tasks.ts. This index is here so that read, and the
      // per-Study list, do not scan the whole table.
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
      // Pinning a Study groups the list for whoever reads it. The column
      // stores 0/1 and defaults to 0, so every Study that already exists
      // reads back unpinned — `toStudy` maps 0 to an absent key, which is
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
      // one Study and agent. It names no Task of its own — a Task's live
      // session is found through the turn that already ties one to it,
      // which is what lets one session outlive several turns filed under
      // different Tasks in the same Study.
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
      // A standing grant is scoped to (study, runtime) rather than to the
      // Study alone: the path it names only means anything on the
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
