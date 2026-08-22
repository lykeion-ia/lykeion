import { afterEach, expect, it } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  type KernelEnvStatus,
  type Language,
  type LykeionApi,
} from "@lykeion/api";
import { expectRejection } from "@lykeion/api/conformance";
import {
  environmentLockfileFingerprint,
  environmentPackageFingerprint,
} from "@lykeion/api/environment-setup-evidence";
import { openStore } from "../store/sqlite";
import { migrate, nextSeq } from "../store/migrations";
import { environmentStore } from "../store/environments";
import { readConfig } from "../config";
import { createChannel, type Channel } from "../channel";
import { createRunRelay, type RunCommand, type RunRelay } from "../run-relay";
import { createRevertRegistry } from "../run-revert";
import { createKernelListRegistry } from "../kernel-list-registry";
import { createTitleRegistry } from "../title-registry";
import { createPendingCells } from "../kernel-cells";
import {
  createEnvironmentSetupCoordinator,
  type EnvironmentSetupCoordinator,
} from "../environment-setup-coordinator";
import { environmentSetupStore } from "../store/environment-setups";
import type { StoredEnvironmentSetupJob } from "../store/environment-setups";
import { openSession, recordTurn } from "../store/sessions";
import { createRequestListener } from "../http";
import { handleDaemonRoute } from "../routes/daemon-routes";
import { hashSecret } from "../auth";
import { apiFor, signUpOwner } from "../test-support/server-api";
import { seedLabContent } from "../store/seed";
import { changeRecorder } from "./changes";
import { environmentsApi } from "./environments";
import type { Deps } from "./index";
import type { Store } from "../store/store";

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-environments-api-"));
  dirs.push(dir);
  const store = openStore(join(dir, "workspace.db"));
  opened.push(store);
  migrate(store);
  return store;
}

afterEach(() => {
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      // best effort — a stuck close must not strand the rest of cleanup.
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort — nothing here is worth failing an already-passed test.
    }
  }
});

const NOW = 1_800_000_000;

function addOwner(store: Store, id: string): void {
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, `${id}@lab.example`, id, "x", NOW, nextSeq(store)],
  );
  store.run(`INSERT INTO members (user_id, role, joined_ts, seq) VALUES (?, 'owner', ?, ?)`, [
    id,
    NOW,
    nextSeq(store),
  ]);
}

function depsFor(store: Store, overrides: Partial<Deps> = {}): Deps {
  const actor = { userId: "u_ana", role: "owner" } as const;
  const channel = createChannel(store, 1000);
  const runs = overrides.runs ?? createRunRelay();
  return {
    store,
    actor,
    now: () => NOW,
    config: readConfig({}),
    channel,
    runs,
    reverts: createRevertRegistry(),
    kernelLists: createKernelListRegistry(),
    titles: createTitleRegistry(),
    pendingCells: createPendingCells(),
    coordinator: overrides.coordinator ?? createEnvironmentSetupCoordinator({
      store, runs, now: () => NOW,
    }),
    changes: changeRecorder({ store, actorId: actor.userId, now: () => NOW, channel }),
    ...overrides,
  };
}

/** A machine of `ownerId`'s, last heard from at `lastSeenTs` — enough of a
 *  `runtimes` row for `authorizedOwnRuntime` to resolve and for `healthFor`
 *  to judge, which is all a setup ask reads. */
function addRuntime(store: Store, id: string, ownerId: string, lastSeenTs: number): void {
  store.run(
    `INSERT INTO runtimes (id, owner_id, name, platform, daemon_version, capabilities, created_ts, last_seen_ts, seq)
     VALUES (?, ?, ?, 'macos-aarch64', '0.1.0', '[]', ?, ?, ?)`,
    [id, ownerId, `${id}-machine`, NOW, lastSeenTs, nextSeq(store)],
  );
}

