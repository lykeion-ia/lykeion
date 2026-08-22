/**
 * The whole environment-setup feature, end to end, as one lifecycle.
 *
 * Tasks 1-7 were each proved at their own seam — the public contract, the
 * durable store, the coordinator, exactly-once continuation, the Research
 * soft default, the brokered permission, the calm bar. None of them proved
 * the seams BETWEEN those pieces, and the seams are where a durable,
 * server-owned asynchronous build actually lives: a Task blocked on an
 * environment has to survive the server restarting under it, a daemon
 * retrying its own POST, a colleague typing again, a Task deleted and an
 * environment removed — without ever resuming an agent twice, and without
 * leaving one queued on a build that will never finish.
 *
 * Everything below is driven the way the feature is actually reached: RPC
 * over HTTP as a signed-in browser reaches it, `/daemon/...` over HTTP as a
 * paired machine reaches it, and the run relay as a daemon's own command
 * stream sees it. Nothing here calls the coordinator directly — that is what
 * `environment-setup-coordinator.test.ts` is for, and a lifecycle test that
 * reached past the wire would skip the joins it exists to prove.
 */
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type {
  KernelEnvStatus,
  Language,
  LykeionApi,
  RunEventFrame,
  TaskEnvironmentSetup,
} from "@lykeion/api";
import {
  environmentLockfileFingerprint,
  environmentPackageFingerprint,
} from "@lykeion/api/environment-setup-evidence";
import { readConfig } from "./config";
import { openStore } from "./store/sqlite";
import { migrate } from "./store/migrations";
import { seedLabContent } from "./store/seed";
import { createChannel } from "./channel";
import { createRunRelay, type RunCommand } from "./run-relay";
import { createRevertRegistry } from "./run-revert";
import { createKernelListRegistry } from "./kernel-list-registry";
import { createTitleRegistry } from "./title-registry";
import { createPendingCells } from "./kernel-cells";
import { createEnvironmentSetupCoordinator } from "./environment-setup-coordinator";
import { createRequestListener, startServer } from "./http";
import { changeRecorder } from "./api/changes";
import { apiFor, signUpOwner } from "./test-support/server-api";
import type { Store } from "./store/store";

const NOW = 1_800_000_000;

/** The shape `TurnState`'s executing variant requires. No steps: what these
 *  cases are about is the frame sequence, never the plan inside it. */
const EMPTY_PLAN = { steps: [] };

const dirs: string[] = [];
const running: Harness[] = [];

afterEach(async () => {
  for (const harness of running.splice(0)) await harness.stopServerOnly();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  LABS.clear();
});

/**
 * A lab's durable identity, kept across a restart of its server the same way
 * the SQLite file keeps everything else. A browser's cookie and a machine's
 * bearer token both outlive the process that minted them, so a reopened
 * harness signs back in with the ones it already has rather than making a
 * second owner in a lab that already has one.
 */
interface LabIdentity {
  cookie: string;
  machineId: string;
  machineToken: string;
  machineName: string;
  researchId: string;
  /** Seconds. Carried across a restart so a reopened server never rewinds a
   *  clock the store has already written timestamps from. */
  clock: number;
  /** The exact terminal bodies this lab's machine has already POSTed, by
   *  environment name — so `postReady` twice replays the first one byte for
   *  byte, which is what a daemon retrying an unacknowledged POST sends and
   *  the only thing the duplicate path is allowed to accept. */
  results: Map<string, unknown>;
}

const LABS = new Map<string, LabIdentity>();

interface BlockedTask {
  taskId: string;
  /** The researcher's own turn that asked for work this environment blocks —
   *  ended, the way a real one is by the time the agent has said it needs an
   *  environment that is not there. */
  runId: string;
  sessionId: string;
  waiterId: string;
  environmentName: string;
}

interface Harness {
  /** Read directly for the durable facts the public contract does not
   *  project — a waiter's `cancelled_reason`, a turn's `ended_ts`. Everything
   *  the contract DOES project is asserted through `api`. */
  store: Store;
  api: LykeionApi;
  machineId: string;
  /** This lab's paired machine's own bearer token, for the one case that
   *  drives a real `startServer` and so has no relay to attach to. */
  machineToken: string;
  researchId: string;
  /** Every command this lab's machine has been handed on its command stream,
   *  in order. The relay is attached directly, the way `run-recovery.test.ts`
   *  attaches to it, so a command is captured in the same tick the request
   *  that produced it is handled and an assertion made after the `await`
   *  cannot race the delivery it is about. */
  commandsOfType(type: RunCommand["type"]): RunCommand[];
  continuationRuns(): RunCommand[];
  declareEnvironment(name: string, language?: Language, packages?: string[]): Promise<void>;
  /** `researchId` defaults to this lab's own; a test proving a sweep is
   *  scoped to one Research passes another. */
  blockOnEnvironment(
    name: string,
    language?: Language,
    researchId?: string,
  ): Promise<BlockedTask>;
  setupFor(taskId: string, name: string): Promise<TaskEnvironmentSetup | undefined>;
  postReady(name: string): Promise<Response>;
  postProgress(name: string, stage: string, line: string): Promise<Response>;
  postFailure(name: string, error: string): Promise<Response>;
  /** One machine report. `environments` absent is a machine that has not said
   *  what it holds — a silence, never an empty list. */
  report(environments?: KernelEnvStatus[]): Promise<Response>;
  postFrames(runId: string, frames: RunEventFrame[]): Promise<Response>;
  /** The next frame sequence this run's durable row will accept. */
  nextFrameSeq(runId: string): number;
  completeRun(runId: string): Promise<Response>;
  waiter(waiterId: string): Record<string, unknown> | undefined;
  turnRow(runId: string): Record<string, unknown> | undefined;
  /** Drops the machine's command stream, the way a daemon that stopped does.
   *  Commands enqueued afterwards are queued and delivered to nothing. */
  detachMachine(): void;
  /** Ends the HTTP server and closes this process's store handle, leaving the
   *  SQLite file and every durable identity intact — a lab whose server
   *  stopped, not a lab that was torn down. */
  stopServerOnly(): Promise<void>;
}

function freshDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-envsetup-e2e-"));
  dirs.push(dir);
  return dir;
}

