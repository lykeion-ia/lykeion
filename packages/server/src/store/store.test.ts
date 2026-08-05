import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./sqlite";
import { assertAscending, migrate, MIGRATIONS, nextSeq } from "./migrations";
import type { Migration } from "./migrations";
import type { Store } from "./store";

// The migration in migrations.ts declares `users.password` and `users.seq`
// NOT NULL with no default, so every insert below supplies both: a
// placeholder password, and a real sequence number from the same counter
// production writes will use. Values are chosen to exercise the schema as
// it actually is, not to test password hashing or sequencing themselves.

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-store-"));
  dirs.push(dir);
  const store = openStore(join(dir, "workspace.db"));
  opened.push(store);
  return store;
}

afterEach(() => {
  // A failing close() or rm() must not stop the rest of cleanup from
  // running — otherwise one bad store in a run leaks every temp directory
  // after it for the rest of the suite.
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      // best effort — see comment above.
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort — see comment above.
    }
  }
});

function insertUser(store: Store, id: string, email: string, name: string): void {
  store.run(
    "INSERT INTO users (id, email, display_name, created_ts, password, seq) VALUES (?, ?, ?, ?, ?, ?)",
    [id, email, name, 1000, "placeholder-hash", nextSeq(store)],
  );
}

it("round-trips a row through the four-method surface", () => {
  const store = freshStore();
  migrate(store);
  insertUser(store, "u_1", "ana@lab.example", "Ana");
  expect(store.get("SELECT display_name FROM users WHERE id = ?", ["u_1"])).toEqual({
    display_name: "Ana",
  });
  expect(store.all("SELECT id FROM users")).toEqual([{ id: "u_1" }]);
});

it("throws a clear error when a BLOB reaches narrow, rather than corrupt it silently", () => {
  // narrow() has no correct way to hand back a BLOB: SqlValue has no member
  // for it, and converting the raw bytes to text is lossy and irreversible.
  // A `TEXT`-affinity column still stores a BLOB literal as-is — SQLite
  // never coerces BLOB values on write — so this reaches narrow() the same
  // way a real driver-level BLOB read would.
  const store = freshStore();
  migrate(store);
  insertUser(store, "u_blob", "blob@lab.example", "Blob");
  store.run(
    "UPDATE users SET password = X'0102030405060708090A0B0C0D0E0F10' WHERE id = ?",
    ["u_blob"],
  );
  expect(() => store.get("SELECT password FROM users WHERE id = ?", ["u_blob"])).toThrow(
    /BLOB/i,
  );
});

it("rolls a transaction back whole when its body throws", () => {
  const store = freshStore();
  migrate(store);
  expect(() =>
    store.tx(() => {
      insertUser(store, "u_2", "b@lab.example", "Bo");
      throw new Error("half way");
    }),
  ).toThrow("half way");
  expect(store.all("SELECT id FROM users")).toEqual([]);
});

it("returns the transaction body's value", () => {
  const store = freshStore();
  migrate(store);
  expect(store.tx(() => 42)).toBe(42);
});

it("does not leave transactions disabled after a failed BEGIN", () => {
  // SQLite refuses to start a second transaction on a connection that
  // already has one open — the same failure a stray, unclosed BEGIN from
  // outside tx() would produce. This forces that failure directly.
  const store = freshStore();
  migrate(store);
  store.run("BEGIN");
  expect(() => store.tx(() => {})).toThrow();
  store.run("ROLLBACK");

  // A tx() call afterward must still run as a real transaction: rolling
  // back a body that throws, not silently skipping BEGIN/COMMIT/ROLLBACK
  // because the failed attempt above left internal bookkeeping stuck.
  expect(() =>
    store.tx(() => {
      insertUser(store, "u_after_failed_begin", "afb@lab.example", "Afb");
      throw new Error("still rolls back");
    }),
  ).toThrow("still rolls back");
  expect(store.all("SELECT id FROM users")).toEqual([]);
});

