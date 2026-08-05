import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@lykeion/api";
import { backoffDelayMs } from "./lab";
import { startRuns, type RunSubsystem } from "./runs";

const STUB = join(import.meta.dirname, "test-support", "stub-acp-agent.ts");
const running: RunSubsystem[] = [];
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  // Unconditional, not only on a test's own success path: a test whose
  // `until()` throws first must not leave its script sitting in the
  // environment for whatever runs next in this same file to trip over.
  delete process.env.LYKEION_STUB_SCRIPT;
  delete process.env.LYKEION_STUB_EXIT_MARKER;
});

/** A lab that holds a command stream open and records what comes back. */
async function stubLab(commands: unknown[]) {
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  const live: string[][] = [];
  let commandStream: import("node:http").ServerResponse | undefined;
  let seq = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      commandStream = res;
      for (const c of commands) {
        seq += 1;
        res.write(`event: command\ndata: ${JSON.stringify({ seq, command: c })}\n\n`);
      }
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      if (req.url === "/daemon/run/events")
        events.push(parsed as unknown as { runId: string; frames: never[] });
      if (req.url === "/daemon/run/live") live.push(parsed.runIds as string[]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  return {
    base: `http://127.0.0.1:${port}`,
    events,
    live,
    commandConnected(): boolean {
      return commandStream !== undefined;
    },
    send(command: unknown): void {
      if (!commandStream) throw new Error("the command stream is not connected");
      seq += 1;
      commandStream.write(`event: command\ndata: ${JSON.stringify({ seq, command })}\n\n`);
    },
  };
}

function subsystem(base: string, dataDir: string) {
  const r = startRuns({
    lab: base,
    token: "machine-token",
    dataDir,
    adapterFor: () => ({
      command: process.execPath,
      args: ["--experimental-strip-types", STUB],
    }),
  });
  running.push(r);
  return r;
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${what} never happened`);
}

it("says which runs it holds as soon as it connects", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);
  await until(() => lab.live.length > 0, "a live report");
  expect(lab.live[0]).toEqual([]);
});

it("takes a start-run command and posts the turn's events back", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_1",
      studyId: "s_cmp",
      sessionId: "se_1",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);

  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a completed turn",
  );
  const frames = lab.events.flatMap((e) => e.frames);
  expect(frames.some((f) => f.event.event === "assistant-text")).toBe(true);
  // Numbered by the only producer there is, so a retry cannot duplicate one.
  expect(frames.map((f) => f.seq)).toEqual([...frames.map((f) => f.seq)].sort((a, b) => a - b));
  expect(new Set(frames.map((f) => f.seq)).size).toBe(frames.length);
});

it("refuses a start-run for an agent this machine has no adapter for", async () => {
  const lab = await stubLab([
    { type: "start-run", runId: "run_2", studyId: "s_cmp", sessionId: "se_2", agent: "nope", prompt: "go", grants: [] },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = startRuns({ lab: lab.base, token: "t", dataDir: data, adapterFor: () => undefined });
  running.push(r);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a refusal",
  );
  const done = lab.events
    .flatMap((e) => e.frames)
    .find((f) => f.event.event === "completed") as { event: { state: { state: string; reason?: string } } };
  expect(done.event.state.state).toBe("failed");
  expect(done.event.state.reason).toMatch(/nope/);
});

it("refuses a start-run command missing required fields", async () => {
  const lab = await stubLab([{ type: "start-run", runId: "run_bad", agent: "claude", grants: [] }]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a refusal",
  );
  const done = lab.events
    .flatMap((e) => e.frames)
    .find((f) => f.event.event === "completed") as { event: { state: { state: string; reason?: string } } };
  expect(done.event.state.state).toBe("failed");
  expect(done.event.state.reason).toMatch(/studyId|sessionId|prompt/);
});

it("posts the terminal frame for a turn that was still running when stopped", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "t1", title: "Write /tmp/somewhere" },
  ]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_mid",
      studyId: "s_cmp",
      sessionId: "se_mid",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(lab.base, data);

  // Proof the turn is genuinely still running: the subprocess is sitting
  // inside `session/request_permission`, holding `session/prompt` open —
  // nothing will ever answer it on its own.
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "permission-card")),
    "a permission card",
  );

  await r.stop();

  const frames = lab.events.flatMap((e) => e.frames);
  const completed = frames.find((f) => f.event.event === "completed") as
    | { event: { state: { state: string } } }
    | undefined;
  expect(completed?.event.state.state).toBe("failed");
});

it("carries a run's own ending to the lab even when it starts only after stop's own wait has already begun", async () => {
  // stop() must not merely check what was already in flight the moment it
  // started waiting: a `completed` frame produced by closing a session — the
  // very thing this same shutdown just did — can be deferred behind an
  // ordinary batch that is already travelling to the lab, and only start its
  // own POST once that earlier one settles. A wait that only ever looks at
  // its original snapshot would move on and abort the connection out from
  // under a delivery that had only just begun.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "t1", title: "Write /tmp/somewhere" },
  ]);
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  let releaseFirst: (() => void) | undefined;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: 1,
          command: {
            type: "start-run",
            runId: "run_drain",
            studyId: "s_cmp",
            sessionId: "se_drain",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      if (req.url === "/daemon/run/events") {
        events.push(parsed as unknown as { runId: string; frames: never[] });
        if (!releaseFirst) {
          // Held open: the permission card's own immediate flush — the one
          // batch already in flight the moment `stop` looks at what it must
          // wait on.
          releaseFirst = () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
          };
          return;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(base, data);

  await until(() => releaseFirst !== undefined, "the first batch to be held open");

  const stopping = r.stop();
  // Comfortably under FINAL_FLUSH_GRACE_MS (2s): long enough for stop's own
  // synchronous work — closing the session, which rejects the held-open
  // `session/prompt` call and produces the run's `completed` frame — to have
  // already happened, so that frame is sitting in `pending` behind the still
  // -held-open first batch by the time this releases it.
  await new Promise((resolve) => setTimeout(resolve, 200));
  releaseFirst!();
  await stopping;

  expect(events.flatMap((e) => e.frames).find((f) => f.event.event === "completed")).toBeDefined();
});

it("does not act on a start-run command a second time when a reconnect replays it", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const command = {
    type: "start-run",
    runId: "run_replay",
    studyId: "s_cmp",
    sessionId: "se_replay",
    agent: "claude",
    prompt: "go",
    grants: [],
  };
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  const commandUrls: string[] = [];
  let connections = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      connections += 1;
      commandUrls.push(req.url);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: command\ndata: ${JSON.stringify({ seq: 1, command })}\n\n`);
      // The first connection drops before this daemon can prove it saw the
      // command — exactly the situation a lab's own reconnect logic would
      // answer by replaying it, which the second connection does here.
      if (connections === 1) res.end();
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      if (req.url === "/daemon/run/events")
        events.push(parsed as unknown as { runId: string; frames: never[] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(base, data);

  await until(() => connections >= 2, "a second connection replaying the command");
  await until(
    () => events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a completed turn",
  );
  // Room for the replayed delivery to also run its course and post its own
  // completed frame, if it were (wrongly) acted on a second time.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const completedCount = events.flatMap((e) => e.frames).filter((f) => f.event.event === "completed").length;
  expect(completedCount).toBe(1);
  // The reconnect itself carries a cursor: the seq of the last command this
  // daemon handled (1, from the first connection), not a blank slate.
  expect(commandUrls[1]).toContain("cursor=1");
});

it("stops calling the lab once it says this machine has been removed", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no such machine" }));
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = startRuns({ lab: base, token: "t", dataDir: data, adapterFor: () => undefined });
  running.push(r);

  await until(() => hits > 0, "the lab to be called at all");
  const afterFirstRefusal = hits;
  // Long enough to span the first retry's own backoff, so a bug that kept
  // retrying regardless of the refusal would show up here as a second call.
  await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(1) + 300));
  expect(hits).toBe(afterFirstRefusal);
});

