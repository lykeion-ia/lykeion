import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./sqlite";
import { migrate, nextSeq } from "./migrations";
import { environmentSetupStore } from "./environment-setups";
import { environmentStore } from "./environments";
import { finishTurn, openSession, recordTurn } from "./sessions";
import type { Store } from "./store";

const dirs: string[] = [];
const opened: Store[] = [];
const NOW = 1_800_000_000;

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-environment-setups-"));
  dirs.push(dir);
  const store = openStore(join(dir, "workspace.db"));
  opened.push(store);
  migrate(store);
  return store;
}

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed(store: Store): { sessions: Record<string, string>; turns: Record<string, string> } {
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
  for (const [id, number] of [["t_1", 1], ["t_2", 2]] as const) {
    store.run(
      `INSERT INTO tasks
         (id, number, study_id, stage, title, status, priority, created_by,
          created_ts, updated_ts, seq)
       VALUES (?, ?, 's_1', 'background', ?, 'todo', 'no-priority', 'u_1', ?, ?, ?)`,
      [id, number, id, NOW, NOW, nextSeq(store)],
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
       (name, language, manager, packages, created_by, created_ts, lock_revision,
        declaration_generation_id)
     VALUES ('analysis', 'python', 'uv', '["numpy"]', 'u_1', ?, 4, 'envgen_analysis')`,
    [NOW],
  );

  const sessions: Record<string, string> = {};
  const turns: Record<string, string> = {};
  for (const taskId of ["t_1", "t_2"]) {
    const sessionId = openSession(store, {
      researchId: "s_1",
      machineId: "rt_1",
      agent: "claude",
      openedBy: "u_1",
      openedTs: NOW,
    });
    const turnId = recordTurn(store, {
      sessionId,
      taskId,
      prompt: `work on ${taskId}`,
      startedTs: NOW,
    });
    finishTurn(store, turnId, { endedTs: NOW + 1, status: "ok" });
    sessions[taskId] = sessionId;
    turns[taskId] = turnId;
  }
  return { sessions, turns };
}

function requirementInput(
  seeded: ReturnType<typeof seed>,
  taskId: "t_1" | "t_2",
  overrides: Partial<{ environmentName: string; runtimeId: string }> = {},
) {
  return {
    studyId: "s_1",
    taskId,
    sessionId: seeded.sessions[taskId]!,
    sourceTurnId: seeded.turns[taskId]!,
    sourceRunId: seeded.turns[taskId]!,
    language: "python" as const,
    environmentName: overrides.environmentName ?? "analysis",
    runtimeId: overrides.runtimeId ?? "rt_1",
    createdTs: NOW + 2,
  };
}

function jobInput(
  taskId: "t_1" | "t_2",
  overrides: Partial<{
    requestId: string;
    environmentName: string;
    lockRevision: number;
    requestedTs: number;
    runtimeId: string;
    language: "python" | "r";
    manager: "uv" | "conda";
    requestedPackages: string[];
    sourceRunId: string;
    previousJobId: string;
    round: number;
    declarationCreatedTs: number;
    declarationGenerationId: string;
  }> = {},
) {
  return {
    studyId: "s_1",
    taskId,
    runtimeId: overrides.runtimeId ?? "rt_1",
    environmentName: overrides.environmentName ?? "analysis",
    language: overrides.language ?? "python" as const,
    manager: overrides.manager ?? "uv" as const,
    lockRevision: overrides.lockRevision ?? 4,
    declarationCreatedTs: overrides.declarationCreatedTs ?? NOW,
    declarationGenerationId: overrides.declarationGenerationId ?? "envgen_analysis",
    requestId: overrides.requestId ?? `req_${taskId}`,
    requestedBy: "u_1",
    requestedTs: overrides.requestedTs ?? NOW + 3,
    requestedPackages: overrides.requestedPackages ?? ["numpy"],
    ...(overrides.sourceRunId === undefined ? {} : { sourceRunId: overrides.sourceRunId }),
    ...(overrides.previousJobId === undefined ? {} : { previousJobId: overrides.previousJobId }),
    ...(overrides.round === undefined ? {} : { round: overrides.round }),
    resolvedFrom: ["numpy"],
    reason: "environment-not-built",
  };
}

it("records an environment requirement before any physical job and deduplicates its source", () => {
  const store = freshStore();
  const { sessions, turns } = seed(store);
  const setups = environmentSetupStore(store);
  const input = {
    studyId: "s_1",
    taskId: "t_1",
    sessionId: sessions.t_1!,
    sourceTurnId: turns.t_1!,
    sourceRunId: turns.t_1!,
    language: "python" as const,
    environmentName: "analysis",
    runtimeId: "rt_1",
    createdTs: NOW + 2,
  };

  const first = setups.recordRequirement(input);
  const duplicate = setups.recordRequirement(input);

  expect(duplicate.id).toBe(first.id);
  expect(first).toMatchObject({ state: "waiting", taskId: "t_1" });
  expect(first.jobId).toBeUndefined();
  expect(store.all(`SELECT * FROM kernel_env_setup_jobs`)).toEqual([]);
  expect(setups.waitingForJob("job_missing")).toEqual([]);
});

it("attaches only the exact source requirement named by a Task request", () => {
  const store = freshStore();
  const seeded = seed(store);
  const setups = environmentSetupStore(store);
  const firstRequirement = setups.recordRequirement(requirementInput(seeded, "t_1"));
  const secondRequirement = setups.recordRequirement(requirementInput(seeded, "t_2"));

  const unrelated = setups.requestJob(
    jobInput("t_1", { requestId: "req_unrelated", environmentName: "other" }),
  );
  expect(unrelated.waiter).toBeUndefined();
  expect(
    store.get(`SELECT job_id FROM task_env_setup_waiters WHERE id = ?`, [firstRequirement.id])!.job_id,
  ).toBeNull();

  const omitted = setups.requestJob(jobInput("t_1"));
  expect(omitted.waiter).toBeUndefined();
  const mismatched = setups.requestJob(jobInput("t_1", {
    requestId: "req_mismatch",
    sourceRunId: seeded.turns.t_2!,
  }));
  expect(mismatched.waiter).toBeUndefined();

  const first = setups.requestJob(jobInput("t_1", { sourceRunId: seeded.turns.t_1! }));
  const second = setups.requestJob(jobInput("t_2", {
    requestId: "req_second",
    sourceRunId: seeded.turns.t_2!,
  }));

  expect(second.job.id).toBe(first.job.id);
  expect(first.waiter?.id).toBe(firstRequirement.id);
  expect(second.waiter?.id).toBe(secondRequirement.id);
  expect(second.waiter?.id).not.toBe(first.waiter?.id);
  expect(setups.waitingForJob(first.job.id).map(({ id }) => id)).toEqual([
    firstRequirement.id,
    secondRequirement.id,
  ]);
  expect(setups.forTask("t_1")).toHaveLength(2);
  expect(setups.forTask("t_2")).toHaveLength(1);
});

it("monotonically unions a Task interest's package snapshots and resets its coverage budget", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);

  const first = setups.requestJob(
    jobInput("t_1", { requestId: "req_first", requestedPackages: ["numpy"] }),
  );
  const second = setups.requestJob(
    jobInput("t_2", {
      requestId: "req_second",
      requestedPackages: ["numpy", "metafor"],
    }),
  );
  setups.requestJob(
    jobInput("t_1", {
      requestId: "req_join_again",
      requestedPackages: ["numpy", "metafor", "tidyverse"],
    }),
  );

  expect(second.job.id).toBe(first.job.id);
  expect(
    store.all(
      `SELECT task_id, requested_packages FROM kernel_env_setup_interests
        WHERE job_id = ? ORDER BY task_id ASC`,
      [first.job.id],
    ),
  ).toEqual([
    { task_id: "t_1", requested_packages: '["numpy","metafor","tidyverse"]' },
    { task_id: "t_2", requested_packages: '["numpy","metafor"]' },
  ]);
  expect(
    store.all(
      `SELECT task_id, coverage_round FROM kernel_env_setup_interests
        WHERE job_id = ? ORDER BY task_id ASC`,
      [first.job.id],
    ),
  ).toEqual([
    { task_id: "t_1", coverage_round: 1 },
    { task_id: "t_2", coverage_round: 1 },
  ]);
});

it("keeps progress monotonic and treats a duplicate phase line idempotently", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  setups.requestJob(jobInput("t_1"));

  expect(setups.markProgress("req_t_1", "finalizing", "writing marker", NOW + 10))
    .toEqual({ accepted: true, changed: true });
  expect(setups.markProgress("req_t_1", "installing", "late install", NOW + 11))
    .toEqual({ accepted: true, changed: false });
  expect(setups.markProgress("req_t_1", "finalizing", "writing marker", NOW + 12))
    .toEqual({ accepted: true, changed: false });
  expect(setups.jobByRequest("req_t_1")).toMatchObject({
    stage: "finalizing",
    log: ["writing marker"],
    updatedTs: NOW + 10,
  });
});

it("atomically rebinds a resolving job to its written lock and keeps one active physical build", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  const first = setups.requestJob(jobInput("t_1", { requestId: "req_resolve" }));

  expect(
    setups.bindResolvedLock(
      "rt_1",
      "req_resolve",
      "analysis",
      "envgen_analysis",
      "numpy==2\n",
      NOW + 10,
    ),
  ).toBe(5);
  expect(
    setups.bindResolvedLock(
      "rt_1",
      "req_resolve",
      "analysis",
      "envgen_analysis",
      "numpy==2\n",
      NOW + 11,
    ),
  ).toBe(5);
  expect(environmentStore(store).get("analysis")!.lockRevision).toBe(5);
  expect(setups.job(first.job.id)).toMatchObject({ lockRevision: 5, resolvedFrom: ["numpy"] });

  const racing = setups.requestJob(jobInput("t_2", {
    requestId: "req_racing",
    lockRevision: 5,
  }));
  expect(racing).toMatchObject({ created: false, job: { id: first.job.id, requestId: "req_resolve" } });
  expect(setups.nonterminalJobs()).toHaveLength(1);
});

it("refuses an old resolver after delete and redeclare before mutating the replacement", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  const requested = setups.requestJob(jobInput("t_1", { requestId: "req_old_resolver" }));
  const oldGeneration = requested.job.declarationGenerationId!;
  const envs = environmentStore(store);
  envs.remove("analysis");
  const replacement = envs.declare({
    name: "analysis",
    language: "python",
    manager: "uv",
    packages: ["numpy"],
    createdBy: "u_1",
    createdTs: NOW + 20,
  });
  expect(replacement.declarationGenerationId).not.toBe(oldGeneration);

  expect(
    setups.bindResolvedLock(
      "rt_1",
      requested.job.requestId,
      "analysis",
      oldGeneration,
      "numpy==2\n",
      NOW + 21,
    ),
  ).toBeUndefined();
  expect(envs.get("analysis")!.lockRevision).toBe(0);
  expect(store.get(`SELECT COUNT(*) AS count FROM kernel_env_locks WHERE name = 'analysis'`))
    .toEqual({ count: 0 });
  expect(setups.job(requested.job.id)).toMatchObject({
    declarationGenerationId: oldGeneration,
    lockRevision: 4,
  });
});

it("commits ready state, one durable follow-up, and eligible interest transfers as one idempotent transition", () => {
  const store = freshStore();
  const seeded = seed(store);
  const setups = environmentSetupStore(store);
  const cappedWaiter = setups.recordRequirement(requirementInput(seeded, "t_1"));
  const movingWaiter = setups.recordRequirement(requirementInput(seeded, "t_2"));
  const source = setups.requestJob(jobInput("t_1", {
    requestId: "req_source",
    requestedPackages: ["numpy", "metafor"],
    sourceRunId: seeded.turns.t_1!,
  }));
  setups.requestJob(jobInput("t_2", {
    requestId: "req_join",
    requestedPackages: ["numpy", "tidyverse"],
    sourceRunId: seeded.turns.t_2!,
  }));
  store.run(
    `UPDATE kernel_env_setup_interests SET coverage_round = 4
      WHERE job_id = ? AND task_id = 't_1'`,
    [source.job.id],
  );
  store.run(
    `UPDATE kernel_env_setup_interests SET coverage_round = 2
      WHERE job_id = ? AND task_id = 't_2'`,
    [source.job.id],
  );

  const completed = setups.completeReadyWithFollowup(
    "req_source",
    ["numpy"],
    {
      runtimeId: "rt_1",
      environmentName: "analysis",
      language: "python",
      manager: "uv",
      lockRevision: 4,
      declarationGenerationId: "envgen_analysis",
      declarationCreatedTs: NOW,
      requestId: "req_followup",
      requestedTs: NOW + 20,
      resolvedFrom: ["numpy", "metafor", "tidyverse"],
    },
    NOW + 20,
  );

  expect(completed).toMatchObject({
    ready: { id: source.job.id, state: "ready" },
    target: { state: "requested", requestId: "req_followup" },
    created: true,
    moved: [{ taskId: "t_2", coverageRound: 2 }],
    capped: [{ taskId: "t_1", coverageRound: 4 }],
  });
  expect(setups.nonterminalJobs().map(({ requestId }) => requestId)).toEqual(["req_followup"]);
  expect(setups.waiter(cappedWaiter.id)?.jobId).toBe(source.job.id);
  expect(setups.waiter(movingWaiter.id)?.jobId).toBe(completed.target!.id);
  expect(
    store.get(
      `SELECT coverage_round FROM kernel_env_setup_interests
        WHERE job_id = ? AND task_id = 't_2'`,
      [completed.target!.id],
    ),
  ).toEqual({ coverage_round: 3 });

  expect(
    setups.completeReadyWithFollowup("req_source", ["numpy"], undefined, NOW + 21),
  ).toEqual({ created: false, moved: [], capped: [] });
  expect(store.all(`SELECT id FROM kernel_env_setup_jobs WHERE request_id = 'req_followup'`))
    .toHaveLength(1);
});

it("keeps retry and follow-up coverage budgets independent when their interests coalesce", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  const source = setups.requestJob(jobInput("t_2", {
    requestId: "req_source_budget",
    requestedPackages: ["numpy", "tidyverse"],
  }));
  setups.markReady(source.job.requestId, NOW + 10);
  store.run(
    `UPDATE kernel_env_setup_interests SET coverage_round = 2
      WHERE job_id = ? AND task_id = 't_2'`,
    [source.job.id],
  );
  const target = setups.requestJob(jobInput("t_1", {
    requestId: "req_retry_budget",
    requestedTs: NOW + 11,
    requestedPackages: ["numpy", "metafor"],
  }));

  setups.carryForwardUncovered(source.job.id, target.job.id, ["numpy"], NOW + 12);

  expect(
    store.all(
      `SELECT task_id, coverage_round FROM kernel_env_setup_interests
        WHERE job_id = ? ORDER BY task_id`,
      [target.job.id],
    ),
  ).toEqual([
    { task_id: "t_1", coverage_round: 1 },
    { task_id: "t_2", coverage_round: 3 },
  ]);
});

it("a direct setup creates an interest but never manufactures a resumable waiter", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);

  const requested = setups.requestJob(jobInput("t_1"));

  expect(requested.waiter).toBeUndefined();
  expect(setups.waitingForJob(requested.job.id)).toEqual([]);
  expect(setups.forTask("t_1")).toEqual([
    {
      job: {
        id: requested.job.id,
        machineId: "rt_1",
        machineName: "Mac",
        environmentName: "analysis",
        language: "python",
        manager: "uv",
        lockRevision: 4,
        declarationGenerationId: "envgen_analysis",
        declarationCreatedTs: NOW,
        state: "requested",
        stage: "waiting-for-machine",
        requestedTs: NOW + 3,
        updatedTs: NOW + 3,
        log: [],
      },
    },
  ]);
});

it("advances one job through bounded progress to one terminal result", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  const { job } = setups.requestJob(jobInput("t_1"));

  expect(setups.jobByRequest("req_t_1")?.id).toBe(job.id);
  for (let index = 0; index < 205; index += 1) {
    expect(setups.markProgress("req_t_1", "installing", `line-${index}`, NOW + 10 + index))
      .toEqual({ accepted: true, changed: true });
  }
  const progressing = setups.jobByRequest("req_t_1")!;
  expect(progressing).toMatchObject({
    state: "building",
    stage: "installing",
    startedTs: NOW + 10,
  });
  expect(progressing.log).toHaveLength(200);
  expect(progressing.log[0]).toBe("line-5");
  expect(progressing.log.at(-1)).toBe("line-204");

  expect(setups.markProgress("req_t_1", "finalizing", "x".repeat(70_000), NOW + 300))
    .toEqual({ accepted: true, changed: true });
  const bounded = setups.jobByRequest("req_t_1")!.log;
  expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(65_536);

  expect(setups.markReady("req_t_1", NOW + 400)).toMatchObject({
    id: job.id,
    state: "ready",
    finishedTs: NOW + 400,
  });
  const ready = setups.jobByRequest("req_t_1")!;
  expect(setups.markProgress("req_t_1", "resolving", "late", NOW + 401))
    .toEqual({ accepted: false, changed: false });
  expect(setups.markReady("req_t_1", NOW + 402)).toBeUndefined();
  expect(setups.jobByRequest("req_t_1")).toEqual(ready);

  setups.requestJob(jobInput("t_1", { requestId: "req_retry", requestedTs: NOW + 500 }));
  expect(setups.markFailed("req_retry", "solver failed", NOW + 501)).toMatchObject({
    state: "failed",
    errorSummary: "solver failed",
    finishedTs: NOW + 501,
  });
  expect(setups.markFailed("req_retry", "duplicate", NOW + 502)).toBeUndefined();
});

it("redacts credential-like progress, diagnostics, and failures before UTF-8 byte bounds", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  const secret = "store-boundary-secret-must-not-survive";
  const unsafe = `${"🙂".repeat(1_020)} https://alice:${secret}`;
  const unsafeAtFront = `https://alice:${secret} ${"🙂".repeat(2_000)}`;

  setups.requestJob(jobInput("t_1", { requestId: "req_safe_progress" }));
  expect(setups.markProgress("req_safe_progress", "installing", unsafe, NOW + 10).accepted)
    .toBe(true);
  const progress = setups.jobByRequest("req_safe_progress")!.log.at(-1)!;
  expect(Buffer.byteLength(progress, "utf8")).toBeLessThanOrEqual(4_096);
  expect(progress).not.toContain(secret);
  expect(progress).toContain("[redacted]");

  expect(setups.appendDiagnostic("req_safe_progress", `diagnostic ${unsafeAtFront}`, NOW + 21))
    .toBe(true);
  const diagnostic = setups.jobByRequest("req_safe_progress")!.log.at(-1)!;
  expect(Buffer.byteLength(diagnostic, "utf8")).toBeLessThanOrEqual(4_096);
  expect(diagnostic).not.toContain(secret);
  expect(diagnostic).toContain("[redacted]");

  for (const [index, secretLine] of [
    'GITHUB_TOKEN = "github storage secret with spaces"',
    "AWS_SECRET_ACCESS_KEY='aws storage secret with spaces'",
    '{"token": "json storage secret with spaces"}',
  ].entries()) {
    expect(setups.markProgress("req_safe_progress", "finalizing", secretLine, NOW + 40 + index).accepted)
      .toBe(true);
  }
  const replayed = environmentSetupStore(store).jobByRequest("req_safe_progress")!.log;
  expect(replayed.join(" ")).not.toMatch(/github storage secret|aws storage secret|json storage secret/);
  expect(replayed.slice(-3).every((line) => line.includes("[redacted]"))).toBe(true);

  const failed = setups.markFailed("req_safe_progress", `failure ${unsafeAtFront}`, NOW + 51)!;
  expect(Buffer.byteLength(failed.errorSummary!, "utf8")).toBeLessThanOrEqual(4_096);
  expect(failed.errorSummary).not.toContain(secret);
  expect(failed.errorSummary).toContain("[redacted]");
});

it("queues and resumes a waiter once, and cancellation includes unattached requirements", () => {
  const store = freshStore();
  const seeded = seed(store);
  const setups = environmentSetupStore(store);
  const attached = setups.recordRequirement(requirementInput(seeded, "t_1"));
  const unattached = setups.recordRequirement(requirementInput(seeded, "t_2"));
  const { job } = setups.requestJob(jobInput("t_1"));

  expect(setups.queueWaiter(attached.id, seeded.turns.t_2!, NOW + 10)).toBe(true);
  expect(setups.queueWaiter(attached.id, seeded.turns.t_1!, NOW + 11)).toBe(false);
  expect(setups.markWaiterResumed(seeded.turns.t_2!, NOW + 12)).toBe(true);
  expect(setups.markWaiterResumed(seeded.turns.t_2!, NOW + 13)).toBe(false);
  expect(setups.waitingForJob(job.id)).toEqual([]);

  const cancelled = setups.cancelPendingForTask(
    "t_2",
    "superseded-by-user-turn",
    NOW + 14,
  );
  expect(cancelled).toHaveLength(1);
  expect(cancelled[0]).toMatchObject({
    id: unattached.id,
    state: "cancelled",
    cancelledReason: "superseded-by-user-turn",
  });
  expect(cancelled[0]!.jobId).toBeUndefined();
});

it("creates one default suggestion for a ready job and answers it atomically", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  const { job } = setups.requestJob(jobInput("t_1"));
  setups.markReady("req_t_1", NOW + 10);

  const [suggestion] = setups.createSuggestionsForReadyJob(job.id, NOW + 11);
  expect(suggestion).toEqual({
    id: expect.any(String),
    language: "python",
    environmentName: "analysis",
    state: "pending",
  });
  expect(setups.createSuggestionsForReadyJob(job.id, NOW + 12)).toEqual([suggestion]);
  expect(setups.forTask("t_1")[0]!.suggestion).toEqual(suggestion);

  setups.answerSuggestion(suggestion!.id, "u_1", true, NOW + 13);

  expect(setups.defaultsForResearch("s_1")).toEqual([
    { language: "python", environmentName: "analysis", setBy: "u_1", setTs: NOW + 13 },
  ]);
  expect(setups.forTask("t_1")[0]!.suggestion?.state).toBe("accepted");
  const retry = setups.requestJob(jobInput("t_2", { requestId: "req_after_default" }));
  setups.markReady("req_after_default", NOW + 14);
  expect(setups.createSuggestionsForReadyJob(retry.job.id, NOW + 15)).toEqual([]);
});