it("surfaces the body's real error even when rollback itself has nothing to roll back", () => {
  // Ending the transaction from inside the body simulates what SQLite does
  // on its own under SQLITE_FULL or an I/O error: by the time the catch
  // block runs ROLLBACK, there is no transaction left for it to act on,
  // and a bare ROLLBACK throws about that instead of the real failure.
  const store = freshStore();
  migrate(store);
  let thrown: unknown;
  try {
    store.tx(() => {
      store.run("COMMIT");
      throw new Error("the real failure");
    });
  } catch (err) {
    thrown = err;
  }
  expect((thrown as Error).message).toBe("the real failure");

  // And the rollback's own failure is kept rather than dropped. Swallowing
  // it outright would make "recovery also failed" indistinguishable from
  // "recovery was unnecessary", which are not the same situation on a full
  // disk.
  expect((thrown as Error).cause).toBeInstanceOf(Error);
});

it("rolls back only the inner transaction's work when it throws and the outer catches", () => {
  const store = freshStore();
  migrate(store);
  store.tx(() => {
    insertUser(store, "u_outer", "outer@lab.example", "Outer");
    expect(() =>
      store.tx(() => {
        insertUser(store, "u_inner", "inner@lab.example", "Inner");
        throw new Error("inner failure");
      }),
    ).toThrow("inner failure");
  });
  expect(store.all("SELECT id FROM users").map((r) => r.id)).toEqual(["u_outer"]);
});

it("applies every migration and records the version reached", () => {
  const store = freshStore();
  migrate(store);
  const row = store.get("SELECT MAX(version) AS v FROM schema_version");
  expect(row!.v).toBe(MIGRATIONS[MIGRATIONS.length - 1].version);
});

it("is idempotent: migrating an up-to-date database changes nothing", () => {
  const store = freshStore();
  migrate(store);
  insertUser(store, "u_3", "c@lab.example", "Cy");
  migrate(store);
  expect(store.all("SELECT id FROM users")).toEqual([{ id: "u_3" }]);
});

it("applying migration 1 by hand and then calling migrate() lands on the same version, without re-applying it", () => {
  // Only one migration is registered today, so this cannot yet exercise a
  // multi-step upgrade — that becomes real once a second migration exists.
  // What it does cover now: migrate() must recognise a version already
  // recorded and not try to run that migration's `up` a second time, which
  // would fail outright on the tables it already created.
  const store = freshStore();
  MIGRATIONS[0].up(store);
  store.run("INSERT INTO schema_version (version) VALUES (?)", [MIGRATIONS[0].version]);
  insertUser(store, "u_4", "d@lab.example", "Di");

  migrate(store);

  expect(store.get("SELECT MAX(version) AS v FROM schema_version")!.v).toBe(
    MIGRATIONS[MIGRATIONS.length - 1].version,
  );
  expect(store.all("SELECT id FROM users")).toEqual([{ id: "u_4" }]);
});

it("leaves the database at the last version that succeeded when a later migration throws", () => {
  const store = freshStore();
  migrate(store);
  const before = store.get("SELECT MAX(version) AS v FROM schema_version")!.v;

  const broken: Migration = {
    version: MIGRATIONS[MIGRATIONS.length - 1].version + 1,
    up(s) {
      s.run("CREATE TABLE partial_marker (id INTEGER PRIMARY KEY)");
      s.run("INSERT INTO partial_marker (id) VALUES (1)");
      throw new Error("simulated failure mid-migration");
    },
  };
  MIGRATIONS.push(broken);
  try {
    expect(() => migrate(store)).toThrow("simulated failure mid-migration");
  } finally {
    MIGRATIONS.pop();
  }

  expect(store.get("SELECT MAX(version) AS v FROM schema_version")!.v).toBe(before);
  // The table the broken migration created before throwing must not
  // survive either — a half-applied migration's schema changes are exactly
  // what the version number staying put is meant to guarantee didn't stick.
  expect(() => store.all("SELECT id FROM partial_marker")).toThrow(/no such table/);
});

it("rejects a migration list that is not strictly ascending", () => {
  expect(() =>
    assertAscending([
      { version: 1, up: () => {} },
      { version: 1, up: () => {} },
    ]),
  ).toThrow(/ascending/);
  expect(() =>
    assertAscending([
      { version: 2, up: () => {} },
      { version: 1, up: () => {} },
    ]),
  ).toThrow(/ascending/);
});

it("accepts the registered MIGRATIONS list — otherwise the module could not have loaded", () => {
  expect(() => assertAscending(MIGRATIONS)).not.toThrow();
});

