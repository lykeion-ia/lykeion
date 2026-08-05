import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { LykeionApi, RunEvent, RunEventFrame } from "@lykeion/api";
import { readConfig } from "../config";
import { openStore } from "../store/sqlite";
import { migrate } from "../store/migrations";
import { createChannel } from "../channel";
import { createRunRelay, type RunCommand, type RunRelay } from "../run-relay";
import { createRequestListener } from "../http";
import { apiFor, signUpOwner } from "../test-support/server-api";
import { changeRecorder } from "./changes";
import { sessionsApi } from "./sessions";
import type { Deps } from "./index";
import type { Store } from "../store/store";

const dirs: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface RawServer {
  base: string;
  store: Store;
  relay: RunRelay;
  close(): Promise<void>;
}

/** A real listener wired to a real store and a real run relay, on a real
 *  loopback port — the same building blocks `startServer` assembles, just
 *  handed back rather than hidden, so a test can drive the store and the
 *  relay directly instead of only through what the wire contract returns. */
function freshLabServer(now: () => number): Promise<RawServer> {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-sessions-"));
  dirs.push(dir);
  const uiDir = join(dir, "ui");
  mkdirSync(uiDir);
  const indexHtml = "<!doctype html><head></head><body></body>";
  writeFileSync(join(uiDir, "index.html"), indexHtml);

  const store = openStore(join(dir, "workspace.db"));
  migrate(store);
  const channel = createChannel(store, 1000);
  const relay = createRunRelay();
  const openStreams = new Set<() => void>();
  const config = { ...readConfig({}), host: "127.0.0.1", port: 0, dataDir: dir, uiDir };

  const listener = createRequestListener({
    store, config, secure: false, indexHtml, channel, openStreams, runs: relay, now,
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

async function redeemInvite(base: string, code: string, email: string, displayName: string): Promise<string> {
  const res = await fetch(`${base}/auth/redeem-invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, email, displayName, password: "a good long password" }),
  });
  if (!res.ok) throw new Error(`redeem-invite answered ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0];
}

/** Pairs a machine for the owner and reports it as offering the `claude`
 *  CLI, the way `runtimes.test.ts` pairs one — but through this file's own
 *  harness rather than `makeServerLab`, since a session test needs the raw
 *  store and relay that harness does not expose. */
async function pairClaudeMachine(
  base: string,
  ownerApi: LykeionApi,
  machineName: string,
  cliId = "claude",
): Promise<{ runtimeId: string; token: string }> {
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
  const { token, runtimeId } = (await exchanged.json()) as { token: string; runtimeId: string };
  await fetch(`${base}/daemon/report`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      platform: "macos-aarch64",
      daemonVersion: "0.1.0",
      capabilities: [],
      clis: [{ id: cliId, name: cliId, command: cliId, version: "2.1.220", available: true }],
    }),
  });
  return { runtimeId, token };
}

/** Reads whole `{ seq, command }` blocks off `/daemon/commands` as they
 *  arrive, the same way the daemon's own `openCommands` frames them, until
 *  `count` have been collected — then aborts the connection and returns
 *  them. */