it("keeps one pending default suggestion per Research and language across ready jobs", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  const first = setups.requestJob(jobInput("t_1", { requestId: "req_first" }));
  setups.markReady("req_first", NOW + 10);
  const [firstSuggestion] = setups.createSuggestionsForReadyJob(first.job.id, NOW + 11);

  const second = setups.requestJob(jobInput("t_2", { requestId: "req_second" }));
  setups.markReady("req_second", NOW + 12);
  setups.createSuggestionsForReadyJob(second.job.id, NOW + 13);

  expect(
    store.all(
      `SELECT id, job_id FROM environment_default_suggestions
        WHERE study_id = 's_1' AND language = 'python' AND state = 'pending'`,
    ),
  ).toEqual([{ id: firstSuggestion!.id, job_id: first.job.id }]);
});

it("reattaches a failed job's waiting waiter to an exact active replacement", () => {
  const store = freshStore();
  const seeded = seed(store);
  const setups = environmentSetupStore(store);
  const waiter = setups.recordRequirement(requirementInput(seeded, "t_1"));
  setups.requestJob(jobInput("t_1", {
    requestId: "req_failed",
    sourceRunId: seeded.turns.t_1!,
  }));
  setups.markFailed("req_failed", "solver failed", NOW + 10);
  const replacement = setups.requestJob(jobInput("t_1", { requestId: "req_retry" }));

  expect(setups.reattachWaiter(waiter.id, replacement.job.id, NOW + 11)).toMatchObject({
    id: waiter.id,
    jobId: replacement.job.id,
    state: "waiting",
    updatedTs: NOW + 11,
  });
  expect(setups.waitingForJob(replacement.job.id).map(({ id }) => id)).toEqual([waiter.id]);
  expect(setups.waiter(waiter.id)).toMatchObject({ id: waiter.id, jobId: replacement.job.id });
  expect(setups.waiter("wait_missing")).toBeUndefined();
});

