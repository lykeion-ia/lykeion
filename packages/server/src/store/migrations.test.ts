import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./sqlite";
import { MIGRATIONS, migrate, nextSeq } from "./migrations";
import type { Store } from "./store";

const dirs: string[] = [];
const opened: Store[] = [];

/** An empty database, opened the way the server opens its own — WAL,
 *  `foreign_keys = ON`, the lot — and deliberately NOT migrated. Migration
 *  27 exists to repair a shape `migrate` itself no longer produces, so a
 *  test of it has to build that shape by hand rather than migrate into it. */
function openFresh(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-store-migrations-"));
  dirs.push(dir);
  const store = openStore(join(dir, "workspace.db"));
  opened.push(store);
  return store;
}

function freshStore(): Store {
  const store = openFresh();
  migrate(store);
  return store;
}

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = 1_800_000_000;

const HEAD = MIGRATIONS[MIGRATIONS.length - 1].version;

/** Whether `column` on `table` still refuses NULL — read from SQLite's own
 *  account of the table rather than from the migration's source text. */
function notNull(store: Store, table: string, column: string): boolean {
  const info = store.all(`PRAGMA table_info(${table})`).find((c) => c.name === column);
  if (info === undefined) throw new Error(`${table} has no column named ${column}`);
  return info.notnull !== 0;
}

function ddlOf(store: Store, table: string): string {
  return store.get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [table])
    ?.sql as string;
}

function tableExists(store: Store, table: string): boolean {
  return (
    store.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]) !==
    undefined
  );
}

/**
 * A database at the shape an EARLIER draft of migration 25 left behind:
 * `kernel_envs.created_by` NOT NULL, `kernel_env_locks` referencing it, and
 * `schema_version` stamped at 26 so `migrate` has migration 27 and everything
 * after it left to run. `users` is the minimum the foreign keys on both tables
 * need to resolve against.
 *
 * `cells` and `research_groups` are here because a stand-in stamped at 26 is
 * claiming to BE a lab at 26, and every migration after that one is entitled
 * to reach any table a real lab of that vintage holds — 29 alters the first
 * and 31 the second. A stand-in carrying only the tables the migration
 * originally under test touched fails the next time somebody writes a
 * migration about something else, and it fails as "no such table" rather than
 * as anything about the repair being tested.
 */