async function readCommands(
  base: string,
  token: string,
  cursor: number | undefined,
  count: number,
): Promise<Array<{ seq: number; command: RunCommand }>> {
  const controller = new AbortController();
  const url = cursor === undefined ? `${base}/daemon/commands` : `${base}/daemon/commands?cursor=${cursor}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const out: Array<{ seq: number; command: RunCommand }> = [];
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
        if (dataLine) out.push(JSON.parse(dataLine.slice(5).trim()) as { seq: number; command: RunCommand });
        cut = buffered.indexOf("\n\n");
      }
    }
  } finally {
    controller.abort();
  }
  return out;
}

interface SessionsLab {
  base: string;
  store: Store;
  relay: RunRelay;
  ownerApi: LykeionApi;
  memberApi: LykeionApi;
  ownerId: string;
  runtimeId: string;
  machineName: string;
  /** The paired machine's own bearer token, for a test that speaks to
   *  `/daemon/...` routes directly rather than through `startRun`. */
  token: string;
  studyId: string;
  taskId: string;
  clock: { advance(seconds: number): void };
}

/** A lab with an owner and a member, a machine the owner has paired and
 *  reported as offering `claude`, a Study, and a Task filed into it — what
 *  every test below needs before it can call `startRun`. */
async function labWithPairedMachine(): Promise<SessionsLab> {
  let clock = 1_800_000_000;
  const server = await freshLabServer(() => clock);
  servers.push(server);

  const ownerCookie = await signUpOwner(server.base);
  const ownerApi = apiFor(server.base, ownerCookie);
  const ownerId = (await ownerApi.currentUser()).id;

  const invite = await ownerApi.createInvite("member");
  const memberCookie = await redeemInvite(server.base, invite.code, "member@lab.example", "Member");
  const memberApi = apiFor(server.base, memberCookie);

  const machineName = "ana-macbook";
  const { runtimeId, token } = await pairClaudeMachine(server.base, ownerApi, machineName);

  const study = await ownerApi.createStudy({ key: "CMP", title: "Comparative" });
  const task = await ownerApi.createTask({ studyId: study.id, stage: "background", title: "run me" });

  return {
    base: server.base,
    store: server.store,
    relay: server.relay,
    ownerApi,
    memberApi,
    ownerId,
    runtimeId,
    machineName,
    token,
    studyId: study.id,
    taskId: task.id,
    clock: {
      advance(seconds: number) {
        clock += seconds;
      },
    },
  };
}

async function completeRun(lab: SessionsLab, runId: string): Promise<Response> {
  return fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({
      runId,
      frames: [{ seq: 1, event: { event: "completed", state: { state: "completed" } } }],
    }),
  });
}

it("opens a session, records a turn, and hands the machine a start-run", async () => {
  const lab = await labWithPairedMachine();
  const taken: RunCommand[] = [];
  lab.relay.attach(lab.runtimeId, (_seq, c) => taken.push(c));

  const { runId } = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });

  expect(taken).toHaveLength(1);
  expect(taken[0]).toMatchObject({ type: "start-run", runId, prompt: "go" });
  expect(lab.store.all(`SELECT id FROM sessions`)).toHaveLength(1);
  expect(lab.store.get(`SELECT status FROM turns WHERE id = ?`, [runId])?.status).toBe("running");
});

it("refuses a second active run for the same Task", async () => {
  const lab = await labWithPairedMachine();
  const input = {
    studyId: lab.studyId,
    taskId: lab.taskId,
    prompt: "first",
    // The fixture pairs the stubbed Claude catalogue entry; this is a
    // server-unit fixture, not a live-provider assertion.
    options: { planMode: false, agent: "claude" },
  } as const;

  await lab.ownerApi.startRun(input);
  await expect(
    lab.ownerApi.startRun({ ...input, prompt: "second" }),
  ).rejects.toMatchObject({ code: "conflict" });

  expect(lab.store.all(`SELECT id FROM turns WHERE task_id = ?`, [lab.taskId]))
    .toHaveLength(1);
});

it("allows different Tasks in one Study to run concurrently", async () => {
  const lab = await labWithPairedMachine();
  const sibling = await lab.ownerApi.createTask({
    studyId: lab.studyId,
    stage: "background",
    title: "Sibling task",
  });

  const first = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "first",
    options: { planMode: false, agent: "claude" },
  });
  const second = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: sibling.id, prompt: "second",
    options: { planMode: false, agent: "claude" },
  });

  expect(first.runId).not.toBe(second.runId);
  expect(lab.store.all(`SELECT id FROM turns WHERE ended_ts IS NULL`)).toHaveLength(2);
});

it("reuses the Task's live session for a later turn on the same agent", async () => {
  const lab = await labWithPairedMachine();
  const go = () =>
    lab.ownerApi.startRun({
      studyId: lab.studyId, taskId: lab.taskId, prompt: "go",
      options: { planMode: false, agent: "claude" },
    });
  const first = await go();
  expect((await completeRun(lab, first.runId)).status).toBe(200);
  const second = await go();
  expect(second.runId).not.toBe(first.runId);
  expect(lab.store.all(`SELECT id FROM sessions`)).toHaveLength(1);
  expect(lab.store.all(`SELECT id FROM turns`)).toHaveLength(2);
});

it("resumes an owned active turn and reveals it to no other member", async () => {
  const lab = await labWithPairedMachine();
  const first = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "first",
    options: { planMode: false, agent: "claude" },
  });
  const resumed = await lab.ownerApi.resumeRuns(lab.taskId);
  expect(resumed.map((run) => ({ runId: run.runId, prompt: run.snapshot.prompt }))).toEqual([
    { runId: first.runId, prompt: "first" },
  ]);
  expect(await lab.memberApi.resumeRuns(lab.taskId)).toEqual([]);
});

it("refuses a run on a machine that is not the caller's", async () => {
  // Ana's laptop would spend Ana's subscription and read Ana's files. The
  // topology exists to stop exactly this.
  const lab = await labWithPairedMachine(); // paired by the owner
  await expect(
    lab.memberApi.startRun({
      studyId: lab.studyId, taskId: lab.taskId, prompt: "go",
      options: { planMode: false, agent: "claude" },
    }),
  ).rejects.toMatchObject({ code: "forbidden" });
  expect(lab.store.all(`SELECT id FROM sessions`)).toHaveLength(0);
});

it("refuses a run on an unfiled Task by name", async () => {
  const lab = await labWithPairedMachine();
  const unfiled = await lab.ownerApi.createTask({ stage: "background", title: "loose end" });
  await expect(
    lab.ownerApi.startRun({
      studyId: lab.studyId, taskId: unfiled.id, prompt: "go",
      options: { planMode: false, agent: "claude" },
    }),
  ).rejects.toThrow(/not in a Study/);
});

it("refuses a run on a machine that is offline", async () => {
  const lab = await labWithPairedMachine();
  lab.clock.advance(10 * 60); // past the offline threshold
  await expect(
    lab.ownerApi.startRun({
      studyId: lab.studyId, taskId: lab.taskId, prompt: "go",
      options: { planMode: false, agent: "claude" },
    }),
  ).rejects.toThrow(new RegExp(lab.machineName));
});

it("carries the Study's standing folder grants in the command", async () => {
  const lab = await labWithPairedMachine();
  lab.store.run(
    `INSERT INTO folder_grants (id, study_id, runtime_id, path, mode, granted_by, granted_ts, seq)
     VALUES ('fg_1', ?, ?, '/work/rna-seq', 'write', ?, 1, 1)`,
    [lab.studyId, lab.runtimeId, lab.ownerId],
  );
  const taken: RunCommand[] = [];
  lab.relay.attach(lab.runtimeId, (_seq, c) => taken.push(c));
  await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });
  expect(taken[0]!.grants).toEqual([{ path: "/work/rna-seq", mode: "write" }]);
});

// ---- the three /daemon/ routes, over real HTTP rather than against the
// relay object directly — the SSE framing, the cursor filter, and the
// bearer-auth paths only exist in `http.ts`, not in `run-relay.ts` itself.

it("delivers a queued command over the wire on /daemon/commands", async () => {
  const lab = await labWithPairedMachine();
  const { runId } = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });

  const [frame] = await readCommands(lab.base, lab.token, undefined, 1);
  expect(frame).toMatchObject({ command: { type: "start-run", runId, prompt: "go" } });
});

it("replays only what a cursor missed when /daemon/commands reconnects", async () => {
  const lab = await labWithPairedMachine();
  await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "first",
    options: { planMode: false, agent: "claude" },
  });
  const [first] = await readCommands(lab.base, lab.token, undefined, 1);
  expect((await completeRun(lab, lab.store.get(`SELECT id FROM turns WHERE task_id = ?`, [lab.taskId])!.id as string)).status)
    .toBe(200);

  await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "second",
    options: { planMode: false, agent: "claude" },
  });
  const replayed = await readCommands(lab.base, lab.token, first!.seq, 1);

  // Only what it missed — a replay that repeated the first command as well
  // would queue the same turn a second time on the daemon's own side.
  expect(replayed).toHaveLength(1);
  expect(replayed[0]!.seq).toBeGreaterThan(first!.seq);
  expect(replayed[0]!.command).toMatchObject({ prompt: "second" });
});

it("refuses the command stream to an unrecognized bearer token", async () => {
  const lab = await labWithPairedMachine();
  const res = await fetch(`${lab.base}/daemon/commands`, {
    headers: { authorization: "Bearer not-a-real-token" },
  });
  expect(res.status).toBe(401);
});

it("reconciles what a machine reports live on /daemon/run/live, requiring its own bearer token", async () => {
  const lab = await labWithPairedMachine();
  // A run only counts as live once a connected daemon has actually been
  // handed its start-run — attached here the way a real daemon's own
  // command stream is already open before a researcher ever starts a run.
  lab.relay.attach(lab.runtimeId, () => {});

  const unauthorized = await fetch(`${lab.base}/daemon/run/live`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runIds: [] }),
  });
  expect(unauthorized.status).toBe(401);

  const { runId } = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });
  expect(lab.relay.liveFor(lab.runtimeId)).toEqual([runId]);

  const res = await fetch(`${lab.base}/daemon/run/live`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({ runIds: [] }),
  });
  expect(res.status).toBe(200);
  // The route actually reached `reconcile`, not merely answered `ok` — the
  // relay's own belief about what this runtime holds moved with it.
  expect(lab.relay.liveFor(lab.runtimeId)).toEqual([]);
});

it("refuses to publish run events for a run the calling machine does not own", async () => {
  // Any paired machine holds a perfectly valid bearer token; the token alone
  // must not be enough to post frames into a run started on someone else's
  // machine, including a colleague's or another of the same owner's own.
  const lab = await labWithPairedMachine();
  const { runId } = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });
  const other = await pairClaudeMachine(lab.base, lab.ownerApi, "bobs-desktop");

  const res = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${other.token}` },
    body: JSON.stringify({
      runId,
      frames: [{ seq: 1, event: { event: "assistant-text", text: "forged", partial: false } }],
    }),
  });
  expect(res.status).toBe(403);
});