it("posts a grant to the lab when a card is answered for the Study", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "t1", title: "Write /work/rna-seq" },
  ]);
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  const grants: Array<{ runId: string; path: string; mode: string }> = [];
  let sendCommand: ((c: unknown) => void) | undefined;
  let commandSeq = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      commandSeq += 1;
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: commandSeq,
          command: {
            type: "start-run",
            runId: "run_g",
            studyId: "s_cmp",
            sessionId: "se_g",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      // Held open so a decision can be sent down it once a card appears,
      // the way the lab's own command stream stays open across a turn.
      sendCommand = (c) => {
        commandSeq += 1;
        res.write(`event: command\ndata: ${JSON.stringify({ seq: commandSeq, command: c })}\n\n`);
      };
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      if (req.url === "/daemon/run/events")
        events.push(parsed as unknown as { runId: string; frames: never[] });
      if (req.url === "/daemon/run/grant")
        grants.push(parsed as unknown as { runId: string; path: string; mode: string });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(base, data);

  await until(() => sendCommand !== undefined, "the command stream to be ready");
  await until(
    () => events.some((e) => e.frames.some((f) => f.event.event === "permission-card")),
    "a permission card",
  );
  const card = events
    .flatMap((e) => e.frames)
    .find((f) => f.event.event === "permission-card") as { event: { request: { id: string } } };

  sendCommand!({
    type: "decision",
    runId: "run_g",
    decision: {
      action: "permission",
      requestId: card.event.request.id,
      decision: { decision: "allow", scope: "study" },
    },
  });

  await until(() => grants.length > 0, "a grant posted to the lab");
  expect(grants[0]).toEqual({ runId: "run_g", path: "/work/rna-seq", mode: "write" });
});