it("carries only uncovered interests and their waiting waiters into an exact next round", () => {
  const store = freshStore();
  const seeded = seed(store);
  const setups = environmentSetupStore(store);
  const coveredWaiter = setups.recordRequirement(requirementInput(seeded, "t_1"));
  const uncoveredWaiter = setups.recordRequirement(requirementInput(seeded, "t_2"));
  const source = setups.requestJob(
    jobInput("t_1", {
      requestId: "req_source",
      requestedPackages: ["numpy"],
      sourceRunId: seeded.turns.t_1!,
    }),
  );
  setups.requestJob(
    jobInput("t_2", {
      requestId: "req_source_join",
      requestedPackages: ["numpy", "metafor"],
      sourceRunId: seeded.turns.t_2!,
    }),
  );
  setups.markReady("req_source", NOW + 10);
  const target = setups.requestJob(
    jobInput("t_2", {
      requestId: "req_target",
      lockRevision: 5,
      requestedPackages: ["numpy", "metafor"],
    }),
  );

  const moved = setups.carryForwardUncovered(
    source.job.id,
    target.job.id,
    ["numpy"],
    NOW + 11,
  );

  expect(moved.interests).toEqual([
    {
      studyId: "s_1",
      taskId: "t_2",
      requestedBy: "u_1",
      requestedTs: NOW + 3,
      requestedPackages: ["numpy", "metafor"],
      coverageRound: 1,
    },
  ]);
  expect(moved.waiters.map(({ id, jobId }) => ({ id, jobId }))).toEqual([
    { id: uncoveredWaiter.id, jobId: target.job.id },
  ]);
  expect(
    store.all(
      `SELECT task_id FROM kernel_env_setup_interests WHERE job_id = ? ORDER BY task_id`,
      [source.job.id],
    ),
  ).toEqual([{ task_id: "t_1" }]);
  expect(
    store.get(`SELECT job_id FROM task_env_setup_waiters WHERE id = ?`, [coveredWaiter.id])!
      .job_id,
  ).toBe(source.job.id);
  expect(
    store.get(`SELECT job_id FROM task_env_setup_waiters WHERE id = ?`, [uncoveredWaiter.id])!
      .job_id,
  ).toBe(target.job.id);
});