function addResearchTask(store: Store, researchId = "s_1", taskId = "t_1"): void {
  store.run(
    `INSERT INTO studies (id, key, title, created_by, created_ts, updated_ts, seq)
     VALUES (?, 'ENV', 'Environment', 'u_ana', ?, ?, ?)`,
    [researchId, NOW, NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO tasks
       (id, number, study_id, stage, title, status, priority, created_by,
        created_ts, updated_ts, seq)
     VALUES (?, 1, ?, 'background', 'Set up', 'todo', 'no-priority', 'u_ana', ?, ?, ?)`,
    [taskId, researchId, NOW, NOW, nextSeq(store)],
  );
}

it("returns durable setup intent immediately and projects it for the Task", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  addResearchTask(store);
  addRuntime(store, "rt_durable", "u_ana", NOW);
  const runs = createRunRelay();
  const taken: RunCommand[] = [];
  runs.attach("rt_durable", (_seq, command) => taken.push(command));
  const coordinator = createEnvironmentSetupCoordinator({ store, runs, now: () => NOW });
  const envs = environmentsApi(depsFor(store, { runs, coordinator }));
  await envs.kernelEnvCreate({ name: "analysis", language: "python", packages: ["scanpy"] });

  const requested = await envs.requestKernelEnvironmentSetup({
    taskId: "t_1",
    machineId: "rt_durable",
    environmentName: "analysis",
  });

  expect(requested.jobId).toMatch(/^envjob_/);
  expect(taken).toHaveLength(1);
  expect(await envs.taskEnvironmentSetups("t_1")).toMatchObject([
    { job: { id: requested.jobId, state: "requested", environmentName: "analysis" } },
  ]);
  await expect(envs.retryKernelEnvironmentSetup("wait_missing")).rejects.toMatchObject({
    code: "conflict",
  });
});

it("offers the Research a default the moment its build becomes ready, and not before", async () => {
  // The suggestion is what a FINISHED build offers. Created mid-build it
  // would be a default for an environment that may still fail, and answering
  // it would pin this Research to something no machine holds.
  const store = freshStore();
  addOwner(store, "u_ana");
  addResearchTask(store);
  addRuntime(store, "rt_ready", "u_ana", NOW);
  const runs = createRunRelay();
  const taken: RunCommand[] = [];
  runs.attach("rt_ready", (_seq, command) => taken.push(command));
  const coordinator = createEnvironmentSetupCoordinator({ store, runs, now: () => NOW });
  const envs = environmentsApi(depsFor(store, { runs, coordinator }));
  const declarations = environmentStore(store);
  await envs.kernelEnvCreate({ name: "meta-analysis-r", language: "r", packages: ["metafor"] });
  const lockfile = "metafor=4.6\n";
  declarations.writeLock("meta-analysis-r", lockfile, NOW, ["metafor"]);

  await envs.requestKernelEnvironmentSetup({
    taskId: "t_1",
    machineId: "rt_ready",
    environmentName: "meta-analysis-r",
  });

  expect((await envs.taskEnvironmentSetups("t_1"))[0]!.suggestion).toBeUndefined();

  coordinator.settle(
    "rt_ready",
    taken[0]!.runId,
    {
      ok: true,
      status: {
        state: "ready",
        name: "meta-analysis-r",
        language: "r",
        manager: "conda",
        platform: "macos-aarch64",
        root: "/work/envs/meta-analysis-r",
        version: "4.6.1",
        packageCount: 1,
        lockRevision: 1,
        setupRequestId: taken[0]!.runId,
        lockfileFingerprint: environmentLockfileFingerprint(lockfile),
        packageFingerprint: environmentPackageFingerprint(["metafor"]),
        declarationGenerationId: declarations.get("meta-analysis-r")!.declarationGenerationId,
        declarationCreatedTs: NOW,
      },
    },
    () => {},
  );

  const [setup] = await envs.taskEnvironmentSetups("t_1");
  expect(setup!.job.state).toBe("ready");
  expect(setup!.suggestion).toMatchObject({
    language: "r",
    environmentName: "meta-analysis-r",
    state: "pending",
  });
});

it("writes Not now as declined and leaves the Research's existing default untouched", async () => {
  // Declining is an answer, not a deferral: the suggestion stops being
  // pending — so nothing offers it again — and the Research is left exactly
  // as it was, down to the default it already held. "Not now" is about the
  // question, and touches nothing else.
  const store = freshStore();
  addOwner(store, "u_ana");
  addResearchTask(store);
  addRuntime(store, "rt_declined", "u_ana", NOW);
  const runs = createRunRelay();
  const coordinator = createEnvironmentSetupCoordinator({ store, runs, now: () => NOW });
  const envs = environmentsApi(depsFor(store, { runs, coordinator }));
  const setups = environmentSetupStore(store);
  // Declared, because a setup job in production always names one this lab
  // holds — and a suggestion is only ever raised about an environment the lab
  // still declares.
  await envs.kernelEnvCreate({ name: "analysis", language: "python", packages: ["scanpy"] });
  const job = setups.requestJob({
    studyId: "s_1",
    taskId: "t_1",
    runtimeId: "rt_declined",
    environmentName: "analysis",
    language: "python",
    manager: "uv",
    lockRevision: 0,
    declarationGenerationId: "envgen_declined",
    declarationCreatedTs: NOW,
    requestId: "req_declined",
    requestedBy: "u_ana",
    requestedTs: NOW,
    requestedPackages: ["scanpy"],
    resolvedFrom: ["scanpy"],
  }).job;
  setups.markReady(job.requestId, NOW + 1);
  const [suggestion] = setups.createSuggestionsForReadyJob(job.id, NOW + 2);
  // A default this Research already holds for the SAME language, seeded after
  // the question was raised — which is the only order that can produce the
  // pair, since a Research that already had one would have been asked
  // nothing. Written directly because no API reaches this state, and the
  // point is what declining does to a default that EXISTS: asserting an empty
  // list stay empty could not fail however `answerSuggestion` behaved.
  store.run(
    `INSERT INTO research_environment_defaults
       (study_id, language, environment_name, set_by, set_ts)
     VALUES ('s_1', 'python', 'already-chosen', 'u_ana', ?)`,
    [NOW],
  );

  await envs.answerEnvironmentDefaultSuggestion(suggestion!.id, false);

  // Untouched, down to who set it and when. Declining is an answer about the
  // question, never a write to the default.
  expect(setups.defaultsForResearch("s_1")).toEqual([
    {
      language: "python",
      environmentName: "already-chosen",
      setBy: "u_ana",
      setTs: NOW,
    },
  ]);
  expect((await envs.taskEnvironmentSetups("t_1"))[0]!.suggestion).toMatchObject({
    state: "declined",
  });
});

it("deleting an environment forgets its defaults and cancels every Task waiting on it", async () => {
  // This case used to assert the opposite of its second half — that a delete
  // left every waiter exactly where it was — and it was right to, for as long
  // as the only alternative on offer was a HALF cancellation: marking the row
  // cancelled from this path, without finishing the continuation turn a
  // `queued` waiter owns or recalling the run already dispatched for it, would
  // have left both of those going with nothing that could ever settle them.
  //
  // The whole operation is now built, in the one place that can do it: the
  // coordinator's `cancelForEnvironment` cancels the waiter, finishes its
  // continuation turn and names the run to recall, all inside the delete's own
  // transaction, and `kernelEnvDelete` dispatches the `cancel` commands only
  // once that transaction has committed. Leaving the waiters alone is no
  // longer the safe option it was: once the declaration is gone nothing can
  // plan that build, so a waiter left standing is a Task blocked forever on a
  // build that will never be asked for again.
  const store = freshStore();
  addOwner(store, "u_ana");
  addResearchTask(store);
  addRuntime(store, "rt_waiting", "u_ana", NOW);
  const runs = createRunRelay();
  const coordinator = createEnvironmentSetupCoordinator({ store, runs, now: () => NOW });
  const envs = environmentsApi(depsFor(store, { runs, coordinator }));
  await envs.kernelEnvCreate({ name: "meta-analysis-r", language: "r", packages: ["metafor"] });
  const setups = environmentSetupStore(store);
  const sessionId = openSession(store, {
    researchId: "s_1",
    machineId: "rt_waiting",
    agent: "claude",
    openedBy: "u_ana",
    openedTs: NOW,
  });
  const sourceRunId = recordTurn(store, {
    sessionId,
    taskId: "t_1",
    prompt: "pool the trials",
    startedTs: NOW,
  });
  const waiter = setups.recordRequirement({
    studyId: "s_1",
    taskId: "t_1",
    sessionId,
    sourceTurnId: sourceRunId,
    sourceRunId,
    language: "r",
    environmentName: "meta-analysis-r",
    runtimeId: "rt_waiting",
    createdTs: NOW,
  });
  // Queued, which is the state that makes the whole operation necessary: this
  // waiter owns a durable continuation turn and a run on somebody's laptop, so
  // cancelling it means ending both as well.
  const continuationTurnId = recordTurn(store, {
    sessionId,
    taskId: "t_1",
    prompt: "The environment meta-analysis-r is ready on this machine.",
    startedTs: NOW,
    origin: "system",
    continuation: {
      kind: "environment-setup",
      waiterId: waiter.id,
      sourceTurnId: sourceRunId,
      environmentName: "meta-analysis-r",
      machineId: "rt_waiting",
    },
  });
  expect(setups.queueWaiter(waiter.id, continuationTurnId, NOW)).toBe(true);
  store.run(
    `INSERT INTO research_environment_defaults
       (study_id, language, environment_name, set_by, set_ts)
     VALUES ('s_1', 'r', 'meta-analysis-r', 'u_ana', ?)`,
    [NOW],
  );

  const taken: RunCommand[] = [];
  const detach = runs.attach("rt_waiting", (_seq, command) => taken.push(command));

  await envs.kernelEnvDelete("meta-analysis-r");

  expect(setups.defaultsForResearch("s_1")).toEqual([]);
  expect(setups.waiter(waiter.id)).toMatchObject({
    state: "cancelled",
    cancelledReason: "environment-deleted",
    continuationTurnId,
    environmentName: "meta-analysis-r",
  });
  // All three halves of one fact, not one of them: the waiter is cancelled,
  // the turn it owned is finished, and the machine holding that run is told
  // to stop it.
  expect(store.get(`SELECT ended_ts, status FROM turns WHERE id = ?`, [continuationTurnId]))
    .toEqual({ ended_ts: NOW, status: "cancelled" });
  expect(taken).toEqual([{ type: "cancel", runId: continuationTurnId }]);
  detach();
});

it("offers no default for an environment this lab no longer declares", async () => {
  // A job carries the name it was requested for and goes on carrying it after
  // the lab deletes that declaration — nothing joins the two, and deleting a
  // declaration leaves every job that named it exactly where it was. The
  // delete path sweeps the defaults and the outstanding questions that exist
  // when it runs; what it cannot do is stop a later one being written. So the
  // guard belongs where the suggestion is WRITTEN: a default naming an
  // environment nothing in this lab has could never resolve, and accepting
  // one would put the lab back in the state the delete path exists to leave
  // it out of.
  //
  // The one route from a build in flight is separately shut, one layer up:
  // `settle` refuses a result whose declaration generation is no longer this
  // lab's, so a delete DURING a build fails that job rather than readying it.
  // This is the state that route cannot produce and the store still must not
  // allow — a job that genuinely reached ready, asked again after the delete.
  const store = freshStore();
  addOwner(store, "u_ana");
  addResearchTask(store);
  addRuntime(store, "rt_deleted", "u_ana", NOW);
  const runs = createRunRelay();
  const taken: RunCommand[] = [];
  runs.attach("rt_deleted", (_seq, command) => taken.push(command));
  const coordinator = createEnvironmentSetupCoordinator({ store, runs, now: () => NOW });
  const envs = environmentsApi(depsFor(store, { runs, coordinator }));
  const declarations = environmentStore(store);
  await envs.kernelEnvCreate({ name: "meta-analysis-r", language: "r", packages: ["metafor"] });
  const lockfile = "metafor=4.6\n";
  declarations.writeLock("meta-analysis-r", lockfile, NOW, ["metafor"]);
  const declarationGenerationId = declarations.get("meta-analysis-r")!.declarationGenerationId!;
  await envs.requestKernelEnvironmentSetup({
    taskId: "t_1",
    machineId: "rt_deleted",
    environmentName: "meta-analysis-r",
  });
  const setups = environmentSetupStore(store);
  const jobId = setups.jobByRequest(taken[0]!.runId)!.id;
  coordinator.settle(
    "rt_deleted",
    taken[0]!.runId,
    {
      ok: true,
      status: {
        state: "ready",
        name: "meta-analysis-r",
        language: "r",
        manager: "conda",
        platform: "macos-aarch64",
        root: "/work/envs/meta-analysis-r",
        version: "4.6.1",
        packageCount: 1,
        lockRevision: 1,
        setupRequestId: taken[0]!.runId,
        lockfileFingerprint: environmentLockfileFingerprint(lockfile),
        packageFingerprint: environmentPackageFingerprint(["metafor"]),
        declarationGenerationId,
        declarationCreatedTs: NOW,
      },
    },
    () => {},
  );
  // The build landed and the Research was asked, which is the whole of the
  // ordinary flow — and the precondition for what follows.
  expect(setups.job(jobId)!.state).toBe("ready");
  expect((await envs.taskEnvironmentSetups("t_1"))[0]!.suggestion).toMatchObject({
    state: "pending",
  });

  await envs.kernelEnvDelete("meta-analysis-r");

  // Swept, and it stays swept: asking the same ready job again raises nothing.
  expect(setups.createSuggestionsForReadyJob(jobId, NOW + 3)).toEqual([]);
  expect(store.all(`SELECT id FROM environment_default_suggestions`)).toEqual([]);
  expect((await envs.taskEnvironmentSetups("t_1"))[0]!.suggestion).toBeUndefined();
});

it("answers a durable environment default suggestion through the setup store", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  addResearchTask(store);
  addRuntime(store, "rt_suggestion", "u_ana", NOW);
  const runs = createRunRelay();
  const coordinator = createEnvironmentSetupCoordinator({ store, runs, now: () => NOW });
  const envs = environmentsApi(depsFor(store, { runs, coordinator }));
  const setups = environmentSetupStore(store);
  // Declared, because a setup job in production always names one this lab
  // holds — and a suggestion is only ever raised about an environment the lab
  // still declares.
  await envs.kernelEnvCreate({ name: "analysis", language: "python", packages: ["scanpy"] });
  const job = setups.requestJob({
    studyId: "s_1",
    taskId: "t_1",
    runtimeId: "rt_suggestion",
    environmentName: "analysis",
    language: "python",
    manager: "uv",
    lockRevision: 0,
    declarationGenerationId: "envgen_suggestion",
    declarationCreatedTs: NOW,
    requestId: "req_suggestion",
    requestedBy: "u_ana",
    requestedTs: NOW,
    requestedPackages: ["scanpy"],
    resolvedFrom: ["scanpy"],
  }).job;
  setups.markReady(job.requestId, NOW + 1);
  const [suggestion] = setups.createSuggestionsForReadyJob(job.id, NOW + 2);

  await envs.answerEnvironmentDefaultSuggestion(suggestion!.id, true);

  expect(setups.defaultsForResearch("s_1")).toEqual([
    {
      language: "python",
      environmentName: "analysis",
      setBy: "u_ana",
      setTs: NOW,
    },
  ]);
  await expect(
    envs.answerEnvironmentDefaultSuggestion("suggest_missing", true),
  ).rejects.toMatchObject({ code: "not-found" });
});

it("declares with the actor who asked, when, and the manager derived for python", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  const declared = await envs.kernelEnvCreate({
    name: "crispr",
    language: "python",
    packages: ["scanpy", "anndata"],
  });

  expect(declared.createdBy).toBe("u_ana");
  expect(declared.createdTs).toBe(NOW);
  // Not asked for on the input — the manager is derived from the language,
  // never a caller's choice — but a declaration always carries one.
  expect(declared.manager).toBe("uv");
  expect(declared.lockRevision).toBe(0);
});

it("declares an R environment, deriving conda from the language", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  const declared = await envs.kernelEnvCreate({
    name: "rstats",
    language: "r",
    packages: ["jsonlite"],
  });

  expect(declared.language).toBe("r");
  // An R environment pins R itself, which is what makes it a conda one
  // rather than a uv one — the same derivation `python` gets, in reverse.
  expect(declared.manager).toBe("conda");
});

it("refuses a language this lab cannot build, naming it", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  await expectRejection(
    // Cast past the closed `Language` union the same way a wire caller
    // would arrive here — nothing on that path validates against it, which
    // is why the refusal below has to be written in code, not types.
    envs.kernelEnvCreate({ name: "j", language: "julia" as unknown as Language, packages: [] }),
    "unsupported",
    /julia/,
  );
});

it("refuses a name no machine could ever build, in front of whoever typed it", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  // A declaration's name becomes a directory on every machine that builds
  // it — `<workDir>/envs/<name>` — and the daemon's own `envRoot` refuses
  // anything that is not one path segment. Accepted here, this would be a
  // declaration that fails on a colleague's machine hours later with nobody
  // in front of it to read the failure.
  for (const name of ["../etc", "my env", "", "crispr/v2"]) {
    await expectRejection(
      envs.kernelEnvCreate({ name, language: "python", packages: ["scanpy"] }),
      "invalid",
      // What a researcher can act on, not the rule's regex.
      /letters, numbers, dashes and underscores/,
    );
  }
  // Refused, not merely reported: nothing was declared.
  expect(await envs.kernelEnvList()).toEqual([]);

  // And the shapes a researcher actually types still go through.
  const declared = await envs.kernelEnvCreate({
    name: "crispr_v2-final",
    language: "python",
    packages: ["scanpy"],
  });
  expect(declared.name).toBe("crispr_v2-final");
});

it("refuses the same names on the agent's wire as on the researcher's own", async () => {
  // Two surfaces, one rule. A researcher types a name into this lab; an
  // agent asks for one through `manage_environments`, which arrives over
  // `/daemon/kernel-env/create`. Two copies of the check would drift, and
  // the drift is a name a researcher can create and no agent can — or, the
  // way that goes wrong, a name an agent can create that every machine then
  // has to turn into a directory it cannot make.
  const store = freshStore();
  addOwner(store, "u_ana");
  addRuntime(store, "rt_1", "u_ana", NOW);
  store.run(
    `INSERT INTO machine_tokens (token_hash, runtime_id, owner_id, created_ts, seq) VALUES (?, ?, ?, ?, ?)`,
    [hashSecret("a-real-token"), "rt_1", "u_ana", NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO sessions (id, study_id, runtime_id, agent, opened_by, opened_ts, seq)
     VALUES ('se_1', 's_1', 'rt_1', 'claude', 'u_ana', ?, ?)`,
    [NOW, nextSeq(store)],
  );
  const envs = environmentsApi(depsFor(store));

  for (const name of ["../etc", "my env", "crispr/v2"]) {
    await expectRejection(
      envs.kernelEnvCreate({ name, language: "python", packages: ["scanpy"] }),
      "invalid",
      /letters, numbers, dashes and underscores/,
    );
    const runs = createRunRelay();
    const overTheWire = handleDaemonRoute({
      store,
      changes: changeRecorder({
        store,
        actorId: null,
        now: () => NOW,
        channel: createChannel(store, 1000),
      }),
      method: "POST",
      path: "/daemon/kernel-env/create",
      body: { sessionId: "se_1", name, packages: ["scanpy"] },
      authorization: "Bearer a-real-token",
      now: NOW,
      runs,
      coordinator: createEnvironmentSetupCoordinator({ store, runs, now: () => NOW }),
    });
    expect(overTheWire!.status).toBe(400);
    expect((overTheWire!.json as { error: string }).error).toMatch(
      /letters, numbers, dashes and underscores/,
    );
  }
  expect(await envs.kernelEnvList()).toEqual([]);
});