it("waits for a grant still travelling to the lab before stop finishes", async () => {
  // A grant is a durable decision, not a replaceable event batch — losing
  // one to a shutdown that did not wait for it would mean the researcher
  // answered "for the Study" and gets asked again with no trace of having
  // already said yes.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "t1", title: "Write /work/rna-seq" },
  ]);
  const grants: Array<{ runId: string; path: string; mode: string }> = [];
  let releaseGrant: (() => void) | undefined;
  let sendCommand: ((c: unknown) => void) | undefined;
  let commandSeq = 0;
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      commandSeq += 1;
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: commandSeq,
          command: {
            type: "start-run",
            runId: "run_wait",
            studyId: "s_cmp",
            sessionId: "se_wait",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      sendCommand = (c) => {
        commandSeq += 1;
        res.write(`event: command\ndata: ${JSON.stringify({ seq: commandSeq, command: c })}\n\n`);
      };
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      if (req.url === "/daemon/run/events") {
        events.push(parsed as unknown as { runId: string; frames: never[] });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{}");
      }
      if (req.url === "/daemon/run/grant") {
        grants.push(parsed as unknown as { runId: string; path: string; mode: string });
        // Held open on purpose: this response is not sent until the test
        // calls `releaseGrant`, so the daemon's own POST looks exactly like
        // one still in flight at the moment `stop` is called.
        releaseGrant = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        };
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(base, data);

  await until(() => sendCommand !== undefined, "the command stream to be ready");
  await until(
    () => events.some((e) => e.frames.some((f) => f.event.event === "permission-card")),
    "a permission card",
  );
  const card = events
    .flatMap((e) => e.frames)
    .find((f) => f.event.event === "permission-card") as { event: { request: { id: string } } };
  sendCommand!({
    type: "decision",
    runId: "run_wait",
    decision: {
      action: "permission",
      requestId: card.event.request.id,
      decision: { decision: "allow", scope: "study" },
    },
  });

  await until(() => grants.length > 0, "the grant to reach the lab");
  await until(() => releaseGrant !== undefined, "the grant response to be held open");

  let stopped = false;
  const stopping = r.stop().then(() => {
    stopped = true;
  });
  // Comfortably under `FINAL_FLUSH_GRACE_MS` (2s), so this is not merely
  // observing `stop` still running — it is proving it has not given up and
  // moved on while the grant's own response is deliberately withheld.
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(stopped).toBe(false);

  releaseGrant!();
  await stopping;
  expect(stopped).toBe(true);

});