it("accepts run events posted by the machine that actually owns the run", async () => {
  const lab = await labWithPairedMachine();
  const { runId } = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });
  const seen: RunEventFrame[] = [];
  lab.relay.subscribe(runId, undefined, (f) => seen.push(f));

  const res = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({
      runId,
      frames: [{ seq: 1, event: { event: "assistant-text", text: "hi", partial: false } }],
    }),
  });

  expect(res.status).toBe(200);
  expect(seen).toEqual([{ seq: 1, event: { event: "assistant-text", text: "hi", partial: false } }]);
});

it("derives lastRunStatus from the latest settled turn", async () => {
  const lab = await labWithPairedMachine();
  const first = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "first",
    options: { planMode: false, agent: "claude" },
  });
  const postCompletion = (runId: string, state: Record<string, unknown>) =>
    fetch(`${lab.base}/daemon/run/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
      body: JSON.stringify({ runId, frames: [{ seq: 1, event: { event: "completed", state } }] }),
    });

  expect((await postCompletion(first.runId, { state: "failed", reason: "first failed" })).status)
    .toBe(200);
  const second = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "second",
    options: { planMode: false, agent: "claude" },
  });
  expect((await postCompletion(second.runId, { state: "completed" })).status).toBe(200);

  const detail = await lab.ownerApi.getTask(lab.taskId);
  expect(detail.turns.map((turn) => turn.status)).toEqual(["failed", "ok"]);
  expect(detail.task.lastRunStatus).toBe("ok");
});

it("preserves Done after a completed run and reopens it for later new work", async () => {
  const lab = await labWithPairedMachine();
  const first = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "first sibling",
    options: { planMode: false, agent: "claude" },
  });
  const postSuccess = (runId: string) =>
    fetch(`${lab.base}/daemon/run/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
      body: JSON.stringify({
        runId,
        frames: [{ seq: 1, event: { event: "completed", state: { state: "completed" } } }],
      }),
    });

  expect((await postSuccess(first.runId)).status).toBe(200);
  await lab.ownerApi.updateTask(lab.taskId, { status: "done" });
  expect((await lab.ownerApi.getTask(lab.taskId)).task.status).toBe("done");

  const third = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "new work after done",
    options: { planMode: false, agent: "claude" },
  });
  expect((await postSuccess(third.runId)).status).toBe(200);
  expect((await lab.ownerApi.getTask(lab.taskId)).task.status).toBe("in-review");
});