it("finds uncovered interests in stable request order only after a job is ready", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  const source = setups.requestJob(
    jobInput("t_2", {
      requestId: "req_source",
      requestedTs: NOW + 4,
      requestedPackages: ["numpy", "metafor"],
    }),
  );
  setups.requestJob(
    jobInput("t_1", {
      requestId: "req_join",
      requestedTs: NOW + 3,
      requestedPackages: ["numpy", "tidyverse"],
    }),
  );

  expect(setups.uncoveredInterests(source.job.id, ["numpy"])).toEqual([]);
  setups.markReady("req_source", NOW + 10);
  expect(setups.uncoveredInterests(source.job.id, ["numpy"]).map(({ taskId }) => taskId))
    .toEqual(["t_1", "t_2"]);
  expect(setups.uncoveredInterests(source.job.id, ["numpy", "tidyverse"]))
    .toEqual([
      {
        studyId: "s_1",
        taskId: "t_2",
        requestedBy: "u_1",
        requestedTs: NOW + 4,
        requestedPackages: ["numpy", "metafor"],
        coverageRound: 1,
      },
    ]);
  expect(setups.uncoveredInterests("envjob_missing", [])).toEqual([]);
});

it("refuses carry-forward unless source and target have exact lifecycle identity", () => {
  const build = () => {
    const store = freshStore();
    seed(store);
    const setups = environmentSetupStore(store);
    const source = setups.requestJob(jobInput("t_1", { requestId: "req_source" }));
    return { store, setups, source };
  };

  {
    const h = build();
    const target = h.setups.requestJob(
      jobInput("t_2", { requestId: "req_target", lockRevision: 5 }),
    );
    expect(
      h.setups.carryForwardUncovered(h.source.job.id, target.job.id, [], NOW + 10),
    ).toEqual({ interests: [], waiters: [] });
  }
  {
    const h = build();
    h.setups.markReady("req_source", NOW + 9);
    const target = h.setups.requestJob(
      jobInput("t_2", { requestId: "req_target", lockRevision: 5 }),
    );
    h.setups.markReady("req_target", NOW + 10);
    expect(
      h.setups.carryForwardUncovered(h.source.job.id, target.job.id, [], NOW + 11),
    ).toEqual({ interests: [], waiters: [] });
  }
  {
    const h = build();
    h.store.run(
      `INSERT INTO runtimes
         (id, owner_id, name, platform, daemon_version, capabilities, created_ts,
          last_seen_ts, seq)
       VALUES ('rt_2', 'u_1', 'Other Mac', 'darwin', '1', '[]', ?, ?, ?)`,
      [NOW, NOW, nextSeq(h.store)],
    );
    h.setups.markReady("req_source", NOW + 9);
    const target = h.setups.requestJob(
      jobInput("t_2", { requestId: "req_target", lockRevision: 5, runtimeId: "rt_2" }),
    );
    expect(
      h.setups.carryForwardUncovered(h.source.job.id, target.job.id, [], NOW + 10),
    ).toEqual({ interests: [], waiters: [] });
  }
});

