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