it("reopens a completed turn with prose and execution steps in their durable arrival order", async () => {
  const lab = await labWithPairedMachine();
  const { runId } = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "inspect counts",
    options: { planMode: false, agent: "claude" },
  });
  const frames: RunEventFrame[] = [
    { seq: 1, event: { event: "assistant-text", text: "Before the read.", partial: false } },
    {
      seq: 2,
      event: {
        event: "log-entry",
        entry: {
          ts: 1_800_000_001,
          toolUseId: "read-1",
          tool: "Read",
          title: "Read counts.csv",
          input: { path: "counts.csv" },
          decision: "ran",
          result: "12 rows",
          isError: false,
        },
      },
    },
    { seq: 3, event: { event: "assistant-text", text: "After the read.", partial: false } },
    { seq: 4, event: { event: "completed", state: { state: "completed" } } },
  ];
  const res = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({ runId, frames }),
  });
  expect(res.status).toBe(200);

  const reopened = await lab.ownerApi.getTask(lab.taskId);
  expect(reopened.turns).toEqual([
    {
      runId,
      sequence: lab.store.get(`SELECT seq FROM turns WHERE id = ?`, [runId])!.seq,
      ts: 1_800_000_000,
      prompt: "inspect counts",
      messages: ["Before the read.After the read."],
      stream: [
        { kind: "text", text: "Before the read.", block: "interim" },
        {
          kind: "step",
          entry: {
            ts: 1_800_000_001,
            toolUseId: "read-1",
            tool: "Read",
            title: "Read counts.csv",
            input: { path: "counts.csv" },
            decision: "ran",
            result: "12 rows",
            isError: false,
          },
        },
        { kind: "text", text: "After the read.", block: "interim" },
      ],
      status: "ok",
      code: [],
      outputs: [],
    },
  ]);
});

