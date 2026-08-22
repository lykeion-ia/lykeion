import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Actor } from "./auth";
import type { KernelEnvStatus } from "@lykeion/api";
import {
  environmentLockfileFingerprint,
  environmentPackageFingerprint,
} from "@lykeion/api/environment-setup-evidence";
import { createEnvironmentSetupCoordinator } from "./environment-setup-coordinator";
import { createRunRelay, type RunCommand } from "./run-relay";
import { environmentSetupStore } from "./store/environment-setups";
import { environmentStore } from "./store/environments";
import { migrate, nextSeq } from "./store/migrations";
import { finishTurn, openSession, recordRunFrames, recordTurn } from "./store/sessions";
import { openStore } from "./store/sqlite";
import type { Store } from "./store/store";

const NOW = 1_800_000_000;
const actor: Actor = { userId: "u_1", role: "owner" };
const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-environment-coordinator-"));
  dirs.push(dir);
  const store = openStore(join(dir, "workspace.db"));
  opened.push(store);
  migrate(store);
  seed(store);
  return store;
}

function seed(store: Store): void {
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
     VALUES ('analysis', 'python', 'uv', '["tidyverse"]', 'u_1', ?, 4, 'envgen_analysis')`,
    [NOW],
  );
  store.run(
    `INSERT INTO kernel_env_locks
       (name, revision, lockfile, written_ts, requested_packages)
     VALUES ('analysis', 4, 'tidyverse==1.0.0\n', ?, '["tidyverse"]')`,
    [NOW],
  );
  const sessionId = openSession(store, {
    researchId: "s_1",
    machineId: "rt_1",
    agent: "claude",
    openedBy: "u_1",
    openedTs: NOW,
  });
  const turnId = recordTurn(store, {
    sessionId,
    taskId: "t_1",
    prompt: "analyze",
    startedTs: NOW,
  });
  finishTurn(store, turnId, { endedTs: NOW + 1, status: "ok" });
}

function harness() {
  const store = freshStore();
  const runs = createRunRelay();
  const taken: RunCommand[] = [];
  runs.attach("rt_1", (_seq, command) => taken.push(command));
  const coordinator = createEnvironmentSetupCoordinator({ store, runs, now: () => NOW + 10 });
  const changes: Array<{ kind: string; payload: unknown; actorId?: string }> = [];
  const record = (kind: string, payload: unknown, actorId?: string) => {
    changes.push({ kind, payload, ...(actorId === undefined ? {} : { actorId }) });
  };
  return { store, runs, taken, coordinator, changes, record };
}

function request(taskId = "t_1") {
  return { taskId, machineId: "rt_1", environmentName: "analysis" };
}

function readyStatus(
  lockRevision = 4,
  setupRequestId = "envsetup_fixture",
  lockfile = "tidyverse==1.0.0\n",
  requestedPackages: string[] = ["tidyverse"],
): KernelEnvStatus {
  return {
    name: "analysis",
    language: "python",
    manager: "uv",
    state: "ready",
    platform: "macos-aarch64",
    root: "/tmp/envs/analysis",
    lockRevision,
    setupRequestId,
    lockfileFingerprint: environmentLockfileFingerprint(lockfile),
    packageFingerprint: environmentPackageFingerprint(requestedPackages),
    declarationGenerationId: "envgen_analysis",
    declarationCreatedTs: NOW,
  };
}

function blockedSetup(h: ReturnType<typeof harness>) {
  const sourceRunId = h.store.get(
    `SELECT id FROM turns WHERE task_id = 't_1' ORDER BY seq DESC LIMIT 1`,
  )!.id as string;
  const sessionId = h.store.get(`SELECT session_id FROM turns WHERE id = ?`, [sourceRunId])!
    .session_id as string;
  const waiter = environmentSetupStore(h.store).recordRequirement({
    studyId: "s_1",
    taskId: "t_1",
    sessionId,
    sourceTurnId: sourceRunId,
    sourceRunId,
    language: "python",
    environmentName: "analysis",
    runtimeId: "rt_1",
    createdTs: NOW + 2,
  });
  const requested = h.coordinator.request({ ...request(), sourceRunId }, actor, h.record);
  return {
    sourceRunId,
    sessionId,
    waiter,
    job: environmentSetupStore(h.store).job(requested.jobId)!,
  };
}

function faultingStore(
  store: Store,
  fault: (method: "all" | "get" | "run", sql: string) => void,
): Store {
  return {
    all(sql, params) {
      fault("all", sql);
      return store.all(sql, params);
    },
    get(sql, params) {
      fault("get", sql);
      return store.get(sql, params);
    },
    run(sql, params) {
      fault("run", sql);
      store.run(sql, params);
    },
    tx: (fn) => store.tx(fn),
    close: () => {},
  };
}

function attachSecondTaskWaiter(h: ReturnType<typeof harness>) {
  const sessionId = openSession(h.store, {
    researchId: "s_1",
    machineId: "rt_1",
    agent: "claude",
    openedBy: "u_1",
    openedTs: NOW,
  });
  const sourceRunId = recordTurn(h.store, {
    sessionId,
    taskId: "t_2",
    prompt: "compare",
    startedTs: NOW,
  });
  finishTurn(h.store, sourceRunId, { endedTs: NOW + 1, status: "ok" });
  const waiter = environmentSetupStore(h.store).recordRequirement({
    studyId: "s_1",
    taskId: "t_2",
    sessionId,
    sourceTurnId: sourceRunId,
    sourceRunId,
    language: "python",
    environmentName: "analysis",
    runtimeId: "rt_1",
    createdTs: NOW + 2,
  });
  h.coordinator.request({ ...request("t_2"), sourceRunId }, actor, h.record);
  return waiter;
}

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("returns durable intent before the daemon result and dispatches one coalesced build", () => {
  const h = harness();

  const first = h.coordinator.request(request("t_1"), actor, h.record);
  const second = h.coordinator.request(request("t_2"), actor, h.record);

  expect(first.jobId).toBe(second.jobId);
  expect(h.taken.filter((command) => command.type === "kernel-env-setup")).toHaveLength(1);
  expect(environmentSetupStore(h.store).forTask("t_1")[0]!.job.state).toBe("requested");
  expect(h.taken[0]).toMatchObject({
    type: "kernel-env-setup",
    name: "analysis",
    lockfile: "tidyverse==1.0.0\n",
    lockRevision: 4,
    requestedPackages: ["tidyverse"],
    declarationGenerationId: "envgen_analysis",
    declarationCreatedTs: NOW,
  });
});

it("reconciles only status bound to the exact request, lock bytes, and requested packages", () => {
  const h = harness();
  const requested = h.coordinator.request(request(), actor, h.record);
  const job = environmentSetupStore(h.store).job(requested.jobId)!;

  for (const stale of [
    { ...readyStatus(4, job.requestId), setupRequestId: "envsetup_older" },
    { ...readyStatus(4, job.requestId), lockfileFingerprint: "a".repeat(64) },
    { ...readyStatus(4, job.requestId), packageFingerprint: "b".repeat(64) },
  ]) {
    h.coordinator.reconcileMachine("rt_1", [stale], h.record);
    expect(environmentSetupStore(h.store).job(job.id)!.state).toBe("requested");
  }

  h.coordinator.reconcileMachine("rt_1", [readyStatus(4, job.requestId)], h.record);
  expect(environmentSetupStore(h.store).job(job.id)!.state).toBe("ready");
});

it("keeps an unreported build waiting and reconciles it from a later ready report", () => {
  const h = harness();
  const { jobId } = h.coordinator.request(request(), actor, h.record);

  h.coordinator.reconcileMachine("rt_1", undefined, h.record);
  expect(environmentSetupStore(h.store).job(jobId)!.state).toBe("requested");

  h.coordinator.reconcileMachine(
    "rt_1",
    [readyStatus(4, environmentSetupStore(h.store).job(jobId)!.requestId)],
    h.record,
  );
  expect(environmentSetupStore(h.store).job(jobId)!.state).toBe("ready");
});

it("does not manufacture a waiter from sourceRunId and attaches only a pre-recorded exact requirement", () => {
  const h = harness();
  const sourceRunId = h.store.get(`SELECT id FROM turns WHERE task_id = 't_1'`)!.id as string;

  const direct = h.coordinator.request({ ...request(), sourceRunId }, actor, h.record);
  expect(direct.waiterId).toBeUndefined();

  const waiter = environmentSetupStore(h.store).recordRequirement({
    studyId: "s_1",
    taskId: "t_1",
    sessionId: h.store.get(`SELECT session_id FROM turns WHERE id = ?`, [sourceRunId])!
      .session_id as string,
    sourceTurnId: sourceRunId,
    sourceRunId,
    language: "python",
    environmentName: "analysis",
    runtimeId: "rt_1",
    createdTs: NOW + 11,
  });
  const attached = h.coordinator.request({ ...request(), sourceRunId }, actor, h.record);

  expect(attached).toEqual({ jobId: direct.jobId, waiterId: waiter.id });
  expect(h.taken.filter((command) => command.type === "kernel-env-setup")).toHaveLength(1);
});

it("refuses a source run that does not belong to the requested Task", () => {
  const h = harness();
  const sourceRunId = h.store.get(`SELECT id FROM turns WHERE task_id = 't_1'`)!.id as string;

  expect(() =>
    h.coordinator.request({ ...request("t_2"), sourceRunId }, actor, h.record),
  ).toThrow(/does not belong to Task t_2/);
  expect(h.taken).toEqual([]);
});

it("binds progress and a single terminal result to the durable request", () => {
  const h = harness();
  const { jobId } = h.coordinator.request(request(), actor, h.record);
  const job = environmentSetupStore(h.store).job(jobId)!;

  expect(h.coordinator.progress("rt_other", job.requestId, "installing", "spoofed", h.record))
    .toEqual({ accepted: false, changed: false });
  expect(h.coordinator.progress("rt_1", job.requestId, "installing", "installing", h.record))
    .toEqual({ accepted: true, changed: true });
  expect(environmentSetupStore(h.store).job(jobId)).toMatchObject({
    state: "building",
    stage: "installing",
    log: ["installing"],
  });

  expect(h.coordinator.settle("rt_1", job.requestId, { ok: true, status: readyStatus(4, job.requestId) }, h.record))
    .toBe(true);
  const ready = environmentSetupStore(h.store).job(jobId)!;
  expect(h.coordinator.settle("rt_1", job.requestId, { ok: true, status: readyStatus(4, job.requestId) }, h.record))
    .toBe(false);
  expect(environmentSetupStore(h.store).job(jobId)).toEqual(ready);

  const replayed: RunCommand[] = [];
  h.runs.attach("rt_1", (_seq, command) => replayed.push(command));
  expect(replayed).toEqual([]);
});

it("queues one system continuation with authoritative metadata for duplicate ready reports", () => {
  const h = harness();
  const blocked = blockedSetup(h);
  // A default this Research had already confirmed before the build that
  // blocked this Task. The continuation is a turn on the same Task in the
  // same session as the one the researcher typed, so it has to carry the same
  // structured context — a machine told where an unaddressed cell lands on
  // one and not the other would resolve the same cell two ways depending on
  // who started the turn.
  h.store.run(
    `INSERT INTO research_environment_defaults
       (study_id, language, environment_name, set_by, set_ts)
     VALUES ('s_1', 'python', 'analysis', 'u_1', ?)`,
    [NOW],
  );

  expect(
    h.coordinator.settle(
      "rt_1",
      blocked.job.requestId,
      { ok: true, status: readyStatus(4, blocked.job.requestId) },
      h.record,
    ),
  ).toBe(true);
  expect(
    h.coordinator.settle(
      "rt_1",
      blocked.job.requestId,
      { ok: true, status: readyStatus(4, blocked.job.requestId) },
      h.record,
    ),
  ).toBe(false);

  const continuations = h.store.all(
    `SELECT id, prompt, origin, continuation FROM turns
      WHERE task_id = 't_1' AND origin = 'system' ORDER BY seq`,
  );
  expect(continuations).toHaveLength(1);
  expect(continuations[0]!.prompt).toBe(
    "The environment analysis is ready on this machine. Continue the work blocked in the source turn. Do not ask the researcher to repeat the request, and do not repeat completed work.",
  );
  expect(JSON.parse(continuations[0]!.continuation as string)).toEqual({
    kind: "environment-setup",
    waiterId: blocked.waiter.id,
    sourceTurnId: blocked.sourceRunId,
    environmentName: "analysis",
    machineId: "rt_1",
  });
  expect(environmentSetupStore(h.store).waiter(blocked.waiter.id)).toMatchObject({
    state: "queued",
    continuationTurnId: continuations[0]!.id,
  });
  expect(h.taken.at(-1)).toMatchObject({
    type: "start-run",
    runId: continuations[0]!.id,
    studyId: "s_1",
    taskId: "t_1",
    sessionId: blocked.sessionId,
    agent: "claude",
    prompt: continuations[0]!.prompt,
    // Why this turn exists, carried whole rather than left for the machine to
    // infer — it cannot, since nothing on that end knows which waiter a
    // system turn continues.
    continuation: {
      kind: "environment-setup",
      waiterId: blocked.waiter.id,
      sourceTurnId: blocked.sourceRunId,
      environmentName: "analysis",
      machineId: "rt_1",
    },
    environmentDefaults: [{ language: "python", environmentName: "analysis" }],
  });
});

it("rolls ready back when waiter discovery throws at the former commit boundary", () => {
  const h = harness();
  const blocked = blockedSetup(h);
  h.taken.splice(0);
  let armed = false;
  const store = faultingStore(h.store, (method, sql) => {
    if (
      armed &&
      method === "all" &&
      sql.includes("FROM task_env_setup_waiters") &&
      sql.includes("job_id = ? AND state = 'waiting'")
    ) throw new Error("fault after physical ready");
  });
  const coordinator = createEnvironmentSetupCoordinator({
    store,
    runs: h.runs,
    now: () => NOW + 20,
  });
  armed = true;

  expect(() =>
    coordinator.settle(
      "rt_1",
      blocked.job.requestId,
      { ok: true, status: readyStatus(4, blocked.job.requestId) },
      h.record,
    ),
  ).toThrow("fault after physical ready");

  expect(environmentSetupStore(h.store).job(blocked.job.id)).toMatchObject({ state: "requested" });
  expect(environmentSetupStore(h.store).waiter(blocked.waiter.id)).toMatchObject({
    state: "waiting",
  });
  expect(h.store.get(`SELECT COUNT(*) AS count FROM turns WHERE origin = 'system'`)!.count).toBe(0);
  expect(h.taken).toEqual([]);
});

it("rolls every waiter and ready transition back when the second continuation insert throws", () => {
  const h = harness();
  const first = blockedSetup(h);
  const second = attachSecondTaskWaiter(h);
  h.taken.splice(0);
  let continuationInserts = 0;
  const store = faultingStore(h.store, (method, sql) => {
    if (method !== "run" || !sql.includes("INSERT INTO turns")) return;
    continuationInserts += 1;
    if (continuationInserts === 2) throw new Error("fault during second continuation");
  });
  const coordinator = createEnvironmentSetupCoordinator({
    store,
    runs: h.runs,
    now: () => NOW + 20,
  });

  expect(() =>
    coordinator.settle(
      "rt_1",
      first.job.requestId,
      { ok: true, status: readyStatus(4, first.job.requestId) },
      h.record,
    ),
  ).toThrow("fault during second continuation");

  expect(environmentSetupStore(h.store).job(first.job.id)).toMatchObject({ state: "requested" });
  expect(environmentSetupStore(h.store).waiter(first.waiter.id)).toMatchObject({ state: "waiting" });
  expect(environmentSetupStore(h.store).waiter(second.id)).toMatchObject({ state: "waiting" });
  expect(h.store.get(`SELECT COUNT(*) AS count FROM turns WHERE origin = 'system'`)!.count).toBe(0);
  expect(h.taken).toEqual([]);
});

it("skips a waiter it cannot route and still settles the build for everyone else", () => {
  // The other side of the two rollbacks above, and the line between them.
  // A store that fails mid-continuation has to take the whole settle with it,
  // because half a continuation is not a state to carry on from. A waiter
  // this lab simply cannot ROUTE is not that: the build physically finished,
  // and refusing to record it — on this attempt and on every recovery that
  // retried it — leaves every other Task on that build blocked forever over
  // one waiter nobody could have resumed anyway.
  const h = harness();
  const first = blockedSetup(h);
  // Unroutable by construction: the waiter names the machine the build ran
  // on, while its own session is open on a different one — so the durable
  // continuation written for it cannot answer the waiter field for field, and
  // `commandForContinuation` refuses to build a command from it.
  h.store.run(
    `INSERT INTO runtimes
       (id, owner_id, name, platform, daemon_version, capabilities, created_ts, last_seen_ts, seq)
     VALUES ('rt_2', 'u_1', 'Other', 'darwin', '1', '[]', ?, ?, ?)`,
    [NOW, NOW, nextSeq(h.store)],
  );
  const strandedSession = openSession(h.store, {
    researchId: "s_1",
    machineId: "rt_2",
    agent: "claude",
    openedBy: "u_1",
    openedTs: NOW,
  });
  const strandedRun = recordTurn(h.store, {
    sessionId: strandedSession,
    taskId: "t_2",
    prompt: "compare",
    startedTs: NOW,
  });
  finishTurn(h.store, strandedRun, { endedTs: NOW + 1, status: "ok" });
  const stranded = environmentSetupStore(h.store).recordRequirement({
    studyId: "s_1",
    taskId: "t_2",
    sessionId: strandedSession,
    sourceTurnId: strandedRun,
    sourceRunId: strandedRun,
    language: "python",
    environmentName: "analysis",
    runtimeId: "rt_1",
    createdTs: NOW + 2,
  });
  h.coordinator.request({ ...request("t_2"), sourceRunId: strandedRun }, actor, h.record);
  h.taken.splice(0);

  expect(
    h.coordinator.settle(
      "rt_1",
      first.job.requestId,
      { ok: true, status: readyStatus(4, first.job.requestId) },
      h.record,
    ),
  ).toBe(true);

  // The build is recorded and the routable waiter resumes on it.
  expect(environmentSetupStore(h.store).job(first.job.id)).toMatchObject({ state: "ready" });
  expect(environmentSetupStore(h.store).waiter(first.waiter.id)).toMatchObject({ state: "queued" });
  expect(
    h.taken.filter((command) => command.type === "start-run").map((command) => command.taskId),
  ).toEqual(["t_1"]);
  // And the one that could not be routed is exactly as it was, with no
  // half-written turn left standing behind it.
  expect(environmentSetupStore(h.store).waiter(stranded.id)).toMatchObject({ state: "waiting" });
  expect(environmentSetupStore(h.store).waiter(stranded.id)!.continuationTurnId).toBeUndefined();
  expect(h.store.get(`SELECT COUNT(*) AS count FROM turns WHERE origin = 'system'`)!.count).toBe(1);
});

it("recovers a legacy ready job with waiting waiters exactly once", () => {
  const h = harness();
  const blocked = blockedSetup(h);
  h.taken.splice(0);
  environmentSetupStore(h.store).markReady(blocked.job.requestId, NOW + 20);

  h.coordinator.recover(h.record);
  h.coordinator.recover(h.record);

  const waiter = environmentSetupStore(h.store).waiter(blocked.waiter.id)!;
  expect(waiter).toMatchObject({ state: "queued", continuationTurnId: expect.any(String) });
  expect(h.store.get(`SELECT COUNT(*) AS count FROM turns WHERE origin = 'system'`)!.count).toBe(1);
  expect(h.taken.filter(({ type }) => type === "start-run")).toHaveLength(2);
  expect(h.taken[0]!.runId).toBe(waiter.continuationTurnId);
  expect(h.taken[1]!.runId).toBe(waiter.continuationTurnId);
});

it("a newer user turn cancels the pending continuation, not the ready build", () => {
  const h = harness();
  const blocked = blockedSetup(h);
  recordTurn(h.store, {
    sessionId: blocked.sessionId,
    taskId: "t_1",
    prompt: "new direction",
    startedTs: NOW + 3,
  });

  h.coordinator.settle(
    "rt_1",
    blocked.job.requestId,
    { ok: true, status: readyStatus(4, blocked.job.requestId) },
    h.record,
  );

  expect(environmentSetupStore(h.store).job(blocked.job.id)).toMatchObject({ state: "ready" });
  expect(environmentSetupStore(h.store).waiter(blocked.waiter.id)).toMatchObject({
    state: "cancelled",
    cancelledReason: "superseded-by-user-turn",
  });
  expect(
    h.store.get(`SELECT COUNT(*) AS count FROM turns WHERE task_id = 't_1' AND origin = 'system'`)!
      .count,
  ).toBe(0);
});

it("recovers a queued continuation with the same turn and run id", () => {
  const h = harness();
  const blocked = blockedSetup(h);
  h.coordinator.settle(
    "rt_1",
    blocked.job.requestId,
    { ok: true, status: readyStatus(4, blocked.job.requestId) },
    h.record,
  );
  const continuationTurnId = environmentSetupStore(h.store).waiter(blocked.waiter.id)!
    .continuationTurnId!;
  const recoveredRuns = createRunRelay();
  const recoveredCommands: RunCommand[] = [];
  recoveredRuns.attach("rt_1", (_seq, command) => recoveredCommands.push(command));

  createEnvironmentSetupCoordinator({
    store: h.store,
    runs: recoveredRuns,
    now: () => NOW + 20,
  }).recover(h.record);

  expect(recoveredCommands).toContainEqual(
    expect.objectContaining({
      type: "start-run",
      runId: continuationTurnId,
      sessionId: blocked.sessionId,
      agent: "claude",
    }),
  );
  expect(
    h.store.get(`SELECT COUNT(*) AS count FROM turns WHERE id = ?`, [continuationTurnId])!.count,
  ).toBe(1);
});

it("keeps a continuation queued when its post-commit enqueue fails", () => {
  const h = harness();
  const blocked = blockedSetup(h);
  h.runs.enqueue = () => {
    throw new Error("relay unavailable");
  };

  expect(() =>
    h.coordinator.settle(
      "rt_1",
      blocked.job.requestId,
      { ok: true, status: readyStatus(4, blocked.job.requestId) },
      h.record,
    ),
  ).not.toThrow();
  expect(environmentSetupStore(h.store).waiter(blocked.waiter.id)).toMatchObject({
    state: "queued",
    continuationTurnId: expect.any(String),
  });
});

it("marks a queued waiter resumed on the first accepted daemon frame", () => {
  const h = harness();
  const blocked = blockedSetup(h);
  h.coordinator.settle(
    "rt_1",
    blocked.job.requestId,
    { ok: true, status: readyStatus(4, blocked.job.requestId) },
    h.record,
  );
  const continuationTurnId = environmentSetupStore(h.store).waiter(blocked.waiter.id)!
    .continuationTurnId!;

  recordRunFrames(
    h.store,
    continuationTurnId,
    [{ seq: 1, event: { event: "state", state: { state: "planning" } } }],
    NOW + 30,
  );

  expect(environmentSetupStore(h.store).waiter(blocked.waiter.id)).toMatchObject({
    state: "resumed",
  });
});

it("cancels the exact queued waiter when a turn ends before execution begins", () => {
  const h = harness();
  const blocked = blockedSetup(h);
  h.coordinator.settle(
    "rt_1",
    blocked.job.requestId,
    { ok: true, status: readyStatus(4, blocked.job.requestId) },
    h.record,
  );
  const continuationTurnId = environmentSetupStore(h.store).waiter(blocked.waiter.id)!
    .continuationTurnId!;

  recordRunFrames(
    h.store,
    continuationTurnId,
    [
      {
        seq: 1,
        event: {
          event: "completed",
          state: { state: "failed", reason: "adapter unavailable before prompt" },
        },
      },
    ],
    NOW + 30,
  );

  expect(environmentSetupStore(h.store).waiter(blocked.waiter.id)).toMatchObject({
    state: "cancelled",
    cancelledReason: "continuation-ended-before-start",
  });
  expect(
    h.store.get(`SELECT status, ended_ts FROM turns WHERE id = ?`, [continuationTurnId]),
  ).toEqual({ status: "cancelled", ended_ts: NOW + 30 });
  expect(
    JSON.parse(
      h.store.get(`SELECT recovery_snapshot FROM turns WHERE id = ?`, [continuationTurnId])!
        .recovery_snapshot as string,
    ),
  ).toMatchObject({ state: { state: "cancelled" } });
});

it("converges a direct Stop of the queued continuation on the same durable cancellation", () => {
  const h = harness();
  const blocked = blockedSetup(h);
  h.coordinator.settle(
    "rt_1",
    blocked.job.requestId,
    { ok: true, status: readyStatus(4, blocked.job.requestId) },
    h.record,
  );
  const continuationTurnId = environmentSetupStore(h.store).waiter(blocked.waiter.id)!
    .continuationTurnId!;

  recordRunFrames(
    h.store,
    continuationTurnId,
    [{ seq: 1, event: { event: "completed", state: { state: "cancelled" } } }],
    NOW + 30,
  );

  expect(environmentSetupStore(h.store).waiter(blocked.waiter.id)).toMatchObject({
    state: "cancelled",
    cancelledReason: "continuation-ended-before-start",
  });
  expect(
    h.store.get(`SELECT status FROM turns WHERE id = ?`, [continuationTurnId]),
  ).toEqual({ status: "cancelled" });
});

it("keeps a genuine execution-evidence failure resumed and failed", () => {
  const h = harness();
  const blocked = blockedSetup(h);
  h.coordinator.settle(
    "rt_1",
    blocked.job.requestId,
    { ok: true, status: readyStatus(4, blocked.job.requestId) },
    h.record,
  );
  const continuationTurnId = environmentSetupStore(h.store).waiter(blocked.waiter.id)!
    .continuationTurnId!;

  recordRunFrames(
    h.store,
    continuationTurnId,
    [
      { seq: 1, event: { event: "state", state: { state: "planning" } } },
      {
        seq: 2,
        event: {
          event: "completed",
          state: { state: "failed", reason: "the started adapter failed" },
        },
      },
    ],
    NOW + 30,
  );

  expect(environmentSetupStore(h.store).waiter(blocked.waiter.id)).toMatchObject({
    state: "resumed",
  });
  expect(
    h.store.get(`SELECT status FROM turns WHERE id = ?`, [continuationTurnId]),
  ).toEqual({ status: "failed" });
});

it("dispatches a second durable round when a coalesced Task requires newly declared packages", () => {
  const h = harness();
  const first = h.coordinator.request(request("t_1"), actor, h.record);
  environmentStore(h.store).addPackages("analysis", ["metafor"]);
  const joined = h.coordinator.request(request("t_2"), actor, h.record);
  expect(joined.jobId).toBe(first.jobId);
  const firstJob = environmentSetupStore(h.store).job(first.jobId)!;

  expect(
    h.coordinator.settle(
      "rt_1",
      firstJob.requestId,
      { ok: true, status: readyStatus(4, firstJob.requestId) },
      h.record,
    ),
  ).toBe(true);

  expect(h.taken.filter((command) => command.type === "kernel-env-setup")).toHaveLength(2);
  expect(h.taken[1]).toMatchObject({
    type: "kernel-env-setup",
    packages: ["tidyverse", "metafor"],
  });
  const [next] = environmentSetupStore(h.store).nonterminalJobs();
  expect(next).toMatchObject({
    previousJobId: firstJob.id,
    round: 2,
    resolvedFrom: ["tidyverse", "metafor"],
  });
  expect(environmentSetupStore(h.store).forTask("t_1")[0]!.job.id).toBe(firstJob.id);
  expect(environmentSetupStore(h.store).forTask("t_2")[0]!.job.id).toBe(next!.id);
});

it("keeps one command across the resolve-lock-to-result request race", () => {
  const h = harness();
  environmentStore(h.store).addPackages("analysis", ["metafor"]);
  const first = h.coordinator.request(request("t_1"), actor, h.record);
  const job = environmentSetupStore(h.store).job(first.jobId)!;
  expect(h.taken).toHaveLength(1);
  expect(h.taken[0]).toMatchObject({ packages: ["tidyverse", "metafor"] });

  expect(
    h.coordinator.bindResolvedLock(
      "rt_1",
      job.requestId,
      "analysis",
      job.declarationGenerationId!,
      "tidyverse==1\nmetafor==1\n",
      h.record,
    ),
  ).toBe(5);
  const joined = h.coordinator.request(request("t_2"), actor, h.record);

  expect(joined.jobId).toBe(first.jobId);
  expect(h.taken).toHaveLength(1);
  expect(
    h.coordinator.settle(
      "rt_1",
      job.requestId,
      {
        ok: true,
        status: readyStatus(
          5,
          job.requestId,
          "tidyverse==1\nmetafor==1\n",
          ["tidyverse", "metafor"],
        ),
      },
      h.record,
    ),
  ).toBe(true);
  expect(environmentSetupStore(h.store).job(first.jobId)).toMatchObject({
    state: "ready",
    lockRevision: 5,
  });
  expect(h.taken).toHaveLength(1);
});

it("refuses an old resolver result after the same name is redeclared", () => {
  const h = harness();
  environmentStore(h.store).addPackages("analysis", ["metafor"]);
  const requested = h.coordinator.request(request(), actor, h.record);
  const job = environmentSetupStore(h.store).job(requested.jobId)!;
  const oldGeneration = job.declarationGenerationId!;
  const envs = environmentStore(h.store);
  envs.remove("analysis");
  const replacement = envs.declare({
    name: "analysis",
    language: "python",
    manager: "uv",
    packages: ["numpy"],
    createdBy: "u_1",
    createdTs: NOW + 11,
  });
  expect(replacement.declarationGenerationId).not.toBe(oldGeneration);

  expect(
    h.coordinator.bindResolvedLock(
      "rt_1",
      job.requestId,
      "analysis",
      oldGeneration,
      "numpy==2\n",
      h.record,
    ),
  ).toBeUndefined();
  expect(environmentStore(h.store).get("analysis")!.lockRevision).toBe(0);
  expect(environmentSetupStore(h.store).job(job.id)).toMatchObject({
    declarationGenerationId: oldGeneration,
    lockRevision: 4,
  });
});

it("coalesces a package rebuild and a durable request through one physical job", () => {
  // Two ways in — an agent's `manage_packages` add and a researcher's Setup —
  // must never send one machine building the same directory twice: two
  // `uv venv --clear` runs over one root is the worse failure. One job, one
  // command, and both callers' interests recorded on it.
  const store = freshStore();
  const runs = createRunRelay();
  const taken: RunCommand[] = [];
  runs.attach("rt_1", (_seq, command) => taken.push(command));
  const coordinator = createEnvironmentSetupCoordinator({ store, runs, now: () => NOW + 10 });
  const record = () => {};

  const rebuild = coordinator.requestRebuild(
    {
      machineId: "rt_1",
      environmentName: "analysis",
      requestedPackages: ["tidyverse"],
      requestedBy: "u_1",
      taskId: "t_1",
    },
    record,
  );
  const durable = coordinator.request(request(), actor, record);
  const job = environmentSetupStore(store).job(durable.jobId)!;

  expect(rebuild!.jobId).toBe(durable.jobId);
  expect(taken).toHaveLength(1);
  expect(taken[0]!.runId).toBe(job.requestId);
  expect(
    coordinator.settle("rt_1", job.requestId, { ok: true, status: readyStatus(4, job.requestId) }, record),
  ).toBe(true);
  expect(environmentSetupStore(store).job(durable.jobId)).toMatchObject({ state: "ready" });
});

it("recovers requested jobs independently when one replay lock is missing", () => {
  const h = harness();
  environmentStore(h.store).declare({
    name: "missing",
    language: "python",
    manager: "uv",
    packages: ["numpy"],
    createdBy: "u_1",
    createdTs: NOW,
  });
  environmentStore(h.store).writeLock("missing", "numpy==1\n", NOW, ["numpy"]);
  const skipped = environmentSetupStore(h.store).requestPhysicalJob({
    runtimeId: "rt_1",
    environmentName: "missing",
    language: "python",
    manager: "uv",
    lockRevision: 1,
    declarationGenerationId: environmentStore(h.store).get("missing")!.declarationGenerationId!,
    declarationCreatedTs: NOW,
    requestId: "req_missing_lock",
    requestedTs: NOW + 1,
  }).job;
  h.store.run(`DELETE FROM kernel_env_locks WHERE name = 'missing'`);
  h.store.run(`UPDATE kernel_envs SET lock_revision = 0 WHERE name = 'missing'`);
  const valid = h.coordinator.request(request(), actor, h.record);
  h.taken.splice(0);

  expect(() => h.coordinator.recover(h.record)).not.toThrow();

  expect(h.taken.map(({ runId }) => runId)).toEqual([
    environmentSetupStore(h.store).job(valid.jobId)!.requestId,
  ]);
  expect(environmentSetupStore(h.store).job(skipped.id)).toMatchObject({
    state: "requested",
    log: [expect.stringMatching(/Recovery skipped.*lockfile/i)],
  });
});

it("holds a legacy in-flight singleton until its exact result settles, then permits current-generation setup", () => {
  const h = harness();
  h.store.run(
    `INSERT INTO kernel_env_setup_jobs
       (id, runtime_id, environment_name, language, manager, lock_revision,
        declaration_generation_id, declaration_created_ts, request_id, state, stage,
        requested_ts, started_ts, updated_ts, seq)
     VALUES ('job_legacy_hold', 'rt_1', 'analysis', 'python', 'uv', 4,
             NULL, ?, 'req_legacy_hold', 'building', 'installing', ?, ?, ?, ?)`,
    [NOW, NOW + 1, NOW + 1, NOW + 1, nextSeq(h.store)],
  );

  h.coordinator.reconcileMachine("rt_1", [readyStatus()], h.record);
  expect(environmentSetupStore(h.store).job("job_legacy_hold")).toMatchObject({
    state: "building",
  });
  expect(
    environmentSetupStore(h.store).job("job_legacy_hold")!.declarationGenerationId,
  ).toBeUndefined();
  expect(() => h.coordinator.request(request(), actor, h.record)).toThrow(
    /legacy|settle|generation/i,
  );
  expect(h.taken).toEqual([]);

  expect(h.coordinator.settle(
    "rt_1",
    "req_legacy_hold",
    { ok: true, status: readyStatus() },
    h.record,
  )).toBe(true);
  expect(environmentSetupStore(h.store).job("job_legacy_hold")).toMatchObject({
    state: "failed",
    errorSummary: expect.stringMatching(/generation/i),
  });

  const current = h.coordinator.request(request(), actor, h.record);
  expect(environmentSetupStore(h.store).job(current.jobId)).toMatchObject({
    state: "requested",
    declarationGenerationId: "envgen_analysis",
  });
  expect(h.taken).toEqual([
    expect.objectContaining({
      type: "kernel-env-setup",
      declarationGenerationId: "envgen_analysis",
    }),
  ]);
});

it("retries only a failed waiting requirement as a fresh round-one attempt", () => {
  const h = harness();
  const sourceRunId = h.store.get(`SELECT id FROM turns WHERE task_id = 't_1'`)!.id as string;
  const source = h.store.get(`SELECT session_id FROM turns WHERE id = ?`, [sourceRunId])!;
  const requirement = environmentSetupStore(h.store).recordRequirement({
    studyId: "s_1",
    taskId: "t_1",
    sessionId: source.session_id as string,
    sourceTurnId: sourceRunId,
    sourceRunId,
    language: "python",
    environmentName: "analysis",
    runtimeId: "rt_1",
    createdTs: NOW + 1,
  });
  const first = h.coordinator.request({ ...request(), sourceRunId }, actor, h.record);
  const firstJob = environmentSetupStore(h.store).job(first.jobId)!;
  expect(first.waiterId).toBe(requirement.id);
  expect(
    h.coordinator.settle(
      "rt_1",
      firstJob.requestId,
      { ok: false, name: "analysis", error: "solver failed" },
      h.record,
    ),
  ).toBe(true);

  const retried = h.coordinator.retry(requirement.id, actor, h.record);
  const retriedJob = environmentSetupStore(h.store).job(retried.jobId)!;

  expect(retried).toEqual({ jobId: retriedJob.id, waiterId: requirement.id });
  expect(retriedJob.id).not.toBe(firstJob.id);
  expect(retriedJob).toMatchObject({ round: 1, state: "requested" });
  expect(retriedJob.previousJobId).toBeUndefined();
  expect(environmentSetupStore(h.store).waiter(requirement.id)).toMatchObject({
    jobId: retriedJob.id,
    sourceRunId,
    sourceTurnId: sourceRunId,
  });
  expect(h.taken.filter((command) => command.type === "kernel-env-setup")).toHaveLength(2);
});

it("recovers only requested attempts with their original durable request ids", () => {
  const h = harness();
  const requested = h.coordinator.request(request(), actor, h.record);
  const requestedJob = environmentSetupStore(h.store).job(requested.jobId)!;
  const recoveredRuns = createRunRelay();
  const recoveredCommands: RunCommand[] = [];
  recoveredRuns.attach("rt_1", (_seq, command) => recoveredCommands.push(command));
  const recovered = createEnvironmentSetupCoordinator({
    store: h.store,
    runs: recoveredRuns,
    now: () => NOW + 20,
  });

  recovered.recover(h.record);

  expect(recoveredCommands).toHaveLength(1);
  expect(recoveredCommands[0]).toMatchObject({
    type: "kernel-env-setup",
    runId: requestedJob.requestId,
    name: "analysis",
  });
  expect(environmentSetupStore(h.store).job(requested.jobId)!.state).toBe("requested");

  environmentSetupStore(h.store).markProgress(
    requestedJob.requestId,
    "installing",
    "installing",
    NOW + 21,
  );
  const laterRuns = createRunRelay();
  const laterCommands: RunCommand[] = [];
  laterRuns.attach("rt_1", (_seq, command) => laterCommands.push(command));
  createEnvironmentSetupCoordinator({ store: h.store, runs: laterRuns, now: () => NOW + 22 })
    .recover(h.record);
  expect(laterCommands).toEqual([]);
});

it("does not recover-dispatch a requested job from a stale declaration generation", () => {
  const h = harness();
  const requested = h.coordinator.request(request(), actor, h.record);
  const job = environmentSetupStore(h.store).job(requested.jobId)!;
  h.taken.length = 0;
  const envs = environmentStore(h.store);
  envs.remove("analysis");
  const replacement = envs.declare({
    name: "analysis",
    language: "python",
    manager: "uv",
    packages: ["tidyverse"],
    createdBy: "u_1",
    createdTs: NOW + 20,
  });
  expect(replacement.declarationGenerationId).not.toBe(job.declarationGenerationId);
  for (let revision = 1; revision <= 4; revision += 1)
    envs.writeLock("analysis", `tidyverse==${revision}.0.0\n`, NOW + 20 + revision, ["tidyverse"]);

  h.coordinator.recover(h.record);

  expect(h.taken).toEqual([]);
  expect(environmentSetupStore(h.store).job(job.id)).toMatchObject({
    state: "requested",
    declarationGenerationId: job.declarationGenerationId,
  });
  expect(environmentSetupStore(h.store).job(job.id)!.log.at(-1)).toMatch(/generation/i);
});

it("caps coverage at four ready rounds and lets a later explicit setup carry the uncovered waiter", () => {
  const h = harness();
  const setups = environmentSetupStore(h.store);
  environmentStore(h.store).addPackages("analysis", ["metafor"]);
  const sourceRunId = h.store.get(`SELECT id FROM turns WHERE task_id = 't_1'`)!.id as string;
  const source = h.store.get(`SELECT session_id FROM turns WHERE id = ?`, [sourceRunId])!;
  const waiter = setups.recordRequirement({
    studyId: "s_1",
    taskId: "t_1",
    sessionId: source.session_id as string,
    sourceTurnId: sourceRunId,
    sourceRunId,
    language: "python",
    environmentName: "analysis",
    runtimeId: "rt_1",
    createdTs: NOW + 1,
  });
  let round = setups.requestJob({
    studyId: "s_1",
    taskId: "t_1",
    runtimeId: "rt_1",
    environmentName: "analysis",
    language: "python",
    manager: "uv",
    lockRevision: 4,
    declarationGenerationId: "envgen_analysis",
    declarationCreatedTs: NOW,
    requestId: "req_round_1",
    requestedBy: "u_1",
    requestedTs: NOW + 2,
    requestedPackages: ["tidyverse", "metafor"],
    sourceRunId,
    resolvedFrom: ["tidyverse"],
  }).job;
  for (let number = 2; number <= 4; number += 1) {
    setups.markReady(round.requestId, NOW + number);
    const next = setups.requestPhysicalJob({
      runtimeId: "rt_1",
      environmentName: "analysis",
      language: "python",
      manager: "uv",
      lockRevision: 4,
      declarationGenerationId: "envgen_analysis",
      declarationCreatedTs: NOW,
      requestId: `req_round_${number}`,
      requestedTs: NOW + number + 10,
      previousJobId: round.id,
      round: number,
      resolvedFrom: ["tidyverse"],
    }).job;
    setups.carryForwardUncovered(round.id, next.id, ["tidyverse"], NOW + number + 20);
    round = next;
  }

  expect(
    h.coordinator.settle(
      "rt_1",
      round.requestId,
      { ok: true, status: readyStatus(4, round.requestId) },
      h.record,
    ),
  ).toBe(true);
  expect(setups.job(round.id)).toMatchObject({ state: "ready", round: 4 });
  expect(setups.waiter(waiter.id)).toMatchObject({ jobId: round.id, state: "waiting" });
  expect(h.taken).toEqual([]);

  const restartedRuns = createRunRelay();
  const restartedCommands: RunCommand[] = [];
  restartedRuns.attach("rt_1", (_seq, command) => restartedCommands.push(command));
  createEnvironmentSetupCoordinator({ store: h.store, runs: restartedRuns, now: () => NOW + 30 })
    .recover(h.record);
  expect(restartedCommands).toEqual([]);
  expect(setups.waiter(waiter.id)).toMatchObject({ jobId: round.id, state: "waiting" });
  expect(h.store.get(`SELECT COUNT(*) AS count FROM turns WHERE origin = 'system'`)!.count).toBe(0);

  const explicit = h.coordinator.request({ ...request(), sourceRunId }, actor, h.record);
  const fresh = setups.job(explicit.jobId)!;
  expect(explicit.waiterId).toBe(waiter.id);
  expect(fresh).toMatchObject({ round: 1, state: "requested" });
  expect(fresh.previousJobId).toBeUndefined();
  expect(setups.waiter(waiter.id)).toMatchObject({ jobId: fresh.id, state: "waiting" });
  expect(h.taken).toHaveLength(1);
});
