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
import { createRunRelay, type RunRelay } from "./run-relay";
import { createRequestListener } from "./http";
import { apiFor, signUpOwner } from "./test-support/server-api";
import type { Store } from "./store/store";
import { recordRunFrames } from "./store/sessions";
import { createRevertRegistry } from "./run-revert";
import { createKernelListRegistry } from "./kernel-list-registry";
import { createTitleRegistry } from "./title-registry";
import { createPendingCells } from "./kernel-cells";
import { createEnvSetupRegistry } from "./env-setup-registry";

const dirs: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A real listener wired to a real store and a real run relay, on a real
 *  loopback port — the same building blocks `startServer` assembles, just
 *  handed back rather than hidden, so a test can read `turns`/`turn_steps`/
 *  `change_log` straight out of the store instead of only through whatever
 *  the wire contract returns — the same thing `api/sessions.test.ts` builds
 *  its own harness around, for the same reason. */
function freshLabServer(existingDir?: string): Promise<{
  base: string;
  dataDir: string;
  store: Store;
  relay: RunRelay;
  raceNextSnapshotRead(callback: () => void): void;
  close(): Promise<void>;
}> {
  const dir = existingDir ?? mkdtempSync(join(tmpdir(), "lykeion-run-stream-"));
  if (existingDir === undefined) dirs.push(dir);
  const uiDir = join(dir, "ui");
  mkdirSync(uiDir, { recursive: true });
  const indexHtml = "<!doctype html><head></head><body></body>";
  writeFileSync(join(uiDir, "index.html"), indexHtml);

  const store = openStore(join(dir, "workspace.db"));
  migrate(store);
  const channel = createChannel(store, 1000);
  const relay = createRunRelay();
  let afterSnapshotRead: (() => void) | undefined;
  const routedStore: Store = {
    all: (sql, params) => store.all(sql, params),
    get(sql, params) {
      const row = store.get(sql, params);
      if (afterSnapshotRead && sql.includes("t.last_frame_seq") && sql.includes("WHERE t.id = ?")) {
        const callback = afterSnapshotRead;
        afterSnapshotRead = undefined;
        callback();
      }
      return row;
    },
    run: (sql, params) => store.run(sql, params),
    tx: (fn) => store.tx(fn),
    close: () => store.close(),
  };
  const openStreams = new Set<() => void>();
  const config = { ...readConfig({}), host: "127.0.0.1", port: 0, dataDir: dir, uiDir };

  const listener = createRequestListener({
    store: routedStore,
    config,
    secure: false,
    indexHtml,
    channel,
    openStreams,
    runs: relay, reverts: createRevertRegistry(), kernelLists: createKernelListRegistry(), titles: createTitleRegistry(), pendingCells: createPendingCells(), envSetups: createEnvSetupRegistry(),
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
        raceNextSnapshotRead(callback) {
          afterSnapshotRead = callback;
        },
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
 *  CLI, the way a real daemon's pairing handshake and first report do. */
async function pairClaudeMachine(base: string, ownerApi: LykeionApi): Promise<string> {
  const { verifier, challenge } = secretPair();
  const { code } = await ownerApi.pairMachine({
    name: "ana-macbook",
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
  const { token } = (await exchanged.json()) as { token: string; runtimeId: string };
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
  return token;
}

interface RunStreamLab {
  base: string;
  dataDir: string;
  raceNextSnapshotRead(callback: () => void): void;
  store: Store;
  relay: RunRelay;
  /** The owner's session cookie — the one who paired the machine the run
   *  happened on, and so the one every passing test opens the stream as. */
  ownerCookie: string;
  /** A second lab member's cookie, signed in but owning no machine — what
   *  the ownership-refusal test opens the stream as. */
  memberCookie: string;
  /** The paired machine's own bearer token, for posting frames the way its
   *  daemon would. */
  token: string;
  runId: string;
  taskId: string;
}

/** A lab with an owner, a member, a machine the owner paired and reported,
 *  a Study and Task, and a turn already started on that machine — what
 *  every test below needs before it can post or read this run's frames. */
async function labWithRunInFlight(): Promise<RunStreamLab> {
  const server = await freshLabServer();
  servers.push(server);

  const ownerCookie = await signUpOwner(server.base);
  const ownerApi = apiFor(server.base, ownerCookie);

  const invite = await ownerApi.createInvite("member");
  const memberCookie = await redeemInvite(server.base, invite.code, "member@lab.example", "Member");

  const token = await pairClaudeMachine(server.base, ownerApi);

  const study = await ownerApi.createStudy({ key: "CMP", title: "Comparative" });
  const task = await ownerApi.createTask({ studyId: study.id, stage: "background", title: "run me" });

  const { runId } = await ownerApi.startRun({
    studyId: study.id, taskId: task.id, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });

  return {
    base: server.base,
    dataDir: server.dataDir,
    raceNextSnapshotRead: server.raceNextSnapshotRead,
    store: server.store,
    relay: server.relay,
    ownerCookie,
    memberCookie,
    token,
    runId,
    taskId: task.id,
  };
}

/** POSTs a batch of run frames to `/daemon/run/events`, bearing the paired
 *  machine's token — the way the daemon that actually holds the run does. */
async function postFrames(lab: RunStreamLab, frames: RunEventFrame[]): Promise<void> {
  const res = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({ runId: lab.runId, frames }),
  });
  if (!res.ok) throw new Error(`postFrames answered ${res.status}`);
}

/** Opens `/runs/<runId>/events` as the owner and hands every `event: frame`
 *  block it reads to `onFrame`, in order, as they arrive — reading raw SSE
 *  off the wire the same way `readCommands` in `api/sessions.test.ts` reads
 *  `/daemon/commands`. Resolves once the connection is open (headers
 *  received), not once it closes — a caller polls for what it expects with
 *  `until`, the same way a real subscriber has no way to know how many
 *  frames are coming. `onClose`, when given, fires once the stream actually
 *  ends — the server closing it on a `completed` frame, or the lab's own
 *  teardown at the end of a test. */
async function openRunStream(
  lab: RunStreamLab,
  runId: string,
  cursor: number | undefined,
  onFrame: (f: RunEventFrame) => void,
  onClose?: () => void,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const url = `${lab.base}/runs/${runId}/events${cursor === undefined ? "" : `?cursor=${cursor}`}`;
  const res = await fetch(url, { headers: { cookie: lab.ownerCookie, ...extraHeaders } });
  if (!res.ok) throw new Error(`run stream answered ${res.status}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          onClose?.();
          return;
        }
        buffered += decoder.decode(value, { stream: true });
        let cut = buffered.indexOf("\n\n");
        while (cut !== -1) {
          const block = buffered.slice(0, cut);
          buffered = buffered.slice(cut + 2);
          const lines = block.split("\n");
          const eventLine = lines.find((l) => l.startsWith("event:"));
          const dataLine = lines.find((l) => l.startsWith("data:"));
          if (eventLine?.slice("event:".length).trim() === "frame" && dataLine)
            onFrame(JSON.parse(dataLine.slice("data:".length).trim()) as RunEventFrame);
          cut = buffered.indexOf("\n\n");
        }
      }
    } catch {
      // The connection was torn down from outside the read loop (the lab's
      // own teardown at `afterEach`, most often) rather than settling on its
      // own — nothing left here for a test to see either way.
    }
  })();
}

/**
 * What the two rollover behaviours below are given, rather than the default
 * every other test here runs happily inside.
 *
 * They are the only tests that must overrun the relay's own frame limit to
 * mean anything, so each writes more than five hundred frames through the
 * store and then waits for every one of them to arrive. That is real work
 * measured in hundreds of milliseconds on an idle machine, and this suite
 * runs beside three other packages' suites — on a machine already saturated
 * by them, the same work takes long enough to overrun a budget sized for
 * tests that post one frame. A budget that a correct implementation can miss
 * because of what else the machine is doing tests the machine, not the code.
 */
const ROLLOVER_TEST_TIMEOUT_MS = 30_000;

/** Polls `predicate` until it holds, the way a subscriber with no signal for
 *  "nothing more is coming right now" has to. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the condition to hold");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it("starts a fresh stream with an authoritative snapshot before later frames", async () => {
  const lab = await labWithRunInFlight();
  const seen: RunEventFrame[] = [];
  await openRunStream(lab, lab.runId, undefined, (f) => seen.push(f));
  await until(() => seen.length === 1);
  expect(seen[0]).toEqual(expect.objectContaining({
    seq: 0,
    event: expect.objectContaining({
      event: "snapshot",
      snapshot: expect.objectContaining({
        runId: lab.runId,
        state: { state: "planning" },
        lastEventSeq: 0,
      }),
    }),
  }));

  await postFrames(lab, [
    { seq: 1, event: { event: "assistant-text", text: "hi", partial: true } },
    { seq: 2, event: { event: "live", live: { text: "hi" } } },
  ]);
  await until(() => seen.length === 3);
  expect(seen[1]!.event).toEqual({ event: "assistant-text", text: "hi", partial: true });

  const reloaded: RunEventFrame[] = [];
  await openRunStream(lab, lab.runId, undefined, (frame) => reloaded.push(frame));
  await until(() => reloaded.length === 1);
  expect(reloaded[0]).toEqual(expect.objectContaining({
    seq: 2,
    event: expect.objectContaining({
      event: "snapshot",
      snapshot: expect.objectContaining({
        stream: [{ kind: "text", text: "hi", block: "interim" }],
        live: { text: "hi" },
        lastEventSeq: 2,
      }),
    }),
  }));
});

it("replays from a cursor so a reload mid-turn catches up", async () => {
  const lab = await labWithRunInFlight();
  await postFrames(lab, [
    { seq: 1, event: { event: "assistant-text", text: "one", partial: true } },
    { seq: 2, event: { event: "assistant-text", text: "two", partial: true } },
  ]);
  const seen: RunEventFrame[] = [];
  await openRunStream(lab, lab.runId, 1, (f) => seen.push(f));
  await until(() => seen.length === 1);
  expect(seen).toEqual([
    expect.objectContaining({
      seq: 2,
      event: expect.objectContaining({
        event: "snapshot",
        snapshot: expect.objectContaining({ lastEventSeq: 2 }),
      }),
    }),
  ]);
});

it("resumes from Last-Event-ID, the header a reconnecting browser sends — not just the query parameter", async () => {
  // `EventSource` reconnects on its own after a dropped connection and
  // carries the last id it saw in this header; nothing in a page sets the
  // query parameter on that reconnect, so a route that only reads the query
  // parameter would answer it with a full replay instead of a resume.
  const lab = await labWithRunInFlight();
  await postFrames(lab, [
    { seq: 1, event: { event: "assistant-text", text: "one", partial: true } },
    { seq: 2, event: { event: "assistant-text", text: "two", partial: true } },
  ]);
  const seen: RunEventFrame[] = [];
  await openRunStream(lab, lab.runId, undefined, (f) => seen.push(f), undefined, {
    "last-event-id": "1",
  });
  await until(() => seen.length === 1);
  expect(seen).toEqual([
    expect.objectContaining({
      seq: 2,
      event: expect.objectContaining({
        event: "snapshot",
        snapshot: expect.objectContaining({ lastEventSeq: 2 }),
      }),
    }),
  ]);
});

it("starts a resumed stream with one authoritative snapshot and never republishes a retried frame", async () => {
  const lab = await labWithRunInFlight();
  await postFrames(lab, [
    { seq: 1, event: { event: "assistant-text", text: "one", partial: false } },
  ]);
  const seen: RunEventFrame[] = [];
  await openRunStream(lab, lab.runId, 0, (frame) => seen.push(frame));
  await until(() => seen.length === 1);

  await postFrames(lab, [
    { seq: 1, event: { event: "assistant-text", text: "one", partial: false } },
    { seq: 2, event: { event: "assistant-text", text: "two", partial: false } },
  ]);
  await until(() => seen.length === 2);
  expect(seen.map((frame) => ({ seq: frame.seq, event: frame.event.event }))).toEqual([
    { seq: 1, event: "snapshot" },
    { seq: 2, event: "assistant-text" },
  ]);
});

it("resumes from the durable snapshot after the relay replay window has rolled over", async () => {
  const lab = await labWithRunInFlight();
  const frames: RunEventFrame[] = Array.from({ length: 501 }, (_, index) => ({
    seq: index + 1,
    event: { event: "assistant-text", text: `${index + 1},`, partial: true },
  }));
  await postFrames(lab, frames);

  const seen: RunEventFrame[] = [];
  await openRunStream(lab, lab.runId, 0, (frame) => seen.push(frame));
  await until(() => seen.length === 1);
  expect(seen[0]).toEqual(expect.objectContaining({
    seq: 501,
    event: expect.objectContaining({
      event: "snapshot",
      snapshot: expect.objectContaining({ lastEventSeq: 501 }),
    }),
  }));
}, ROLLOVER_TEST_TIMEOUT_MS);

it("gates a fresh stream before the snapshot read so racing frames survive relay rollover", async () => {
  const lab = await labWithRunInFlight();
  await postFrames(lab, [
    { seq: 1, event: { event: "assistant-text", text: "before", partial: false } },
  ]);
  const racingFrames: RunEventFrame[] = Array.from({ length: 501 }, (_, index) => ({
    seq: index + 2,
    event: { event: "assistant-text", text: `${index + 2},`, partial: true },
  }));
  lab.raceNextSnapshotRead(() => {
    const accepted = recordRunFrames(lab.store, lab.runId, racingFrames, 1_800_000_010);
    lab.relay.publish(lab.runId, accepted);
  });

  const seen: RunEventFrame[] = [];
  await openRunStream(lab, lab.runId, undefined, (frame) => seen.push(frame));
  await until(() => seen.length === 502, ROLLOVER_TEST_TIMEOUT_MS);
  expect(seen[0]).toEqual(expect.objectContaining({
    seq: 1,
    event: expect.objectContaining({ event: "snapshot" }),
  }));
  expect(seen.slice(1).map((frame) => frame.seq)).toEqual(
    Array.from({ length: 501 }, (_, index) => index + 2),
  );
}, ROLLOVER_TEST_TIMEOUT_MS);

it("maps a daemon frame sequence gap to conflict without publishing it", async () => {
  const lab = await labWithRunInFlight();
  await postFrames(lab, [
    { seq: 1, event: { event: "assistant-text", text: "one", partial: false } },
  ]);
  const seen: RunEventFrame[] = [];
  await openRunStream(lab, lab.runId, undefined, (frame) => seen.push(frame));
  await until(() => seen.length === 1);

  const response = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({
      runId: lab.runId,
      frames: [{ seq: 3, event: { event: "assistant-text", text: "gap", partial: false } }],
    }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: `frame sequence gap for ${lab.runId}: expected 2, received 3`,
  });
  expect(seen).toHaveLength(1);
});

it("recovers an active run after a server rebuild and supplies a terminal snapshot when completion wins reattachment", async () => {
  const lab = await labWithRunInFlight();
  await postFrames(lab, [
    { seq: 1, event: { event: "assistant-text", text: "before restart", partial: false } },
  ]);

  const original = servers.pop()!;
  await original.close();
  const rebuilt = await freshLabServer(lab.dataDir);
  servers.push(rebuilt);
  const rebuiltLab = { ...lab, base: rebuilt.base, store: rebuilt.store };
  const ownerApi = apiFor(rebuilt.base, lab.ownerCookie);
  const [resumed] = await ownerApi.resumeRuns(lab.taskId);
  expect(resumed.snapshot).toEqual(expect.objectContaining({
    runId: lab.runId,
    lastEventSeq: 1,
    stream: [{ kind: "text", text: "before restart", block: "interim" }],
  }));

  await postFrames(rebuiltLab, [
    { seq: 2, event: { event: "completed", state: { state: "completed" } } },
  ]);
  const seen: RunEventFrame[] = [];
  let closed = false;
  await openRunStream(
    rebuiltLab,
    lab.runId,
    resumed.snapshot.lastEventSeq,
    (frame) => seen.push(frame),
    () => (closed = true),
  );
  await until(() => closed);
  expect(seen).toEqual([
    expect.objectContaining({
      seq: 2,
      event: expect.objectContaining({
        event: "snapshot",
        snapshot: expect.objectContaining({ state: { state: "completed" }, lastEventSeq: 2 }),
      }),
    }),
  ]);
  expect(await ownerApi.resumeRuns(lab.taskId)).toEqual([]);
  expect((await ownerApi.getTask(lab.taskId)).turns.map((turn) => turn.runId)).toEqual([lab.runId]);
});

it("writes a log entry into turn_steps as it arrives, not at the end", async () => {
  const lab = await labWithRunInFlight();
  await postFrames(lab, [
    {
      seq: 1,
      event: {
        event: "log-entry",
        entry: { ts: 1, toolUseId: "t1", tool: "Read", input: {}, decision: "ran", isError: false },
      },
    },
  ]);
  // Before any completion: a turn a browser joins late must already show
  // the steps that happened before it arrived.
  expect(lab.store.all(`SELECT tool_use_id FROM turn_steps`)).toEqual([{ tool_use_id: "t1" }]);
  expect(lab.store.get(`SELECT status FROM turns WHERE id = ?`, [lab.runId])?.status).toBe("running");
});

it("ends the turn and closes the stream on a completed frame", async () => {
  const lab = await labWithRunInFlight();
  let closed = false;
  await openRunStream(lab, lab.runId, undefined, () => {}, () => (closed = true));
  await postFrames(lab, [{ seq: 1, event: { event: "completed", state: { state: "completed" } } }]);
  await until(() => closed);
  const turn = lab.store.get(`SELECT status, ended_ts FROM turns WHERE id = ?`, [lab.runId])!;
  expect(turn.status).toBe("ok");
  expect(turn.ended_ts).not.toBeNull();
  const refreshed = await apiFor(lab.base, lab.ownerCookie).getTask(lab.taskId);
  expect(refreshed.task).toMatchObject({
    status: "in-review",
    runCount: 1,
    lastRunStatus: "ok",
  });
});

it("gives a fresh browser opening a finished run one terminal snapshot and a close signal", async () => {
  // A run's viewer arriving after it settled is the ordinary case, not a
  // rare one — nobody has to be watching at the exact moment a turn ends
  // for a later visit to still work.
  const lab = await labWithRunInFlight();
  await postFrames(lab, [
    { seq: 1, event: { event: "assistant-text", text: "hi", partial: true } },
    { seq: 2, event: { event: "completed", state: { state: "completed" } } },
  ]);
  const seen: RunEventFrame[] = [];
  let closed = false;
  await openRunStream(lab, lab.runId, undefined, (f) => seen.push(f), () => (closed = true));
  await until(() => closed);
  expect(seen).toEqual([
    expect.objectContaining({
      seq: 2,
      event: expect.objectContaining({
        event: "snapshot",
        snapshot: expect.objectContaining({
          state: { state: "completed" },
          stream: [{ kind: "text", text: "hi", block: "interim" }],
          lastEventSeq: 2,
        }),
      }),
    }),
  ]);
});

it("refuses a run stream to somebody who does not own the machine", async () => {
  const lab = await labWithRunInFlight(); // machine is the owner's
  const res = await fetch(`${lab.base}/runs/${lab.runId}/events`, {
    headers: { cookie: lab.memberCookie },
  });
  expect(res.status).toBe(403);
});

it("keeps a run's frames out of the workspace change log", async () => {
  // Fourteen screens re-read on every change; a token stream published as
  // one would make them re-read on every chunk.
  const lab = await labWithRunInFlight();
  const before = lab.store.get(`SELECT COUNT(*) AS n FROM change_log`)!.n as number;
  const frames: RunEventFrame[] = Array.from({ length: 20 }, (_, i) => ({
    seq: i + 1,
    event: { event: "assistant-text", text: `chunk ${i}`, partial: true },
  }));
  await postFrames(lab, frames);
  expect(lab.store.get(`SELECT COUNT(*) AS n FROM change_log`)!.n).toBe(before);
});