it("reopens repeated updates for one tool call as one enriched logical step", async () => {
  const lab = await labWithPairedMachine();
  const { runId } = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "write counts",
    options: { planMode: false, agent: "claude" },
  });
  const baseEntry = {
    ts: 1_800_000_001,
    toolUseId: "write-1",
    tool: "Write",
    input: { path: "counts.csv" },
    decision: "pending",
    isError: false,
  };
  const frames: RunEventFrame[] = [
    { seq: 1, event: { event: "log-entry", entry: baseEntry } },
    {
      seq: 2,
      event: {
        event: "log-entry",
        entry: { ...baseEntry, title: "Write counts.csv", decision: "allowed-once" },
      },
    },
    { seq: 3, event: { event: "assistant-text", text: "Writing complete.", partial: false } },
    {
      seq: 4,
      event: {
        event: "log-entry",
        entry: {
          ...baseEntry,
          title: "Write counts.csv",
          decision: "allowed-once",
          result: "disk full",
          isError: true,
        },
      },
    },
    { seq: 5, event: { event: "completed", state: { state: "completed" } } },
  ];
  const res = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({ runId, frames }),
  });
  expect(res.status).toBe(200);

  const [turn] = (await lab.ownerApi.getTask(lab.taskId)).turns;
  expect(turn.stream).toEqual([
    {
      kind: "step",
      entry: {
        ...baseEntry,
        title: "Write counts.csv",
        decision: "allowed-once",
        result: "disk full",
        isError: true,
      },
    },
    { kind: "text", text: "Writing complete.", block: "interim" },
  ]);
  expect(lab.store.all(`SELECT id FROM turn_steps WHERE turn_id = ?`, [runId])).toHaveLength(1);
});

it("records a cancelled turn as cancelled rather than defaulting to ok, and runHistory reports it", async () => {
  const lab = await labWithPairedMachine();
  const { runId } = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });

  const res = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({
      runId,
      frames: [{ seq: 1, event: { event: "completed", state: { state: "cancelled" } } }],
    }),
  });

  expect(res.status).toBe(200);
  expect(lab.store.get(`SELECT status FROM turns WHERE id = ?`, [runId])?.status).toBe("cancelled");
  const history = await lab.ownerApi.runHistory(lab.taskId);
  expect(history.find((h) => h.runId === runId)?.status).toBe("cancelled");
});