it("answers a card 'once' or 'for this conversation' without ever posting a grant", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "t1", title: "Write /work/rna-seq" },
    { ask: "permission", toolCallId: "t2", title: "Write /work/other" },
  ]);
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  const grants: Array<{ runId: string; path: string; mode: string }> = [];
  let sendCommand: ((c: unknown) => void) | undefined;
  let commandSeq = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      commandSeq += 1;
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: commandSeq,
          command: {
            type: "start-run",
            runId: "run_h",
            studyId: "s_cmp",
            sessionId: "se_h",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      sendCommand = (c) => {
        commandSeq += 1;
        res.write(`event: command\ndata: ${JSON.stringify({ seq: commandSeq, command: c })}\n\n`);
      };
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      if (req.url === "/daemon/run/events")
        events.push(parsed as unknown as { runId: string; frames: never[] });
      if (req.url === "/daemon/run/grant")
        grants.push(parsed as unknown as { runId: string; path: string; mode: string });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(base, data);

  await until(() => sendCommand !== undefined, "the command stream to be ready");
  await until(
    () => events.some((e) => e.frames.some((f) => f.event.event === "permission-card")),
    "the first permission card",
  );
  const firstCard = events.flatMap((e) => e.frames).find((f) => f.event.event === "permission-card") as {
    event: { request: { id: string } };
  };
  sendCommand!({
    type: "decision",
    runId: "run_h",
    decision: {
      action: "permission",
      requestId: firstCard.event.request.id,
      decision: { decision: "allow", scope: "once" },
    },
  });

  await until(
    () => events.flatMap((e) => e.frames).filter((f) => f.event.event === "permission-card").length >= 2,
    "the second permission card",
  );
  const secondCard = events
    .flatMap((e) => e.frames)
    .filter((f) => f.event.event === "permission-card")[1] as { event: { request: { id: string } } };
  sendCommand!({
    type: "decision",
    runId: "run_h",
    decision: {
      action: "permission",
      requestId: secondCard.event.request.id,
      decision: { decision: "allow", scope: "conversation" },
    },
  });

  await until(
    () => events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "the turn to complete",
  );
  expect(grants).toEqual([]);
});

it("fails a turn when the adapter dies, with its stderr as the reason", async () => {
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_x",
      studyId: "s_cmp",
      sessionId: "se_x",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = startRuns({
    lab: lab.base,
    token: "t",
    dataDir: data,
    adapterFor: () => ({
      command: process.execPath,
      args: ["-e", "process.stderr.write('adapter blew up\\n');process.exit(1)"],
    }),
  });
  running.push(r);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a failure",
  );
  const done = lab.events
    .flatMap((e) => e.frames)
    .find((f) => f.event.event === "completed") as { event: { state: { state: string; reason?: string } } };
  expect(done.event.state.state).toBe("failed");
  expect(done.event.state.reason).toMatch(/adapter blew up/);
});

/** A lab that opens the command stream normally — handing over one start-run
 *  right away — and answers every other daemon call at once, except
 *  `/daemon/run/events`: that request is simply never answered. What a
 *  suspended machine or a load balancer that lost its backend looks like
 *  from here. */
async function deadLab(): Promise<{ base: string }> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: 1,
          command: {
            type: "start-run",
            runId: "run_chatty",
            studyId: "s_cmp",
            sessionId: "se_chatty",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      return;
    }
    if (req.url === "/daemon/run/events") return; // accepted, never answered
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  return { base: `http://127.0.0.1:${port}` };
}

it("fails a turn rather than dropping events when the outbound queue overflows", async () => {
  // A lab that accepts the stream and answers nothing, against a script —
  // several thousand message chunks, well past the outbound queue's own
  // bound, with no `endTurn` directive — that never stops talking. The
  // wrong outcome is a turn that looks complete having quietly lost its
  // middle.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify(
    Array.from({ length: 3000 }, () => ({ emit: "agent_message_chunk", text: "chatter " })),
  );
  const lab = await deadLab();
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(lab.base, data);
  await until(() => r.lastFailure() !== undefined, "an overflow failure");
  expect(r.lastFailure()).toMatch(/could not be sent/);
});

it("gives a run still queued behind another its own honest ending when stop is called before its turn begins", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "t1", title: "Write /tmp/somewhere" },
  ]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_first",
      studyId: "s_cmp",
      sessionId: "se_queue",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
    {
      type: "start-run",
      runId: "run_second",
      studyId: "s_cmp",
      sessionId: "se_queue",
      agent: "claude",
      prompt: "go again",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(lab.base, data);

  // Proof the first turn is genuinely still running, with the second queued
  // behind it on the same session: nothing will answer the open permission
  // request on its own.
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "permission-card")),
    "a permission card",
  );

  await r.stop();

  const completedFor = (runId: string) =>
    lab.events
      .filter((e) => e.runId === runId)
      .flatMap((e) => e.frames)
      .find((f) => f.event.event === "completed") as { event: { state: { state: string } } } | undefined;

  expect(completedFor("run_first")?.event.state.state).toBe("failed");
  expect(completedFor("run_second")?.event.state.state).toBe("failed");
});

