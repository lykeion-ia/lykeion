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
import { createRunRelay } from "./run-relay";
import { createRequestListener } from "./http";
import { apiFor, signUpOwner } from "./test-support/server-api";
import type { Store } from "./store/store";

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
function freshLabServer(): Promise<{ base: string; store: Store; close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-run-stream-"));
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

  const listener = createRequestListener({ store, config, secure: false, indexHtml, channel, openStreams, runs: relay });
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
  store: Store;
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

  return { base: server.base, store: server.store, ownerCookie, memberCookie, token, runId };
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

/** Polls `predicate` until it holds, the way a subscriber with no signal for
 *  "nothing more is coming right now" has to. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the condition to hold");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it("fans a frame a machine posted out to a subscribed browser", async () => {
  const lab = await labWithRunInFlight();
  const seen: RunEventFrame[] = [];
  await openRunStream(lab, lab.runId, undefined, (f) => seen.push(f));
  await postFrames(lab, [{ seq: 1, event: { event: "assistant-text", text: "hi", partial: true } }]);
  await until(() => seen.length === 1);
  expect(seen[0]!.event).toEqual({ event: "assistant-text", text: "hi", partial: true });
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
  // Only what it missed — a replay that repeats what the browser already
  // rendered would duplicate the prose on screen.
  expect(seen.map((f) => f.seq)).toEqual([2]);
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
  expect(seen.map((f) => f.seq)).toEqual([2]);
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
});

it("gives a browser opening a finished run its whole history and a close signal", async () => {
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
  expect(seen.map((f) => f.seq)).toEqual([1, 2]);
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