it("refuses a name this lab already has", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  await expectRejection(
    envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["anndata"] }),
    "conflict",
    /crispr/,
  );
});

it("refuses a name that differs from one this lab has only in case, because both are one folder", async () => {
  // Two rows in SQLite (its default collation is case-sensitive) and ONE
  // directory on every machine (seatbelt is the only backend, so every
  // machine is macOS, whose default volume is not). `materializeEnvironment`
  // runs `uv venv --clear` over `<workDir>/envs/<name>`, so the second
  // declaration's first build deletes the first one's — the starter every
  // default Python kernel in the lab runs in, if the pair is `python`.
  // Afterwards `readEnvStatus("python")` reads the other declaration's
  // marker and every `python`-bound kernel silently runs its interpreter.
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  await envs.kernelEnvCreate({ name: "python", language: "python", packages: ["numpy"] });
  await expectRejection(
    envs.kernelEnvCreate({ name: "Python", language: "python", packages: ["torch"] }),
    "conflict",
    // Both spellings, because which one this lab already holds is what the
    // caller needs in order to write its next call.
    /already has an environment named python.*Python would be the same folder/s,
  );
  // Refused, not folded onto the existing one: nothing was written, and the
  // declaration this lab already had is untouched.
  expect((await envs.kernelEnvList()).map((e) => [e.name, e.packages])).toEqual([
    ["python", ["numpy"]],
  ]);
});

it("deleting drops a declaration from the list, hard, all the way down", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  await envs.kernelEnvDelete("crispr");

  expect(await envs.kernelEnvList()).toEqual([]);
  // A hard delete, not a tombstone (fix round 1): the store beneath the API
  // answers `undefined` here, the same as a name that was never declared.
  expect(environmentStore(store).get("crispr")).toBeUndefined();
});

it("refuses to delete an environment this lab never declared, including one already deleted", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  await expectRejection(envs.kernelEnvDelete("bogus"), "not-found", /bogus/);

  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  await envs.kernelEnvDelete("crispr");
  // A second delete of the same name now takes the identical path an
  // unknown name does — there is no longer a distinct "already gone" case.
  await expectRejection(envs.kernelEnvDelete("crispr"), "not-found", /crispr/);
});

it("refuses to delete the starter — nobody made it, and a lab with none has no way to make one", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  // The real path a fresh lab actually takes, not a hand-built stand-in.
  seedLabContent(store);
  const envs = environmentsApi(depsFor(store));

  await expectRejection(
    envs.kernelEnvDelete("python"),
    "forbidden",
    /Lykeion's own starter environment/,
  );
  // Refused, not merely left undone: the declaration is exactly as it was.
  expect(environmentStore(store).get("python")).toBeDefined();

  // A declaration a researcher DID create is unaffected by this guard.
  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  await envs.kernelEnvDelete("crispr");
  expect(environmentStore(store).get("crispr")).toBeUndefined();
});

it("lets a deleted name be declared again, starting fresh with no lock carried over", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  const envs = environmentsApi(depsFor(store));

  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  await envs.kernelEnvDelete("crispr");

  // Before the fix, this second create hit the `kernel_envs.name` PRIMARY
  // KEY the deleted row still occupied and threw a raw SQLite error rather
  // than succeeding or raising a `LykeionError`.
  const recreated = await envs.kernelEnvCreate({
    name: "crispr",
    language: "python",
    packages: ["anndata"],
  });
  expect(recreated.packages).toEqual(["anndata"]);
  // The number that matters: a fresh declaration pins nothing yet, and
  // nothing of its predecessor's lockfile survives under it.
  expect(recreated.lockRevision).toBe(0);
});

// ---------------------------------------------------------------------------
// `requestKernelEnvironmentSetup`'s refusals, each against the branch that
// raises it and each asserting the CODE a client will branch on, not merely
// that something threw. The direct harness rather than the wire server below:
// these need a machine held at a chosen `last_seen_ts`, which a real daemon
// stub does not oblige. Distinct runtime ids per test.
// ---------------------------------------------------------------------------