function databaseAtBrokenTwentyFive(): Store {
  const store = openFresh();
  store.run(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY)`);
  store.run(`CREATE TABLE users (id TEXT PRIMARY KEY)`);
  store.run(`
    CREATE TABLE kernel_envs (
      name          TEXT PRIMARY KEY,
      language      TEXT NOT NULL CHECK (language IN ('python', 'r')),
      manager       TEXT NOT NULL CHECK (manager IN ('uv', 'conda')),
      packages      TEXT NOT NULL,
      created_by    TEXT NOT NULL REFERENCES users(id),
      created_ts    INTEGER NOT NULL,
      lock_revision INTEGER NOT NULL DEFAULT 0
    )`);
  store.run(`
    CREATE TABLE kernel_env_locks (
      name       TEXT NOT NULL REFERENCES kernel_envs(name),
      revision   INTEGER NOT NULL,
      lockfile   TEXT NOT NULL,
      written_ts INTEGER NOT NULL,
      PRIMARY KEY (name, revision)
    )`);
  // As migration 20 created it, since that is what a lab at 26 has.
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
  // As migration 3 created it, since that is what a lab at 26 has.
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
  store.run(`INSERT INTO schema_version (version) VALUES (26)`);
  return store;
}

it("repairs a database left at the earlier draft's NOT NULL creator, without losing the pin it already held", () => {
  const store = databaseAtBrokenTwentyFive();
  // A real creator, because the old column would not take a NULL one — which
  // is the whole reason this repair exists.
  store.run(`INSERT INTO users (id) VALUES ('u_ana')`);
  store.run(
    `INSERT INTO kernel_envs (name, language, manager, packages, created_by, created_ts, lock_revision)
     VALUES ('crispr', 'python', 'uv', '["scanpy"]', 'u_ana', ?, 1)`,
    [NOW],
  );
  // The row that makes this migration fail rather than merely be pointless:
  // `kernel_env_locks.name` references the very table being rebuilt, and
  // foreign keys cannot be turned off inside the transaction `migrate` runs
  // each migration in. A lab that pinned nothing never saw this.
  store.run(
    `INSERT INTO kernel_env_locks (name, revision, lockfile, written_ts)
     VALUES ('crispr', 1, 'scanpy==1.9.0\nanndata==0.10.0\n', ?)`,
    [NOW],
  );

  // This is `startServer`'s own call. Throwing here is a lab that does not
  // boot, which is the exact symptom migration 27 was written to prevent.
  expect(() => migrate(store)).not.toThrow();

  expect(store.get(`SELECT MAX(version) AS v FROM schema_version`)!.v).toBe(HEAD);
  expect(notNull(store, "kernel_envs", "created_by")).toBe(false);
  // The declaration came through the rebuild whole.
  const env = store.get(`SELECT * FROM kernel_envs WHERE name = 'crispr'`)!;
  expect(env.created_by).toBe("u_ana");
  expect(env.packages).toBe('["scanpy"]');
  expect(env.lock_revision).toBe(1);
  // And so did the pin. Every later machine replays this text verbatim
  // (D4), so a repair that silently dropped it would be worse than the
  // failure it fixes.
  const lock = store.get(`SELECT * FROM kernel_env_locks WHERE name = 'crispr' AND revision = 1`)!;
  expect(lock.lockfile).toBe("scanpy==1.9.0\nanndata==0.10.0\n");
  expect(lock.written_ts).toBe(NOW);
  // The recreated child keeps its foreign key — the rebuild carried the pins
  // across a gap, it did not buy the crossing by dropping the constraint.
  expect(ddlOf(store, "kernel_env_locks")).toMatch(/REFERENCES kernel_envs\(name\)/);
  // And the holding pen it crossed on is gone.
  expect(tableExists(store, "kernel_env_locks_carried")).toBe(false);
});

it("leaves a database that already has the nullable creator entirely alone", () => {
  const store = freshStore();
  store.run(`INSERT INTO users (id, email, display_name, password, created_ts, seq)
             VALUES ('u_ana', 'ana@lab.example', 'Ana', 'x', ?, ?)`, [NOW, nextSeq(store)]);
  store.run(
    `INSERT INTO kernel_envs (name, language, manager, packages, created_by, created_ts, lock_revision)
     VALUES ('crispr', 'python', 'uv', '["scanpy"]', 'u_ana', ?, 1)`,
    [NOW],
  );
  store.run(
    `INSERT INTO kernel_env_locks (name, revision, lockfile, written_ts)
     VALUES ('crispr', 1, 'scanpy==1.9.0\n', ?)`,
    [NOW],
  );
  const envsBefore = store.all(`SELECT * FROM kernel_envs ORDER BY name`);
  const locksBefore = store.all(`SELECT * FROM kernel_env_locks ORDER BY name, revision`);
  const envDdlBefore = ddlOf(store, "kernel_envs");
  const locksDdlBefore = ddlOf(store, "kernel_env_locks");

  // Put 27 back in front of `migrate` so the migration actually runs and has
  // to decide for itself. Re-running `migrate` untouched would prove only
  // that `MAX(schema_version)` works.
  store.run(`DELETE FROM schema_version WHERE version = 27`);
  migrate(store);

  expect(store.all(`SELECT * FROM kernel_envs ORDER BY name`)).toEqual(envsBefore);
  expect(store.all(`SELECT * FROM kernel_env_locks ORDER BY name, revision`)).toEqual(locksBefore);
  // Byte-identical DDL: a rebuild would have left SQLite's own record of
  // these tables rewritten by the rename, even where every row survived.
  expect(ddlOf(store, "kernel_envs")).toBe(envDdlBefore);
  expect(ddlOf(store, "kernel_env_locks")).toBe(locksDdlBefore);
});

it("gives a pin somewhere to record what it was resolved from, and leaves the pins it already had unable to say", () => {
  // Migration 28. The column is what makes "is this pin still the pin for
  // what the declaration now asks for" DERIVED rather than flagged — and its
  // being NULLABLE is the load-bearing half: a row written before this
  // migration cannot name its own request, and must read as "this lab cannot
  // say" rather than as "resolved from nothing". `kernelEnvSetup` widens to a
  // resolve for the first and would replay for the second, dropping every
  // package a researcher approved.
  const store = freshStore();
  store.run(
    `INSERT INTO kernel_envs (name, language, manager, packages, created_by, created_ts, lock_revision)
     VALUES ('crispr', 'python', 'uv', '["scanpy"]', NULL, ?, 1)`,
    [NOW],
  );
  // A pin written the way a database that predates this column holds one:
  // every other field, and nothing here.
  store.run(
    `INSERT INTO kernel_env_locks (name, revision, lockfile, written_ts)
     VALUES ('crispr', 1, 'scanpy==1.9.0\n', ?)`,
    [NOW],
  );

  expect(notNull(store, "kernel_env_locks", "requested_packages")).toBe(false);
  expect(
    store.get(`SELECT requested_packages AS p FROM kernel_env_locks WHERE name = 'crispr'`)!.p,
  ).toBeNull();

  // And a pin written since can say exactly what it answers.
  store.run(
    `INSERT INTO kernel_env_locks (name, revision, lockfile, written_ts, requested_packages)
     VALUES ('crispr', 2, 'scanpy==1.9.1\n', ?, '["scanpy","anndata"]')`,
    [NOW],
  );
  expect(
    store.get(`SELECT requested_packages AS p FROM kernel_env_locks WHERE revision = 2`)!.p,
  ).toBe('["scanpy","anndata"]');
});

it("a fresh database reaches head with a creator that may be absent, which is what the seeded starter needs", () => {
  const store = freshStore();

  expect(store.get(`SELECT MAX(version) AS v FROM schema_version`)!.v).toBe(HEAD);
  expect(notNull(store, "kernel_envs", "created_by")).toBe(false);

  // `seedLabContent` declares the starter before any user exists to own it
  // (R14): absent creator means Lykeion declared it, not a person. Against
  // the earlier draft's NOT NULL this threw inside `startServer`.
  store.run(
    `INSERT INTO kernel_envs (name, language, manager, packages, created_by, created_ts, lock_revision)
     VALUES ('python', 'python', 'uv', '["numpy"]', NULL, ?, 0)`,
    [NOW],
  );
  expect(store.get(`SELECT created_by FROM kernel_envs WHERE name = 'python'`)!.created_by).toBeNull();
});

it("gives a record its own table, ordered on the workspace-wide sequence", () => {
  const store = freshStore();

  // Every ordered list in this store sorts on insertion as its final
  // tiebreak, and that holds only while the column carrying it can be
  // neither absent nor shared. Read from SQLite's own account of the table
  // rather than from the migration's source text.
  expect(notNull(store, "provenance_envelopes", "seq")).toBe(true);
  store.run(
    `INSERT INTO provenance_envelopes (id, version, body, task_id, session_id, ts, seq)
     VALUES ('a', 'lykeion.provenance.v1', '{}', 'tk_1', 'se_1', ?, ?)`,
    [NOW, nextSeq(store)],
  );
  expect(() =>
    store.run(
      `INSERT INTO provenance_envelopes (id, version, body, task_id, session_id, ts, seq)
       VALUES ('b', 'lykeion.provenance.v1', '{}', 'tk_1', 'se_1', ?, 1)`,
      [NOW],
    ),
  ).toThrow(/UNIQUE/);
  expect(() =>
    store.run(
      `INSERT INTO provenance_envelopes (id, version, body, task_id, session_id, ts, seq)
       VALUES ('c', 'lykeion.provenance.v1', '{}', 'tk_1', 'se_1', ?, NULL)`,
      [NOW],
    ),
  ).toThrow(/NOT NULL/);
});

it("leaves every cell recorded before this lab kept a record pointing at none", () => {
  // Nullable, and no default: a cell that ran before anything wrote an
  // envelope has none, and a default here would be this lab inventing one.
  const store = freshStore();

  expect(notNull(store, "cells", "provenance_id")).toBe(false);
  store.run(
    `INSERT INTO cells
       (id, task_id, session_id, kernel_id, name, language, environment, execution_count,
        source, origin_surface, origin_by, ok, wall_ms, ts, outputs, seq)
     VALUES ('cell_before', 'tk_1', 'se_1', 'k_1', 'main', 'python', 'python', 1,
             '1 + 1', 'repl', 'u_1', 1, 5, ?, '[]', ?)`,
    [NOW, nextSeq(store)],
  );
  expect(
    store.get(`SELECT provenance_id AS p FROM cells WHERE id = 'cell_before'`)!.p,
  ).toBeNull();
});