it("surfaces a run's own ending through lastFailure when the lab never accepts it, rather than swallowing it silently", async () => {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: 1,
          command: {
            type: "start-run",
            runId: "run_lost",
            studyId: "s_cmp",
            sessionId: "se_lost",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      if (req.url === "/daemon/run/events") {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "nope" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(base, data);
  await until(() => r.lastFailure() !== undefined, "the ending's own delivery failure");
  expect(r.lastFailure()).toMatch(/could not be delivered/);
});

it("reports a live session's own working directory, so a sweep never removes it out from under a running adapter", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_live_dir",
      studyId: "s_cmp",
      sessionId: "se_live_dir",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(lab.base, data);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a completed turn",
  );
  expect(r.liveSessionDirs()).toEqual([join(data, "studies", "s_cmp", "sessions", "se_live_dir")]);
});

it("retires a session whose stop was unacknowledged and keeps a later turn healthy", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const oldMarker = join(data, "old.closed");
  const freshMarker = join(data, "fresh.closed");
  process.env.LYKEION_STUB_EXIT_MARKER = oldMarker;
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { sleep: 120 },
    { ask: "permission", toolCallId: "late", title: "Write /late/out.csv" },
    { endTurn: "end_turn" },
  ]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_poisoned",
      studyId: "s_cmp",
      sessionId: "se_reused",
      agent: "claude",
      prompt: "first",
      grants: [],
    },
  ]);
  const r = startRuns({
    lab: lab.base,
    token: "machine-token",
    dataDir: data,
    cancelGraceMs: 20,
    adapterFor: () => ({ command: process.execPath, args: ["--experimental-strip-types", STUB] }),
  });
  running.push(r);
  await until(() => lab.commandConnected(), "the command stream");
  await until(
    () => lab.events.some((post) => post.runId === "run_poisoned" && post.frames.some(
      (frame) => frame.event.event === "state" && frame.event.state.state === "planning",
    )),
    "the first turn to start",
  );
  lab.send({ type: "cancel", runId: "run_poisoned" });
  await until(
    () => lab.events.some((post) => post.runId === "run_poisoned" && post.frames.some(
      (frame) => frame.event.event === "completed" && frame.event.state.state === "cancelled" && frame.event.state.unacknowledged,
    )),
    "an unacknowledged stop",
  );

  process.env.LYKEION_STUB_EXIT_MARKER = freshMarker;
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "healthy", title: "Write /fresh/out.csv" },
    { endTurn: "end_turn" },
  ]);
  lab.send({
    type: "start-run",
    runId: "run_fresh",
    studyId: "s_cmp",
    sessionId: "se_reused",
    agent: "claude",
    prompt: "second",
    grants: [],
  });
  await until(
    () => lab.events.some((post) => post.runId === "run_fresh" && post.frames.some(
      (frame) => frame.event.event === "permission-card" && frame.event.request.tool === "healthy",
    )),
    "the fresh turn's permission card",
  );
  const card = lab.events.flatMap((post) => post.runId === "run_fresh" ? post.frames : []).find(
    (frame) => frame.event.event === "permission-card",
  )!.event;
  if (card.event !== "permission-card") throw new Error("permission card missing");
  lab.send({
    type: "decision",
    runId: "run_fresh",
    decision: {
      action: "permission",
      requestId: card.request.id,
      decision: { decision: "allow", scope: "once" },
    },
  });
  await until(
    () => lab.events.some((post) => post.runId === "run_fresh" && post.frames.some(
      (frame) => frame.event.event === "completed" && frame.event.state.state === "completed",
    )),
    "the fresh turn to complete",
  );
  expect(lab.events.flatMap((post) => post.runId === "run_fresh" ? post.frames : []).some(
    (frame) => frame.event.event === "log-entry" && frame.event.entry.toolUseId === "late",
  )).toBe(false);

  await r.stop();
  expect(existsSync(oldMarker)).toBe(true);
  expect(existsSync(freshMarker)).toBe(true);
});