it("refuses setup on an offline machine with conflict, before any command is minted", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  // Silent for an hour: well past `UNSTABLE_WITHIN_SECONDS`.
  addRuntime(store, "rt_offline", "u_ana", NOW - 3600);
  const relay = createRunRelay();
  const taken: RunCommand[] = [];
  relay.attach("rt_offline", (_seq, command) => {
    taken.push(command);
  });
  addResearchTask(store);
  const envs = environmentsApi(depsFor(store, { runs: relay }));
  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });

  await expectRejection(
    envs.requestKernelEnvironmentSetup({
      taskId: "t_1", machineId: "rt_offline", environmentName: "crispr",
    }),
    "conflict",
    /is offline/,
  );
  // Refused ahead of the relay, not merely reported: nothing was sent.
  expect(taken).toEqual([]);
});

it("refuses with conflict when the declaration names a revision whose lockfile this lab does not hold", async () => {
  const store = freshStore();
  addOwner(store, "u_ana");
  addRuntime(store, "rt_missing", "u_ana", NOW);
  const relay = createRunRelay();
  const taken: RunCommand[] = [];
  relay.attach("rt_missing", (_seq, command) => {
    taken.push(command);
  });
  addResearchTask(store);
  const envs = environmentsApi(depsFor(store, { runs: relay }));
  await envs.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  // A declaration pointing at a pin this lab cannot produce. The machine
  // must not be told to resolve instead: that is exactly the second,
  // independent resolution D4 exists to prevent, and it would silently
  // become revision 4 as if nothing were wrong.
  store.run(`UPDATE kernel_envs SET lock_revision = 3 WHERE name = 'crispr'`);

  await expectRejection(
    envs.requestKernelEnvironmentSetup({
      taskId: "t_1", machineId: "rt_missing", environmentName: "crispr",
    }),
    "conflict",
    /revision 3 is missing from this lab's own store/,
  );
  expect(taken).toEqual([]);
});

// ---------------------------------------------------------------------------
// The wire: environment setup and `kernelEnvReclaim` over a real server, a
// real run relay, and stub daemons standing in for two researchers' own
// machines. Mirrors the harness `api/kernels.test.ts` builds for
// `kernelExecute` et al., for the same reason: these tests need the raw store
// and relay directly, to see what a command actually carried and to settle a
// build the way a real daemon's HTTP calls would.
// ---------------------------------------------------------------------------

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function freshWireServer(): Promise<{
  base: string;
  store: Store;
  relay: RunRelay;
  channel: Channel;
  coordinator: EnvironmentSetupCoordinator;
  close(): Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-environments-wire-"));
  dirs.push(dir);
  const uiDir = join(dir, "ui");
  mkdirSync(uiDir);
  writeFileSync(join(uiDir, "index.html"), "<!doctype html><head></head><body></body>");

  const store = openStore(join(dir, "workspace.db"));
  migrate(store);
  const channel = createChannel(store, 1000);
  const relay = createRunRelay();
  const coordinator = createEnvironmentSetupCoordinator({ store, runs: relay });
  const openStreams = new Set<() => void>();
  const config = { ...readConfig({}), host: "127.0.0.1", port: 0, dataDir: dir, uiDir };

  const listener = createRequestListener({
    store,
    config,
    secure: false,
    indexHtml: "<!doctype html><head></head><body></body>",
    channel,
    openStreams,
    runs: relay,
    reverts: createRevertRegistry(),
    kernelLists: createKernelListRegistry(),
    titles: createTitleRegistry(),
    pendingCells: createPendingCells(),
    coordinator,
  });
  const server = createHttpServer(listener);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}`,
        store,
        relay,
        channel,
        coordinator,
        close: () =>
          new Promise<void>((res) => {
            for (const end of openStreams) end();
            server.close(() => {
              store.close();
              res();
            });
          }),
      });
    });
  });
}

function secretPair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Pairs and reports a machine for whichever `LykeionApi` is handed to it —
 *  the owner's own or an invited member's — enough of `/daemon/report`'s
 *  required fields to bring the runtime online, nothing about its CLI
 *  catalogue, which a setup ask's own checks never read. */
async function pairMachine(
  base: string,
  api: LykeionApi,
  machineName: string,
): Promise<{ machineId: string; token: string }> {
  const { verifier, challenge } = secretPair();
  const { code } = await api.pairMachine({
    name: machineName,
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    challenge,
    redirect: "http://127.0.0.1:7420/paired",
  });
  const exchanged = await fetch(`${base}/daemon/pair/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  // The pairing response still says `runtimeId` on purpose — a daemon already
  // paired is not upgraded in step with the lab it is paired to, so that one
  // key keeps the old name while everything above it says `machineId`.
  const { token, runtimeId: machineId } = (await exchanged.json()) as {
    token: string;
    runtimeId: string;
  };
  await fetch(`${base}/daemon/report`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ platform: "macos-aarch64", daemonVersion: "0.1.0", capabilities: [], clis: [] }),
  });
  return { machineId, token };
}

async function redeemInvite(base: string, code: string): Promise<string> {
  const res = await fetch(`${base}/auth/redeem-invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      email: "member@lab.example",
      displayName: "Member",
      password: "a good long password",
    }),
  });
  if (!res.ok) throw new Error(`redeem-invite answered ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0];
}

/** What one stub daemon does with every `kernel-env-setup`/
 *  `kernel-env-reclaim` command it receives on `machineId`'s own connection
 *  — a canned, successful resolve-and-materialize, or reclaim, the way a
 *  real daemon's `handleKernelEnvSetup`/`handleKernelEnvReclaim` would,
 *  without simulating a whole daemon process or running real `uv`.
 *  `resolvedLockfile` is what this stub "resolves" to when a command
 *  carries no lockfile of its own to replay; a command that already
 *  carries one is materialized from THAT text and never resolves — which is
 *  the fact under test. Returns every command this stub received, and its
 *  own detach function. */