it("records an unacknowledged stop distinctly, and runHistory reports the flag alongside cancelled", async () => {
  // The daemon's own grace expiring, not the researcher's Stop button —
  // the fact that the agent never confirmed must survive the trip through
  // the store rather than collapsing into the same row an ordinary,
  // confirmed stop leaves.
  const lab = await labWithPairedMachine();
  const { runId } = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });

  const res = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({
      runId,
      frames: [
        {
          seq: 1,
          event: { event: "completed", state: { state: "cancelled", unacknowledged: true } },
        },
      ],
    }),
  });

  expect(res.status).toBe(200);
  // Durably distinct from an ordinary cancel — not the same row value.
  expect(lab.store.get(`SELECT status FROM turns WHERE id = ?`, [runId])?.status).not.toBe(
    "cancelled",
  );
  const history = await lab.ownerApi.runHistory(lab.taskId);
  const entry = history.find((h) => h.runId === runId);
  // The wire contract stays `status: "cancelled"` — `unacknowledged` is the
  // separate fact, exactly the shape `TurnState`'s own `cancelled` carries.
  expect(entry?.status).toBe("cancelled");
  expect(entry?.unacknowledged).toBe(true);
  const firstSession = lab.store.get(`SELECT session_id FROM turns WHERE id = ?`, [runId])!.session_id;
  expect(lab.store.get(`SELECT ended_ts FROM sessions WHERE id = ?`, [firstSession])?.ended_ts).not.toBeNull();

  const next = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "try again",
    options: { planMode: false, agent: "claude" },
  });
  const nextSession = lab.store.get(`SELECT session_id FROM turns WHERE id = ?`, [next.runId])!.session_id;
  expect(nextSession).not.toBe(firstSession);
});

it("refuses a malformed /daemon/run/events body", async () => {
  const lab = await labWithPairedMachine();
  const res = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({ runId: 12345, frames: "not-an-array" }),
  });
  expect(res.status).toBe(400);
});

// ---- the RunHandle returned to an in-process caller, since dispatch strips
// its functions before any RPC caller ever sees them.

it("wires the returned handle's onEvent/submit/close to the relay for an in-process caller", async () => {
  const lab = await labWithPairedMachine();
  const channel = createChannel(lab.store, 1000);
  const deps: Deps = {
    store: lab.store,
    actor: { userId: lab.ownerId, role: "owner" },
    now: () => 1_800_000_010,
    config: readConfig({}),
    channel,
    runs: lab.relay,
    changes: changeRecorder({ store: lab.store, actorId: lab.ownerId, now: () => 1_800_000_600, channel }),
  };

  const handle = await sessionsApi(deps).startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });

  const seen: RunEvent[] = [];
  const unsubscribe = handle.onEvent((e) => seen.push(e));
  lab.relay.publish(handle.runId, [{ seq: 1, event: { event: "assistant-text", text: "hi", partial: false } }]);
  expect(seen).toEqual([
    {
      event: "snapshot",
      snapshot: expect.objectContaining({
        runId: handle.runId,
        prompt: "go",
        state: { state: "planning" },
        lastEventSeq: 0,
      }),
    },
    { event: "assistant-text", text: "hi", partial: false },
  ]);
  unsubscribe();

  // `attach` replays the start-run this same `startRun` call already
  // queued, so only what `submit`/`close` add afterward is asserted on.
  const commands: RunCommand[] = [];
  lab.relay.attach(lab.runtimeId, (_seq, c) => commands.push(c));
  handle.submit({ action: "cancel" });
  handle.close();
  expect(
    commands.filter((c) => c.type !== "start-run").map((c) => ({ type: c.type, runId: c.runId })),
  ).toEqual([
    { type: "decision", runId: handle.runId },
    { type: "cancel", runId: handle.runId },
  ]);
});

