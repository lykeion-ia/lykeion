import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { LykeionApi, RunEventFrame } from "@lykeion/api";
import { readConfig } from "./config";
import { openStore } from "./store/sqlite";
import { migrate } from "./store/migrations";
import { createChannel } from "./channel";
import { createRunRelay, type RunCommand, type RunRelay } from "./run-relay";
import { createRequestListener } from "./http";
import { apiFor, signUpOwner } from "./test-support/server-api";
import type { Store } from "./store/store";
import { failDroppedRuns } from "./run-recovery";
import { createRevertRegistry } from "./run-revert";
import { createKernelListRegistry } from "./kernel-list-registry";
import { createTitleRegistry } from "./title-registry";
import { createPendingCells } from "./kernel-cells";
import { createEnvSetupRegistry } from "./env-setup-registry";

/**
 * A machine that restarts, or simply drops its command-stream connection and
 * reconnects, does not carry its in-flight runs across that gap by itself —
 * it tells the lab which run ids it still holds, and `/daemon/run/live`'s job
 * is to fail whatever the lab believed was live but the machine no longer
 * names. This is that route driven the way a real daemon drives it: over the
 * wire, with a real store behind it, so what is asserted is what `turns` and
 * `runHistory` actually say, not what an in-memory relay merely believes.
 */
const dirs: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface RawServer {
  base: string;
  dataDir: string;
  store: Store;
  relay: RunRelay;
  close(): Promise<void>;
}

function freshLabServer(existingDir?: string): Promise<RawServer> {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), "lykeion-recovery-"));
  if (existingDir === undefined) dirs.push(dir);
  const uiDir = join(dir, "ui");
  mkdirSync(uiDir, { recursive: true });
  const indexHtml = "<!doctype html><head></head><body></body>";
  writeFileSync(join(uiDir, "index.html"), indexHtml);

  const store = openStore(join(dir, "workspace.db"));
  migrate(store);
  const channel = createChannel(store, 1000);
  const relay = createRunRelay();
  const openStreams = new Set<() => void>();
  const config = { ...readConfig({}), host: "127.0.0.1", port: 0, dataDir: dir, uiDir };

  const listener = createRequestListener({
    store, config, secure: false, indexHtml, channel, openStreams, runs: relay,
    reverts: createRevertRegistry(), kernelLists: createKernelListRegistry(), titles: createTitleRegistry(), pendingCells: createPendingCells(), envSetups: createEnvSetupRegistry(),
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
        dataDir: dir,
        store,
        relay,
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

async function pairClaudeMachine(
  base: string,
  ownerApi: LykeionApi,
  machineName: string,
): Promise<{ machineId: string; token: string }> {
  const { verifier, challenge } = secretPair();
  const { code } = await ownerApi.pairMachine({
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
  const { token, runtimeId: machineId } = (await exchanged.json()) as {
    token: string;
    /** The key this response actually carries. The daemon parses it, so it
     *  is the one name the runtimes → machines rename had to leave alone. */
    runtimeId: string;
  };
  await fetch(`${base}/daemon/report`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      platform: "macos-aarch64",
      daemonVersion: "0.1.0",
      capabilities: [],
      clis: [{ id: "claude", name: "Claude Code", command: "claude", version: "2.1.220", available: true }],
    }),
  });
  return { machineId, token };
}

interface RecoveryLab {
  base: string;
  dataDir: string;
  store: Store;
  relay: RunRelay;
  ownerApi: LykeionApi;
  machineId: string;
  machineName: string;
  token: string;
  taskId: string;
  runId: string;
}

/** A lab with an owner, a machine paired and reported as offering `claude`,
 *  a Study and a Task, and a turn already started on that machine — what
 *  every test below needs before it can reconcile the machine's own list of
 *  what it still holds. Its command stream is attached before the run ever
 *  starts, the way a real daemon's already is by the time a researcher
 *  starts one — a run only counts as live once its `start-run` has actually
 *  been handed to a connected daemon, and every test here is exercising
 *  what happens to a run that genuinely was. */
async function labWithRunInFlight(): Promise<RecoveryLab> {
  const server = await freshLabServer();
  servers.push(server);

  const ownerCookie = await signUpOwner(server.base);
  const ownerApi = apiFor(server.base, ownerCookie);

  const machineName = "ana-macbook";
  const { machineId, token } = await pairClaudeMachine(server.base, ownerApi, machineName);
  server.relay.attach(machineId, () => {});

  const study = await ownerApi.createStudy({ key: "CMP", title: "Comparative" });
  const task = await ownerApi.createTask({ studyId: study.id, stage: "background", title: "run me" });

  const { runId } = await ownerApi.startRun({
    studyId: study.id, taskId: task.id, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });

  return {
    base: server.base,
    dataDir: server.dataDir,
    store: server.store,
    relay: server.relay,
    ownerApi,
    machineId,
    machineName,
    token,
    taskId: task.id,
    runId,
  };
}

async function postLive(
  lab: RecoveryLab,
  runIds: string[],
  token = lab.token,
  commandCursor = 1,
): Promise<Response> {
  return fetch(`${lab.base}/daemon/run/live`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      runIds,
      generation: lab.relay.generation,
      commandCursor,
    }),
  });
}