function attachEnvStubDaemon(
  lab: { base: string; relay: RunRelay },
  machineId: string,
  token: string,
  resolvedLockfile: string,
): { taken: RunCommand[]; detach: () => void } {
  const taken: RunCommand[] = [];
  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(`${lab.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  const detach = lab.relay.attach(machineId, (_seq, command) => {
    taken.push(command);
    if (command.type === "kernel-env-setup") {
      void (async () => {
        let lockRevision = command.lockRevision;
        let lockfile = command.lockfile;
        if (lockfile === undefined) {
          // Nothing to replay — resolve, and learn the revision from the
          // lab's own reply, exactly as `postKernelEnvLock` does.
          lockfile = resolvedLockfile;
          // `requestId` names the ask this machine is carrying out. The lab
          // refuses a pin from a machine it did not ask, because a lockfile
          // is the one thing every OTHER machine later replays verbatim.
          const lockRes = await post("/daemon/kernel-env/lock", {
            requestId: command.runId,
            name: command.name,
            declarationGenerationId: command.declarationGenerationId,
            lockfile,
          });
          ({ lockRevision } = (await lockRes.json()) as { lockRevision: number });
        }
        const status: KernelEnvStatus = {
          state: "ready",
          name: command.name!,
          language: command.language ?? "python",
          manager: command.manager ?? "uv",
          platform: "macos-aarch64",
          root: `/work/envs/${command.name}`,
          version: "3.12.7",
          packageCount: 1,
          lockRevision,
          setupRequestId: command.runId,
          lockfileFingerprint: environmentLockfileFingerprint(lockfile),
          packageFingerprint: environmentPackageFingerprint(command.requestedPackages ?? []),
          declarationGenerationId: command.declarationGenerationId,
          declarationCreatedTs: command.declarationCreatedTs,
        };
        await post("/daemon/kernel-env/result", {
          requestId: command.runId,
          name: status.name,
          declarationGenerationId: command.declarationGenerationId,
          ok: true,
          status,
        });
      })().catch(() => {});
    }
  });
  return { taken, detach };
}

/** A Task of this researcher's own, in a Research of their own — what a
 *  durable setup ask has to be filed against. The removed per-machine setup
 *  call needed none of this: it addressed a machine and nothing else. */
async function taskFor(api: LykeionApi, key: string): Promise<string> {
  const research = await api.createResearch({ title: `Research ${key}`, key });
  const task = await api.createTask({
    researchId: research.id,
    stage: "background",
    title: `Set up ${key}`,
  });
  return task.id;
}

/** A Setup click on the durable contract: ask, then wait for the machine's
 *  stub to have carried the build all the way to a terminal job.
 *
 *  The removed per-machine setup call returned the finished status and these
 *  tests awaited it. The durable call returns the moment the ask is recorded —
 *  that is the whole
 *  point of it — so the wait that used to live inside the API call lives here
 *  instead, and what it waits for is the lab's own record of the build rather
 *  than a promise held open in this process. */
async function setupOn(
  lab: { store: Store },
  api: LykeionApi,
  taskId: string,
  machineId: string,
  environmentName: string,
): Promise<StoredEnvironmentSetupJob> {
  const { jobId } = await api.requestKernelEnvironmentSetup({ taskId, machineId, environmentName });
  const setups = environmentSetupStore(lab.store);
  await until(() => {
    const job = setups.job(jobId);
    return job !== undefined && (job.state === "ready" || job.state === "failed");
  });
  return setups.job(jobId)!;
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the condition to hold");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("resolves once and replays that lockfile on every later machine — Ben never resolves, which is why his numbers match Ana's", async () => {
  const lab = await freshWireServer();
  servers.push(lab);

  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const invite = await ana.createInvite("member");
  const benCookie = await redeemInvite(lab.base, invite.code);
  const ben = apiFor(lab.base, benCookie);

  const { machineId: rtAna, token: tokenAna } = await pairMachine(lab.base, ana, "ana-macbook");
  const { machineId: rtBen, token: tokenBen } = await pairMachine(lab.base, ben, "ben-laptop");

  await ana.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  const anaTask = await taskFor(ana, "ANA");
  const benTask = await taskFor(ben, "BEN");

  const stubAna = attachEnvStubDaemon(lab, rtAna, tokenAna, "scanpy==1.9.0\nanndata==0.10.0\n");
  const stubBen = attachEnvStubDaemon(lab, rtBen, tokenBen, "this-must-never-be-read==0.0.0\n");

  const anaResult = await setupOn(lab, ana, anaTask, rtAna, "crispr");
  expect(anaResult.state).toBe("ready");
  expect(anaResult.lockRevision).toBe(1);

  const envs = environmentStore(lab.store);
  expect(envs.get("crispr")!.lockRevision).toBe(1);
  const storedLockfile = envs.readLock("crispr", 1);
  expect(storedLockfile).toBe("scanpy==1.9.0\nanndata==0.10.0\n");

  const anaSetups = stubAna.taken.filter((c): c is RunCommand & { type: "kernel-env-setup" } =>
    c.type === "kernel-env-setup",
  );
  expect(anaSetups).toHaveLength(1);
  // Nothing to replay yet — Ana's machine is the one that resolves.
  expect(anaSetups[0]!.lockfile).toBeUndefined();
  expect(anaSetups[0]!.packages).toEqual(["scanpy"]);

  const benResult = await setupOn(lab, ben, benTask, rtBen, "crispr");
  expect(benResult.state).toBe("ready");
  expect(benResult.lockRevision).toBe(1);

  const benSetups = stubBen.taken.filter((c): c is RunCommand & { type: "kernel-env-setup" } =>
    c.type === "kernel-env-setup",
  );
  expect(benSetups).toHaveLength(1);
  // Ben's machine never resolves. This is the whole reason his figures
  // match Ana's rather than whatever PyPI happens to resolve to today.
  expect(benSetups[0]!.lockfile).toBe(storedLockfile);
  expect(benSetups[0]!.lockRevision).toBe(1);
  expect(benSetups[0]!.packages).toBeUndefined();

  // The lab's own revision never moved a second time — only a resolve can
  // move it, and Ben's machine never resolved.
  expect(envs.get("crispr")!.lockRevision).toBe(1);

  stubAna.detach();
  stubBen.detach();
});

/** Every `kernel-env-setup` one stub daemon has been sent, newest last. */
function setupsOf(taken: RunCommand[]): RunCommand[] {
  return taken.filter((command) => command.type === "kernel-env-setup");
}

it("replays a pin that still answers the declaration, and resolves again the moment it does not", async () => {
  // The whole of D4's branch, both halves in one run, because each half on
  // its own passes an implementation that is wrong in the other direction:
  // "always replay" silently drops every package a researcher just approved,
  // and "always resolve" re-pins the lab on every Setup and drifts the
  // moment a maintainer publishes.
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId, token } = await pairMachine(lab.base, ana, "ana-macbook");
  await ana.kernelEnvCreate({ name: "stale", language: "python", packages: ["scanpy"] });
  const task = await taskFor(ana, "STALE");
  const stub = attachEnvStubDaemon(lab, machineId, token, "scanpy==1.9.0\n");
  const envs = environmentStore(lab.store);

  // First: nothing pinned, so this machine resolves — and the lab writes
  // down what it asked to be resolved FROM beside the text that came back.
  await setupOn(lab, ana, task, machineId, "stale");
  expect(envs.get("stale")!.lockRevision).toBe(1);
  expect(envs.readLockRequest("stale", 1)).toEqual(["scanpy"]);

  // Second, unchanged: the pin still answers the declaration, so this
  // replays. Without this half a "resolve whenever in doubt" implementation
  // passes everything below.
  await setupOn(lab, ana, task, machineId, "stale");
  expect(setupsOf(stub.taken)).toHaveLength(2);
  expect(setupsOf(stub.taken)[1]!.lockfile).toBe("scanpy==1.9.0\n");
  expect(setupsOf(stub.taken)[1]!.packages).toBeUndefined();
  expect(envs.get("stale")!.lockRevision).toBe(1);

  // Now the declaration grows past its pin, which is exactly what
  // `manage_packages` does to it.
  envs.addPackages("stale", ["anndata"]);

  await setupOn(lab, ana, task, machineId, "stale");
  const third = setupsOf(stub.taken)[2]!;
  // Resolved, not replayed. Replaying here would build an environment
  // holding no `anndata` at all, on every machine in the lab, with nothing
  // anywhere saying so.
  expect(third.lockfile).toBeUndefined();
  expect(third.packages).toEqual(["scanpy", "anndata"]);
  // And the new pin records the new request, so the NEXT setup replays.
  expect(envs.get("stale")!.lockRevision).toBe(2);
  expect(envs.readLockRequest("stale", 2)).toEqual(["scanpy", "anndata"]);

  await setupOn(lab, ana, task, machineId, "stale");
  expect(setupsOf(stub.taken)[3]!.lockRevision).toBe(2);
  expect(setupsOf(stub.taken)[3]!.packages).toBeUndefined();

  stub.detach();
});

it("resolves when the package added sorts after everything already pinned", async () => {
  // `sameRequest`'s length check, driven. Without it the sorted comparison
  // walks only as far as the shorter list, so a pinned request that is a
  // sorted PREFIX of the declaration reads as a match — pinned from
  // `["anndata"]`, declaration now `["anndata","scanpy"]` — and the pin is
  // replayed, dropping `scanpy` on every machine in the lab.
  //
  // The names are chosen for their ORDER and nothing else: the D4 test above
  // adds `anndata` to a pin of `["scanpy"]`, which sorts BEFORE it, so its
  // first comparison already differs and it passes with or without the guard.
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId, token } = await pairMachine(lab.base, ana, "ana-macbook");
  await ana.kernelEnvCreate({ name: "prefix", language: "python", packages: ["anndata"] });
  const task = await taskFor(ana, "PREFIX");
  const stub = attachEnvStubDaemon(lab, machineId, token, "anndata==0.10.0\n");
  const envs = environmentStore(lab.store);

  await setupOn(lab, ana, task, machineId, "prefix");
  expect(envs.readLockRequest("prefix", 1)).toEqual(["anndata"]);

  envs.addPackages("prefix", ["scanpy"]);
  await setupOn(lab, ana, task, machineId, "prefix");

  const second = setupsOf(stub.taken)[1]!;
  expect(second.lockfile).toBeUndefined();
  expect(second.packages).toEqual(["anndata", "scanpy"]);
  stub.detach();
});

it("resolves for an add that joined a replay, which resolved nothing at all", async () => {
  // The other direction of the coalescing defect. A researcher clicks Setup on
  // an already-pinned environment, so that build REPLAYS and resolves nothing;
  // an agent's add lands while it runs and joins it. Without the coverage
  // follow-up the approved packages are not merely built late, they are never
  // resolved — the build the add joined was a materialize of a lockfile
  // written before they existed.
  //
  // Driven through the coordinator directly rather than the wire, because what
  // has to be arranged is a second caller arriving mid-build; a stub daemon
  // that answers as fast as loopback allows cannot hold that window open.
  //
  // The add is `requestRebuild` — what `/daemon/kernel-env/packages` calls —
  // and the round it earns comes from its Task INTEREST being uncovered by the
  // replay, which is the durable substitute for the old awaited re-check loop.
  const store = freshStore();
  addOwner(store, "u_ana");
  addRuntime(store, "rt_replayjoin", "u_ana", NOW);
  addResearchTask(store);
  const relay = createRunRelay();
  const taken: RunCommand[] = [];
  const detach = relay.attach("rt_replayjoin", (_seq, command) => {
    taken.push(command);
  });
  const envs = environmentStore(store);
  envs.declare({
    name: "replayjoin", language: "python", manager: "uv", packages: ["numpy"],
    createdBy: "u_ana", createdTs: NOW,
  });
  envs.writeLock("replayjoin", "numpy==1.0.0\n", NOW, ["numpy"]);
  const coordinator = createEnvironmentSetupCoordinator({ store, runs: relay, now: () => NOW });
  const record = () => {};
  const ready = (command: RunCommand, lockfile: string, lockRevision: number): KernelEnvStatus => ({
    state: "ready", name: "replayjoin", language: "python", manager: "uv",
    platform: "macos-aarch64", root: "/work/envs/replayjoin", version: "3.12.7",
    packageCount: command.requestedPackages?.length ?? 0,
    lockRevision,
    setupRequestId: command.runId,
    lockfileFingerprint: environmentLockfileFingerprint(lockfile),
    packageFingerprint: environmentPackageFingerprint(command.requestedPackages ?? []),
    declarationGenerationId: envs.get("replayjoin")!.declarationGenerationId,
    declarationCreatedTs: NOW,
  });

  // The Setup click. Its plan is a replay — the pin still answers the
  // declaration exactly.
  const click = coordinator.request(
    { taskId: "t_1", machineId: "rt_replayjoin", environmentName: "replayjoin" },
    { userId: "u_ana", role: "owner" },
    record,
  );
  expect(taken).toHaveLength(1);
  expect(taken[0]!.lockfile).toBe("numpy==1.0.0\n");
  expect(taken[0]!.packages).toBeUndefined();

  // The agent's add, landing mid-build. It appends and joins.
  envs.addPackages("replayjoin", ["scanpy"]);
  const joined = coordinator.requestRebuild(
    {
      machineId: "rt_replayjoin",
      environmentName: "replayjoin",
      requestedPackages: ["numpy", "scanpy"],
      requestedBy: "u_ana",
      taskId: "t_1",
      reason: "scanpy was added to replayjoin",
    },
    record,
  );
  // It joined rather than starting a second build over the same directory.
  expect(joined!.jobId).toBe(click.jobId);
  expect(taken).toHaveLength(1);

  coordinator.settle("rt_replayjoin", taken[0]!.runId, {
    ok: true,
    status: ready(taken[0]!, "numpy==1.0.0\n", 1),
  }, record);

  // The replay covered `numpy` and nothing else, so the interest is uncovered
  // and earns a round of its own — and that round RESOLVES.
  expect(taken).toHaveLength(2);
  expect(taken[1]!.lockfile).toBeUndefined();
  expect(taken[1]!.packages).toEqual(["numpy", "scanpy"]);
  // And it announces the add that earned it. The Setup press this add joined
  // carried no sentence — a researcher looking at the button they pressed
  // needs none — so the job it joined had none either, and the add's own
  // sentence filled that silence. Without that, the kernels this round
  // restarts are restarted announcing nothing.
  expect(taken[1]!.reason).toBe("scanpy was added to replayjoin");
  const grownLockfile = "numpy==1.0.0\nscanpy==1.9.0\n";
  const grownRevision = coordinator.bindResolvedLock(
    "rt_replayjoin",
    taken[1]!.runId,
    "replayjoin",
    taken[1]!.declarationGenerationId!,
    grownLockfile,
    record,
  );
  expect(grownRevision).toBe(2);
  expect(
    coordinator.settle("rt_replayjoin", taken[1]!.runId, {
      ok: true,
      status: ready(taken[1]!, grownLockfile, grownRevision!),
    }, record),
  ).toBe(true);
  // Built, not merely declared: the second round finished ready holding both.
  expect(environmentSetupStore(store).job(
    environmentSetupStore(store).jobByRequest(taken[1]!.runId)!.id,
  )).toMatchObject({ state: "ready" });
  expect(envs.readLockRequest("replayjoin", 2)).toEqual(["numpy", "scanpy"]);
  detach();
});

it("gives up rather than chasing a build that is never going to carry what was asked for", async () => {
  // The bound on the coverage follow-up. An interest whose packages keep
  // missing every build — something appending on a timer — must not spin
  // forever. Driven by asking for a package nothing ever adds to the
  // declaration, which is the same shape from the follow-up's point of view.
  //
  // The old awaited loop ended by REJECTING the caller in words. There is no
  // caller left holding a promise to reject: the bound now lives in
  // `coverage_round`, and what it produces is a capped interest and no fifth
  // build.
  const store = freshStore();
  addOwner(store, "u_ana");
  addRuntime(store, "rt_giveup", "u_ana", NOW);
  addResearchTask(store);
  const relay = createRunRelay();
  const taken: RunCommand[] = [];
  const coordinator = createEnvironmentSetupCoordinator({ store, runs: relay, now: () => NOW });
  const record = () => {};
  const detach = relay.attach("rt_giveup", (_seq, command) => {
    taken.push(command);
    // Answered immediately and successfully, so what ends this is the bound
    // and nothing else.
    const lockfile = command.lockfile ?? "numpy==1.0.0\n";
    const lockRevision = command.lockRevision ?? coordinator.bindResolvedLock(
      "rt_giveup",
      command.runId,
      "giveup",
      command.declarationGenerationId!,
      lockfile,
      record,
    )!;
    coordinator.settle("rt_giveup", command.runId, {
      ok: true,
      status: {
        state: "ready", name: "giveup", language: "python", manager: "uv",
        platform: "macos-aarch64", root: "/work/envs/giveup", version: "3.12.7",
        packageCount: command.requestedPackages?.length ?? 0,
        lockRevision,
        setupRequestId: command.runId,
        lockfileFingerprint: environmentLockfileFingerprint(lockfile),
        packageFingerprint: environmentPackageFingerprint(command.requestedPackages ?? []),
        declarationGenerationId:
          environmentStore(store).get("giveup")!.declarationGenerationId,
        declarationCreatedTs: NOW,
      },
    }, record);
  });
  environmentStore(store).declare({
    name: "giveup", language: "python", manager: "uv", packages: ["numpy"],
    createdBy: "u_ana", createdTs: NOW,
  });

  coordinator.requestRebuild(
    {
      machineId: "rt_giveup",
      environmentName: "giveup",
      // `never-declared` is not in the declaration and nothing ever adds it,
      // so no build can ever cover this interest.
      requestedPackages: ["numpy", "never-declared"],
      requestedBy: "u_ana",
      taskId: "t_1",
    },
    record,
  );

  // Bounded, and the bound is what stopped it — not one attempt, not endless.
  expect(taken).toHaveLength(4);
  detach();
});

it("does not re-pin the lab because a package list came back in a different order", async () => {
  // `["a","b"]` and `["b","a"]` are one request. A comparison that called
  // them different would resolve — and so re-pin every machine in the lab —
  // over nothing anybody asked for.
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId, token } = await pairMachine(lab.base, ana, "ana-macbook");
  await ana.kernelEnvCreate({
    name: "reordered", language: "python", packages: ["scanpy", "anndata"],
  });
  const task = await taskFor(ana, "REORDER");
  const stub = attachEnvStubDaemon(lab, machineId, token, "scanpy==1.9.0\n");
  const envs = environmentStore(lab.store);

  await setupOn(lab, ana, task, machineId, "reordered");
  expect(envs.get("reordered")!.lockRevision).toBe(1);

  // The same two names, the other way round.
  lab.store.run(`UPDATE kernel_envs SET packages = ? WHERE name = 'reordered'`, [
    JSON.stringify(["anndata", "scanpy"]),
  ]);

  await setupOn(lab, ana, task, machineId, "reordered");

  expect(setupsOf(stub.taken)[1]!.lockfile).toBe("scanpy==1.9.0\n");
  expect(envs.get("reordered")!.lockRevision).toBe(1);
  stub.detach();
});

it("resolves against a pin this lab cannot name the request for, rather than replaying on faith", async () => {
  // A row written before the column that records what a resolve was asked
  // for existed. It is not "resolved from nothing" — it is a request this
  // lab cannot name, and the caller widens: resolving where a replay would
  // have done costs one re-pin, while replaying where a resolve was needed
  // drops packages a researcher approved, on every machine, silently.
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId, token } = await pairMachine(lab.base, ana, "ana-macbook");
  await ana.kernelEnvCreate({ name: "unnamed", language: "python", packages: ["scanpy"] });
  const task = await taskFor(ana, "UNNAMED");
  // Pinned the way a database that predates migration 28 holds one: a real
  // lockfile at a real revision, and no record of the request behind it.
  lab.store.run(
    `INSERT INTO kernel_env_locks (name, revision, lockfile, written_ts) VALUES (?, 1, ?, ?)`,
    ["unnamed", "older==0.1.0\n", NOW],
  );
  lab.store.run(`UPDATE kernel_envs SET lock_revision = 1 WHERE name = 'unnamed'`);
  const stub = attachEnvStubDaemon(lab, machineId, token, "scanpy==1.9.0\n");

  await setupOn(lab, ana, task, machineId, "unnamed");

  const setup = setupsOf(stub.taken)[0]!;
  expect(setup.lockfile).toBeUndefined();
  expect(setup.packages).toEqual(["scanpy"]);
  // And the re-pin the widening cost, which the next setup will replay.
  expect(environmentStore(lab.store).readLockRequest("unnamed", 2)).toEqual(["scanpy"]);
  stub.detach();
});

it("refuses a machine that is not the caller's own", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const invite = await ana.createInvite("member");
  const benCookie = await redeemInvite(lab.base, invite.code);
  const ben = apiFor(lab.base, benCookie);

  const { machineId: rtAna } = await pairMachine(lab.base, ana, "ana-macbook");
  await ana.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  const benTask = await taskFor(ben, "BEN");

  await expectRejection(
    ben.requestKernelEnvironmentSetup({
      taskId: benTask, machineId: rtAna, environmentName: "crispr",
    }),
    "forbidden",
    /paired/,
  );
});

it("refuses a name this lab has never declared", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId } = await pairMachine(lab.base, ana, "ana-macbook");
  const task = await taskFor(ana, "NOPE");

  await expectRejection(
    ana.requestKernelEnvironmentSetup({ taskId: task, machineId, environmentName: "nope" }),
    "not-found",
    /nope/,
  );
});

it("refuses setup on a machine this lab has never paired", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  await ana.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  const task = await taskFor(ana, "UNPAIRED");
  await expectRejection(
    ana.requestKernelEnvironmentSetup({
      taskId: task, machineId: "rt_never-paired", environmentName: "crispr",
    }),
    "not-found",
    /rt_never-paired/,
  );
});

it("collapses two researchers asking the same machine to build the same environment into one command", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  await ana.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  const { machineId, token } = await pairMachine(lab.base, ana, "ana-macbook");

  let replies = 0;
  const detach = lab.relay.attach(machineId, (_seq, command) => {
    if (command.type !== "kernel-env-setup") return;
    replies += 1;
    // Held open past both requests actually landing on this server, so the
    // race this test is about — two callers arriving before either settles
    // — is not left to however fast a loopback round trip happens to be.
    void new Promise((resolve) => setTimeout(resolve, 200)).then(async () => {
      const lockfile = "scanpy==1.9.0\n";
      const lockResponse = await fetch(`${lab.base}/daemon/kernel-env/lock`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          requestId: command.runId,
          name: "crispr",
          declarationGenerationId: command.declarationGenerationId,
          lockfile,
        }),
      });
      const { lockRevision } = await lockResponse.json() as { lockRevision: number };
      return fetch(`${lab.base}/daemon/kernel-env/result`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({
          requestId: command.runId,
          name: "crispr",
          declarationGenerationId: command.declarationGenerationId,
          ok: true,
          status: {
            state: "ready", name: "crispr", language: "python", manager: "uv",
            platform: "macos-aarch64", root: "/work/envs/crispr", version: "3.12.7",
            packageCount: command.requestedPackages?.length ?? 0,
            lockRevision,
            setupRequestId: command.runId,
            lockfileFingerprint: environmentLockfileFingerprint(lockfile),
            packageFingerprint: environmentPackageFingerprint(command.requestedPackages ?? []),
            declarationGenerationId: command.declarationGenerationId,
            declarationCreatedTs: command.declarationCreatedTs,
          },
        }),
      });
    }).catch(() => {});
  });

  // Two callers racing in, before either has settled.
  const anaTask = await taskFor(ana, "RACE1");
  const otherTask = await taskFor(ana, "RACE2");
  const [first, second] = await Promise.all([
    ana.requestKernelEnvironmentSetup({
      taskId: anaTask, machineId, environmentName: "crispr",
    }),
    ana.requestKernelEnvironmentSetup({
      taskId: otherTask, machineId, environmentName: "crispr",
    }),
  ]);
  // One physical job, one command down the wire, one reply — whichever of the
  // two asks got there first. Both Tasks are recorded as interested in it.
  expect(first.jobId).toBe(second.jobId);
  await until(() => replies === 1);
  expect(replies).toBe(1);
  detach();
});

it("delivers a real kernel-env-reclaim command naming the environment", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  await ana.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
  const { machineId } = await pairMachine(lab.base, ana, "ana-macbook");

  const taken: RunCommand[] = [];
  const detach = lab.relay.attach(machineId, (_seq, command) => {
    taken.push(command);
  });

  await ana.kernelEnvReclaim(machineId, "crispr");
  await until(() => taken.some((c) => c.type === "kernel-env-reclaim"));
  const reclaim = taken.find((c) => c.type === "kernel-env-reclaim")!;
  expect(reclaim.name).toBe("crispr");
  detach();
});

it("reclaims a machine's own copy of the starter even though the starter itself cannot be deleted", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  // The real path a fresh lab actually takes, not a hand-built stand-in.
  seedLabContent(lab.store);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId } = await pairMachine(lab.base, ana, "ana-macbook");

  const taken: RunCommand[] = [];
  const detach = lab.relay.attach(machineId, (_seq, command) => {
    taken.push(command);
  });

  // The guard on `kernelEnvDelete` must not reach this at all: freeing a
  // machine's own copy leaves the declaration standing.
  await ana.kernelEnvReclaim(machineId, "python");
  await until(() => taken.some((c) => c.type === "kernel-env-reclaim"));
  const reclaim = taken.find((c) => c.type === "kernel-env-reclaim")!;
  expect(reclaim.name).toBe("python");
  expect(environmentStore(lab.store).get("python")).toBeDefined();
  detach();
});

it("leaves a Research's default standing when a machine reclaims its own copy of it", async () => {
  // The counterpart to the delete path, and the reason the two are different
  // operations. Deleting the declaration sweeps every default naming it,
  // because nothing could ever resolve one again. Reclaim frees a MACHINE's
  // gigabytes and leaves the declaration — and so the default goes on naming
  // something this lab still has, and the next machine to build it makes the
  // default reachable again.
  const store = freshStore();
  addOwner(store, "u_ana");
  addResearchTask(store);
  addRuntime(store, "rt_reclaim", "u_ana", NOW);
  const runs = createRunRelay();
  // Reclaim is delivered to a connected machine or refused, so the command
  // stream has to be up before it is asked for.
  const taken: RunCommand[] = [];
  const detach = runs.attach("rt_reclaim", (_seq, command) => taken.push(command));
  const envs = environmentsApi(depsFor(store, { runs }));
  await envs.kernelEnvCreate({ name: "analysis", language: "python", packages: ["scanpy"] });

  const setups = environmentSetupStore(store);
  const job = setups.requestJob({
    studyId: "s_1",
    taskId: "t_1",
    runtimeId: "rt_reclaim",
    environmentName: "analysis",
    language: "python",
    manager: "uv",
    lockRevision: 0,
    declarationGenerationId: "envgen_reclaim",
    declarationCreatedTs: NOW,
    requestId: "req_reclaim",
    requestedBy: "u_ana",
    requestedTs: NOW,
    requestedPackages: ["scanpy"],
    resolvedFrom: ["scanpy"],
  }).job;
  setups.markReady(job.requestId, NOW + 1);
  const [suggestion] = setups.createSuggestionsForReadyJob(job.id, NOW + 2);
  await envs.answerEnvironmentDefaultSuggestion(suggestion!.id, true);
  expect(setups.defaultsForResearch("s_1")).toHaveLength(1);

  await envs.kernelEnvReclaim("rt_reclaim", "analysis");

  expect(taken.map((command) => command.type)).toEqual(["kernel-env-reclaim"]);
  expect(setups.defaultsForResearch("s_1")).toEqual([
    { language: "python", environmentName: "analysis", setBy: "u_ana", setTs: NOW },
  ]);
  expect(environmentStore(store).get("analysis")).toBeDefined();
  detach();
});

it("bounds and redacts a progress line before it reaches this lab's own record of the build", async () => {
  // A machine's `uv` output is untrusted text that lands in a durable log and
  // goes out to every open tab. A machine sending a megabyte of it, or a line
  // carrying a credential out of its own environment, must not be able to make
  // either this lab's problem.
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId, token } = await pairMachine(lab.base, ana, "ana-macbook");
  const ownerId = lab.store.get(`SELECT owner_id FROM runtimes WHERE id = ?`, [machineId])!
    .owner_id as string;
  const envs = environmentStore(lab.store);
  const declaration = envs.declare({
    name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: NOW,
  });
  const requested = environmentSetupStore(lab.store).requestPhysicalJob({
    runtimeId: machineId,
    environmentName: "crispr",
    language: "python",
    manager: "uv",
    lockRevision: 0,
    declarationGenerationId: declaration.declarationGenerationId!,
    declarationCreatedTs: NOW,
    requestId: "envsetup_safe_line",
    requestedTs: NOW,
    resolvedFrom: ["scanpy"],
  });
  expect(ownerId).toBeDefined();
  const secret = "compatibility-channel-secret with spaces";

  const response = await fetch(`${lab.base}/daemon/kernel-env/progress`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      requestId: "envsetup_safe_line",
      name: "crispr",
      progress: {
        stage: "installing",
        line: `${"界".repeat(1_340)} {"AWS_SECRET_ACCESS_KEY": "${secret}"}`,
      },
    }),
  });

  expect(response.status).toBe(200);
  const log = environmentSetupStore(lab.store).job(requested.job.id)!.log;
  expect(log).toHaveLength(1);
  expect(new TextEncoder().encode(log[0]!).byteLength).toBeLessThanOrEqual(4_096);
  expect(log[0]!).not.toContain(secret);
  expect(log[0]!).toContain("[redacted]");
});

it("binds durable progress and refuses a terminal duplicate that does not match", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { machineId, token } = await pairMachine(lab.base, ana, "ana-macbook");
  const ownerId = lab.store.get(`SELECT owner_id FROM runtimes WHERE id = ?`, [machineId])!
    .owner_id as string;
  lab.store.run(
    `INSERT INTO studies (id, key, title, created_by, created_ts, updated_ts, seq)
     VALUES ('s_setup', 'SETUP', 'Setup', ?, ?, ?, ?)`,
    [ownerId, NOW, NOW, nextSeq(lab.store)],
  );
  lab.store.run(
    `INSERT INTO tasks
       (id, number, study_id, stage, title, status, priority, created_by,
        created_ts, updated_ts, seq)
     VALUES ('t_setup', 1, 's_setup', 'background', 'Setup', 'todo', 'no-priority',
             ?, ?, ?, ?)`,
    [ownerId, NOW, NOW, nextSeq(lab.store)],
  );
  const envs = environmentStore(lab.store);
  envs.declare({
    name: "durable", language: "python", manager: "uv", packages: ["scanpy"], createdTs: NOW,
  });
  envs.writeLock("durable", "scanpy==1.9.0\n", NOW, ["scanpy"]);
  const requested = environmentSetupStore(lab.store).requestJob({
    studyId: "s_setup",
    taskId: "t_setup",
    runtimeId: machineId,
    environmentName: "durable",
    language: "python",
    manager: "uv",
    lockRevision: 1,
    declarationGenerationId: envs.get("durable")!.declarationGenerationId!,
    declarationCreatedTs: NOW,
    requestId: "envsetup_collision",
    requestedBy: ownerId,
    requestedTs: NOW,
    requestedPackages: ["scanpy"],
  });

  const progress = await fetch(`${lab.base}/daemon/kernel-env/progress`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      requestId: "envsetup_collision",
      name: "durable",
      progress: { stage: "installing", line: "installing scanpy" },
    }),
  });
  expect(progress.status).toBe(200);
  expect(environmentSetupStore(lab.store).job(requested.job.id)).toMatchObject({
    state: "building",
    stage: "installing",
    log: ["installing scanpy"],
  });
  for (const progressBody of [
    { stage: "finalizing", line: "writing marker" },
    { stage: "installing", line: "late installing line" },
    { stage: "finalizing", line: "writing marker" },
  ]) {
    const response = await fetch(`${lab.base}/daemon/kernel-env/progress`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        requestId: "envsetup_collision",
        name: "durable",
        progress: progressBody,
      }),
    });
    expect(response.status).toBe(200);
  }
  expect(environmentSetupStore(lab.store).job(requested.job.id)).toMatchObject({
    stage: "finalizing",
    log: ["installing scanpy", "writing marker"],
  });

  const status: KernelEnvStatus = {
    state: "ready",
    name: "durable",
    language: "python",
    manager: "uv",
    platform: "macos-aarch64",
    root: "/work/envs/durable",
    packageCount: 12,
    lockRevision: 1,
    setupRequestId: "envsetup_collision",
    lockfileFingerprint: environmentLockfileFingerprint("scanpy==1.9.0\n"),
    packageFingerprint: environmentPackageFingerprint(["scanpy"]),
    declarationGenerationId: envs.get("durable")!.declarationGenerationId,
    declarationCreatedTs: NOW,
  };
  const generation = envs.get("durable")!.declarationGenerationId!;
  const postTerminal = (terminal: Record<string, unknown>) => fetch(`${lab.base}/daemon/kernel-env/result`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(terminal),
  });
  const successBody = {
    requestId: "envsetup_collision",
    name: "durable",
    declarationGenerationId: generation,
    ok: true,
    status,
  };
  const postResult = () => postTerminal(successBody);
  const missingOuterGeneration = await postTerminal({
    requestId: "envsetup_collision",
    name: "durable",
    ok: true,
    status,
  });
  expect(missingOuterGeneration.status).toBe(400);
  expect(environmentSetupStore(lab.store).job(requested.job.id)!.state).toBe("building");
  const malformed = await fetch(`${lab.base}/daemon/kernel-env/result`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      requestId: "envsetup_collision",
      name: "durable",
      ok: true,
      status: { state: "ready", name: "durable" },
    }),
  });
  expect(malformed.status).toBe(400);
  const wrongFailure = await fetch(`${lab.base}/daemon/kernel-env/result`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      requestId: "envsetup_collision",
      name: "other",
      declarationGenerationId: generation,
      ok: false,
      error: "spoofed failure",
    }),
  });
  expect(wrongFailure.status).toBe(403);
  expect(environmentSetupStore(lab.store).job(requested.job.id)!.state).toBe("building");
  const first = await postResult();
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true });
  const duplicate = await postResult();
  expect(duplicate.status).toBe(200);
  expect(await duplicate.json()).toEqual({ ok: true, duplicate: true });
  expect(environmentSetupStore(lab.store).job(requested.job.id)!.state).toBe("ready");
  const successFingerprint = environmentSetupStore(lab.store)
    .job(requested.job.id)!.terminalOutcomeFingerprint;
  expect(successFingerprint).toMatch(/^[a-f0-9]{64}$/);
  for (const conflict of [
    { ...successBody, name: "other" },
    { ...successBody, declarationGenerationId: "envgen_other" },
    { ...successBody, status: { ...status, name: "other" } },
    { ...successBody, status: { ...status, declarationGenerationId: "envgen_other" } },
    { ...successBody, status: { ...status, language: "r" } },
    { ...successBody, status: { ...status, manager: "conda" } },
    { ...successBody, status: { ...status, platform: "linux-x64" } },
    { ...successBody, status: { ...status, root: "/other/root" } },
    { ...successBody, status: { ...status, version: "3.13.0" } },
    { ...successBody, status: { ...status, packageCount: 13 } },
    { ...successBody, status: { ...status, lockRevision: 2 } },
    { ...successBody, status: { ...status, declarationCreatedTs: NOW + 1 } },
    {
      requestId: successBody.requestId,
      name: successBody.name,
      declarationGenerationId: generation,
      ok: false,
      error: "conflicting failure",
    },
  ]) {
    expect((await postTerminal(conflict)).status).toBeGreaterThanOrEqual(400);
  }
  expect(
    environmentSetupStore(lab.store).job(requested.job.id)!.terminalOutcomeFingerprint,
  ).toBe(successFingerprint);
  const failed = environmentSetupStore(lab.store).requestJob({
    studyId: "s_setup",
    taskId: "t_setup",
    runtimeId: machineId,
    environmentName: "durable",
    language: "python",
    manager: "uv",
    lockRevision: 1,
    declarationGenerationId: envs.get("durable")!.declarationGenerationId!,
    declarationCreatedTs: NOW,
    requestId: "envsetup_bounded_failure",
    requestedBy: ownerId,
    requestedTs: NOW + 1,
    requestedPackages: ["scanpy"],
  });
  const failure = await fetch(`${lab.base}/daemon/kernel-env/result`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      requestId: "envsetup_bounded_failure",
      name: "durable",
      declarationGenerationId: generation,
      ok: false,
      error: "x".repeat(10_000),
    }),
  });
  expect(failure.status).toBe(200);
  expect(environmentSetupStore(lab.store).job(failed.job.id)).toMatchObject({
    state: "failed",
    errorSummary: "x".repeat(4_096),
  });
  const sameFailure = await postTerminal({
    requestId: "envsetup_bounded_failure",
    name: "durable",
    declarationGenerationId: generation,
    ok: false,
    error: "x".repeat(10_000),
  });
  expect(sameFailure.status).toBe(200);
  expect(await sameFailure.json()).toEqual({ ok: true, duplicate: true });
  expect((await postTerminal({
    requestId: "envsetup_bounded_failure",
    name: "durable",
    declarationGenerationId: generation,
    ok: false,
    error: "different failure",
  })).status).toBe(409);
  expect((await postTerminal({
    ...successBody,
    requestId: "envsetup_bounded_failure",
    status: { ...status, setupRequestId: "envsetup_bounded_failure" },
  })).status).toBe(409);
  const legacyTerminal = environmentSetupStore(lab.store).requestJob({
    studyId: "s_setup",
    taskId: "t_setup",
    runtimeId: machineId,
    environmentName: "durable",
    language: "python",
    manager: "uv",
    lockRevision: 1,
    declarationGenerationId: generation,
    declarationCreatedTs: NOW,
    requestId: "envsetup_legacy_terminal_without_fingerprint",
    requestedBy: ownerId,
    requestedTs: NOW + 2,
    requestedPackages: ["scanpy"],
  });
  environmentSetupStore(lab.store).markReady(legacyTerminal.job.requestId, NOW + 3);
  expect(
    environmentSetupStore(lab.store).job(legacyTerminal.job.id)?.terminalOutcomeFingerprint,
  ).toBeUndefined();
  expect((await postTerminal({
    ...successBody,
    requestId: legacyTerminal.job.requestId,
    status: { ...status, setupRequestId: legacyTerminal.job.requestId },
  })).status).toBe(409);
  lab.store.run(
    `INSERT INTO kernel_env_setup_jobs
       (id, runtime_id, environment_name, language, manager, lock_revision,
        declaration_generation_id, declaration_created_ts, request_id, state, stage,
        requested_ts, started_ts, updated_ts, seq)
     VALUES ('job_legacy_active_result', ?, 'durable', 'python', 'uv', 1,
             NULL, ?, 'envsetup_legacy_active_result', 'building', 'installing',
             ?, ?, ?, ?)`,
    [machineId, NOW, NOW + 4, NOW + 4, NOW + 4, nextSeq(lab.store)],
  );
  const legacyActiveBody = {
    requestId: "envsetup_legacy_active_result",
    name: "durable",
    ok: true,
    status: {
      ...status,
      declarationGenerationId: undefined,
    },
  };
  expect((await postTerminal(legacyActiveBody)).status).toBe(200);
  expect(environmentSetupStore(lab.store).job("job_legacy_active_result")).toMatchObject({
    state: "failed",
    errorSummary: expect.stringMatching(/generation/i),
  });
  expect(
    environmentSetupStore(lab.store).job("job_legacy_active_result")?.terminalOutcomeFingerprint,
  ).toBeUndefined();
  expect((await postTerminal(legacyActiveBody)).status).toBe(409);
});

it("refuses a progress line with no name", async () => {
  const lab = await freshWireServer();
  servers.push(lab);
  const ownerCookie = await signUpOwner(lab.base);
  const ana = apiFor(lab.base, ownerCookie);
  const { token } = await pairMachine(lab.base, ana, "ana-macbook");

  const res = await fetch(`${lab.base}/daemon/kernel-env/progress`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestId: "envsetup_1", line: "Resolved 12 packages in 340ms" }),
  });

  expect(res.status).toBe(400);
  // Refused on its shape, before anything is written anywhere.
  expect(
    lab.store.all(`SELECT kind FROM change_log`).map(({ kind }) => kind as string),
  ).not.toContain("environment-setup-progress");
});