it("looks up durable jobs by id and enumerates only nonterminal jobs for recovery", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  store.run(
    `INSERT INTO runtimes
       (id, owner_id, name, platform, daemon_version, capabilities, created_ts,
        last_seen_ts, seq)
     VALUES ('rt_2', 'u_1', 'Other Mac', 'darwin', '1', '[]', ?, ?, ?)`,
    [NOW, NOW, nextSeq(store)],
  );
  const requested = setups.requestJob(jobInput("t_1", { requestId: "req_requested" }));
  const building = setups.requestJob(
    jobInput("t_2", { requestId: "req_building", lockRevision: 5, runtimeId: "rt_2" }),
  );
  setups.markProgress("req_building", "installing", "installing", NOW + 10);
  const ready = setups.requestJob(
    jobInput("t_1", { requestId: "req_ready", lockRevision: 6, environmentName: "other" }),
  );
  setups.markReady("req_ready", NOW + 11);

  expect(setups.job(requested.job.id)).toEqual(setups.jobByRequest("req_requested"));
  expect(setups.job("envjob_missing")).toBeUndefined();
  expect(setups.nonterminalJobs().map(({ id }) => id)).toEqual([
    requested.job.id,
    building.job.id,
  ]);
  expect(setups.nonterminalJobs().map(({ id }) => id)).not.toContain(ready.job.id);
});

