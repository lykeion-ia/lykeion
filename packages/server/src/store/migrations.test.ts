import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEnvironmentSetupCoordinator } from "../environment-setup-coordinator";
import { createRunRelay, type RunCommand } from "../run-relay";
import { environmentSetupStore } from "./environment-setups";
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

it("stores a per-interest coverage budget and enforces one physical build across lock revisions", () => {
  const store = freshStore();
  const coverage = store.all(`PRAGMA table_info(kernel_env_setup_interests)`)
    .find(({ name }) => name === "coverage_round");
  expect(coverage).toMatchObject({ notnull: 1, dflt_value: "1" });
  expect(
    store.get(
      `SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'one_active_environment_build'`,
    )?.sql,
  ).toMatch(/\(runtime_id, environment_name\)/);
  expect(
    store.get(
      `SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'one_active_environment_build'`,
    )?.sql,
  ).not.toMatch(/lock_revision/);
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

function migration(version: number) {
  const found = MIGRATIONS.find((candidate) => candidate.version === version);
  if (!found) throw new Error(`missing migration ${version}`);
  return found;
}

function databaseAt(version: number): Store {
  const store = openFresh();
  for (const candidate of MIGRATIONS.filter(({ version: candidateVersion }) => candidateVersion <= version)) {
    store.tx(() => {
      candidate.up(store);
      store.run(`INSERT INTO schema_version (version) VALUES (?)`, [candidate.version]);
    });
  }
  return store;
}

it("migration 38 appends and safely backfills the exact declaration generation", () => {
  const store = databaseAt(37);
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq)
     VALUES ('u_generation', 'generation@example.test', 'Generation', 'x', ?, ?)`,
    [NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO runtimes
       (id, owner_id, name, platform, daemon_version, capabilities, created_ts,
        last_seen_ts, seq)
     VALUES ('rt_generation', 'u_generation', 'Mac', 'darwin', '1', '[]', ?, ?, ?)`,
    [NOW, NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO kernel_envs
       (name, language, manager, packages, created_by, created_ts, lock_revision)
     VALUES ('analysis', 'python', 'uv', '[]', 'u_generation', ?, 0)`,
    [NOW],
  );
  store.run(
    `INSERT INTO kernel_env_setup_jobs
       (id, runtime_id, environment_name, language, manager, lock_revision,
        request_id, state, stage, requested_ts, updated_ts, seq)
     VALUES ('job_generation', 'rt_generation', 'analysis', 'python', 'uv', 0,
             'req_generation', 'requested', 'waiting-for-machine', ?, ?, ?)`,
    [NOW + 1, NOW + 1, nextSeq(store)],
  );

  store.tx(() => migration(38).up(store));

  expect(store.all(`PRAGMA table_info(kernel_env_setup_jobs)`)).toContainEqual(
    expect.objectContaining({ name: "declaration_created_ts", notnull: 0 }),
  );
  expect(
    store.get(
      `SELECT declaration_created_ts FROM kernel_env_setup_jobs WHERE id = 'job_generation'`,
    ),
  ).toEqual({ declaration_created_ts: NOW });
});

it("migration 39 mints opaque declaration generations and quarantines ambiguous active work", () => {
  const store = databaseAt(38);
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq)
     VALUES ('u_opaque', 'opaque@example.test', 'Opaque', 'x', ?, ?)`,
    [NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO runtimes
       (id, owner_id, name, platform, daemon_version, capabilities, created_ts,
        last_seen_ts, seq)
     VALUES ('rt_opaque', 'u_opaque', 'Mac', 'darwin', '1', '[]', ?, ?, ?)`,
    [NOW, NOW, nextSeq(store)],
  );
  for (const name of ["requested_legacy", "building_legacy"]) {
    store.run(
      `INSERT INTO kernel_envs
         (name, language, manager, packages, created_by, created_ts, lock_revision)
       VALUES (?, 'python', 'uv', '[]', 'u_opaque', ?, 0)`,
      [name, NOW],
    );
  }
  for (const [name, state] of [
    ["requested_legacy", "requested"],
    ["building_legacy", "building"],
  ] as const) {
    store.run(
      `INSERT INTO kernel_env_setup_jobs
         (id, runtime_id, environment_name, language, manager, lock_revision,
          declaration_created_ts, request_id, state, stage, requested_ts, updated_ts, seq)
       VALUES (?, 'rt_opaque', ?, 'python', 'uv', 0, ?, ?, ?, 'waiting-for-machine', ?, ?, ?)`,
      [
        `job_${state}`,
        name,
        NOW,
        `req_${state}`,
        state,
        NOW + 1,
        NOW + 1,
        nextSeq(store),
      ],
    );
  }

  store.tx(() => migration(39).up(store));

  const declarations = store.all(
    `SELECT name, declaration_generation_id FROM kernel_envs ORDER BY name`,
  );
  expect(declarations).toEqual([
    { name: "building_legacy", declaration_generation_id: expect.stringMatching(/^envgen_/) },
    { name: "requested_legacy", declaration_generation_id: expect.stringMatching(/^envgen_/) },
  ]);
  expect(store.get(
    `SELECT state, declaration_generation_id FROM kernel_env_setup_jobs WHERE id = 'job_requested'`,
  )).toEqual({ state: "requested", declaration_generation_id: null });
  expect(store.get(
    `SELECT state, declaration_generation_id FROM kernel_env_setup_jobs WHERE id = 'job_building'`,
  )).toEqual({ state: "building", declaration_generation_id: null });

  const setups = environmentSetupStore(store);
  const currentRequestedGeneration = declarations.find(
    ({ name }) => name === "requested_legacy",
  )!.declaration_generation_id as string;
  const retryRequested = () => setups.requestPhysicalJob({
    runtimeId: "rt_opaque",
    environmentName: "requested_legacy",
    language: "python",
    manager: "uv",
    lockRevision: 0,
    declarationCreatedTs: NOW,
    declarationGenerationId: currentRequestedGeneration,
    requestId: "req_requested_current",
    requestedTs: NOW + 2,
  });
  expect(retryRequested).toThrow(/legacy|settle|generation/i);
  setups.markFailed("req_requested", "operator reconciled the old request", NOW + 3);
  expect(retryRequested().created).toBe(true);

  const currentBuildingGeneration = declarations.find(
    ({ name }) => name === "building_legacy",
  )!.declaration_generation_id as string;
  const retryBuilding = () => setups.requestPhysicalJob({
    runtimeId: "rt_opaque",
    environmentName: "building_legacy",
    language: "python",
    manager: "uv",
    lockRevision: 0,
    declarationCreatedTs: NOW,
    declarationGenerationId: currentBuildingGeneration,
    requestId: "req_building_current",
    requestedTs: NOW + 2,
  });
  expect(retryBuilding).toThrow(/generation|building|in-flight/i);
  setups.markFailed("req_building", "the old daemon request settled", NOW + 3);
  expect(retryBuilding().created).toBe(true);
});

it("migration 40 appends nullable canonical terminal fingerprints without blessing legacy rows", () => {
  const store = databaseAt(39);
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq)
     VALUES ('u_fingerprint', 'fingerprint@example.test', 'Fingerprint', 'x', ?, ?)`,
    [NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO runtimes
       (id, owner_id, name, platform, daemon_version, capabilities, created_ts,
        last_seen_ts, seq)
     VALUES ('rt_fingerprint', 'u_fingerprint', 'Mac', 'darwin', '1', '[]', ?, ?, ?)`,
    [NOW, NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO kernel_env_setup_jobs
       (id, runtime_id, environment_name, language, manager, lock_revision,
        declaration_generation_id, declaration_created_ts, request_id, state, stage,
        requested_ts, finished_ts, updated_ts, seq)
     VALUES ('job_legacy_terminal', 'rt_fingerprint', 'analysis', 'python', 'uv', 1,
             'envgen_legacy_terminal', ?, 'req_legacy_terminal', 'ready', 'finalizing',
             ?, ?, ?, ?)`,
    [NOW, NOW + 1, NOW + 2, NOW + 2, nextSeq(store)],
  );
  store.tx(() => migration(40).up(store));

  expect(store.all(`PRAGMA table_info(kernel_env_setup_jobs)`)).toContainEqual(
    expect.objectContaining({ name: "terminal_outcome_fingerprint", notnull: 0 }),
  );
  expect(
    store.get(`SELECT state, terminal_outcome_fingerprint
                 FROM kernel_env_setup_jobs WHERE id = 'job_legacy_terminal'`),
  ).toEqual({ state: "ready", terminal_outcome_fingerprint: null });
});

it("migration 37 consolidation keeps every Task obligation under migration 39 quarantine", () => {
  const store = databaseAt(36);
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq)
     VALUES ('u_1', 'owner@example.test', 'Owner', 'x', ?, ?)`,
    [NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO studies (id, key, title, created_by, created_ts, updated_ts, seq)
     VALUES ('s_1', 'ONE', 'One', 'u_1', ?, ?, ?)`,
    [NOW, NOW, nextSeq(store)],
  );
  for (const [index, taskId] of ["t_overlap", "t_old", "t_new"].entries()) {
    store.run(
      `INSERT INTO tasks
         (id, number, study_id, stage, title, status, priority, created_by,
          created_ts, updated_ts, seq)
       VALUES (?, ?, 's_1', 'background', ?, 'todo', 'no-priority',
               'u_1', ?, ?, ?)`,
      [taskId, index + 1, taskId, NOW, NOW, nextSeq(store)],
    );
  }
  store.run(
    `INSERT INTO runtimes
       (id, owner_id, name, platform, daemon_version, capabilities, created_ts,
        last_seen_ts, seq)
     VALUES ('rt_1', 'u_1', 'Mac', 'darwin', '1', '[]', ?, ?, ?)`,
    [NOW, NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO kernel_envs
       (name, language, manager, packages, created_by, created_ts, lock_revision)
     VALUES ('analysis', 'python', 'uv', '["numpy","pandas","matplotlib","scipy","seaborn"]',
             'u_1', ?, 2)`,
    [NOW],
  );
  store.run(
    `INSERT INTO kernel_env_locks
       (name, revision, lockfile, written_ts, requested_packages)
     VALUES ('analysis', 1, 'numpy==1\n', ?, '["numpy"]'),
            ('analysis', 2,
             'numpy==1\npandas==2\nmatplotlib==3\nscipy==4\nseaborn==5\n', ?,
             '["numpy","pandas","matplotlib","scipy","seaborn"]')`,
    [NOW, NOW + 1],
  );
  for (const [sessionId, taskId, turnId] of [
    ["se_old", "t_overlap", "turn_old"],
    ["se_new", "t_overlap", "turn_new"],
    ["se_queued", "t_new", "turn_queued"],
    ["se_cont", "t_new", "turn_cont"],
  ] as const) {
    store.run(
      `INSERT INTO sessions
         (id, study_id, runtime_id, agent, opened_by, opened_ts, seq)
       VALUES (?, 's_1', 'rt_1', 'claude', 'u_1', ?, ?)`,
      [sessionId, NOW, nextSeq(store)],
    );
    store.run(
      `INSERT INTO turns
         (id, session_id, task_id, prompt, started_ts, status, seq)
       VALUES (?, ?, ?, 'setup', ?, 'ok', ?)`,
      [turnId, sessionId, taskId, NOW, nextSeq(store)],
    );
  }
  const insertJob = (
    id: string,
    requestId: string,
    lockRevision: number,
    state: "requested" | "building",
    stage: "waiting-for-machine" | "installing",
    resolvedFrom: string | null,
  ) => store.run(
    `INSERT INTO kernel_env_setup_jobs
       (id, runtime_id, environment_name, language, manager, lock_revision,
        request_id, resolved_from, state, stage, requested_ts, started_ts, updated_ts, seq)
     VALUES (?, 'rt_1', 'analysis', 'python', 'uv', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      lockRevision,
      requestId,
      resolvedFrom,
      state,
      stage,
      NOW + lockRevision,
      state === "building" ? NOW + lockRevision : null,
      NOW + lockRevision,
      nextSeq(store),
    ],
  );
  insertJob("job_ancient", "req_ancient", 0, "building", "installing", '["base"]');
  insertJob("job_old", "req_old", 1, "building", "installing", '["numpy"]');
  insertJob("job_new", "req_new", 2, "requested", "waiting-for-machine", null);

  for (const [jobId, taskId, requestedTs, packages] of [
    ["job_old", "t_overlap", NOW + 1, '["numpy","pandas"]'],
    ["job_old", "t_old", NOW + 2, '["scipy"]'],
    ["job_new", "t_overlap", NOW + 3, '["pandas","matplotlib"]'],
    ["job_new", "t_new", NOW + 4, '["seaborn"]'],
  ] as const) {
    store.run(
      `INSERT INTO kernel_env_setup_interests
         (job_id, study_id, task_id, requested_by, requested_ts, requested_packages)
       VALUES (?, 's_1', ?, 'u_1', ?, ?)`,
      [jobId, taskId, requestedTs, packages],
    );
  }
  for (const [id, jobId, taskId, sessionId, turnId, state, continuation] of [
    ["wait_old", "job_old", "t_overlap", "se_old", "turn_old", "waiting", null],
    ["wait_new", "job_new", "t_overlap", "se_new", "turn_new", "waiting", null],
    ["wait_queued", "job_old", "t_new", "se_queued", "turn_queued", "queued", "turn_cont"],
  ] as const) {
    store.run(
      `INSERT INTO task_env_setup_waiters
         (id, job_id, study_id, task_id, session_id, source_turn_id, source_run_id,
          language, environment_name, runtime_id, state, continuation_turn_id,
          created_ts, updated_ts, seq)
       VALUES (?, ?, 's_1', ?, ?, ?, ?, 'python', 'analysis', 'rt_1', ?, ?, ?, ?, ?)`,
      [id, jobId, taskId, sessionId, turnId, `source_${id}`, state, continuation, NOW, NOW, nextSeq(store)],
    );
  }

  expect(() => migrate(store)).not.toThrow();

  expect(store.get(`SELECT MAX(version) AS version FROM schema_version`)!.version).toBe(HEAD);
  expect(store.get(
    `SELECT request_id, lock_revision, resolved_from, state, stage,
            declaration_generation_id
       FROM kernel_env_setup_jobs WHERE id = 'job_old'`,
  )).toEqual({
    request_id: "req_old",
    lock_revision: 2,
    resolved_from: null,
    state: "requested",
    stage: "waiting-for-machine",
    declaration_generation_id: null,
  });
  const redundant = store.get(
    `SELECT state, error_summary, finished_ts FROM kernel_env_setup_jobs WHERE id = 'job_new'`,
  )!;
  expect(redundant.state).toBe("failed");
  expect(redundant.error_summary).toMatch(/migration 37/i);
  expect((redundant.error_summary as string).length).toBeLessThanOrEqual(4_096);
  expect(redundant.finished_ts).not.toBeNull();
  expect(
    store.get(`SELECT state FROM kernel_env_setup_jobs WHERE id = 'job_ancient'`),
  ).toEqual({ state: "failed" });
  expect(
    store.all(
      `SELECT job_id, task_id, requested_ts, requested_packages, coverage_round
         FROM kernel_env_setup_interests ORDER BY task_id`,
    ),
  ).toEqual([
    {
      job_id: "job_old",
      task_id: "t_new",
      requested_ts: NOW + 4,
      requested_packages: '["seaborn"]',
      coverage_round: 1,
    },
    {
      job_id: "job_old",
      task_id: "t_old",
      requested_ts: NOW + 2,
      requested_packages: '["scipy"]',
      coverage_round: 1,
    },
    {
      job_id: "job_old",
      task_id: "t_overlap",
      requested_ts: NOW + 1,
      requested_packages: '["numpy","pandas","matplotlib"]',
      coverage_round: 1,
    },
  ]);
  expect(
    store.all(
      `SELECT id, job_id, state, continuation_turn_id
         FROM task_env_setup_waiters ORDER BY id`,
    ),
  ).toEqual([
    { id: "wait_new", job_id: "job_old", state: "waiting", continuation_turn_id: null },
    { id: "wait_old", job_id: "job_old", state: "waiting", continuation_turn_id: null },
    { id: "wait_queued", job_id: "job_old", state: "queued", continuation_turn_id: "turn_cont" },
  ]);
  const recovered: RunCommand[] = [];
  const runs = createRunRelay();
  runs.attach("rt_1", (_seq, command) => recovered.push(command));
  createEnvironmentSetupCoordinator({ store, runs, now: () => NOW + 10 }).recover(() => {});
  expect(recovered).toEqual([]);
  expect(() =>
    insertJob("job_again", "req_again", 3, "requested", "waiting-for-machine", null),
  ).toThrow(/UNIQUE/);
});

it("migration 37 recovers nothing beside an incompatible historical build", () => {
  const store = databaseAt(36);
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq)
     VALUES ('u_1', 'owner@example.test', 'Owner', 'x', ?, ?)`,
    [NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO studies (id, key, title, created_by, created_ts, updated_ts, seq)
     VALUES ('s_1', 'ONE', 'One', 'u_1', ?, ?, ?)`,
    [NOW, NOW, nextSeq(store)],
  );
  for (const [index, taskId] of ["t_python", "t_r"].entries()) {
    store.run(
      `INSERT INTO tasks
         (id, number, study_id, stage, title, status, priority, created_by,
          created_ts, updated_ts, seq)
       VALUES (?, ?, 's_1', 'background', ?, 'todo', 'no-priority',
               'u_1', ?, ?, ?)`,
      [taskId, index + 1, taskId, NOW, NOW, nextSeq(store)],
    );
  }
  store.run(
    `INSERT INTO runtimes
       (id, owner_id, name, platform, daemon_version, capabilities, created_ts,
        last_seen_ts, seq)
     VALUES ('rt_1', 'u_1', 'Mac', 'darwin', '1', '[]', ?, ?, ?)`,
    [NOW, NOW, nextSeq(store)],
  );
  // This is the valid state after deleting a Python declaration (which also
  // deletes its locks) and recreating the same name as an unbuilt R env.
  store.run(
    `INSERT INTO kernel_envs
       (name, language, manager, packages, created_by, created_ts, lock_revision)
     VALUES ('analysis', 'r', 'conda', '["tidyverse"]', 'u_1', ?, 0)`,
    [NOW],
  );
  store.run(
    `INSERT INTO kernel_envs
       (name, language, manager, packages, created_by, created_ts, lock_revision)
     VALUES ('secondary', 'r', 'conda', '["jsonlite"]', 'u_1', ?, 0)`,
    [NOW],
  );
  for (const [sessionId, taskId, turnId] of [
    ["se_python", "t_python", "turn_python"],
    ["se_r", "t_r", "turn_r"],
  ] as const) {
    store.run(
      `INSERT INTO sessions
         (id, study_id, runtime_id, agent, opened_by, opened_ts, seq)
       VALUES (?, 's_1', 'rt_1', 'claude', 'u_1', ?, ?)`,
      [sessionId, NOW, nextSeq(store)],
    );
    store.run(
      `INSERT INTO turns
         (id, session_id, task_id, prompt, started_ts, status, seq)
       VALUES (?, ?, ?, 'setup', ?, 'ok', ?)`,
      [turnId, sessionId, taskId, NOW, nextSeq(store)],
    );
  }
  for (const [id, requestId, environment, language, manager, revision, state, stage] of [
    ["job_python", "req_python", "analysis", "python", "uv", 9, "building", "installing"],
    ["job_r", "req_r", "analysis", "r", "conda", 0, "requested", "waiting-for-machine"],
    ["job_secondary_python", "req_secondary_python", "secondary", "python", "uv", 7,
      "building", "installing"],
  ] as const) {
    store.run(
      `INSERT INTO kernel_env_setup_jobs
         (id, runtime_id, environment_name, language, manager, lock_revision,
          request_id, resolved_from, state, stage, requested_ts, started_ts, updated_ts, seq)
       VALUES (?, 'rt_1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        environment,
        language,
        manager,
        revision,
        requestId,
        language === "r" ? '["tidyverse"]' : '["numpy"]',
        state,
        stage,
        NOW + revision,
        state === "building" ? NOW + revision : null,
        NOW + revision,
        nextSeq(store),
      ],
    );
  }
  for (const [jobId, taskId, language, sessionId, turnId, packages] of [
    ["job_python", "t_python", "python", "se_python", "turn_python", '["numpy"]'],
    ["job_r", "t_r", "r", "se_r", "turn_r", '["tidyverse"]'],
  ] as const) {
    store.run(
      `INSERT INTO kernel_env_setup_interests
         (job_id, study_id, task_id, requested_by, requested_ts, requested_packages)
       VALUES (?, 's_1', ?, 'u_1', ?, ?)`,
      [jobId, taskId, NOW, packages],
    );
    store.run(
      `INSERT INTO task_env_setup_waiters
         (id, job_id, study_id, task_id, session_id, source_turn_id, source_run_id,
          language, environment_name, runtime_id, state, created_ts, updated_ts, seq)
       VALUES (?, ?, 's_1', ?, ?, ?, ?, ?, 'analysis', 'rt_1', 'waiting', ?, ?, ?)`,
      [`wait_${language}`, jobId, taskId, sessionId, turnId, `source_${language}`, language,
        NOW, NOW, nextSeq(store)],
    );
  }

  expect(() => migrate(store)).not.toThrow();
  expect(
    store.all(
      `SELECT id, request_id, language, manager, lock_revision, resolved_from, state
         FROM kernel_env_setup_jobs ORDER BY id`,
    ),
  ).toEqual([
    {
      id: "job_python",
      request_id: "req_python",
      language: "python",
      manager: "uv",
      lock_revision: 9,
      resolved_from: '["numpy"]',
      state: "failed",
    },
    {
      id: "job_r",
      request_id: "req_r",
      language: "r",
      manager: "conda",
      lock_revision: 0,
      resolved_from: '["tidyverse"]',
      state: "failed",
    },
    {
      id: "job_secondary_python",
      request_id: "req_secondary_python",
      language: "python",
      manager: "uv",
      lock_revision: 7,
      resolved_from: '["numpy"]',
      state: "failed",
    },
  ]);
  const incompatible = store.get(
    `SELECT error_summary FROM kernel_env_setup_jobs WHERE id = 'job_python'`,
  )!;
  expect(incompatible.error_summary).toMatch(/current declaration is r\/conda/i);
  expect((incompatible.error_summary as string).length).toBeLessThanOrEqual(4_096);
  expect(
    store.get(
      `SELECT state, error_summary FROM kernel_env_setup_jobs
        WHERE id = 'job_secondary_python'`,
    ),
  ).toMatchObject({ state: "failed", error_summary: expect.stringMatching(/r\/conda/i) });
  expect(
    store.all(
      `SELECT job_id, task_id, requested_packages
         FROM kernel_env_setup_interests ORDER BY job_id`,
    ),
  ).toEqual([
    { job_id: "job_python", task_id: "t_python", requested_packages: '["numpy"]' },
    { job_id: "job_r", task_id: "t_r", requested_packages: '["tidyverse"]' },
  ]);
  expect(
    store.all(`SELECT id, job_id, language, state FROM task_env_setup_waiters ORDER BY id`),
  ).toEqual([
    { id: "wait_python", job_id: "job_python", language: "python", state: "waiting" },
    { id: "wait_r", job_id: "job_r", language: "r", state: "waiting" },
  ]);

  const recovered: RunCommand[] = [];
  const runs = createRunRelay();
  runs.attach("rt_1", (_seq, command) => recovered.push(command));
  createEnvironmentSetupCoordinator({ store, runs, now: () => NOW + 10 }).recover(() => {});
  expect(recovered).toEqual([]);
});

function seedSamePairGenerationFixture(store: Store): void {
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq)
     VALUES ('u_generation', 'generation@example.test', 'Generation', 'x', ?, ?)`,
    [NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO studies (id, key, title, created_by, created_ts, updated_ts, seq)
     VALUES ('s_generation', 'GEN', 'Generation', 'u_generation', ?, ?, ?)`,
    [NOW, NOW, nextSeq(store)],
  );
  for (const [index, taskId] of ["t_historical", "t_current"].entries()) {
    store.run(
      `INSERT INTO tasks
         (id, number, study_id, stage, title, status, priority, created_by,
          created_ts, updated_ts, seq)
       VALUES (?, ?, 's_generation', 'background', ?, 'todo', 'no-priority',
               'u_generation', ?, ?, ?)`,
      [taskId, index + 1, taskId, NOW, NOW, nextSeq(store)],
    );
  }
  store.run(
    `INSERT INTO runtimes
       (id, owner_id, name, platform, daemon_version, capabilities, created_ts,
        last_seen_ts, seq)
     VALUES ('rt_generation', 'u_generation', 'Mac', 'darwin', '1', '[]', ?, ?, ?)`,
    [NOW, NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO kernel_envs
       (name, language, manager, packages, created_by, created_ts, lock_revision)
     VALUES ('recreated', 'python', 'uv', '["numpy","pandas"]',
             'u_generation', ?, 0)`,
    [NOW + 100],
  );
  for (const [sessionId, taskId, turnId] of [
    ["se_historical", "t_historical", "turn_historical"],
    ["se_current", "t_current", "turn_current"],
  ] as const) {
    store.run(
      `INSERT INTO sessions
         (id, study_id, runtime_id, agent, opened_by, opened_ts, seq)
       VALUES (?, 's_generation', 'rt_generation', 'claude', 'u_generation', ?, ?)`,
      [sessionId, NOW, nextSeq(store)],
    );
    store.run(
      `INSERT INTO turns
         (id, session_id, task_id, prompt, started_ts, status, seq)
       VALUES (?, ?, ?, 'setup', ?, 'ok', ?)`,
      [turnId, sessionId, taskId, NOW, nextSeq(store)],
    );
  }
}

function insertGenerationJob(
  store: Store,
  input: {
    id: string;
    requestId: string;
    taskId: "t_historical" | "t_current";
    requestedTs: number;
    lockRevision: number;
    state?: "requested" | "building";
  },
): void {
  const suffix = input.taskId === "t_historical" ? "historical" : "current";
  const state = input.state ?? "requested";
  store.run(
    `INSERT INTO kernel_env_setup_jobs
       (id, runtime_id, environment_name, language, manager, lock_revision,
        request_id, resolved_from, state, stage, requested_ts, started_ts, updated_ts, seq)
     VALUES (?, 'rt_generation', 'recreated', 'python', 'uv', ?, ?, '["numpy"]',
             ?, ?, ?, ?, ?, ?)`,
    [input.id, input.lockRevision, input.requestId, state,
      state === "building" ? "installing" : "waiting-for-machine", input.requestedTs,
      state === "building" ? input.requestedTs : null,
      input.requestedTs, nextSeq(store)],
  );
  store.run(
    `INSERT INTO kernel_env_setup_interests
       (job_id, study_id, task_id, requested_by, requested_ts, requested_packages)
     VALUES (?, 's_generation', ?, 'u_generation', ?, '["numpy"]')`,
    [input.id, input.taskId, input.requestedTs],
  );
  store.run(
    `INSERT INTO task_env_setup_waiters
       (id, job_id, study_id, task_id, session_id, source_turn_id, source_run_id,
        language, environment_name, runtime_id, state, created_ts, updated_ts, seq)
     VALUES (?, ?, 's_generation', ?, ?, ?, ?, 'python', 'recreated',
             'rt_generation', 'waiting', ?, ?, ?)`,
    [
      `wait_${suffix}`,
      input.id,
      input.taskId,
      `se_${suffix}`,
      `turn_${suffix}`,
      `source_${suffix}`,
      input.requestedTs,
      input.requestedTs,
      nextSeq(store),
    ],
  );
}

it("migration 37 terminalizes a lone pre-declaration job from the same language and manager", () => {
  const store = databaseAt(36);
  seedSamePairGenerationFixture(store);
  insertGenerationJob(store, {
    id: "job_historical",
    requestId: "req_historical",
    taskId: "t_historical",
    requestedTs: NOW + 10,
    lockRevision: 9,
  });

  expect(() => migrate(store)).not.toThrow();
  expect(
    store.get(
      `SELECT state, lock_revision, error_summary
         FROM kernel_env_setup_jobs WHERE id = 'job_historical'`,
    ),
  ).toMatchObject({
    state: "failed",
    lock_revision: 9,
    error_summary: expect.stringMatching(/generation/i),
  });
  expect(store.all(`SELECT job_id FROM kernel_env_setup_interests`)).toEqual([
    { job_id: "job_historical" },
  ]);
  expect(store.all(`SELECT job_id FROM task_env_setup_waiters`)).toEqual([
    { job_id: "job_historical" },
  ]);

  const recovered: RunCommand[] = [];
  const runs = createRunRelay();
  runs.attach("rt_generation", (_seq, command) => recovered.push(command));
  createEnvironmentSetupCoordinator({ store, runs, now: () => NOW + 200 }).recover(() => {});
  expect(recovered).toEqual([]);
});

it("migration 37 conservatively terminalizes and permits retry of an ambiguous same-tick revision-zero job", () => {
  const store = databaseAt(36);
  seedSamePairGenerationFixture(store);
  // v36 has no declaration-generation identity. This lone row can be the old
  // declaration's last request or the replacement declaration's first request:
  // both have the same pair, revision zero, and second-resolution timestamp.
  insertGenerationJob(store, {
    id: "job_same_tick",
    requestId: "req_same_tick",
    taskId: "t_historical",
    requestedTs: NOW + 100,
    lockRevision: 0,
  });
  expect(
    store.get(
      `SELECT language, manager, created_ts, lock_revision
         FROM kernel_envs WHERE name = 'recreated'`,
    ),
  ).toEqual({
    language: "python",
    manager: "uv",
    created_ts: NOW + 100,
    lock_revision: 0,
  });

  expect(() => migrate(store)).not.toThrow();
  expect(
    store.get(
      `SELECT state, lock_revision, error_summary
         FROM kernel_env_setup_jobs WHERE id = 'job_same_tick'`,
    ),
  ).toMatchObject({
    state: "failed",
    lock_revision: 0,
    error_summary: expect.stringMatching(/generation/i),
  });
  expect(store.all(`SELECT job_id FROM kernel_env_setup_interests`)).toEqual([
    { job_id: "job_same_tick" },
  ]);
  expect(store.all(`SELECT id, job_id, state FROM task_env_setup_waiters`)).toEqual([
    { id: "wait_historical", job_id: "job_same_tick", state: "waiting" },
  ]);

  const recovered: RunCommand[] = [];
  const runs = createRunRelay();
  runs.attach("rt_generation", (_seq, command) => recovered.push(command));
  const coordinator = createEnvironmentSetupCoordinator({
    store,
    runs,
    now: () => NOW + 101,
  });
  coordinator.recover(() => {});
  expect(recovered).toEqual([]);
  expect(
    store.get(
      `SELECT sql FROM sqlite_master
        WHERE type = 'index' AND name = 'one_active_environment_build'`,
    )?.sql,
  ).toMatch(/\(runtime_id, environment_name\)/);

  // Conservatism also terminalizes a genuinely current same-tick request.
  // Its preserved waiter is the explicit retry path; the retry is newer than
  // the declaration and therefore safe to dispatch as a fresh identity.
  const retried = coordinator.retry(
    "wait_historical",
    { userId: "u_generation", role: "owner" },
    () => {},
  );
  expect(retried.waiterId).toBe("wait_historical");
  expect(retried.jobId).not.toBe("job_same_tick");
  expect(recovered).toEqual([
    expect.objectContaining({
      type: "kernel-env-setup",
      name: "recreated",
      packages: ["numpy", "pandas"],
    }),
  ]);
});

it("migration 39 quarantines the T+1 v37 request while preserving its exact attachments", () => {
  const store = databaseAt(36);
  seedSamePairGenerationFixture(store);
  insertGenerationJob(store, {
    id: "job_historical",
    requestId: "req_historical",
    taskId: "t_historical",
    requestedTs: NOW + 10,
    lockRevision: 9,
  });
  insertGenerationJob(store, {
    id: "job_current",
    requestId: "req_current",
    taskId: "t_current",
    requestedTs: NOW + 101,
    lockRevision: 0,
  });

  expect(() => migrate(store)).not.toThrow();
  expect(
    store.all(
      `SELECT id, state, lock_revision FROM kernel_env_setup_jobs ORDER BY id`,
    ),
  ).toEqual([
    { id: "job_current", state: "requested", lock_revision: 0 },
    { id: "job_historical", state: "failed", lock_revision: 9 },
  ]);
  expect(
    store.all(
      `SELECT job_id, task_id FROM kernel_env_setup_interests ORDER BY task_id`,
    ),
  ).toEqual([
    { job_id: "job_current", task_id: "t_current" },
    { job_id: "job_historical", task_id: "t_historical" },
  ]);
  expect(
    store.all(`SELECT id, job_id FROM task_env_setup_waiters ORDER BY id`),
  ).toEqual([
    { id: "wait_current", job_id: "job_current" },
    { id: "wait_historical", job_id: "job_historical" },
  ]);

  const recovered: RunCommand[] = [];
  const runs = createRunRelay();
  runs.attach("rt_generation", (_seq, command) => recovered.push(command));
  createEnvironmentSetupCoordinator({ store, runs, now: () => NOW + 200 }).recover(() => {});
  expect(recovered).toEqual([]);
});

it("migration 39 quarantines a v36 build normalized to requested and refuses overlapping retry", () => {
  const store = databaseAt(36);
  seedSamePairGenerationFixture(store);
  store.run(
    `UPDATE kernel_envs SET lock_revision = 1 WHERE name = 'recreated'`,
  );
  store.run(
    `INSERT INTO kernel_env_locks
       (name, revision, lockfile, written_ts, requested_packages)
     VALUES ('recreated', 1, 'numpy==1\npandas==2\n', ?, '["numpy","pandas"]')`,
    [NOW + 105],
  );
  insertGenerationJob(store, {
    id: "job_historical",
    requestId: "req_historical",
    taskId: "t_historical",
    requestedTs: NOW + 10,
    lockRevision: 9,
    state: "building",
  });
  insertGenerationJob(store, {
    id: "job_current_building",
    requestId: "req_current_building",
    taskId: "t_current",
    requestedTs: NOW + 110,
    lockRevision: 0,
    state: "building",
  });
  store.run(
    `INSERT INTO kernel_env_setup_jobs
       (id, runtime_id, environment_name, language, manager, lock_revision,
        request_id, resolved_from, state, stage, requested_ts, updated_ts, seq)
     VALUES ('job_current_requested', 'rt_generation', 'recreated', 'python', 'uv', 1,
             'req_current_requested', NULL, 'requested', 'waiting-for-machine', ?, ?, ?)`,
    [NOW + 120, NOW + 120, nextSeq(store)],
  );

  expect(() => migrate(store)).not.toThrow();
  expect(
    store.all(
      `SELECT id, request_id, state, lock_revision
         FROM kernel_env_setup_jobs ORDER BY id`,
    ),
  ).toEqual([
    {
      id: "job_current_building",
      request_id: "req_current_building",
      state: "requested",
      lock_revision: 1,
    },
    {
      id: "job_current_requested",
      request_id: "req_current_requested",
      state: "failed",
      lock_revision: 1,
    },
    {
      id: "job_historical",
      request_id: "req_historical",
      state: "failed",
      lock_revision: 9,
    },
  ]);

  const recovered: RunCommand[] = [];
  const runs = createRunRelay();
  runs.attach("rt_generation", (_seq, command) => recovered.push(command));
  createEnvironmentSetupCoordinator({ store, runs, now: () => NOW + 200 }).recover(() => {});
  expect(recovered).toEqual([]);
  const currentGeneration = store.get(
    `SELECT declaration_generation_id FROM kernel_envs WHERE name = 'recreated'`,
  )!.declaration_generation_id as string;
  expect(() => environmentSetupStore(store).requestPhysicalJob({
    runtimeId: "rt_generation",
    environmentName: "recreated",
    language: "python",
    manager: "uv",
    lockRevision: 1,
    declarationGenerationId: currentGeneration,
    declarationCreatedTs: NOW + 100,
    requestId: "req_current_after_upgrade",
    requestedTs: NOW + 201,
  })).toThrow(/legacy|settle|generation/i);
  expect(store.get(
    `SELECT state FROM kernel_env_setup_jobs WHERE id = 'job_current_building'`,
  )).toEqual({ state: "requested" });
});

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
  // Parent tables migration 33's durable lifecycle rows reference. Migration
  // 34 deletes duplicate suggestion rows, and SQLite resolves their foreign
  // keys even when this historical fixture holds no suggestions.
  store.run(`CREATE TABLE studies (id TEXT PRIMARY KEY)`);
  store.run(`CREATE TABLE tasks (id TEXT PRIMARY KEY)`);
  store.run(`CREATE TABLE runtimes (id TEXT PRIMARY KEY)`);
  store.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY)`);
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
  // As migrations 7, 10, and 16 left it. Migration 33 adds durable origin
  // metadata to every lab at 32, including this historical repair fixture.
  store.run(`
    CREATE TABLE turns (
      id                TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL,
      task_id           TEXT NOT NULL,
      prompt            TEXT NOT NULL,
      started_ts        INTEGER NOT NULL,
      ended_ts          INTEGER,
      status            TEXT NOT NULL,
      text              TEXT NOT NULL DEFAULT '',
      seq               INTEGER NOT NULL UNIQUE,
      last_frame_seq    INTEGER NOT NULL DEFAULT 0,
      recovery_snapshot TEXT NOT NULL DEFAULT
        '{"version":1,"state":{"state":"planning"},"stream":[],"live":{},"reviewing":false}',
      snapshot_taken    INTEGER,
      snapshot_reason   TEXT
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
  // say" rather than as "resolved from nothing". `planFor` widens to a
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

it("gives durable setup interests an append-only requested package snapshot", () => {
  const store = freshStore();

  expect(notNull(store, "kernel_env_setup_interests", "requested_packages")).toBe(true);
  expect(
    store.all(`PRAGMA table_info(kernel_env_setup_interests)`).find(
      (column) => column.name === "requested_packages",
    )?.dflt_value,
  ).toBe("'[]'");
});

it("gives durable setup rounds bounded append-only ancestry", () => {
  const store = freshStore();
  const columns = store.all(`PRAGMA table_info(kernel_env_setup_jobs)`);

  expect(columns.find((column) => column.name === "previous_job_id")?.notnull).toBe(0);
  expect(columns.find((column) => column.name === "round")?.notnull).toBe(1);
  expect(columns.find((column) => column.name === "round")?.dflt_value).toBe("1");
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

it("migration 33 preserves old turns as user-authored and permits unattached waiters", () => {
  const store = openFresh();
  for (const candidate of MIGRATIONS.filter(({ version }) => version <= 32)) {
    store.tx(() => candidate.up(store));
  }
  store.run(
    `INSERT INTO turns
       (id, session_id, task_id, prompt, started_ts, status, seq, last_frame_seq, recovery_snapshot)
     VALUES ('run_before', 'sess_1', 't_1', 'before', ?, 'ok', ?, 0,
             '{"version":1,"state":{"state":"planning"},"stream":[],"live":{},"reviewing":false}')`,
    [NOW, nextSeq(store)],
  );

  store.tx(() => migration(33).up(store));

  expect(store.get(`SELECT origin, continuation FROM turns WHERE id = 'run_before'`)).toEqual({
    origin: "user",
    continuation: null,
  });
  expect(notNull(store, "task_env_setup_waiters", "job_id")).toBe(false);
});

it("migration 33 permits one active environment attempt and later terminal attempts", () => {
  const store = freshStore();
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq)
     VALUES ('u_1', 'owner@example.test', 'Owner', 'x', ?, ?)`,
    [NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO runtimes
       (id, owner_id, name, platform, daemon_version, capabilities, created_ts,
        last_seen_ts, seq)
     VALUES ('rt_1', 'u_1', 'Mac', 'darwin', '1', '[]', ?, ?, ?)`,
    [NOW, NOW, nextSeq(store)],
  );
  const insertJob = (id: string, requestId: string, state: string) =>
    store.run(
      `INSERT INTO kernel_env_setup_jobs
         (id, runtime_id, environment_name, language, manager, lock_revision,
          request_id, state, stage, requested_ts, updated_ts, seq)
       VALUES (?, 'rt_1', 'analysis', 'python', 'uv', 4, ?, ?,
               'waiting-for-machine', ?, ?, ?)`,
      [id, requestId, state, NOW, NOW, nextSeq(store)],
    );

  insertJob("job_active", "req_active", "requested");
  expect(() => insertJob("job_conflict", "req_conflict", "building")).toThrow(/UNIQUE/);
  store.run(`UPDATE kernel_env_setup_jobs SET state = 'ready' WHERE id = 'job_active'`);
  expect(() => insertJob("job_terminal_one", "req_terminal_one", "failed")).not.toThrow();
  expect(() => insertJob("job_terminal_two", "req_terminal_two", "ready")).not.toThrow();
});

it("migration 34 repairs duplicate pending suggestions and prevents another", () => {
  expect(migration(34).version).toBe(34);
  const store = openFresh();
  for (const candidate of MIGRATIONS.filter(({ version }) => version <= 33)) {
    store.tx(() => candidate.up(store));
  }
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq)
     VALUES ('u_1', 'owner@example.test', 'Owner', 'x', ?, ?)`,
    [NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO studies (id, key, title, created_by, created_ts, updated_ts, seq)
     VALUES ('s_1', 'ONE', 'One', 'u_1', ?, ?, ?)`,
    [NOW, NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO tasks
       (id, number, study_id, stage, title, status, priority, created_by,
        created_ts, updated_ts, seq)
     VALUES ('t_1', 1, 's_1', 'background', 'One', 'todo', 'no-priority',
             'u_1', ?, ?, ?)`,
    [NOW, NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO runtimes
       (id, owner_id, name, platform, daemon_version, capabilities, created_ts,
        last_seen_ts, seq)
     VALUES ('rt_1', 'u_1', 'Mac', 'darwin', '1', '[]', ?, ?, ?)`,
    [NOW, NOW, nextSeq(store)],
  );
  for (const [id, requestId] of [["job_1", "req_1"], ["job_2", "req_2"]] as const) {
    store.run(
      `INSERT INTO kernel_env_setup_jobs
         (id, runtime_id, environment_name, language, manager, lock_revision,
          request_id, state, stage, requested_ts, finished_ts, updated_ts, seq)
       VALUES (?, 'rt_1', 'analysis', 'python', 'uv', 4, ?, 'ready',
               'finalizing', ?, ?, ?, ?)`,
      [id, requestId, NOW, NOW, NOW, nextSeq(store)],
    );
  }
  const insertSuggestion = (id: string, jobId: string, state: string) =>
    store.run(
      `INSERT INTO environment_default_suggestions
         (id, job_id, study_id, task_id, language, environment_name, state, created_ts, seq)
       VALUES (?, ?, 's_1', 't_1', 'python', 'analysis', ?, ?, ?)`,
      [id, jobId, state, NOW, nextSeq(store)],
    );

  insertSuggestion("suggest_1", "job_1", "pending");
  insertSuggestion("suggest_2", "job_2", "pending");

  store.tx(() => migration(34).up(store));

  expect(
    store.all(
      `SELECT id FROM environment_default_suggestions
        WHERE study_id = 's_1' AND language = 'python' AND state = 'pending'`,
    ),
  ).toEqual([{ id: "suggest_1" }]);
  expect(() => insertSuggestion("suggest_3", "job_2", "pending")).toThrow(/UNIQUE/);
});