function secretPair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/**
 * A lab on `dataDir`, served over loopback.
 *
 * The startup sequence is `startServer`'s own, in its order: open the store,
 * migrate, seed, build the channel and the relay, build the coordinator,
 * RECOVER (`http.ts:177`), and only then start serving. Assembled here rather
 * than by calling `startServer` because this file needs the relay itself — a
 * dispatched command has to be observable in the tick it was dispatched in
 * for "exactly one continuation" to be an assertion rather than a poll — and
 * `startServer` keeps both the store and the relay to itself.
 *
 * Called a second time on the same directory, this IS a server restart: the
 * store is the same file, the relay is a brand new process-local one holding
 * no commands and no beliefs, and everything the last process knew is gone.
 */
async function openHarness(dataDir: string): Promise<Harness> {
  const uiDir = join(dataDir, "ui");
  mkdirSync(uiDir, { recursive: true });
  const indexHtml = "<!doctype html><head></head><body></body>";
  writeFileSync(join(uiDir, "index.html"), indexHtml);

  const store = openStore(join(dataDir, "workspace.db"));
  migrate(store);
  seedLabContent(store);
  const channel = createChannel(store, 1000);
  const relay = createRunRelay();
  const openStreams = new Set<() => void>();

  const existing = LABS.get(dataDir);
  const clock = { value: existing?.clock ?? NOW };
  const now = () => clock.value;
  const config = { ...readConfig({}), host: "127.0.0.1", port: 0, dataDir, uiDir };
  const coordinator = createEnvironmentSetupCoordinator({ store, runs: relay, now });

  const startup = changeRecorder({ store, actorId: null, now, channel });
  coordinator.recover(startup.record);
  startup.flush();

  const listener = createRequestListener({
    store,
    config,
    secure: false,
    indexHtml,
    channel,
    openStreams,
    runs: relay,
    reverts: createRevertRegistry(),
    kernelLists: createKernelListRegistry(),
    titles: createTitleRegistry(),
    pendingCells: createPendingCells(),
    now,
    coordinator,
  });
  const server = createHttpServer(listener);
  const base = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });

  const identity = existing ?? (await bootstrapLab(base));
  LABS.set(dataDir, { ...identity, clock: clock.value });

  const api = apiFor(base, identity.cookie);
  const commands: RunCommand[] = [];
  let detach = relay.attach(identity.machineId, (_seq, command) => commands.push(command));

  const daemon = (path: string, body: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${identity.machineToken}`,
      },
      body: JSON.stringify(body),
    });

  /** The setup job this lab's machine holds for `name` — the active one when
   *  there is one, and otherwise the newest, so a post landing after the job
   *  has already settled still names the request that settled. */
  const jobFor = (name: string) =>
    store.get(
      `SELECT request_id, lock_revision, declaration_generation_id, declaration_created_ts,
              resolved_from, language, manager, state
         FROM kernel_env_setup_jobs
        WHERE environment_name = ? AND runtime_id = ?
        ORDER BY (state IN ('requested', 'building')) DESC, seq DESC
        LIMIT 1`,
      [name, identity.machineId],
    );

  const harness: Harness = {
    store,
    api,
    machineId: identity.machineId,
    machineToken: identity.machineToken,
    researchId: identity.researchId,

    commandsOfType(type) {
      return commands.filter((command) => command.type === type);
    },

    continuationRuns() {
      return commands.filter(
        (command) => command.type === "start-run" && command.continuation !== undefined,
      );
    },

    async declareEnvironment(name, language = "r", packages = ["meta"]) {
      if (store.get(`SELECT 1 FROM kernel_envs WHERE name = ?`, [name])) return;
      await api.kernelEnvCreate({ name, language, packages });
    },

    /**
     * A Task whose researcher asked for something the environment it needs
     * cannot run yet: a turn started, the machine filed the requirement while
     * that turn was still live (which `/daemon/kernel-env/require` requires),
     * and then the turn ended — the shape a real blocked Task has by the time
     * anybody looks at it.
     */
    async blockOnEnvironment(name, language = "r", researchId = identity.researchId) {
      await harness.declareEnvironment(name, language);
      const task = await api.createTask({
        researchId,
        stage: "background",
        title: `blocked on ${name}`,
      });
      const { runId } = await api.startRun({
        researchId,
        taskId: task.id,
        prompt: `use ${name}`,
        options: { planMode: false, agent: "claude" },
      });
      const sessionId = store.get(`SELECT session_id FROM turns WHERE id = ?`, [runId])!
        .session_id as string;
      const required = await daemon("/daemon/kernel-env/require", {
        runId,
        sessionId,
        environmentName: name,
      });
      if (!required.ok) throw new Error(`kernel-env/require answered ${required.status}`);
      const { waiterId } = (await required.json()) as { waiterId: string };
      const ended = await harness.completeRun(runId);
      if (!ended.ok) throw new Error(`source turn completion answered ${ended.status}`);
      return { taskId: task.id, runId, sessionId, waiterId, environmentName: name };
    },

    async setupFor(taskId, name) {
      const all = await api.taskEnvironmentSetups(taskId);
      return all.find((entry) => entry.job.environmentName === name);
    },

    async postProgress(name, stage, line) {
      const job = jobFor(name);
      if (!job) throw new Error(`no setup job for ${name}`);
      return daemon("/daemon/kernel-env/progress", {
        requestId: job.request_id,
        name,
        progress: { stage, line },
      });
    },

    async postFailure(name, error) {
      const job = jobFor(name);
      if (!job) throw new Error(`no setup job for ${name}`);
      return daemon("/daemon/kernel-env/result", {
        requestId: job.request_id as string,
        name,
        declarationGenerationId: job.declaration_generation_id as string,
        ok: false,
        error,
      });
    },

    /**
     * What a machine that has finished a build actually does: bind whatever
     * it resolved, then report the exact status its own completion marker
     * carries. A second call for the same environment replays the first body
     * byte for byte — a daemon retrying a POST it never saw acknowledged
     * sends the same bytes, and anything else would be a different claim
     * about a build that only happened once.
     */
    async postReady(name) {
      const replay = LABS.get(dataDir)!.results.get(name);
      if (replay !== undefined) return daemon("/daemon/kernel-env/result", replay);

      const job = jobFor(name);
      if (!job) throw new Error(`no setup job for ${name}`);
      const requestId = job.request_id as string;
      const declarationGenerationId = job.declaration_generation_id as string;
      const lockfile = `${name}==1.0.0\n`;

      if (job.resolved_from !== null) {
        const bound = await daemon("/daemon/kernel-env/lock", {
          requestId,
          name,
          lockfile,
          declarationGenerationId,
        });
        if (!bound.ok) throw new Error(`kernel-env/lock answered ${bound.status}`);
      }

      const status = readyStatusFor(store, jobFor(name)!, name);
      const body = { requestId, name, declarationGenerationId, ok: true as const, status };
      LABS.get(dataDir)!.results.set(name, body);
      return daemon("/daemon/kernel-env/result", body);
    },

    async report(environments) {
      return daemon("/daemon/report", {
        platform: "macos-aarch64",
        daemonVersion: "0.1.0",
        capabilities: [],
        clis: [
          {
            id: "claude",
            name: "Claude Code",
            command: "claude",
            version: "2.1.220",
            available: true,
            sessionReady: true,
          },
        ],
        ...(environments === undefined ? {} : { environments }),
      });
    },

    async postFrames(runId, frames) {
      return daemon("/daemon/run/events", { runId, frames });
    },

    nextFrameSeq(runId) {
      const row = store.get(`SELECT last_frame_seq FROM turns WHERE id = ?`, [runId]);
      return ((row?.last_frame_seq as number | undefined) ?? 0) + 1;
    },

    async completeRun(runId) {
      return harness.postFrames(runId, [
        {
          seq: harness.nextFrameSeq(runId),
          event: { event: "completed", state: { state: "completed" } },
        },
      ]);
    },

    waiter(waiterId) {
      return store.get(`SELECT * FROM task_env_setup_waiters WHERE id = ?`, [waiterId]);
    },

    turnRow(runId) {
      return store.get(`SELECT * FROM turns WHERE id = ?`, [runId]);
    },

    detachMachine() {
      detach();
      detach = () => {};
    },

    async stopServerOnly() {
      const at = running.indexOf(harness);
      if (at !== -1) running.splice(at, 1);
      LABS.set(dataDir, { ...LABS.get(dataDir)!, clock: clock.value });
      await new Promise<void>((resolve) => {
        for (const end of openStreams) end();
        server.close(() => {
          store.close();
          resolve();
        });
      });
    },
  };

  running.push(harness);
  return harness;
}

/** The exact status a machine's own completion marker carries for a build it
 *  finished — the same five pieces of evidence `kernelEnvironmentStatusAnswers`
 *  weighs, read off the durable job rather than guessed beside it. */
function readyStatusFor(
  store: Store,
  job: Record<string, unknown>,
  name: string,
): KernelEnvStatus {
  const lockRevision = job.lock_revision as number;
  const lock = store.get(
    `SELECT lockfile, requested_packages FROM kernel_env_locks WHERE name = ? AND revision = ?`,
    [name, lockRevision],
  );
  const completedPackages = JSON.parse(
    (job.resolved_from as string | null) ??
      ((lock?.requested_packages as string | undefined) ?? "[]"),
  ) as string[];
  return {
    state: "ready",
    name,
    language: job.language as Language,
    manager: job.manager as KernelEnvStatus["manager"],
    platform: "macos-aarch64",
    root: `/tmp/envs/${name}`,
    lockRevision,
    setupRequestId: job.request_id as string,
    lockfileFingerprint: environmentLockfileFingerprint((lock?.lockfile as string | undefined) ?? ""),
    packageFingerprint: environmentPackageFingerprint(completedPackages),
    declarationGenerationId: job.declaration_generation_id as string,
    ...(job.declaration_created_ts === null
      ? {}
      : { declarationCreatedTs: job.declaration_created_ts as number }),
  };
}

/** Signs up the owner, pairs one machine as this lab's and reports it as
 *  offering `claude`, and files the Research every Task below belongs to. */
async function bootstrapLab(base: string): Promise<LabIdentity> {
  const cookie = await signUpOwner(base);
  const api = apiFor(base, cookie);

  const machineName = "ana-macbook";
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
  const { token, runtimeId } = (await exchanged.json()) as { token: string; runtimeId: string };
  const reported = await fetch(`${base}/daemon/report`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      platform: "macos-aarch64",
      daemonVersion: "0.1.0",
      capabilities: [],
      clis: [
        {
          id: "claude",
          name: "Claude Code",
          command: "claude",
          version: "2.1.220",
          available: true,
          sessionReady: true,
        },
      ],
    }),
  });
  if (!reported.ok) throw new Error(`machine report answered ${reported.status}`);

  const research = await api.createResearch({ key: "MET", title: "Meta-analysis" });
  return {
    cookie,
    machineId: runtimeId,
    machineToken: token,
    machineName,
    researchId: research.id,
    clock: NOW,
    results: new Map(),
  };
}

// ---------------------------------------------------------------------------
// The lifecycle
// ---------------------------------------------------------------------------

it("survives a server restart and resumes one blocked Task once", async () => {
  const sqlitePath = freshDataDir();
  const first = await openHarness(sqlitePath);
  const blocked = await first.blockOnEnvironment("meta-analysis-r");
  await first.api.requestKernelEnvironmentSetup({
    taskId: blocked.taskId,
    machineId: first.machineId,
    environmentName: "meta-analysis-r",
    sourceRunId: blocked.runId,
  });
  await first.stopServerOnly();

  const second = await openHarness(sqlitePath);
  expect(second.commandsOfType("kernel-env-setup")).toHaveLength(1);
  await second.postReady("meta-analysis-r");
  await second.postReady("meta-analysis-r");

  // Before the continuation settles, because `getTask` is the SETTLED
  // transcript and would be equally empty if a second continuation were
  // running beside the first. What a browser holding this Task open sees is
  // one live system-origin run, carrying the exact waiter it continues.
  const live = await second.api.resumeRuns(blocked.taskId);
  expect(live.map((run) => run.snapshot.origin)).toEqual(["system"]);
  expect(live[0]!.snapshot.continuation).toMatchObject({
    kind: "environment-setup",
    waiterId: blocked.waiterId,
    sourceTurnId: blocked.runId,
    environmentName: "meta-analysis-r",
    machineId: second.machineId,
  });
  // `detach`, never `close`: closing an unfinished handle submits a cancel
  // decision for the run, and this test is about the continuation that is
  // supposed to go on running.
  for (const run of live) run.detach();
  // The agent actually starts working before the turn ends. Without this the
  // bare completion below would take `recordRunFrames`'s
  // pre-execution-cancellation branch, and the turn this test counts would be
  // one the product records as never having started — which is not what a
  // test called "resumes one blocked Task" should be counting.
  expect(
    (await second.postFrames(live[0]!.runId, [
      { seq: 1, event: { event: "state", state: { state: "planning" } } },
    ])).status,
  ).toBe(200);
  expect(second.waiter(blocked.waiterId)).toMatchObject({ state: "resumed" });
  await second.completeRun(live[0]!.runId);

  const turns = await second.api.getTask(blocked.taskId);
  expect(turns.turns.filter((turn) => turn.origin === "system")).toHaveLength(1);
  expect(second.commandsOfType("start-run").filter((c) => c.continuation)).toHaveLength(1);
});

it("gives two Tasks blocked on one build a continuation each", async () => {
  const harness = await openHarness(freshDataDir());
  const first = await harness.blockOnEnvironment("shared-r");
  const second = await harness.blockOnEnvironment("shared-r");

  const a = await harness.api.requestKernelEnvironmentSetup({
    taskId: first.taskId,
    machineId: harness.machineId,
    environmentName: "shared-r",
    sourceRunId: first.runId,
  });
  const b = await harness.api.requestKernelEnvironmentSetup({
    taskId: second.taskId,
    machineId: harness.machineId,
    environmentName: "shared-r",
    sourceRunId: second.runId,
  });

  // One build, joined — `(machineId, environmentName, lockRevision)` is the
  // identity, so the second ask does not start a second download.
  expect(b.jobId).toBe(a.jobId);
  expect(harness.commandsOfType("kernel-env-setup")).toHaveLength(1);

  expect((await harness.postReady("shared-r")).status).toBe(200);

  // Two continuations, one per Task — not one shared between them.
  const continuations = harness.continuationRuns();
  expect(continuations).toHaveLength(2);
  expect(new Set(continuations.map((c) => c.taskId))).toEqual(
    new Set([first.taskId, second.taskId]),
  );
  expect(continuations.map((c) => c.continuation!.waiterId).sort()).toEqual(
    [first.waiterId, second.waiterId].sort(),
  );
  expect((await harness.setupFor(first.taskId, "shared-r"))!.waiter!.state).toBe("queued");
  expect((await harness.setupFor(second.taskId, "shared-r"))!.waiter!.state).toBe("queued");
});

it("offers a default after a direct setup and continues nothing", async () => {
  const harness = await openHarness(freshDataDir());
  await harness.declareEnvironment("direct-r");
  const task = await harness.api.createTask({
    researchId: harness.researchId,
    stage: "background",
    title: "set it up from the bar",
  });

  // No `sourceRunId`: the Set up button, pressed by a researcher with nothing
  // blocked behind it. A continuation needs a waiter; a suggestion does not.
  await harness.api.requestKernelEnvironmentSetup({
    taskId: task.id,
    machineId: harness.machineId,
    environmentName: "direct-r",
  });
  expect((await harness.postReady("direct-r")).status).toBe(200);

  expect(harness.continuationRuns()).toEqual([]);
  const setup = (await harness.setupFor(task.id, "direct-r"))!;
  expect(setup.job.state).toBe("ready");
  expect(setup.waiter).toBeUndefined();
  expect(setup.suggestion).toMatchObject({
    state: "pending",
    language: "r",
    environmentName: "direct-r",
  });
});

it("takes a duplicate progress line and a duplicate result without acting twice", async () => {
  const harness = await openHarness(freshDataDir());
  const blocked = await harness.blockOnEnvironment("dupe-r");
  await harness.api.requestKernelEnvironmentSetup({
    taskId: blocked.taskId,
    machineId: harness.machineId,
    environmentName: "dupe-r",
    sourceRunId: blocked.runId,
  });

  expect((await harness.postProgress("dupe-r", "installing", "resolving deps")).status).toBe(200);
  expect((await harness.postProgress("dupe-r", "installing", "resolving deps")).status).toBe(200);
  const building = (await harness.setupFor(blocked.taskId, "dupe-r"))!;
  expect(building.job.state).toBe("building");
  expect(building.job.stage).toBe("installing");
  expect(building.job.log).toEqual(["resolving deps"]);

  expect(await (await harness.postReady("dupe-r")).json()).toEqual({ ok: true });
  expect(await (await harness.postReady("dupe-r")).json()).toEqual({ ok: true, duplicate: true });

  expect(harness.continuationRuns()).toHaveLength(1);
  expect(
    harness.store.all(`SELECT id FROM turns WHERE task_id = ? AND origin = 'system'`, [
      blocked.taskId,
    ]),
  ).toHaveLength(1);
  expect((await harness.setupFor(blocked.taskId, "dupe-r"))!.job.state).toBe("ready");
});

it("leaves a waiter waiting when the machine reports without saying what it holds", async () => {
  const harness = await openHarness(freshDataDir());
  const blocked = await harness.blockOnEnvironment("silent-r");
  await harness.api.requestKernelEnvironmentSetup({
    taskId: blocked.taskId,
    machineId: harness.machineId,
    environmentName: "silent-r",
    sourceRunId: blocked.runId,
  });

  // First the machine DOES say what it holds — it does not hold this one.
  const held: KernelEnvStatus = {
    state: "absent",
    name: "silent-r",
    language: "r",
    manager: "conda",
    platform: "macos-aarch64",
    root: "/tmp/envs/silent-r",
  };
  expect((await harness.report([held])).status).toBe(200);
  const reported = harness.store.get(`SELECT environments FROM runtimes WHERE id = ?`, [
    harness.machineId,
  ])!.environments as string;
  expect(JSON.parse(reported)).toEqual([held]);

  // Then it reports again saying nothing about environments at all. Absent is
  // not empty, and the difference is observable: the column is written
  // `COALESCE(?, environments)` (`routes/daemon-routes.ts`), so a silent
  // report KEEPS what the machine last said rather than erasing it. An empty
  // list would have replaced it with `[]`.
  expect((await harness.report()).status).toBe(200);
  expect(
    JSON.parse(harness.store.get(`SELECT environments FROM runtimes WHERE id = ?`, [
      harness.machineId,
    ])!.environments as string),
  ).toEqual([held]);

  // And silence is never a result either way: not a build that finished, and
  // not one that failed.
  const setup = (await harness.setupFor(blocked.taskId, "silent-r"))!;
  expect(setup.job.state).toBe("requested");
  expect(setup.waiter!.state).toBe("waiting");
  expect(harness.continuationRuns()).toEqual([]);
});

it("keeps an explicitly failed setup failed until Retry, and never on its own", async () => {
  const harness = await openHarness(freshDataDir());
  const blocked = await harness.blockOnEnvironment("broken-r");
  await harness.api.requestKernelEnvironmentSetup({
    taskId: blocked.taskId,
    machineId: harness.machineId,
    environmentName: "broken-r",
    sourceRunId: blocked.runId,
  });

  expect((await harness.postFailure("broken-r", "no candidate version for meta")).status).toBe(200);
  const failed = (await harness.setupFor(blocked.taskId, "broken-r"))!;
  expect(failed.job.state).toBe("failed");
  expect(failed.job.errorSummary).toContain("no candidate version");
  // Still waiting, not cancelled: the requirement stands, and Retry is what
  // the researcher is offered against it.
  expect(failed.waiter!.state).toBe("waiting");
  expect(harness.continuationRuns()).toEqual([]);

  // A report, a reconnect and a restart are all silence about this build. None
  // of them un-fails it, and none of them resumes the Task behind it.
  expect((await harness.report([])).status).toBe(200);
  expect((await harness.setupFor(blocked.taskId, "broken-r"))!.job.state).toBe("failed");
  expect(harness.continuationRuns()).toEqual([]);
});

it("retries under a new request id while the original waiter and source turn stand", async () => {
  const harness = await openHarness(freshDataDir());
  const blocked = await harness.blockOnEnvironment("retry-r");
  const first = await harness.api.requestKernelEnvironmentSetup({
    taskId: blocked.taskId,
    machineId: harness.machineId,
    environmentName: "retry-r",
    sourceRunId: blocked.runId,
  });
  await harness.postFailure("retry-r", "solver gave up");

  const retried = await harness.api.retryKernelEnvironmentSetup(blocked.waiterId);

  expect(retried.waiterId).toBe(blocked.waiterId);
  expect(retried.jobId).not.toBe(first.jobId);
  const asks = harness.commandsOfType("kernel-env-setup");
  expect(asks).toHaveLength(2);
  expect(asks[1]!.runId).not.toBe(asks[0]!.runId);

  const setups = await harness.api.taskEnvironmentSetups(blocked.taskId);
  const waiter = harness.waiter(blocked.waiterId)!;
  expect(waiter.state).toBe("waiting");
  // The requirement is the SAME one: same id, same source turn, moved onto
  // the replacement build rather than filed again.
  expect(waiter.source_turn_id).toBe(blocked.runId);
  expect(waiter.source_run_id).toBe(blocked.runId);
  expect(waiter.job_id).toBe(retried.jobId);
  // Both attempts are on the Task's own record: the failed original stands as
  // what happened, and the replacement is the one now running.
  expect(setups.map(({ job }) => [job.id, job.state])).toEqual([
    [first.jobId, "failed"],
    [retried.jobId, "requested"],
  ]);
});

it("cancels only the Task whose researcher typed again", async () => {
  const harness = await openHarness(freshDataDir());
  const mine = await harness.blockOnEnvironment("busy-r");
  const theirs = await harness.blockOnEnvironment("busy-r");
  for (const blocked of [mine, theirs])
    await harness.api.requestKernelEnvironmentSetup({
      taskId: blocked.taskId,
      machineId: harness.machineId,
      environmentName: "busy-r",
      sourceRunId: blocked.runId,
    });

  await harness.api.startRun({
    researchId: harness.researchId,
    taskId: mine.taskId,
    prompt: "never mind, do this instead",
    options: { planMode: false, agent: "claude" },
  });

  expect(harness.waiter(mine.waiterId)).toMatchObject({
    state: "cancelled",
    cancelled_reason: "superseded-by-user-turn",
  });
  expect(harness.waiter(theirs.waiterId)).toMatchObject({ state: "waiting" });

  // And the build still finishes for the Task that is still waiting on it —
  // one continuation, for the other Task.
  expect((await harness.postReady("busy-r")).status).toBe(200);
  expect(harness.continuationRuns().map((c) => c.taskId)).toEqual([theirs.taskId]);
});

it("keeps a waiter through archiving the Research it belongs to", async () => {
  const harness = await openHarness(freshDataDir());
  const blocked = await harness.blockOnEnvironment("filed-r");
  await harness.api.requestKernelEnvironmentSetup({
    taskId: blocked.taskId,
    machineId: harness.machineId,
    environmentName: "filed-r",
    sourceRunId: blocked.runId,
  });

  await harness.api.archiveResearch(harness.researchId);

  // Archiving is filing, not deleting. The build is still running on somebody's
  // machine and the Task is still blocked behind it.
  expect(harness.waiter(blocked.waiterId)).toMatchObject({ state: "waiting" });
  expect((await harness.postReady("filed-r")).status).toBe(200);
  expect(harness.continuationRuns().map((c) => c.taskId)).toEqual([blocked.taskId]);
  expect(harness.waiter(blocked.waiterId)).toMatchObject({ state: "queued" });
});

it("takes a deleted Task's waiter away and leaves its neighbour's alone", async () => {
  const harness = await openHarness(freshDataDir());
  const doomed = await harness.blockOnEnvironment("neighbour-r");
  const survivor = await harness.blockOnEnvironment("neighbour-r");
  for (const blocked of [doomed, survivor])
    await harness.api.requestKernelEnvironmentSetup({
      taskId: blocked.taskId,
      machineId: harness.machineId,
      environmentName: "neighbour-r",
      sourceRunId: blocked.runId,
    });

  await harness.api.deleteTask(doomed.taskId);

  expect(harness.waiter(doomed.waiterId)).toBeUndefined();
  expect(harness.waiter(survivor.waiterId)).toMatchObject({ state: "waiting" });

  // The build was never the deleted Task's alone, so it still finishes — and
  // resumes exactly the Task that is still there.
  expect((await harness.postReady("neighbour-r")).status).toBe(200);
  expect(harness.continuationRuns().map((c) => c.taskId)).toEqual([survivor.taskId]);
});

it("ends a deleted Task's already-running continuation and recalls it", async () => {
  // Scenario 9's dangerous half. The neighbour case above deletes a Task whose
  // waiter is still `waiting` — nothing has been dispatched, so a cascade is
  // enough. This one deletes a Task whose build has ALREADY settled: the
  // waiter is `queued`, it owns a durable system-origin turn, and that turn's
  // `start-run` is on a machine right now.
  const harness = await openHarness(freshDataDir());
  const doomed = await harness.blockOnEnvironment("orphan-r");
  const survivor = await harness.blockOnEnvironment("orphan-r");
  for (const blocked of [doomed, survivor])
    await harness.api.requestKernelEnvironmentSetup({
      taskId: blocked.taskId,
      machineId: harness.machineId,
      environmentName: "orphan-r",
      sourceRunId: blocked.runId,
    });
  expect((await harness.postReady("orphan-r")).status).toBe(200);

  const doomedRun = harness.continuationRuns().find((c) => c.taskId === doomed.taskId)!.runId;
  const survivorRun = harness.continuationRuns().find((c) => c.taskId === survivor.taskId)!.runId;
  expect(harness.waiter(doomed.waiterId)).toMatchObject({ state: "queued" });

  await harness.api.deleteTask(doomed.taskId);

  // The requirement goes with the Task, as before.
  expect(harness.waiter(doomed.waiterId)).toBeUndefined();
  // And so does the run it started: a turn left open for a Task that no longer
  // exists is an agent working on nothing, on somebody's laptop, with nothing
  // left in this lab that could ever settle it.
  expect(harness.turnRow(doomedRun)).toMatchObject({ status: "cancelled" });
  expect(harness.commandsOfType("cancel").map((command) => command.runId)).toEqual([doomedRun]);

  // The neighbour is untouched: same waiter, same turn, still going.
  expect(harness.waiter(survivor.waiterId)).toMatchObject({ state: "queued" });
  expect(harness.turnRow(survivorRun)).toMatchObject({ ended_ts: null });
});

it("ends a deleted Research's already-running continuations and recalls them", async () => {
  // The door beside the archive above, and this one is not filing. The rows
  // all cascade off `studies` — Tasks, waiters, interests — so the row side
  // of this needs nothing. The turn side needs everything: neither `turns`
  // nor `sessions` carries a foreign key to `studies`, so a `queued` waiter's
  // system-origin continuation survives the Research it belongs to with its
  // `start-run` already on a machine, and the agent goes on working — writing
  // into the workspace — for a Research this lab no longer has.
  const harness = await openHarness(freshDataDir());
  const other = await harness.api.createResearch({ key: "KEPT", title: "Another line of work" });
  const doomedFirst = await harness.blockOnEnvironment("shared-r");
  const doomedSecond = await harness.blockOnEnvironment("shared-r");
  const survivor = await harness.blockOnEnvironment("shared-r", "r", other.id);
  for (const blocked of [doomedFirst, doomedSecond, survivor])
    await harness.api.requestKernelEnvironmentSetup({
      taskId: blocked.taskId,
      machineId: harness.machineId,
      environmentName: "shared-r",
      sourceRunId: blocked.runId,
    });
  expect((await harness.postReady("shared-r")).status).toBe(200);

  const runOf = (taskId: string) =>
    harness.continuationRuns().find((c) => c.taskId === taskId)!.runId;
  const doomedRuns = [runOf(doomedFirst.taskId), runOf(doomedSecond.taskId)];
  const survivorRun = runOf(survivor.taskId);
  for (const blocked of [doomedFirst, doomedSecond, survivor])
    expect(harness.waiter(blocked.waiterId)).toMatchObject({ state: "queued" });

  await harness.api.deleteResearch(harness.researchId);

  // The requirements go with the Research, on the cascade alone.
  expect(harness.waiter(doomedFirst.waiterId)).toBeUndefined();
  expect(harness.waiter(doomedSecond.waiterId)).toBeUndefined();
  // The runs they started do not, unless somebody ends them and says so:
  // every one of them, and each recalled exactly once.
  for (const runId of doomedRuns)
    expect(harness.turnRow(runId)).toMatchObject({ status: "cancelled" });
  expect(harness.commandsOfType("cancel").map((command) => command.runId).sort()).toEqual(
    [...doomedRuns].sort(),
  );

  // And the other Research is untouched: same waiter, same turn, still going.
  expect(harness.waiter(survivor.waiterId)).toMatchObject({ state: "queued" });
  expect(harness.turnRow(survivorRun)).toMatchObject({ ended_ts: null });
});

it("cancels every waiter on a deleted environment and clears what it defaulted", async () => {
  const harness = await openHarness(freshDataDir());
  const queued = await harness.blockOnEnvironment("doomed-r");
  const stillWaiting = await harness.blockOnEnvironment("doomed-r");
  await harness.api.requestKernelEnvironmentSetup({
    taskId: queued.taskId,
    machineId: harness.machineId,
    environmentName: "doomed-r",
    sourceRunId: queued.runId,
  });

  // A second Research joining the same build before it settles, so this ready
  // transition raises a question in TWO Researches — one that gets answered
  // below and one that is left outstanding. The delete has to sweep both, and
  // a test with only an answered one could not tell.
  const other = await harness.api.createResearch({ key: "OTH", title: "Other work" });
  const otherTask = await harness.api.createTask({
    researchId: other.id,
    stage: "background",
    title: "also wants doomed-r",
  });
  await harness.api.requestKernelEnvironmentSetup({
    taskId: otherTask.id,
    machineId: harness.machineId,
    environmentName: "doomed-r",
  });

  await harness.postReady("doomed-r");
  const continuationRunId = harness.continuationRuns()[0]!.runId;

  // A second Task blocked on the same name. The first build has already
  // settled, so this ask starts a fresh one and this waiter is still plain
  // `waiting` while the first is `queued` behind its continuation — the two
  // states the deletion has to reach, and they are reached differently.
  await harness.api.requestKernelEnvironmentSetup({
    taskId: stillWaiting.taskId,
    machineId: harness.machineId,
    environmentName: "doomed-r",
    sourceRunId: stillWaiting.runId,
  });
  expect(harness.waiter(stillWaiting.waiterId)).toMatchObject({ state: "waiting" });

  const suggestion = (await harness.setupFor(queued.taskId, "doomed-r"))!.suggestion!;
  await harness.api.answerEnvironmentDefaultSuggestion(suggestion.id, true);
  expect(
    (await harness.api.getResearch(harness.researchId)).research.environmentDefaults,
  ).toHaveLength(1);

  // The other Research's question is still outstanding when the delete lands.
  const pending = (await harness.setupFor(otherTask.id, "doomed-r"))!.suggestion!;
  expect(pending.state).toBe("pending");

  await harness.api.kernelEnvDelete("doomed-r");

  // Both waiters cancelled, and named as cancelled by the deletion rather than
  // left standing on a build this lab can no longer plan at all — once the
  // declaration is gone nothing will ever ask for that build again, so a
  // waiter left alone is a Task blocked forever.
  expect(harness.waiter(queued.waiterId)).toMatchObject({
    state: "cancelled",
    cancelled_reason: "environment-deleted",
  });
  expect(harness.waiter(stillWaiting.waiterId)).toMatchObject({
    state: "cancelled",
    cancelled_reason: "environment-deleted",
  });
  // The continuation that was already dispatched is ended and recalled, not
  // left going with nothing left to settle it.
  expect(harness.turnRow(continuationRunId)).toMatchObject({ status: "cancelled" });
  expect(harness.commandsOfType("cancel").map((command) => command.runId)).toEqual([
    continuationRunId,
  ]);
  // And nothing goes on naming it: neither the confirmed default nor the
  // question that would have written one.
  expect(
    (await harness.api.getResearch(harness.researchId)).research.environmentDefaults,
  ).toEqual([]);
  expect(
    harness.store.get(`SELECT state FROM environment_default_suggestions WHERE id = ?`, [
      pending.id,
    ]),
  ).toBeUndefined();
  // Pending ONLY. An answered question is a record of what somebody was asked
  // and what they said, and deleting an environment does not un-ask it.
  expect(
    harness.store.get(`SELECT state FROM environment_default_suggestions WHERE id = ?`, [
      suggestion.id,
    ]),
  ).toEqual({ state: "accepted" });
});

it("leaves a Research default standing when a machine reclaims its own copy", async () => {
  const harness = await openHarness(freshDataDir());
  await harness.declareEnvironment("kept-r");
  const task = await harness.api.createTask({
    researchId: harness.researchId,
    stage: "background",
    title: "keep the default",
  });
  await harness.api.requestKernelEnvironmentSetup({
    taskId: task.id,
    machineId: harness.machineId,
    environmentName: "kept-r",
  });
  await harness.postReady("kept-r");
  const suggestion = (await harness.setupFor(task.id, "kept-r"))!.suggestion!;
  await harness.api.answerEnvironmentDefaultSuggestion(suggestion.id, true);

  await harness.api.kernelEnvReclaim(harness.machineId, "kept-r");

  // The gigabytes go; the declaration stands, so the default still names
  // something this lab has and the next build makes it reachable again.
  expect((await harness.api.getResearch(harness.researchId)).research.environmentDefaults).toEqual([
    expect.objectContaining({ language: "r", environmentName: "kept-r" }),
  ]);
  expect(await harness.api.kernelEnvList()).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "kept-r" })]),
  );
  expect(harness.commandsOfType("kernel-env-reclaim")).toHaveLength(1);
});

it("leaves a continuation queued for recovery when the machine is not there to take it", async () => {
  const sqlitePath = freshDataDir();
  const first = await openHarness(sqlitePath);
  const blocked = await first.blockOnEnvironment("offline-r");
  await first.api.requestKernelEnvironmentSetup({
    taskId: blocked.taskId,
    machineId: first.machineId,
    environmentName: "offline-r",
    sourceRunId: blocked.runId,
  });

  // The daemon's command stream drops between the build finishing and the
  // continuation being handed over. Nothing took the `start-run`.
  first.detachMachine();
  expect((await first.postReady("offline-r")).status).toBe(200);
  expect(first.continuationRuns()).toEqual([]);
  const waiter = first.waiter(blocked.waiterId)!;
  expect(waiter.state).toBe("queued");
  const continuationRunId = waiter.continuation_turn_id as string;

  await first.stopServerOnly();
  const second = await openHarness(sqlitePath);

  // Recovery hands over the SAME run id — the daemon deduplicates a repeat of
  // a run it already started, and a fresh id would be a second turn.
  const recovered = second.continuationRuns();
  expect(recovered).toHaveLength(1);
  expect(recovered[0]!.runId).toBe(continuationRunId);
  expect(second.waiter(blocked.waiterId)).toMatchObject({
    state: "queued",
    continuation_turn_id: continuationRunId,
  });
  expect(
    second.store.all(`SELECT id FROM turns WHERE task_id = ? AND origin = 'system'`, [
      blocked.taskId,
    ]),
  ).toHaveLength(1);
});

it("marks the waiter resumed on the continuation's first accepted run frame", async () => {
  const harness = await openHarness(freshDataDir());
  const blocked = await harness.blockOnEnvironment("resume-r");
  await harness.api.requestKernelEnvironmentSetup({
    taskId: blocked.taskId,
    machineId: harness.machineId,
    environmentName: "resume-r",
    sourceRunId: blocked.runId,
  });
  await harness.postReady("resume-r");
  const continuationRunId = harness.continuationRuns()[0]!.runId;

  // Queue position is not evidence that an agent ran anything.
  expect(
    (await harness.postFrames(continuationRunId, [
      { seq: 1, event: { event: "state", state: { state: "queued", ahead: 0 } } },
    ])).status,
  ).toBe(200);
  expect(harness.waiter(blocked.waiterId)).toMatchObject({ state: "queued" });

  // The first frame that IS evidence — the agent planning — is what resumes it.
  expect(
    (await harness.postFrames(continuationRunId, [
      { seq: 2, event: { event: "state", state: { state: "planning" } } },
    ])).status,
  ).toBe(200);
  expect(harness.waiter(blocked.waiterId)).toMatchObject({ state: "resumed" });
  expect((await harness.setupFor(blocked.taskId, "resume-r"))!.waiter!.state).toBe("resumed");
});

// ---------------------------------------------------------------------------
// Step 4: the continuation is an ordinary run, held to the ordinary rules
// ---------------------------------------------------------------------------

it("folds a retried continuation frame batch exactly once", async () => {
  const harness = await openHarness(freshDataDir());
  const blocked = await harness.blockOnEnvironment("frames-r");
  await harness.api.requestKernelEnvironmentSetup({
    taskId: blocked.taskId,
    machineId: harness.machineId,
    environmentName: "frames-r",
    sourceRunId: blocked.runId,
  });
  await harness.postReady("frames-r");
  const runId = harness.continuationRuns()[0]!.runId;

  const batch: RunEventFrame[] = [
    { seq: 1, event: { event: "state", state: { state: "executing", plan: EMPTY_PLAN } } },
    { seq: 2, event: { event: "assistant-text", text: "Picking the work back up.", partial: false } },
  ];
  expect((await harness.postFrames(runId, batch)).status).toBe(200);
  // The same batch again, verbatim: an unacknowledged POST a daemon retries.
  expect((await harness.postFrames(runId, batch)).status).toBe(200);

  expect(harness.turnRow(runId)).toMatchObject({ last_frame_seq: 2 });
  await harness.completeRun(runId);
  const turn = (await harness.api.getTask(blocked.taskId)).turns.find((t) => t.runId === runId)!;
  expect(turn.origin).toBe("system");
  expect(turn.stream).toEqual([
    { kind: "text", text: "Picking the work back up.", block: "interim" },
  ]);
});

it("rebuilds the system-origin continuation from its snapshot after a restart", async () => {
  const sqlitePath = freshDataDir();
  const first = await openHarness(sqlitePath);
  const blocked = await first.blockOnEnvironment("snap-r");
  await first.api.requestKernelEnvironmentSetup({
    taskId: blocked.taskId,
    machineId: first.machineId,
    environmentName: "snap-r",
    sourceRunId: blocked.runId,
  });
  await first.postReady("snap-r");
  const runId = first.continuationRuns()[0]!.runId;
  await first.postFrames(runId, [
    {
      seq: 1,
      event: {
        event: "snapshot",
        snapshot: {
          runId,
          sequence: 1,
          origin: "system",
          prompt: "continue",
          agent: "claude",
          state: { state: "executing", plan: EMPTY_PLAN },
          stream: [{ kind: "text", text: "Back on it." }],
          live: {},
          reviewing: false,
          lastEventSeq: 1,
        },
      },
    },
  ]);

  await first.stopServerOnly();
  const second = await openHarness(sqlitePath);

  const [resumed] = await second.api.resumeRuns(blocked.taskId);
  expect(resumed).toBeDefined();
  expect(resumed!.snapshot.origin).toBe("system");
  expect(resumed!.snapshot.continuation).toMatchObject({
    kind: "environment-setup",
    waiterId: blocked.waiterId,
  });
  expect(resumed!.snapshot.state).toEqual({ state: "executing", plan: EMPTY_PLAN });
  expect(resumed!.snapshot.stream).toEqual([{ kind: "text", text: "Back on it." }]);
  resumed!.detach();
});

it("does not double a continuation's prose when a compatibility whole-frame lands", async () => {
  const harness = await openHarness(freshDataDir());
  const blocked = await harness.blockOnEnvironment("whole-r");
  await harness.api.requestKernelEnvironmentSetup({
    taskId: blocked.taskId,
    machineId: harness.machineId,
    environmentName: "whole-r",
    sourceRunId: blocked.runId,
  });
  await harness.postReady("whole-r");
  const runId = harness.continuationRuns()[0]!.runId;

  await harness.postFrames(runId, [
    { seq: 1, event: { event: "assistant-text", text: "Resu", partial: true } },
    { seq: 2, event: { event: "assistant-text", text: "med.", partial: true } },
    // An older daemon repeats the whole block once it is finished.
    { seq: 3, event: { event: "assistant-text", text: "Resumed.", partial: false } },
  ]);
  await harness.completeRun(runId);

  const turn = (await harness.api.getTask(blocked.taskId)).turns.find((t) => t.runId === runId)!;
  expect(turn.stream).toEqual([{ kind: "text", text: "Resumed.", block: "interim" }]);
  expect(turn.messages).toEqual(["Resumed."]);
});

/**
 * Reads whole `{ seq, command }` blocks off `/daemon/commands` until `count`
 * have arrived, then aborts the connection — the same framing the daemon's own
 * `openCommands` uses, and the same helper shape `api/sessions.test.ts` reads
 * that route with. Blocking on a count rather than polling a clock, so this is
 * deterministic: the assertion is "these commands arrive", never "they arrive
 * within N milliseconds".
 */
async function readCommands(
  base: string,
  token: string,
  count: number,
  deadlineMs = 2_000,
): Promise<RunCommand[]> {
  const controller = new AbortController();
  // A deadline, so a server that sends NOTHING fails this case with what it
  // did send rather than hanging until the runner gives up. It is not a
  // timing assumption: a recovered command is handed to `attach` inside the
  // request that opens this stream, so it is in the first chunk or it is
  // never coming.
  const deadline = setTimeout(() => controller.abort(), deadlineMs);
  const res = await fetch(`${base}/daemon/commands`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const out: RunCommand[] = [];
  try {
    while (out.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let cut = buffered.indexOf("\n\n");
      while (cut !== -1) {
        const block = buffered.slice(0, cut);
        buffered = buffered.slice(cut + 2);
        const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
        if (dataLine)
          out.push((JSON.parse(dataLine.slice(5).trim()) as { command: RunCommand }).command);
        cut = buffered.indexOf("\n\n");
      }
    }
  } catch {
    // The deadline aborted the read. Whatever arrived is the answer.
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
  return out;
}

it("asks for a pending build again when the real server boots on the same lab", async () => {
  // The harness above proves the MECHANISM of recovery — a genuinely new relay,
  // a reopened SQLite file, the same durable request asked for once. It cannot
  // prove the WIRING, because it calls `coordinator.recover` itself, exactly as
  // `startServer` does. Delete that call from `http.ts` and every other case in
  // this file still passes while every blocked Task in a real lab quietly stops
  // resuming after a restart.
  //
  // So this one case boots the real `startServer` on the same data directory
  // and reads the machine's own command stream over the wire. Nothing here is
  // assembled by hand.
  const sqlitePath = freshDataDir();
  const first = await openHarness(sqlitePath);
  const blocked = await first.blockOnEnvironment("boot-r");
  await first.api.requestKernelEnvironmentSetup({
    taskId: blocked.taskId,
    machineId: first.machineId,
    environmentName: "boot-r",
    sourceRunId: blocked.runId,
  });
  const requestId = first.store.get(
    `SELECT request_id FROM kernel_env_setup_jobs WHERE environment_name = 'boot-r'`,
  )!.request_id as string;
  const token = first.machineToken;
  await first.stopServerOnly();

  const booted = await startServer({
    ...readConfig({}),
    host: "127.0.0.1",
    port: 0,
    dataDir: sqlitePath,
    uiDir: join(sqlitePath, "ui"),
  });
  try {
    const commands = await readCommands(`http://127.0.0.1:${booted.port}`, token, 1);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "kernel-env-setup",
      runId: requestId,
      name: "boot-r",
    });
  } finally {
    await booted.close();
  }
});