it("persists the exact declaration generation on every physical setup job", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  const requested = setups.requestJob(jobInput("t_1", {
    declarationCreatedTs: NOW + 41,
    declarationGenerationId: "envgen_exact_job",
  }));

  expect(requested.job).toMatchObject({
    declarationGenerationId: "envgen_exact_job",
    declarationCreatedTs: NOW + 41,
  });
  expect(setups.job(requested.job.id)).toMatchObject({
    declarationGenerationId: "envgen_exact_job",
    declarationCreatedTs: NOW + 41,
  });
  expect(store.get(
    `SELECT declaration_generation_id, declaration_created_ts
       FROM kernel_env_setup_jobs WHERE id = ?`,
    [requested.job.id],
  )).toEqual({
    declaration_generation_id: "envgen_exact_job",
    declaration_created_ts: NOW + 41,
  });
});

it("quarantines an in-flight build from a different opaque declaration generation", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  const old = setups.requestJob(jobInput("t_1", {
    requestId: "req_old_generation",
    declarationGenerationId: "envgen_old",
  }));
  setups.markProgress(old.job.requestId, "installing", "still installing", NOW + 5);

  expect(() => setups.requestPhysicalJob({
    runtimeId: "rt_1",
    environmentName: "analysis",
    language: "python",
    manager: "uv",
    lockRevision: 4,
    declarationCreatedTs: NOW,
    declarationGenerationId: "envgen_current",
    requestId: "req_current_generation",
    requestedTs: NOW + 6,
    resolvedFrom: ["numpy"],
  })).toThrow(/generation|building|in-flight/i);
  expect(setups.job(old.job.id)).toMatchObject({
    state: "building",
    declarationGenerationId: "envgen_old",
  });
});

it("terminalizes an unstarted stale generation and creates the exact current one", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  const old = setups.requestJob(jobInput("t_1", {
    requestId: "req_old_requested_generation",
    declarationGenerationId: "envgen_old",
  }));

  const current = setups.requestPhysicalJob({
    runtimeId: "rt_1",
    environmentName: "analysis",
    language: "python",
    manager: "uv",
    lockRevision: 4,
    declarationCreatedTs: NOW,
    declarationGenerationId: "envgen_current",
    requestId: "req_current_requested_generation",
    requestedTs: NOW + 6,
    resolvedFrom: ["numpy"],
  });

  expect(current.created).toBe(true);
  expect(current.job).toMatchObject({ declarationGenerationId: "envgen_current" });
  expect(setups.job(old.job.id)).toMatchObject({ state: "failed" });
  expect(store.get(
    `SELECT COUNT(*) AS count FROM kernel_env_setup_interests WHERE job_id = ?`,
    [old.job.id],
  )).toEqual({ count: 1 });
});