it("upgrades aggregate transcripts into one deterministic ordered fallback", () => {
  const store = freshStore();
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 8)) {
    store.tx(() => {
      migration.up(store);
      store.run(`INSERT INTO schema_version (version) VALUES (?)`, [migration.version]);
    });
  }
  const sessionSeq = nextSeq(store);
  store.run(
    `INSERT INTO sessions (id, study_id, runtime_id, agent, opened_by, opened_ts, seq)
     VALUES ('sess_legacy', 's_1', 'rt_1', 'claude', 'u_1', 1, ?)`,
    [sessionSeq],
  );
  const turnSeq = nextSeq(store);
  store.run(
    `INSERT INTO turns (id, session_id, task_id, prompt, started_ts, ended_ts, status, text, seq)
     VALUES ('run_legacy', 'sess_legacy', 't_1', 'go', 1, 2, 'ok', 'legacy prose', ?)`,
    [turnSeq],
  );
  for (const [id, toolUseId] of [["step_a", "a"], ["step_b", "b"]] as const) {
    store.run(
      `INSERT INTO turn_steps
         (id, turn_id, ts, tool_use_id, tool, input, decision, is_error, seq)
       VALUES (?, 'run_legacy', 1, ?, 'Read', '{}', 'ran', 0, ?)`,
      [id, toolUseId, nextSeq(store)],
    );
  }

  migrate(store);
  const table = store.get(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turn_items'`,
  );
  expect(table).toBeDefined();
  if (!table) return;
  expect(
    store.all(
      `SELECT kind, text, step_id FROM turn_items WHERE turn_id = 'run_legacy' ORDER BY seq ASC`,
    ),
  ).toEqual([
    { kind: "text", text: "legacy prose", step_id: null },
    { kind: "step", text: null, step_id: "step_a" },
    { kind: "step", text: null, step_id: "step_b" },
  ]);
});

it("terminally fails a v9 active turn while preserving its transcript and ending its session", () => {
  const store = freshStore();
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 9)) {
    store.tx(() => {
      migration.up(store);
      store.run(`INSERT INTO schema_version (version) VALUES (?)`, [migration.version]);
    });
  }
  store.run(
    `INSERT INTO sessions (id, study_id, runtime_id, agent, opened_by, opened_ts, seq)
     VALUES ('sess_legacy', 's_1', 'rt_1', 'claude', 'u_1', 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO turns (id, session_id, task_id, prompt, started_ts, status, text, seq)
     VALUES ('run_legacy', 'sess_legacy', 't_1', 'go', 1, 'running', 'legacy prose', ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO turn_items (id, turn_id, kind, text, partial, seq)
     VALUES ('item_text_1', 'run_legacy', 'text', 'legacy ', 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO turn_items (id, turn_id, kind, text, partial, seq)
     VALUES ('item_text_2', 'run_legacy', 'text', 'prose', 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO turn_steps
       (id, turn_id, ts, tool_use_id, tool, input, decision, result, is_error, seq)
     VALUES ('step_legacy', 'run_legacy', 2, 'read-1', 'Read', '{"path":"notes.md"}',
             'ran', 'ok', 0, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO turn_items (id, turn_id, kind, step_id, seq)
     VALUES ('item_step', 'run_legacy', 'step', 'step_legacy', ?)`,
    [nextSeq(store)],
  );

  migrate(store);

  expect(store.all(`PRAGMA table_info(turns)`).map((column) => column.name)).toEqual(
    expect.arrayContaining(["last_frame_seq", "recovery_snapshot"]),
  );
  const row = store.get(
    `SELECT status, ended_ts, last_frame_seq, recovery_snapshot
       FROM turns WHERE id = 'run_legacy'`,
  )!;
  expect(row).toMatchObject({
    status: "failed",
    ended_ts: expect.any(Number),
    last_frame_seq: 0,
  });
  expect(JSON.parse(row.recovery_snapshot as string)).toEqual({
    version: 1,
    state: {
      state: "failed",
      reason: expect.stringContaining("upgrade"),
    },
    stream: [
      { kind: "text", text: "legacy prose" },
      {
        kind: "step",
        entry: {
          ts: 2,
          toolUseId: "read-1",
          tool: "Read",
          input: { path: "notes.md" },
          decision: "ran",
          result: "ok",
          isError: false,
        },
      },
    ],
    live: {},
    reviewing: false,
  });
  expect(store.get(`SELECT ended_ts FROM sessions WHERE id = 'sess_legacy'`)).toEqual({
    ended_ts: row.ended_ts,
  });
  expect(store.all(
    `SELECT kind, text, partial, step_id
       FROM turn_items WHERE turn_id = 'run_legacy' ORDER BY seq ASC`,
  )).toEqual([
    { kind: "text", text: "legacy ", partial: 1, step_id: null },
    { kind: "text", text: "prose", partial: 1, step_id: null },
    { kind: "step", text: null, partial: null, step_id: "step_legacy" },
  ]);
});