it("fails nothing when a command stream reconnects with its runs intact", async () => {
  const lab = await labWithRunInFlight();
  const res = await postLive(lab, [lab.runId]);
  expect(res.status).toBe(200);
  expect(lab.store.get(`SELECT status FROM turns WHERE id = ?`, [lab.runId])?.status).toBe("running");
  expect(lab.relay.liveFor(lab.machineId)).toEqual([lab.runId]);
});

it("does not fail a start command written to a dropped stream before the daemon acknowledged it", async () => {
  const lab = await labWithRunInFlight();
  const res = await postLive(lab, [], lab.token, 0);
  expect(res.status).toBe(200);
  expect(lab.store.get(`SELECT status FROM turns WHERE id = ?`, [lab.runId])?.status).toBe("running");
});

it("fails a delivered run when a restarted daemon has no matching generation or cursor", async () => {
  const lab = await labWithRunInFlight();
  const res = await fetch(`${lab.base}/daemon/run/live`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${lab.token}`,
    },
    // A new daemon process has no in-memory relay generation or command
    // cursor. The surviving server relay already knows this start was
    // delivered, so treating the missing cursor as an acknowledged zero
    // would protect and then replay provider work the old daemon lost.
    body: JSON.stringify({ runIds: [] }),
  });

  expect(res.status).toBe(200);
  expect(lab.store.get(
    `SELECT status, ended_ts FROM turns WHERE id = ?`,
    [lab.runId],
  )).toMatchObject({ status: "failed", ended_ts: expect.any(Number) });
  const replayed: RunCommand[] = [];
  lab.relay.attach(lab.machineId, (_seq, command) => replayed.push(command));
  expect(replayed).toEqual([]);
});

it("fails a run the machine no longer holds after a restart, and runHistory reports it", async () => {
  const lab = await labWithRunInFlight();
  const res = await postLive(lab, []);
  expect(res.status).toBe(200);

  const turn = lab.store.get(`SELECT status, ended_ts FROM turns WHERE id = ?`, [lab.runId])!;
  expect(turn.status).toBe("failed");
  expect(turn.ended_ts).not.toBeNull();
  expect(lab.relay.liveFor(lab.machineId)).toEqual([]);

  const history = await lab.ownerApi.runHistory(lab.taskId);
  expect(history.find((h) => h.runId === lab.runId)?.status).toBe("failed");
});

it("fails a durable active run missing after both the daemon and server relay restart", async () => {
  const lab = await labWithRunInFlight();

  const original = servers.pop()!;
  await original.close();
  const rebuilt = await freshLabServer(lab.dataDir);
  servers.push(rebuilt);
  const rebuiltLab: RecoveryLab = {
    ...lab,
    base: rebuilt.base,
    store: rebuilt.store,
    relay: rebuilt.relay,
  };

  const res = await postLive(rebuiltLab, []);
  expect(res.status).toBe(200);
  expect(rebuilt.store.get(
    `SELECT status, ended_ts FROM turns WHERE id = ?`,
    [lab.runId],
  )).toMatchObject({ status: "failed", ended_ts: expect.any(Number) });
  expect(rebuilt.relay.liveFor(lab.machineId)).toEqual([]);
});

it("seeds a rebuilt relay from a retained durable active run in the daemon report", async () => {
  const lab = await labWithRunInFlight();

  const original = servers.pop()!;
  await original.close();
  const rebuilt = await freshLabServer(lab.dataDir);
  servers.push(rebuilt);
  const rebuiltLab: RecoveryLab = {
    ...lab,
    base: rebuilt.base,
    store: rebuilt.store,
    relay: rebuilt.relay,
  };

  const res = await postLive(rebuiltLab, [lab.runId]);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, generation: rebuilt.relay.generation });
  expect(rebuilt.relay.generation).not.toBe(lab.relay.generation);
  expect(rebuilt.store.get(`SELECT status FROM turns WHERE id = ?`, [lab.runId])?.status).toBe("running");
  expect(rebuilt.relay.liveFor(lab.machineId)).toEqual([lab.runId]);
});

it("does not seed a rebuilt relay with a terminal run the daemon reports stale", async () => {
  const lab = await labWithRunInFlight();
  const completed = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({
      runId: lab.runId,
      frames: [{ seq: 1, event: { event: "completed", state: { state: "completed" } } }],
    }),
  });
  expect(completed.status).toBe(200);

  const original = servers.pop()!;
  await original.close();
  const rebuilt = await freshLabServer(lab.dataDir);
  servers.push(rebuilt);
  const rebuiltLab: RecoveryLab = {
    ...lab,
    base: rebuilt.base,
    store: rebuilt.store,
    relay: rebuilt.relay,
  };

  const res = await postLive(rebuiltLab, [lab.runId]);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({
    ok: true,
    generation: rebuilt.relay.generation,
    retireRunIds: [lab.runId],
  });
  expect(rebuilt.store.get(`SELECT status FROM turns WHERE id = ?`, [lab.runId])?.status).toBe("ok");
  expect(rebuilt.relay.liveFor(lab.machineId)).toEqual([]);
});

it("continues the durable frame sequence when a rebuilt relay fails a dropped run", async () => {
  const lab = await labWithRunInFlight();
  const posted = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({
      runId: lab.runId,
      frames: [{ seq: 1, event: { event: "assistant-text", text: "before", partial: false } }],
    }),
  });
  expect(posted.status).toBe(200);

  const rebuiltRelay = createRunRelay();
  const seen: RunEventFrame[] = [];
  rebuiltRelay.subscribe(lab.runId, undefined, (frame) => seen.push(frame));
  failDroppedRuns(lab.store, rebuiltRelay, lab.machineId, [lab.runId], 1_800_000_010);

  expect(lab.store.get(`SELECT status, last_frame_seq FROM turns WHERE id = ?`, [lab.runId])).toEqual({
    status: "failed",
    last_frame_seq: 2,
  });
  expect(seen.map((frame) => frame.seq)).toEqual([2]);
});

it("names the machine that went away in the reason a live subscriber sees", async () => {
  const lab = await labWithRunInFlight();
  const seen: RunEventFrame[] = [];
  lab.relay.subscribe(lab.runId, undefined, (f) => seen.push(f));

  await postLive(lab, []);

  const completed = seen.find((f) => f.event.event === "completed") as
    | { event: { state: { state: string; reason?: string } } }
    | undefined;
  expect(completed?.event.state.state).toBe("failed");
  expect(completed?.event.state.reason).toMatch(new RegExp(lab.machineName));
});

it("drops the failed run's own command, the same as a normal completion would", async () => {
  const lab = await labWithRunInFlight();
  await postLive(lab, []);

  const replayed: RunCommand[] = [];
  lab.relay.attach(lab.machineId, (_seq, c) => replayed.push(c));
  expect(replayed).toEqual([]);
});

it("leaves a sibling run's status alone when only one run is missing", async () => {
  const lab = await labWithRunInFlight();
  const studyId = (await lab.ownerApi.listStudies())[0]!.id;
  const sibling = await lab.ownerApi.createTask({
    studyId,
    stage: "background",
    title: "Sibling run",
  });
  const second = await lab.ownerApi.startRun({
    studyId,
    taskId: sibling.id,
    prompt: "go again",
    options: { planMode: false, agent: "claude" },
  });

  await postLive(lab, [second.runId]);

  expect(lab.store.get(`SELECT status FROM turns WHERE id = ?`, [lab.runId])?.status).toBe("failed");
  expect(lab.store.get(`SELECT status FROM turns WHERE id = ?`, [second.runId])?.status).toBe("running");
});

it("does not let a machine reconcile a run it does not own by reporting nothing", async () => {
  const lab = await labWithRunInFlight();
  const bob = await pairClaudeMachine(lab.base, lab.ownerApi, "bobs-desktop");

  const res = await postLive(lab, [], bob.token);
  expect(res.status).toBe(200);
  expect(lab.store.get(`SELECT status FROM turns WHERE id = ?`, [lab.runId])?.status).toBe("running");
});

it("refuses a machine that names a run it does not own, before any of it reaches the relay's belief", async () => {
  // The actual attack: Bob's own bearer token is perfectly valid, and
  // `runIds` is normally just this machine's honest report of what it
  // holds — but nothing here stops Bob's daemon from naming a run id it
  // read off the wire or guessed (`run_<seq>`, sequential across the whole
  // lab). Reporting Alice's run as "held" would, without a check, land in
  // Bob's own `queue.live`; reporting it missing on the very next call would
  // then durably fail it and drop it from Alice's actual machine's queue.
  const lab = await labWithRunInFlight();
  const bob = await pairClaudeMachine(lab.base, lab.ownerApi, "bobs-desktop");

  const res = await postLive(lab, [lab.runId], bob.token);
  expect(res.status).toBe(403);

  // Alice's run is untouched: still running, and her machine's queue still
  // holds the command that would run it — neither the status flip nor the
  // second-order damage (the run silently vanishing from her own queue)
  // ever happened.
  expect(lab.store.get(`SELECT status FROM turns WHERE id = ?`, [lab.runId])?.status).toBe("running");
  const replayed: RunCommand[] = [];
  lab.relay.attach(lab.machineId, (_seq, c) => replayed.push(c));
  expect(replayed.some((c) => c.runId === lab.runId)).toBe(true);
});

it("does not lock a machine out of its command stream over a reported run id that resolves to no turn at all", async () => {
  // A run id whose turn does not exist in this store — nothing ever
  // minted it, or (should a future path ever remove a turn) it once did
  // and no longer does — is a different fact from one that resolves to
  // another machine's machine. Only the second is an attack. Naming an id
  // that resolves to nobody at all must not refuse the whole report and
  // wedge an otherwise honest daemon out of every command behind it,
  // including a decision its own turn is waiting on.
  const lab = await labWithRunInFlight();
  const res = await postLive(lab, [lab.runId, "run_does_not_exist"]);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ retireRunIds: ["run_does_not_exist"] });
  expect(lab.store.get(`SELECT status FROM turns WHERE id = ?`, [lab.runId])?.status).toBe("running");
  // The nonexistent id never reaches the relay's own belief of what this
  // machine holds — dropped before `reconcile` sees it, not merely ignored
  // once inside it.
  expect(lab.relay.liveFor(lab.machineId)).toEqual([lab.runId]);

  // The machine's command stream still works: a decision for a different,
  // still-real run reaches it over a fresh attach, exactly as it would
  // have if the nonexistent id had never been named at all — proving the
  // route did not wedge this machine the way refusing the whole request
  // would have.
  const study = await lab.ownerApi.createStudy({ key: "SEC", title: "Second" });
  const task = await lab.ownerApi.createTask({ studyId: study.id, stage: "background", title: "still real" });
  const second = await lab.ownerApi.startRun({
    studyId: study.id, taskId: task.id, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });
  const replayed: RunCommand[] = [];
  lab.relay.attach(lab.machineId, (_seq, c) => replayed.push(c));
  expect(replayed.some((c) => c.runId === second.runId)).toBe(true);
});

it("does not fail a run whose start-run was never delivered to any command stream", async () => {
  // A run enqueued while the daemon's command stream is down — reconnecting,
  // or not yet opened at all — has not actually been handed to anything: no
  // daemon anywhere has ever heard of it. That daemon's first report of what
  // it holds, once it does connect, must not read as this run having gone
  // missing.
  const server = await freshLabServer();
  servers.push(server);
  const ownerCookie = await signUpOwner(server.base);
  const ownerApi = apiFor(server.base, ownerCookie);
  const { token } = await pairClaudeMachine(server.base, ownerApi, "ana-macbook");

  const study = await ownerApi.createStudy({ key: "CMP", title: "Comparative" });
  const task = await ownerApi.createTask({ studyId: study.id, stage: "background", title: "run me" });
  const { runId } = await ownerApi.startRun({
    studyId: study.id, taskId: task.id, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });

  const res = await fetch(`${server.base}/daemon/run/live`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ runIds: [] }),
  });
  expect(res.status).toBe(200);
  expect(server.store.get(`SELECT status FROM turns WHERE id = ?`, [runId])?.status).toBe("running");
});

it("refuses reconciliation with no bearer token, the same as every other daemon route", async () => {
  const res = await fetch(`${(await labWithRunInFlight()).base}/daemon/run/live`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runIds: [] }),
  });
  expect(res.status).toBe(401);
});