it("owns discovery of ready jobs that still have waiting waiters", () => {
  const store = freshStore();
  const seeded = seed(store);
  const setups = environmentSetupStore(store);
  const waiting = setups.recordRequirement(requirementInput(seeded, "t_1"));
  const ready = setups.requestJob(jobInput("t_1", {
    requestId: "req_ready_waiting",
    sourceRunId: seeded.turns.t_1!,
  }));
  setups.markReady(ready.job.requestId, NOW + 10);
  const terminalWithoutWaiter = setups.requestJob(jobInput("t_2", {
    requestId: "req_ready_empty",
    lockRevision: 5,
    environmentName: "other",
  }));
  setups.markReady(terminalWithoutWaiter.job.requestId, NOW + 11);

  expect(setups.waiter(waiting.id)).toMatchObject({ jobId: ready.job.id, state: "waiting" });
  expect(
    (setups as typeof setups & { readyJobIdsWithWaitingWaiters(): string[] })
      .readyJobIdsWithWaitingWaiters(),
  ).toEqual([ready.job.id]);
});

it("links only an exact ready coverage round to its next bounded round", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  const source = setups.requestJob(jobInput("t_1", { requestId: "req_source" }));
  expect(source.job).toMatchObject({ round: 1 });
  expect(source.job.previousJobId).toBeUndefined();
  setups.markReady("req_source", NOW + 10);

  const target = setups.requestJob(
    jobInput("t_1", {
      requestId: "req_target",
      lockRevision: 5,
      previousJobId: source.job.id,
      round: 2,
    }),
  );
  expect(target.job).toMatchObject({ previousJobId: source.job.id, round: 2 });

  expect(() =>
    setups.requestJob(
      jobInput("t_2", {
        requestId: "req_skipped_round",
        lockRevision: 6,
        previousJobId: target.job.id,
        round: 4,
      }),
    ),
  ).toThrow(/coverage follow-up/);
});

it("reattaches a failed job's waiter while its exact replacement is building", () => {
  const store = freshStore();
  const seeded = seed(store);
  const setups = environmentSetupStore(store);
  const waiter = setups.recordRequirement(requirementInput(seeded, "t_1"));
  setups.requestJob(jobInput("t_1", {
    requestId: "req_failed",
    sourceRunId: seeded.turns.t_1!,
  }));
  setups.markFailed("req_failed", "solver failed", NOW + 10);
  const replacement = setups.requestJob(jobInput("t_1", { requestId: "req_building" }));
  setups.markProgress("req_building", "installing", "installing", NOW + 11);

  expect(setups.reattachWaiter(waiter.id, replacement.job.id, NOW + 12)).toMatchObject({
    id: waiter.id,
    jobId: replacement.job.id,
    state: "waiting",
  });
});

it("refuses waiter reattachment unless source, replacement, interest, identity, and state all match", () => {
  const build = () => {
    const store = freshStore();
    const seeded = seed(store);
    const setups = environmentSetupStore(store);
    const waiter = setups.recordRequirement(requirementInput(seeded, "t_1"));
    const source = setups.requestJob(jobInput("t_1", { requestId: "req_source" }));
    return { store, seeded, setups, waiter, source };
  };

  {
    const h = build();
    const replacement = h.setups.requestJob(
      jobInput("t_2", { requestId: "req_no_interest", lockRevision: 5 }),
    );
    h.setups.markFailed(h.source.job.requestId, "failed", NOW + 10);
    expect(h.setups.reattachWaiter(h.waiter.id, replacement.job.id, NOW + 11)).toBeUndefined();
  }
  {
    const h = build();
    const replacement = h.setups.requestJob(
      jobInput("t_1", { requestId: "req_source_not_failed", lockRevision: 5 }),
    );
    expect(h.setups.reattachWaiter(h.waiter.id, replacement.job.id, NOW + 11)).toBeUndefined();
  }
  {
    const h = build();
    h.setups.markFailed(h.source.job.requestId, "failed", NOW + 10);
    const replacement = h.setups.requestJob(
      jobInput("t_1", { requestId: "req_wrong_environment", environmentName: "other" }),
    );
    expect(h.setups.reattachWaiter(h.waiter.id, replacement.job.id, NOW + 11)).toBeUndefined();
  }
  {
    const h = build();
    h.setups.markFailed(h.source.job.requestId, "failed", NOW + 10);
    const replacement = h.setups.requestJob(
      jobInput("t_1", { requestId: "req_wrong_language", language: "r", manager: "conda" }),
    );
    expect(h.setups.reattachWaiter(h.waiter.id, replacement.job.id, NOW + 11)).toBeUndefined();
  }
  {
    const h = build();
    h.store.run(
      `INSERT INTO runtimes
         (id, owner_id, name, platform, daemon_version, capabilities, created_ts,
          last_seen_ts, seq)
       VALUES ('rt_2', 'u_1', 'Other Mac', 'darwin', '1', '[]', ?, ?, ?)`,
      [NOW, NOW, nextSeq(h.store)],
    );
    h.setups.markFailed(h.source.job.requestId, "failed", NOW + 10);
    const replacement = h.setups.requestJob(
      jobInput("t_1", { requestId: "req_wrong_runtime", runtimeId: "rt_2" }),
    );
    expect(h.setups.reattachWaiter(h.waiter.id, replacement.job.id, NOW + 11)).toBeUndefined();
  }
  {
    const h = build();
    h.setups.markFailed(h.source.job.requestId, "failed", NOW + 10);
    const replacement = h.setups.requestJob(
      jobInput("t_1", { requestId: "req_terminal_replacement" }),
    );
    h.setups.markReady("req_terminal_replacement", NOW + 11);
    expect(h.setups.reattachWaiter(h.waiter.id, replacement.job.id, NOW + 12)).toBeUndefined();
  }
  for (const state of ["cancelled", "queued", "resumed"] as const) {
    const h = build();
    h.setups.markFailed(h.source.job.requestId, "failed", NOW + 10);
    const replacement = h.setups.requestJob(
      jobInput("t_1", { requestId: `req_waiter_${state}` }),
    );
    h.store.run(`UPDATE task_env_setup_waiters SET state = ? WHERE id = ?`, [state, h.waiter.id]);
    expect(h.setups.reattachWaiter(h.waiter.id, replacement.job.id, NOW + 11)).toBeUndefined();
  }
  {
    const h = build();
    h.setups.markFailed(h.source.job.requestId, "failed", NOW + 10);
    const replacement = h.setups.requestJob(
      jobInput("t_2", { requestId: "req_unattached_replacement", lockRevision: 5 }),
    );
    h.store.run(`UPDATE task_env_setup_waiters SET job_id = NULL WHERE id = ?`, [h.waiter.id]);
    h.store.run(
      `INSERT INTO kernel_env_setup_interests
         (job_id, study_id, task_id, requested_by, requested_ts)
       VALUES (?, 's_1', 't_1', 'u_1', ?)`,
      [replacement.job.id, NOW + 10],
    );
    expect(h.setups.reattachWaiter(h.waiter.id, replacement.job.id, NOW + 11)).toBeUndefined();
  }
});