it("stops a fresh handle's queued replay when its callback detaches", async () => {
  const lab = await labWithPairedMachine();
  const channel = createChannel(lab.store, 1000);
  const deps: Deps = {
    store: lab.store,
    actor: { userId: lab.ownerId, role: "owner" },
    now: () => 1_800_000_010,
    config: readConfig({}),
    channel,
    runs: lab.relay,
    changes: changeRecorder({ store: lab.store, actorId: lab.ownerId, now: () => 1_800_000_600, channel }),
  };
  const handle = await sessionsApi(deps).startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "detach while replaying",
    options: { planMode: false, agent: "claude" },
  });
  lab.relay.publish(handle.runId, [
    { seq: 1, event: { event: "assistant-text", text: "first", partial: false } },
    { seq: 2, event: { event: "assistant-text", text: "second", partial: false } },
  ]);

  const seen: RunEvent[] = [];
  handle.onEvent((event) => {
    seen.push(event);
    if (event.event === "assistant-text") handle.detach();
  });
  lab.relay.publish(handle.runId, [
    { seq: 3, event: { event: "assistant-text", text: "later", partial: false } },
  ]);

  expect(seen).toEqual([
    { event: "snapshot", snapshot: expect.objectContaining({ runId: handle.runId }) },
    { event: "assistant-text", text: "first", partial: false },
  ]);
});

it("resumed in-process handles use their durable cursor, route decisions per runtime, detach, and cancel on close", async () => {
  const lab = await labWithPairedMachine();
  const codex = await pairClaudeMachine(lab.base, lab.ownerApi, "ana-codex", "codex");
  const sibling = await lab.ownerApi.createTask({
    studyId: lab.studyId,
    stage: "background",
    title: "Second active run",
  });
  const first = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "claude turn",
    options: { planMode: false, agent: "claude" },
  });
  const second = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: sibling.id, prompt: "codex turn",
    options: { planMode: false, agent: "codex" },
  });
  const firstFrame: RunEventFrame = {
    seq: 1,
    event: { event: "assistant-text", text: "durable", partial: false },
  };
  const posted = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({ runId: first.runId, frames: [firstFrame] }),
  });
  expect(posted.status).toBe(200);

  const channel = createChannel(lab.store, 1000);
  const deps: Deps = {
    store: lab.store,
    actor: { userId: lab.ownerId, role: "owner" },
    now: () => 1_800_000_010,
    config: readConfig({}),
    channel,
    runs: lab.relay,
    changes: changeRecorder({ store: lab.store, actorId: lab.ownerId, now: () => 1_800_000_600, channel }),
  };
  const resumed = [
    ...(await sessionsApi(deps).resumeRuns(lab.taskId)),
    ...(await sessionsApi(deps).resumeRuns(sibling.id)),
  ];
  expect(resumed.map((run) => run.runId)).toEqual([first.runId, second.runId]);

  const seen: RunEvent[] = [];
  resumed[0]!.onEvent((event) => seen.push(event));
  expect(seen).toEqual([]);
  lab.relay.publish(first.runId, [
    { seq: 2, event: { event: "assistant-text", text: "later", partial: false } },
  ]);
  expect(seen).toEqual([{ event: "assistant-text", text: "later", partial: false }]);
  resumed[0]!.detach();
  lab.relay.publish(first.runId, [
    { seq: 3, event: { event: "assistant-text", text: "detached", partial: false } },
  ]);
  expect(seen).toHaveLength(1);
  const replayedAfterDetach: RunEvent[] = [];
  resumed[0]!.onEvent((event) => replayedAfterDetach.push(event));
  expect(replayedAfterDetach).toEqual([
    { event: "assistant-text", text: "detached", partial: false },
  ]);

  const claudeCommands: RunCommand[] = [];
  const codexCommands: RunCommand[] = [];
  lab.relay.attach(lab.runtimeId, (_seq, command) => claudeCommands.push(command));
  lab.relay.attach(codex.runtimeId, (_seq, command) => codexCommands.push(command));
  claudeCommands.length = 0;
  codexCommands.length = 0;
  resumed[0]!.submit({ action: "approve-plan" });
  resumed[1]!.submit({ action: "reject-plan", reason: "stop" });
  resumed[1]!.close();
  resumed[1]!.close();
  const afterClose: RunEvent[] = [];
  resumed[1]!.onEvent((event) => afterClose.push(event));
  expect(claudeCommands).toEqual([
    { type: "decision", runId: first.runId, decision: { action: "approve-plan" } },
  ]);
  expect(codexCommands).toEqual([
    { type: "decision", runId: second.runId, decision: { action: "reject-plan", reason: "stop" } },
    { type: "cancel", runId: second.runId },
  ]);
  expect(afterClose).toEqual([]);
});