it("terminally fails an active turn when upgrading an already-v11 database", () => {
  const store = freshStore();
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 11)) {
    store.tx(() => {
      migration.up(store);
      store.run(`INSERT INTO schema_version (version) VALUES (?)`, [migration.version]);
    });
  }
  insertUser(store, "u_1", "owner@example.test", "Owner");
  store.run(
    `INSERT INTO studies
       (id, key, title, created_by, created_ts, updated_ts, seq)
     VALUES ('s_1', 'ONE', 'One', 'u_1', 1, 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO tasks
       (id, number, study_id, stage, title, status, priority, created_by,
        created_ts, updated_ts, seq)
     VALUES ('t_1', 1, 's_1', 'background', 'Legacy run', 'todo', 'no-priority',
             'u_1', 1, 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO sessions (id, study_id, runtime_id, agent, opened_by, opened_ts, seq)
     VALUES ('sess_v11', 's_1', 'rt_1', 'claude', 'u_1', 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO turns
       (id, session_id, task_id, prompt, started_ts, status, text, seq, last_frame_seq, recovery_snapshot)
     VALUES ('run_v11', 'sess_v11', 't_1', 'go', 1, 'running', 'newer prose', ?, 0,
             '{"version":1,"state":{"state":"executing","plan":{"steps":[]}},"stream":[],"live":{"text":"newer prose"},"reviewing":false}')`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO turn_items (id, turn_id, kind, text, partial, seq)
     VALUES ('item_v11', 'run_v11', 'text', 'newer prose', 1, ?)`,
    [nextSeq(store)],
  );

  migrate(store);

  const row = store.get(
    `SELECT status, ended_ts, last_frame_seq, recovery_snapshot
       FROM turns WHERE id = 'run_v11'`,
  )!;
  expect(row).toMatchObject({
    status: "failed",
    ended_ts: expect.any(Number),
    last_frame_seq: 0,
  });
  expect(JSON.parse(row.recovery_snapshot as string)).toMatchObject({
    state: { state: "failed", reason: expect.stringContaining("upgrade") },
    stream: [{ kind: "text", text: "newer prose" }],
    live: {},
  });
  expect(store.get(`SELECT ended_ts FROM sessions WHERE id = 'sess_v11'`)).toEqual({
    ended_ts: row.ended_ts,
  });
  expect(store.get(
    `SELECT status, run_count, last_run_status, updated_ts FROM tasks WHERE id = 't_1'`,
  )).toEqual({
    status: "todo",
    run_count: 1,
    last_run_status: "failed",
    updated_ts: row.ended_ts,
  });
});

it("keeps the highest-sequence settled status when an older active turn is failed by migration", () => {
  const store = freshStore();
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 11)) {
    store.tx(() => {
      migration.up(store);
      store.run(`INSERT INTO schema_version (version) VALUES (?)`, [migration.version]);
    });
  }
  insertUser(store, "u_1", "owner@example.test", "Owner");
  store.run(
    `INSERT INTO studies
       (id, key, title, created_by, created_ts, updated_ts, seq)
     VALUES ('s_1', 'ONE', 'One', 'u_1', 1, 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO tasks
       (id, number, study_id, stage, title, status, priority, created_by,
        run_count, last_run_status, created_ts, updated_ts, seq)
     VALUES ('t_1', 1, 's_1', 'background', 'Mixed legacy runs', 'in-review',
             'no-priority', 'u_1', 1, 'ok', 1, 9, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO sessions (id, study_id, runtime_id, agent, opened_by, opened_ts, seq)
     VALUES ('sess_mixed', 's_1', 'rt_1', 'claude', 'u_1', 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO turns
       (id, session_id, task_id, prompt, started_ts, status, seq, last_frame_seq)
     VALUES ('run_older_active', 'sess_mixed', 't_1', 'older', 1, 'running', ?, 0)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO turns
       (id, session_id, task_id, prompt, started_ts, ended_ts, status, seq, last_frame_seq)
     VALUES ('run_newer_ok', 'sess_mixed', 't_1', 'newer', 2, 9, 'ok', ?, 0)`,
    [nextSeq(store)],
  );

  migrate(store);

  expect(store.all(
    `SELECT id, status FROM turns WHERE task_id = 't_1' ORDER BY seq ASC`,
  )).toEqual([
    { id: "run_older_active", status: "failed" },
    { id: "run_newer_ok", status: "ok" },
  ]);
  expect(store.get(
    `SELECT run_count, last_run_status FROM tasks WHERE id = 't_1'`,
  )).toEqual({ run_count: 2, last_run_status: "ok" });
});

it("terminally fails a cursor-zero legacy turn even before it has transcript evidence", () => {
  const store = freshStore();
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 11)) {
    store.tx(() => {
      migration.up(store);
      store.run(`INSERT INTO schema_version (version) VALUES (?)`, [migration.version]);
    });
  }
  store.run(
    `INSERT INTO sessions (id, study_id, runtime_id, agent, opened_by, opened_ts, seq)
     VALUES ('sess_empty_legacy', 's_1', 'rt_1', 'claude', 'u_1', 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO turns (id, session_id, task_id, prompt, started_ts, status, seq)
     VALUES ('run_empty_legacy', 'sess_empty_legacy', 't_1', 'go', 1, 'running', ?)`,
    [nextSeq(store)],
  );

  migrate(store);

  expect(store.get(
    `SELECT status, ended_ts, last_frame_seq FROM turns WHERE id = 'run_empty_legacy'`,
  )).toMatchObject({
    status: "failed",
    ended_ts: expect.any(Number),
    last_frame_seq: 0,
  });
  expect(store.get(`SELECT ended_ts FROM sessions WHERE id = 'sess_empty_legacy'`)?.ended_ts)
    .not.toBeNull();
});

it("repairs pre-v10 settled rows with terminal recovery snapshots without recounting them", () => {
  const store = freshStore();
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 9)) {
    store.tx(() => {
      migration.up(store);
      store.run(`INSERT INTO schema_version (version) VALUES (?)`, [migration.version]);
    });
  }
  store.run(
    `INSERT INTO sessions
       (id, study_id, runtime_id, agent, opened_by, opened_ts, ended_ts, seq)
     VALUES ('sess_settled', 's_1', 'rt_1', 'claude', 'u_1', 1, 9, ?)`,
    [nextSeq(store)],
  );
  for (const [id, status] of [
    ["run_old_ok", "ok"],
    ["run_old_failed", "failed"],
    ["run_old_cancelled", "cancelled-unacknowledged"],
  ] as const) {
    store.run(
      `INSERT INTO turns
         (id, session_id, task_id, prompt, started_ts, ended_ts, status, seq)
       VALUES (?, 'sess_settled', 't_1', 'go', 1, 9, ?, ?)`,
      [id, status, nextSeq(store)],
    );
  }
  store.run(
    `INSERT INTO turn_items (id, turn_id, kind, text, partial, seq)
     VALUES ('old_text', 'run_old_ok', 'text', 'preserved', 0, ?)`,
    [nextSeq(store)],
  );

  migrate(store);

  const snapshots = Object.fromEntries(
    store.all(
      `SELECT id, recovery_snapshot FROM turns
        WHERE session_id = 'sess_settled' ORDER BY seq ASC`,
    ).map((row) => [row.id, JSON.parse(row.recovery_snapshot as string)]),
  );
  expect(snapshots.run_old_ok).toMatchObject({
    state: { state: "completed" },
    stream: [{ kind: "text", text: "preserved" }],
    live: {},
  });
  expect(snapshots.run_old_failed).toMatchObject({
    state: { state: "failed", reason: expect.stringContaining("predates") },
  });
  expect(snapshots.run_old_cancelled).toMatchObject({
    state: { state: "cancelled", unacknowledged: true },
  });
  expect(store.get(`SELECT ended_ts FROM sessions WHERE id = 'sess_settled'`)).toEqual({
    ended_ts: 9,
  });
});

it("backfills Task rollups from settled legacy turns while preserving explicit Done", () => {
  const store = freshStore();
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 11)) {
    store.tx(() => {
      migration.up(store);
      store.run(`INSERT INTO schema_version (version) VALUES (?)`, [migration.version]);
    });
  }
  insertUser(store, "u_1", "owner@example.test", "Owner");
  store.run(
    `INSERT INTO studies
       (id, key, title, created_by, created_ts, updated_ts, seq)
     VALUES ('s_1', 'ONE', 'One', 'u_1', 1, 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO tasks
       (id, number, study_id, stage, title, status, priority, created_by,
        run_count, created_ts, updated_ts, seq)
     VALUES ('t_rollup', 1, 's_1', 'background', 'Legacy rollup', 'done',
             'no-priority', 'u_1', 0, 1, 9, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO sessions
       (id, study_id, runtime_id, agent, opened_by, opened_ts, ended_ts, seq)
     VALUES ('sess_rollup', 's_1', 'rt_1', 'claude', 'u_1', 1, 9, ?)`,
    [nextSeq(store)],
  );
  for (const [id, status] of [
    ["run_rollup_ok", "ok"],
    ["run_rollup_cancelled", "cancelled"],
  ] as const) {
    store.run(
      `INSERT INTO turns
         (id, session_id, task_id, prompt, started_ts, ended_ts, status, seq,
          last_frame_seq, recovery_snapshot)
       VALUES (?, 'sess_rollup', 't_rollup', 'go', 1, 9, ?, ?, 1, ?)`,
      [
        id,
        status,
        nextSeq(store),
        JSON.stringify({
          version: 1,
          state: status === "ok" ? { state: "completed" } : { state: "cancelled" },
          stream: [],
          live: {},
          reviewing: false,
        }),
      ],
    );
  }

  migrate(store);

  expect(store.get(
    `SELECT status, run_count, last_run_status, updated_ts
       FROM tasks WHERE id = 't_rollup'`,
  )).toEqual({
    status: "done",
    run_count: 2,
    last_run_status: "failed",
    updated_ts: 9,
  });
});

it("migrates existing turn steps with unknown outside-workspace provenance", () => {
  const store = freshStore();
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 10)) {
    store.tx(() => {
      migration.up(store);
      store.run(`INSERT INTO schema_version (version) VALUES (?)`, [migration.version]);
    });
  }
  store.run(
    `INSERT INTO sessions (id, study_id, runtime_id, agent, opened_by, opened_ts, seq)
     VALUES ('sess_legacy', 's_1', 'rt_1', 'claude', 'u_1', 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO turns (id, session_id, task_id, prompt, started_ts, status, seq)
     VALUES ('run_legacy', 'sess_legacy', 't_1', 'go', 1, 'running', ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO turn_steps
       (id, turn_id, ts, tool_use_id, tool, input, decision, is_error, seq)
     VALUES ('step_legacy', 'run_legacy', 2, 'tool-1', 'Read', '{}', 'ran', 0, ?)`,
    [nextSeq(store)],
  );

  migrate(store);

  expect(store.all(`PRAGMA table_info(turn_steps)`).map((column) => column.name)).toEqual(
    expect.arrayContaining(["outside_workspace"]),
  );
  expect(store.get(`SELECT outside_workspace FROM turn_steps WHERE id = 'step_legacy'`)).toEqual({
    outside_workspace: null,
  });
});

it("hands out strictly increasing sequence numbers", () => {
  const store = freshStore();
  migrate(store);
  expect([nextSeq(store), nextSeq(store), nextSeq(store)]).toEqual([1, 2, 3]);
});

it("rejects a reused sequence number the same way it rejects a reused email", () => {
  const store = freshStore();
  migrate(store);
  const seq = nextSeq(store);
  store.run(
    "INSERT INTO users (id, email, display_name, created_ts, password, seq) VALUES (?, ?, ?, ?, ?, ?)",
    ["u_a", "a@lab.example", "A", 1000, "placeholder-hash", seq],
  );
  expect(() =>
    store.run(
      "INSERT INTO users (id, email, display_name, created_ts, password, seq) VALUES (?, ?, ?, ?, ?, ?)",
      ["u_b", "b@lab.example", "B", 1000, "placeholder-hash", seq],
    ),
  ).toThrow(/UNIQUE/);
});