it("remembers session grants and environment deletion clears waiters and accepted defaults", () => {
  const store = freshStore();
  const seeded = seed(store);
  const setups = environmentSetupStore(store);
  const requirement = setups.recordRequirement(requirementInput(seeded, "t_1"));
  const { job } = setups.requestJob(jobInput("t_2"));
  setups.markReady("req_t_2", NOW + 10);
  const [suggestion] = setups.createSuggestionsForReadyJob(job.id, NOW + 11);
  setups.answerSuggestion(suggestion!.id, "u_1", true, NOW + 12);

  setups.rememberEnvironmentGrant(seeded.sessions.t_1!, "analysis", "u_1", NOW + 13);
  setups.rememberEnvironmentGrant(seeded.sessions.t_1!, "analysis", "u_1", NOW + 14);
  setups.rememberEnvironmentGrant(seeded.sessions.t_1!, "other", "u_1", NOW + 15);
  expect(setups.environmentGrantsForSession(seeded.sessions.t_1!)).toEqual([
    "analysis",
    "other",
  ]);

  setups.cancelForEnvironment("analysis", NOW + 16);

  expect(
    store.get(`SELECT state, cancelled_reason FROM task_env_setup_waiters WHERE id = ?`, [
      requirement.id,
    ]),
  ).toEqual({ state: "cancelled", cancelled_reason: "environment-deleted" });
  expect(setups.defaultsForResearch("s_1")).toEqual([]);
});

it("removes every waiter naming a discarded turn, so the turn itself can be deleted", () => {
  // What reverting a turn runs into. `source_turn_id` and
  // `continuation_turn_id` are both foreign keys onto `turns(id)` with no
  // `ON DELETE`, and nothing else in this store ever deletes a waiter row —
  // so a requirement recorded by a turn does not merely go stale when that
  // turn is discarded, it makes `DELETE FROM turns` fail outright.
  const store = freshStore();
  const seeded = seed(store);
  const setups = environmentSetupStore(store);
  const source = setups.recordRequirement(requirementInput(seeded, "t_1"));
  // A second Task's requirement on its own turn, to prove this is scoped to
  // the turn named and not to everything nearby.
  const neighbour = setups.recordRequirement(requirementInput(seeded, "t_2"));
  // The reverted turn is the source of one waiter and the CONTINUATION of
  // another: both columns reference `turns`, so both have to be swept.
  setups.queueWaiter(neighbour.id, seeded.turns.t_1!, NOW + 10);

  expect(() => store.run(`DELETE FROM turns WHERE id = ?`, [seeded.turns.t_1!])).toThrow(
    /FOREIGN KEY constraint failed/,
  );

  const removed = setups.removeForTurn(seeded.turns.t_1!);

  // Handed back so the coordinator can finish what each one still owns —
  // ordered by `seq`, the way every other sweep in this store returns them.
  expect(removed.map((waiter) => waiter.id)).toEqual([source.id, neighbour.id]);
  expect(removed[1]!.continuationTurnId).toBe(seeded.turns.t_1!);
  expect(store.all(`SELECT id FROM task_env_setup_waiters`)).toEqual([]);
  // The whole point: the turn can now go.
  store.run(`DELETE FROM turns WHERE id = ?`, [seeded.turns.t_1!]);
  expect(store.get(`SELECT id FROM turns WHERE id = ?`, [seeded.turns.t_1!])).toBeUndefined();
});

it("leaves waiters on other turns alone when one turn is discarded", () => {
  const store = freshStore();
  const seeded = seed(store);
  const setups = environmentSetupStore(store);
  setups.recordRequirement(requirementInput(seeded, "t_1"));
  const survivor = setups.recordRequirement(requirementInput(seeded, "t_2"));

  expect(setups.removeForTurn(seeded.turns.t_1!)).toHaveLength(1);

  expect(store.all(`SELECT id FROM task_env_setup_waiters`)).toEqual([{ id: survivor.id }]);
});

it("environment deletion removes a suggestion while it is still pending", () => {
  const store = freshStore();
  seed(store);
  const setups = environmentSetupStore(store);
  const { job } = setups.requestJob(jobInput("t_1"));
  setups.markReady("req_t_1", NOW + 10);
  const [suggestion] = setups.createSuggestionsForReadyJob(job.id, NOW + 11);
  expect(suggestion?.state).toBe("pending");
  expect(
    store.all(`SELECT id FROM environment_default_suggestions WHERE state = 'pending'`),
  ).toEqual([{ id: suggestion!.id }]);

  setups.cancelForEnvironment("analysis", NOW + 12);

  expect(
    store.all(`SELECT id FROM environment_default_suggestions WHERE state = 'pending'`),
  ).toEqual([]);
});