it("stops synchronous replay when a resumed handle closes from its first frame", async () => {
  const lab = await labWithPairedMachine();
  const started = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "close while replaying",
    options: { planMode: false, agent: "claude" },
  });
  lab.relay.publish(started.runId, [
    { seq: 1, event: { event: "assistant-text", text: "first", partial: false } },
    { seq: 2, event: { event: "assistant-text", text: "second", partial: false } },
  ]);
  const channel = createChannel(lab.store, 1000);
  const api = sessionsApi({
    store: lab.store,
    actor: { userId: lab.ownerId, role: "owner" },
    now: () => 1_800_000_010,
    config: readConfig({}),
    channel,
    runs: lab.relay,
    changes: changeRecorder({ store: lab.store, actorId: lab.ownerId, now: () => 1_800_000_600, channel }),
  });
  const [resumed] = await api.resumeRuns(lab.taskId);
  const seen: RunEvent[] = [];
  resumed!.onEvent((event) => {
    seen.push(event);
    resumed!.close();
  });
  lab.relay.publish(started.runId, [
    { seq: 3, event: { event: "assistant-text", text: "later", partial: false } },
  ]);

  expect(seen).toEqual([
    { event: "assistant-text", text: "first", partial: false },
  ]);
});

// ---- submitRunDecision, the RPC-reachable counterpart: addresses a run by
// its bare id rather than through the handle `startRun` returned, since a
// handle's methods never survive the trip across the wire.

it("delivers a decision submitted through submitRunDecision to the run's runtime", async () => {
  const lab = await labWithPairedMachine();
  const { runId } = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });
  const commands: RunCommand[] = [];
  lab.relay.attach(lab.runtimeId, (_seq, c) => commands.push(c));

  await lab.ownerApi.submitRunDecision(runId, { action: "cancel" });

  expect(commands.filter((c) => c.type === "decision")).toEqual([
    { type: "decision", runId, decision: { action: "cancel" } },
  ]);
});

it("does not queue handle or RPC commands after a run is already terminal", async () => {
  const lab = await labWithPairedMachine();
  const channel = createChannel(lab.store, 1000);
  const api = sessionsApi({
    store: lab.store,
    actor: { userId: lab.ownerId, role: "owner" },
    now: () => 1_800_000_010,
    config: readConfig({}),
    channel,
    runs: lab.relay,
    changes: changeRecorder({ store: lab.store, actorId: lab.ownerId, now: () => 1_800_000_600, channel }),
  });
  const handle = await api.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "already done",
    options: { planMode: false, agent: "claude" },
  });
  const posted = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({
      runId: handle.runId,
      frames: [{ seq: 1, event: { event: "completed", state: { state: "cancelled" } } }],
    }),
  });
  expect(posted.status).toBe(200);

  const commands: RunCommand[] = [];
  lab.relay.attach(lab.runtimeId, (_seq, command) => commands.push(command));
  handle.submit({ action: "cancel" });
  handle.close();
  handle.close();
  await api.submitRunDecision(handle.runId, { action: "cancel" });
  expect(commands).toEqual([]);
});

it("refuses a decision on a run whose machine the caller does not own", async () => {
  const lab = await labWithPairedMachine();
  const { runId } = await lab.ownerApi.startRun({
    studyId: lab.studyId, taskId: lab.taskId, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });
  await expect(
    lab.memberApi.submitRunDecision(runId, { action: "cancel" }),
  ).rejects.toMatchObject({ code: "forbidden" });
});

it("refuses a decision on a run id nobody holds, the same way an unowned one is refused", async () => {
  // Run ids are sequential and guessable, so a caller must not be able to
  // tell "no such run" apart from "not yours" by the error it gets back.
  const lab = await labWithPairedMachine();
  await expect(
    lab.ownerApi.submitRunDecision("run_nope", { action: "cancel" }),
  ).rejects.toMatchObject({ code: "forbidden" });
});
