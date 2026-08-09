import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, TurnState } from "@lykeion/api";
import { backoffDelayMs } from "./lab";
import type { KernelHost } from "./kernel-host";
import { PROTOCOL_VERSION } from "./kernel-protocol";
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
  delete process.env.LYKEION_STUB_EXIT_DELAY_MS;
  delete process.env.LYKEION_STUB_SESSION_NEW_MARKER;
  delete process.env.LYKEION_STUB_SESSION_NEW_PARAMS;
  delete process.env.LYKEION_STUB_SESSION_NEW_DELAY_MS;
  delete process.env.LYKEION_STUB_PROMPT_MARKER;
});

/** A lab that holds a command stream open and records what comes back. */
async function stubLab(commands: unknown[]) {
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  const live: string[][] = [];
  const cells: Record<string, unknown>[] = [];
  const kernelListReplies: Array<{ requestId: string; kernels: unknown[] }> = [];
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
      if (req.url === "/daemon/cell") cells.push(parsed);
      if (req.url === "/daemon/kernel/list")
        kernelListReplies.push(parsed as { requestId: string; kernels: unknown[] });
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
    cells,
    kernelListReplies,
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

/** A file the stub can write while it is confined. Every run is sandboxed,
 *  and the one directory a run may write is its Task's — so a marker the
 *  stub records its own progress in has to live there, created up front
 *  because the stub only appends. */
function markerIn(dataDir: string, name: string): string {
  const taskDir = join(`${dataDir}-work`, "studies", "s_cmp", "tasks", "t_cmp");
  mkdirSync(taskDir, { recursive: true });
  dirs.push(`${dataDir}-work`);
  return join(taskDir, name);
}

function subsystem(
  base: string,
  dataDir: string,
  kernelHost?: () => KernelHost,
  kernelReachMs?: number,
) {
  const r = startRuns({
    lab: base,
    token: "machine-token",
    workDir: `${dataDir}-work`,
    dataDir,
    adapterFor: () => ({
      command: process.execPath,
      args: ["--experimental-strip-types", STUB],
    }),
    ...(kernelHost === undefined ? {} : { kernelHost }),
    ...(kernelReachMs === undefined ? {} : { kernelReachMs }),
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

/** Every `ahead` a run's `queued` frames have carried, in the order they were
 *  published. */
function queuedPositions(
  lab: { events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> },
  runId: string,
): number[] {
  return lab.events
    .filter((post) => post.runId === runId)
    .flatMap((post) => post.frames)
    .map((frame) => frame.event)
    .filter((event): event is Extract<RunEvent, { event: "state" }> => event.event === "state")
    .map((event) => event.state)
    .filter((state): state is Extract<TurnState, { state: "queued" }> => state.state === "queued")
    .map((state) => state.ahead);
}

/** A kernel host that answers, and says in what order it was asked.
 *
 *  `configuring` holds the boundary's reply open for as long as a test wants,
 *  which is what makes "before" and "after" observable at all: a machine that
 *  did not wait for it would have opened its session while this was still
 *  unanswered. */
function stubKernelHost(configuring: number, protocol: unknown = PROTOCOL_VERSION) {
  const asked: string[] = [];
  const answering: { configured?: { token?: string } } = {};
  const cellListeners: Array<(params: unknown) => void> = [];
  const host: KernelHost = {
    call: async (method, params) => {
      asked.push(method);
      if (method === "host.hello") return { protocol, environment: "python", reads: [] };
      if (method === "kernel.configure_session") {
        answering.configured = params as { token?: string };
        await new Promise((resolve) => setTimeout(resolve, configuring));
        asked.push("the boundary landed");
        return {};
      }
      return {};
    },
    on: (method, handler) => {
      if (method === "cell") cellListeners.push(handler);
    },
    stop: () => Promise.resolve(),
    get running() {
      return true;
    },
    stderrTail: () => "",
  };
  return {
    host,
    asked,
    get configured() {
      return answering.configured;
    },
    /** Fires this host's own "cell" notification at whoever wired
     *  `forwardKernelCells` onto it, the way `kernel-host.ts` would once the
     *  real process wrote one to its stdout. */
    announceCell(params: unknown): void {
      for (const listener of cellListeners) listener(params);
    },
  };
}

const startRunOn = (runId: string) => ({
  type: "start-run",
  runId,
  agent: "claude",
  studyId: "s_cmp",
  taskId: "t_cmp",
  sessionId: "se_1",
  prompt: "go",
});

it("gives a session a kernel before it starts the agent it names one to", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const opened = markerIn(data, "session-opened");
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = opened;
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(400);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_kernels"));

  await until(() => kernels.asked.includes("the boundary landed"), "the boundary landing");
  // The agent has not been started yet, so no tool call of its own could have
  // reached a kernel this machine had not described a boundary for.
  expect(existsSync(opened)).toBe(false);

  await until(() => existsSync(named), "the session opening");
  const params = JSON.parse(readFileSync(named, "utf8")) as {
    mcpServers: Array<{ name: string; args: string[]; env: Array<{ name: string; value: string }> }>;
    _meta?: unknown;
  };
  expect(kernels.asked).toEqual([
    "host.hello",
    "kernel.configure_session",
    "the boundary landed",
  ]);
  expect(params.mcpServers.map((server) => server.name)).toEqual(["lykeion"]);
  // Present and empty, not absent: the ACP schema requires `env`, and the
  // real adapters silently drop an entry without it — a session that opens
  // with no kernel tools and no error anywhere.
  expect(params.mcpServers[0]?.env).toEqual([]);
  // Alongside the bridge, the run's settings sources are emptied and its MCP
  // config held strict — a claude adapter left to its defaults loads the
  // machine owner's own MCP servers and account connectors into the very
  // session the bridge was supposed to be the whole tool set of.
  expect(params._meta).toMatchObject({
    claudeCode: { options: { settingSources: [], strictMcpConfig: true } },
  });
  expect(params.mcpServers[0]?.args).toContain("--session");
  expect(params.mcpServers[0]?.args).toContain("se_1");
  // The word the relay carries is the one the host was told to expect, and
  // nothing else on this machine has it. A relay holding some other word is a
  // relay this session's kernels were not given to.
  const args = params.mcpServers[0]?.args ?? [];
  const carried = args[args.indexOf("--token") + 1];
  expect(carried).toBeTruthy();
  expect(kernels.configured?.token).toBe(carried);
});

it("forwards a cell the kernel host announces to the run currently taking its session's turn", async () => {
  // Held open past the point the cell is announced: `runOfSession` only
  // names this run for as long as its turn is actually the one running, and
  // a script that ended the turn immediately would race that window closed
  // before the announcement below ever reached it.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ sleep: 500 }, { endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_cell"));

  // Not the boundary landing alone: this run's own turn has to actually be
  // the one running on its session — `runOfSession` names it only once the
  // whole session has opened, which is what the marker below confirms.
  await until(() => existsSync(named), "the session opening");

  kernels.announceCell({
    sessionId: "se_1",
    taskId: "t_cmp",
    kernelId: "k_1",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 1,
    source: "1 + 1",
    origin: { surface: "agent", by: "a_claude" },
    ok: true,
    wallMs: 4,
    ts: 99,
    outputs: [],
  });

  await until(
    () =>
      lab.events.some(
        (post) =>
          post.runId === "run_cell" &&
          post.frames.some((frame) => frame.event.event === "cell"),
      ),
    "the cell reaching the lab",
  );

  const forwarded = lab.events
    .filter((post) => post.runId === "run_cell")
    .flatMap((post) => post.frames)
    .map((frame) => frame.event)
    .find((event): event is Extract<RunEvent, { event: "cell" }> => event.event === "cell")!;
  expect(forwarded.cell.source).toBe("1 + 1");
  expect(forwarded.cell.kernelId).toBe("k_1");
  expect(typeof forwarded.cell.id).toBe("string");
  // The session and Task the announcement named do not travel any further
  // than the routing decision itself.
  expect("sessionId" in forwarded.cell).toBe(false);
  expect("taskId" in forwarded.cell).toBe(false);
  // A turn whose log holds no kernel call leaves the cell unjoined rather
  // than joined to a guess.
  expect("toolUseId" in forwarded.cell).toBe(false);
});

it("joins a forwarded cell to the kernel call the session's own log says it arrived as", async () => {
  // The announcement below carries no toolUseId of its own — a provider that
  // forwarded nothing down the MCP channel — so the daemon reads the turn's
  // log instead, where the adapter announced the very call the cell ran as.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    {
      emit: "tool_call",
      toolCallId: "toolu_x",
      title: "mcp__lykeion__run_python",
      rawInput: { code: "1 + 1" },
    },
    { sleep: 500 },
    { endTurn: "end_turn" },
  ]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_joined_cell"));
  await until(() => existsSync(named), "the session opening");
  // The claim reads the turn's log, so the call has to have reached it —
  // announced to the lab is announced to the log, and later than it.
  await until(
    () =>
      lab.events.some(
        (post) =>
          post.runId === "run_joined_cell" &&
          post.frames.some((frame) => frame.event.event === "log-entry"),
      ),
    "the kernel call reaching the log",
  );

  kernels.announceCell({
    sessionId: "se_1",
    taskId: "t_cmp",
    kernelId: "k_1",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 1,
    source: "1 + 1",
    origin: { surface: "agent", by: "a_claude" },
    ok: true,
    wallMs: 4,
    ts: 99,
    outputs: [],
  });

  await until(
    () =>
      lab.events.some(
        (post) =>
          post.runId === "run_joined_cell" &&
          post.frames.some((frame) => frame.event.event === "cell"),
      ),
    "the cell reaching the lab",
  );

  const forwarded = lab.events
    .filter((post) => post.runId === "run_joined_cell")
    .flatMap((post) => post.frames)
    .map((frame) => frame.event)
    .find((event): event is Extract<RunEvent, { event: "cell" }> => event.event === "cell")!;
  expect(forwarded.cell.toolUseId).toBe("toolu_x");
});

it("drops a cell the kernel host announces for a session with no run currently taking its turn", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ sleep: 500 }, { endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_no_cell"));
  await until(() => existsSync(named), "the session opening");

  kernels.announceCell({
    sessionId: "se_never_started_a_turn",
    taskId: "t_cmp",
    kernelId: "k_1",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 1,
    source: "1 + 1",
    origin: { surface: "agent", by: "a_claude" },
    ok: true,
    wallMs: 4,
    ts: 99,
    outputs: [],
  });

  // A batched event waits out a 50ms flush window before it would ever
  // reach the lab at all — given long enough to have done that, and to have
  // shown up below, before this asserts it never did.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const cellFrames = lab.events
    .filter((post) => post.runId === "run_no_cell")
    .flatMap((post) => post.frames)
    .filter((frame) => frame.event.event === "cell");
  expect(cellFrames).toEqual([]);
});

it("opens the session anyway when this machine's kernels never answer", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  // A host that is up and says nothing — a cold environment still being
  // provisioned, or one wedged. Its calls settle only when the process behind
  // them dies, so without a deadline the turn never begins at all: no state
  // frame, no failure, nothing a researcher could act on.
  const silent: KernelHost = {
    call: () => new Promise(() => {}),
    on: () => {},
    stop: () => Promise.resolve(),
    get running() {
      return true;
    },
    stderrTail: () => "",
  };
  // Captured rather than left on the terminal, and then asserted: a machine
  // that quietly ran a turn without the kernels it was asked for is a machine
  // nobody can diagnose.
  const said: string[] = [];
  const reporting = console.error;
  console.error = (line: unknown) => said.push(String(line));
  try {
    subsystem(lab.base, data, () => silent, 50);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send(startRunOn("run_silent_kernels"));
    await until(() => existsSync(named), "the session opening");
  } finally {
    console.error = reporting;
  }

  expect(JSON.parse(readFileSync(named, "utf8"))).toMatchObject({ mcpServers: [] });
  expect(said.join("\n")).toContain("did not answer in time");
});

it("starts an agent with no tool server at all where this machine holds no kernels", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  subsystem(lab.base, data);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_no_kernels"));

  await until(() => existsSync(named), "the session opening");
  // A tool that leads to a kernel which could never start is worse than no
  // tool: the agent spends its turn discovering that for itself.
  expect(JSON.parse(readFileSync(named, "utf8"))).toMatchObject({ mcpServers: [] });
});

it("says which runs it holds as soon as it connects", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);
  await until(() => lab.live.length > 0, "a live report");
  expect(lab.live[0]).toEqual([]);
});

it("retires a local run the rebuilt server reports already terminal", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ wait: "cancel", timeoutMs: 10_000 }]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const promptMarker = markerIn(data, "prompt-called");
  process.env.LYKEION_STUB_PROMPT_MARKER = promptMarker;
  process.env.LYKEION_STUB_SESSION_NEW_DELAY_MS = "250";
  const liveReports: string[][] = [];
  let commandConnections = 0;
  let finalStream: import("node:http").ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      commandConnections += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (commandConnections === 1) {
        res.write(
          `data: ${JSON.stringify({
            seq: 1,
            command: {
              type: "start-run",
              runId: "run_migrated_terminal",
              studyId: "s_cmp",
              taskId: "t_cmp",
              sessionId: "se_migrated_terminal",
              agent: "claude",
              prompt: "must be retired",
              grants: [],
            },
          })}\n\n`,
        );
        res.end();
      } else if (commandConnections === 2) {
        res.end();
      } else {
        finalStream = res;
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { runIds?: string[] };
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/daemon/run/live") {
        const report = parsed.runIds ?? [];
        liveReports.push(report);
        res.end(JSON.stringify(
          liveReports.length === 2
            ? { retireRunIds: ["run_migrated_terminal"] }
            : {},
        ));
      } else {
        res.end("{}");
      }
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  subsystem(`http://127.0.0.1:${port}`, data);

  await until(() => liveReports.length >= 3, "the post-retirement live report");
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(liveReports[1]).toContain("run_migrated_terminal");
  expect(liveReports[2]).toEqual([]);
  expect(existsSync(promptMarker)).toBe(false);
  finalStream?.end();
});

it("closes a retired active child before releasing its same-session successor", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ wait: "cancel", timeoutMs: 10_000 }]);
  process.env.LYKEION_STUB_EXIT_DELAY_MS = "500";
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const sessions = markerIn(data, "sessions-started");
  const prompts = markerIn(data, "prompts-started");
  const exited = markerIn(data, "old-child-exited");
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = sessions;
  process.env.LYKEION_STUB_PROMPT_MARKER = prompts;
  process.env.LYKEION_STUB_EXIT_MARKER = exited;

  let commandConnections = 0;
  let firstStream: import("node:http").ServerResponse | undefined;
  let finalStream: import("node:http").ServerResponse | undefined;
  let liveReports = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      commandConnections += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (commandConnections === 1) {
        for (const [index, runId] of ["run_retired_active", "run_successor"].entries()) {
          res.write(
            `data: ${JSON.stringify({
              seq: index + 1,
              command: {
                type: "start-run",
                runId,
                studyId: "s_cmp",
                taskId: "t_cmp",
                sessionId: "se_shared_retirement",
                agent: "claude",
                prompt: runId,
                grants: [],
              },
            })}\n\n`,
          );
        }
        firstStream = res;
      } else {
        finalStream = res;
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/daemon/run/live") {
        liveReports += 1;
        res.end(JSON.stringify(
          liveReports === 2 ? { retireRunIds: ["run_retired_active"] } : {},
        ));
      } else {
        res.end("{}");
      }
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  subsystem(`http://127.0.0.1:${port}`, data);

  await until(() => existsSync(prompts), "the first turn to become active");
  firstStream?.end();
  await until(
    () =>
      existsSync(sessions) &&
      readFileSync(sessions, "utf8").trim().split("\n").filter(Boolean).length >= 2,
    "the successor to begin its session",
  );
  expect(existsSync(exited)).toBe(true);
  finalStream?.end();
});

it("takes a start-run command and posts the turn's events back", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_1",
      studyId: "s_cmp",
      taskId: "t_cmp",
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
  const r = startRuns({ lab: lab.base, token: "t", workDir: `${data}-work`, dataDir: data, adapterFor: () => undefined });
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
      taskId: "t_cmp",
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
            taskId: "t_cmp",
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
    taskId: "t_cmp",
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

it("resets its command cursor when an upgraded server first reports a relay generation", async () => {
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  const commandCursors: Array<string | null> = [];
  let liveReports = 0;
  let secondStream: import("node:http").ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      const cursor = new URL(req.url, "http://127.0.0.1").searchParams.get("cursor");
      commandCursors.push(cursor);
      const command = commandCursors.length === 1
        ? { type: "decision", runId: "run_already_seen", decision: { action: "cancel" } }
        : {
            type: "start-run",
            runId: "run_after_server_restart",
            studyId: "s_cmp",
            taskId: "t_cmp",
            sessionId: "se_after_server_restart",
            agent: "claude",
            prompt: "delivered from rebuilt relay",
            grants: [],
          };
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Each relay process starts its own sequence at one. Honour the daemon's
      // cursor exactly as the real route does: without a generation reset,
      // the rebuilt relay's first command is filtered out forever.
      if (cursor === null || Number(cursor) < 1)
        res.write(`data: ${JSON.stringify({ seq: 1, command })}\n\n`);
      if (commandCursors.length === 1) res.end();
      else secondStream = res;
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as {
        runId?: string;
        frames?: Array<{ seq: number; event: RunEvent }>;
      };
      if (req.url === "/daemon/run/events")
        events.push({ runId: parsed.runId!, frames: parsed.frames! });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/daemon/run/live") {
        liveReports += 1;
        // The first response models the old server, which did not expose a
        // generation. The second is the upgraded/restarted relay, whose
        // process-local command sequence begins at one again.
        res.end(JSON.stringify(liveReports === 1 ? {} : { generation: "relay-b" }));
      } else {
        res.end("{}");
      }
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(`http://127.0.0.1:${port}`, data);

  await until(
    () => events.some((post) => post.runId === "run_after_server_restart"),
    "the rebuilt relay's first command",
  );
  expect(commandCursors.slice(0, 2)).toEqual([null, null]);
  secondStream?.end();
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
  const r = startRuns({ lab: base, token: "t", workDir: `${data}-work`, dataDir: data, adapterFor: () => undefined });
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
            taskId: "t_cmp",
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
            taskId: "t_cmp",
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
            taskId: "t_cmp",
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
      taskId: "t_cmp",
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
    workDir: `${data}-work`,
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

it("retries the exact numbered event batch after a transient lab outage before sending later frames", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { emit: "agent_message_chunk", text: "after the outage" },
  ]);
  const attempts: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  let commandStream: import("node:http").ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      commandStream = res;
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: 1,
          command: {
            type: "start-run",
            runId: "run_retry",
            studyId: "s_cmp",
            taskId: "t_cmp",
            sessionId: "se_retry",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as {
        runId?: string;
        frames?: Array<{ seq: number; event: RunEvent }>;
      };
      if (req.url === "/daemon/run/events") {
        attempts.push({ runId: parsed.runId!, frames: parsed.frames! });
        if (attempts.length === 1) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "temporary outage" }));
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
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(`http://127.0.0.1:${port}`, data);

  await until(
    () =>
      attempts.slice(1).some((attempt) =>
        attempt.frames.some((frame) => frame.event.event === "completed"),
      ),
    "the retried run to complete",
  );

  expect(commandStream).toBeDefined();
  expect(attempts[1]).toEqual(attempts[0]);
  const acknowledged = attempts.slice(1).flatMap((attempt) => attempt.frames);
  expect(acknowledged.map((frame) => frame.seq)).toEqual(
    Array.from({ length: acknowledged.length }, (_, index) => index + 1),
  );
});

it("treats a frame-sequence conflict as an explicit failed resynchronization and reports the run missing", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "blocked", title: "Write /tmp/conflict" },
  ]);
  const liveReports: string[][] = [];
  const acceptedLiveReports: string[][] = [];
  let liveCalls = 0;
  let eventPosts = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: 1,
          command: {
            type: "start-run",
            runId: "run_conflict",
            studyId: "s_cmp",
            taskId: "t_cmp",
            sessionId: "se_conflict",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { runIds?: string[] };
      if (req.url === "/daemon/run/events") {
        eventPosts += 1;
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "expected frame 4, received 1" }));
        return;
      }
      if (req.url === "/daemon/run/live") {
        const report = parsed.runIds ?? [];
        liveReports.push(report);
        liveCalls += 1;
        // The initial report opens the command stream. Fail the first report
        // caused by the 409 itself: durable settlement must wait for a later
        // acknowledged retry, not merely for one best-effort attempt.
        if (liveCalls === 2) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "temporary reconciliation outage" }));
          return;
        }
        acceptedLiveReports.push(report);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const run = subsystem(`http://127.0.0.1:${port}`, data);

  await until(() => run.lastFailure() !== undefined, "a sequence conflict failure");
  await until(
    () => acceptedLiveReports.some((report) => report.length === 0) && liveCalls >= 3,
    "an acknowledged missing-run resynchronization retry",
  );
  expect(run.lastFailure()).toMatch(/out of sync.*expected frame 4, received 1/i);
  expect(eventPosts).toBe(1);
  expect(liveReports[1]).toEqual([]);
  expect(liveReports[2]).toEqual([]);
});

it("reports again when another sequence conflict lands during an in-flight reconciliation", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "blocked", title: "Write /tmp/conflict" },
  ]);
  const liveReports: string[][] = [];
  let eventRequests = 0;
  let secondConflict: import("node:http").ServerResponse | undefined;
  let firstReconciliation: import("node:http").ServerResponse | undefined;
  let overlapScheduled = false;
  const finishOverlap = () => {
    if (!secondConflict || !firstReconciliation || overlapScheduled) return;
    overlapScheduled = true;
    secondConflict.writeHead(409, { "content-type": "application/json" });
    secondConflict.end(JSON.stringify({ error: "second sequence conflict" }));
    setTimeout(() => {
      firstReconciliation?.writeHead(200, { "content-type": "application/json" });
      firstReconciliation?.end("{}");
      firstReconciliation = undefined;
    }, 100);
  };
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [index, runId] of ["run_conflict_a", "run_conflict_b"].entries()) {
        res.write(
          `data: ${JSON.stringify({
            seq: index + 1,
            command: {
              type: "start-run",
              runId,
              studyId: "s_cmp",
              taskId: "t_cmp",
              sessionId: `se_${runId}`,
              agent: "claude",
              prompt: "go",
              grants: [],
            },
          })}\n\n`,
        );
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { runIds?: string[] };
      if (req.url === "/daemon/run/events") {
        eventRequests += 1;
        if (eventRequests === 1) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "first sequence conflict" }));
        } else {
          secondConflict = res;
          finishOverlap();
        }
        return;
      }
      if (req.url === "/daemon/run/live") {
        liveReports.push(parsed.runIds ?? []);
        if (liveReports.length === 2) {
          firstReconciliation = res;
          finishOverlap();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        }
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(`http://127.0.0.1:${port}`, data);

  await until(
    () => liveReports.length >= 3 && liveReports.at(-1)?.length === 0,
    "a reconciliation including the conflict that landed during its predecessor",
  );
  expect(liveReports[1]).toHaveLength(1);
  expect(liveReports[2]).toEqual([]);
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
            taskId: "t_cmp",
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
      taskId: "t_cmp",
      sessionId: "se_queue",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
    {
      type: "start-run",
      runId: "run_second",
      studyId: "s_cmp",
      taskId: "t_cmp",
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

it("cancels a queued same-session run durably without ever invoking its prompt", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "first-only", title: "Write /tmp/first" },
  ]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_first",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_queue_cancel",
      agent: "claude",
      prompt: "first",
      grants: [],
    },
    {
      type: "start-run",
      runId: "run_second",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_queue_cancel",
      agent: "claude",
      prompt: "must never run",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);

  await until(
    () => lab.events.some((post) =>
      post.runId === "run_first" &&
      post.frames.some((frame) => frame.event.event === "permission-card"),
    ),
    "the first queued turn to block",
  );
  lab.send({
    type: "decision",
    runId: "run_second",
    decision: { action: "cancel" },
  });
  await until(
    () => lab.events.some((post) =>
      post.runId === "run_second" &&
      post.frames.some((frame) => frame.event.event === "completed"),
    ),
    "the queued turn's cancelled ending",
  );

  const secondFrames = lab.events
    .filter((post) => post.runId === "run_second")
    .flatMap((post) => post.frames);
  // It said it was waiting, and then it said it was cancelled. Nothing
  // between the two: no prose, no tool call, no plan — the prompt was never
  // handed to the agent at all, which is what this test is about. Saying it
  // was waiting is not running it.
  expect(secondFrames).toEqual([
    { seq: 1, event: { event: "state", state: { state: "queued", ahead: 1 } } },
    { seq: 2, event: { event: "completed", state: { state: "cancelled" } } },
  ]);

  lab.send({
    type: "decision",
    runId: "run_first",
    decision: { action: "cancel" },
  });
  await until(
    () => lab.events.some((post) =>
      post.runId === "run_first" &&
      post.frames.some((frame) => frame.event.event === "completed"),
    ),
    "the first turn to stop",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(
    lab.events
      .filter((post) => post.runId === "run_second")
      .flatMap((post) => post.frames),
  ).toEqual(secondFrames);
});

it("cancels and reaps stuck initialization before a same-session successor starts", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const initializing = markerIn(data, "session-new-started");
  const exited = markerIn(data, "initializing-adapter-exited");
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = initializing;
  process.env.LYKEION_STUB_SESSION_NEW_DELAY_MS = "3000";
  process.env.LYKEION_STUB_EXIT_MARKER = exited;
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_cancel_during_init",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_cancel_during_init",
      agent: "claude",
      prompt: "must never reach session/prompt",
      grants: [],
    },
  ]);
  subsystem(lab.base, data);

  await until(() => existsSync(initializing), "session initialization to begin");
  const cancelStarted = Date.now();
  lab.send({
    type: "decision",
    runId: "run_cancel_during_init",
    decision: { action: "cancel" },
  });
  lab.send({
    type: "start-run",
    runId: "run_after_cancelled_init",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_cancel_during_init",
    agent: "claude",
    prompt: "start only after the old child exits",
    grants: [],
  });
  await until(
    () => lab.events.some((post) =>
      post.runId === "run_cancel_during_init" &&
      post.frames.some((frame) => frame.event.event === "completed"),
    ),
    "the initialization-race cancellation",
  );
  await until(
    () =>
      readFileSync(initializing, "utf8").trim().split("\n").filter(Boolean).length >= 2,
    "the same-session successor to begin initialization",
  );

  expect(Date.now() - cancelStarted).toBeLessThan(1500);
  expect(existsSync(exited)).toBe(true);
  expect(
    lab.events
      .filter((post) => post.runId === "run_cancel_during_init")
      .flatMap((post) => post.frames),
  ).toEqual([
    { seq: 1, event: { event: "completed", state: { state: "cancelled" } } },
  ]);
});

it("aborts and reaps a session whose initialization stays stuck after stop", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const initializing = markerIn(data, "session-new-started");
  const prompted = markerIn(data, "prompt-started");
  const exited = markerIn(data, "adapter-exited");
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = initializing;
  // Longer than stop's own bounded final-flush window: a timeout that merely
  // returns while leaving the subprocess alive fails the exit-marker check.
  process.env.LYKEION_STUB_SESSION_NEW_DELAY_MS = "3000";
  process.env.LYKEION_STUB_PROMPT_MARKER = prompted;
  process.env.LYKEION_STUB_EXIT_MARKER = exited;
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_stop_during_init",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_stop_during_init",
      agent: "claude",
      prompt: "must never start after shutdown",
      grants: [],
    },
  ]);
  const run = subsystem(lab.base, data);

  await until(() => existsSync(initializing), "session initialization to begin");
  const stopStarted = Date.now();
  await run.stop();

  expect(Date.now() - stopStarted).toBeLessThan(1500);
  expect(existsSync(prompted)).toBe(false);
  expect(existsSync(exited)).toBe(true);
  expect(
    lab.events
      .filter((post) => post.runId === "run_stop_during_init")
      .flatMap((post) => post.frames),
  ).toEqual([
    {
      seq: 1,
      event: {
        event: "completed",
        state: {
          state: "failed",
          reason: "this machine stopped before this run's turn could begin",
        },
      },
    },
  ]);
});

it("bounds shutdown while retaining and retrying an event batch the lab never accepts", async () => {
  const attempts: Array<Array<{ seq: number; event: RunEvent }>> = [];
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
            taskId: "t_cmp",
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
        const parsed = JSON.parse(body || "{}") as {
          frames?: Array<{ seq: number; event: RunEvent }>;
        };
        attempts.push(parsed.frames ?? []);
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
  await until(() => attempts.length >= 2, "the retained batch to be retried");
  expect(attempts[1]).toEqual(attempts[0]);

  const started = Date.now();
  await r.stop();
  expect(Date.now() - started).toBeLessThan(2_750);
});

it("reports the working directory a live session is standing in, so a sweep never removes it out from under a running adapter", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_live_dir",
      studyId: "s_cmp",
      taskId: "t_cmp",
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
  expect(r.liveSessionDirs()).toEqual([join(`${data}-work`, "studies", "s_cmp", "tasks", "t_cmp")]);
});

it("retires a session whose stop was unacknowledged and keeps a later turn healthy", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const oldMarker = markerIn(data, "old.closed");
  const freshMarker = markerIn(data, "fresh.closed");
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
      taskId: "t_cmp",
      sessionId: "se_reused",
      agent: "claude",
      prompt: "first",
      grants: [],
    },
  ]);
  const r = startRuns({
    lab: lab.base,
    token: "machine-token",
    workDir: `${data}-work`,
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
    taskId: "t_cmp",
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

it("keeps a Task's work in one directory across the sessions that touch it", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_first_agent",
      studyId: "s_cmp",
      taskId: "t_shared",
      sessionId: "se_first_agent",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(lab.base, data);
  const taskDir = join(`${data}-work`, "studies", "s_cmp", "tasks", "t_shared");
  dirs.push(`${data}-work`);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "the first turn",
  );
  expect(r.liveSessionDirs()).toEqual([taskDir]);

  // A second agent on the same Task opens a new session, and lands in the
  // directory the first one's work is already in.
  lab.send({
    type: "start-run",
    runId: "run_second_agent",
    studyId: "s_cmp",
    taskId: "t_shared",
    sessionId: "se_second_agent",
    agent: "codex",
    prompt: "again",
    grants: [],
  });
  await until(
    () =>
      lab.events.filter((e) => e.frames.some((f) => f.event.event === "completed")).length === 2,
    "the second turn",
  );
  expect(r.liveSessionDirs()).toEqual([taskDir, taskDir]);
  expect(existsSync(join(`${data}-work`, "studies", "s_cmp", "sessions"))).toBe(false);
});

it("refuses a start-run that names no Task, since there is nowhere to run it", async () => {
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_no_task",
      studyId: "s_cmp",
      sessionId: "se_no_task",
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
    "a refusal",
  );
  const done = lab.events
    .flatMap((e) => e.frames)
    .find((f) => f.event.event === "completed")!;
  expect(done.event).toMatchObject({ state: { state: "failed" } });
  expect((done.event as { state: { reason: string } }).state.reason).toMatch(/taskId/);
});

it("refuses a run whose grant names a path this machine cannot resolve, and spawns nothing", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const spawned = markerIn(data, "adapter-was-spawned");
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = spawned;
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_bad_grant",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_bad_grant",
      agent: "claude",
      prompt: "go",
      grants: [{ path: "/there-is-no-such-folder-here/data", mode: "write" }],
    },
  ]);
  subsystem(lab.base, data);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a refusal",
  );
  const done = lab.events.flatMap((e) => e.frames).find((f) => f.event.event === "completed")!;
  expect(done.event).toMatchObject({ state: { state: "failed" } });
  expect((done.event as { state: { reason: string } }).state.reason).toMatch(
    /there-is-no-such-folder-here/,
  );
  expect(existsSync(spawned)).toBe(false);
});

it("refuses a run on a platform it cannot confine, naming the platform, and spawns nothing", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const spawned = markerIn(data, "adapter-was-spawned");
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = spawned;
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_no_backend",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_no_backend",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
  ]);
  const r = startRuns({
    lab: lab.base,
    token: "machine-token",
    workDir: `${data}-work`,
    dataDir: data,
    platform: "linux",
    adapterFor: () => ({ command: process.execPath, args: ["--experimental-strip-types", STUB] }),
  });
  running.push(r);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a refusal",
  );
  const done = lab.events.flatMap((e) => e.frames).find((f) => f.event.event === "completed")!;
  expect((done.event as { state: { reason: string } }).state.reason).toMatch(/linux/);
  expect(existsSync(spawned)).toBe(false);
});

it("opens a new session rather than running a later turn inside an older turn's boundary", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const opened = markerIn(data, "sessions-opened");
  const granted = mkdtempSync(join(tmpdir(), "lykeion-granted-"));
  dirs.push(granted);
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = opened;
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_grant_a",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_shared",
      agent: "claude",
      prompt: "first",
      grants: [{ path: granted, mode: "write" }],
    },
  ]);
  subsystem(lab.base, data);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "the first turn",
  );
  expect(readFileSync(opened, "utf8").trim().split("\n")).toHaveLength(1);

  // The same session, with the grant taken away. The boundary the first turn
  // was rendered with no longer describes what the researcher allows, so the
  // subprocess it belongs to cannot be the one this turn runs in.
  lab.send({
    type: "start-run",
    runId: "run_grant_b",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_shared",
    agent: "claude",
    prompt: "second",
    grants: [],
  });
  await until(
    () =>
      lab.events.filter((e) => e.frames.some((f) => f.event.event === "completed")).length === 2,
    "the second turn",
  );
  expect(readFileSync(opened, "utf8").trim().split("\n")).toHaveLength(2);
});

it("keeps one session across turns whose boundary has not changed", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const opened = markerIn(data, "sessions-opened");
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = opened;
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const start = {
    type: "start-run",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_stable",
    agent: "claude",
    prompt: "go",
    grants: [],
  };
  const lab = await stubLab([{ ...start, runId: "run_same_a" }]);
  subsystem(lab.base, data);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "the first turn",
  );
  lab.send({ ...start, runId: "run_same_b" });
  await until(
    () =>
      lab.events.filter((e) => e.frames.some((f) => f.event.event === "completed")).length === 2,
    "the second turn",
  );
  // One subprocess, and therefore one conversation: nothing about the
  // boundary changed, so nothing had to be given up to keep it honest.
  expect(readFileSync(opened, "utf8").trim().split("\n")).toHaveLength(1);
});

it("says a turn is waiting rather than working, until its place in the queue comes up", async () => {
  // A researcher who typed ahead has a turn that has been taken and has not
  // begun. Reported as `planning` it would read as the agent thinking about a
  // prompt it has not been given yet; `queued` says what is true, and `ahead`
  // is how many turns are in front of it.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "t1", title: "Write /tmp/somewhere" },
  ]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_head",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_wait",
      agent: "claude",
      prompt: "first",
      grants: [],
    },
    {
      type: "start-run",
      runId: "run_waiting",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_wait",
      agent: "claude",
      prompt: "and also this",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(lab.base, data);

  await until(
    () =>
      lab.events.some(
        (e) =>
          e.runId === "run_waiting" &&
          e.frames.some(
            (f) => f.event.event === "state" && f.event.state.state === "queued",
          ),
      ),
    "the second turn reporting itself as waiting",
  );

  const waiting = lab.events
    .filter((e) => e.runId === "run_waiting")
    .flatMap((e) => e.frames)
    .find((f) => f.event.event === "state") as
    | { event: { state: { state: string; ahead: number } } }
    | undefined;
  expect(waiting?.event.state).toEqual({ state: "queued", ahead: 1 });

  // And the turn in front of it never says it is waiting: it is the one
  // actually working.
  expect(
    lab.events
      .filter((e) => e.runId === "run_head")
      .flatMap((e) => e.frames)
      .some((f) => f.event.event === "state" && f.event.state.state === "queued"),
  ).toBe(false);

  await r.stop();
});

it("moves a waiting turn up as the turns in front of it settle", async () => {
  // A permission request never answered on its own is what keeps run_1
  // genuinely running rather than finishing before run_2 and run_3 even get
  // a chance to report their place in the queue.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "hold", title: "Write /tmp/somewhere" },
  ]);
  const lab = await stubLab(
    ["run_1", "run_2", "run_3"].map((runId) => ({
      type: "start-run",
      runId,
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_move_queue",
      agent: "claude",
      prompt: runId,
      grants: [],
    })),
  );
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);

  // Proof run_1 is genuinely still running, with run_2 and run_3 queued
  // behind it: nothing answers the open permission request on its own, and
  // by the time a real subprocess has reached it, both queued turns have had
  // far longer than they need to report their place.
  await until(
    () =>
      lab.events.some(
        (e) => e.runId === "run_1" && e.frames.some((f) => f.event.event === "permission-card"),
      ),
    "run_1 to become active",
  );

  expect(queuedPositions(lab, "run_2")).toEqual([1]);
  expect(queuedPositions(lab, "run_3")).toEqual([2]);

  lab.send({ type: "decision", runId: "run_1", decision: { action: "cancel" } });
  await until(
    () =>
      lab.events.some(
        (e) => e.runId === "run_1" && e.frames.some((f) => f.event.event === "completed"),
      ),
    "run_1 to settle",
  );
  // run_2 has begun, so it says so rather than saying it is still waiting;
  // run_3 has one turn in front of it now rather than two.
  await until(() => queuedPositions(lab, "run_3").length > 1, "run_3's revised position");
  expect(queuedPositions(lab, "run_3")).toEqual([2, 1]);
});

it("does not repeat a queued turn's position when the turn cancelled ahead of it is only reached later", async () => {
  // run_2's own continuation reaches `sessionOfRun.delete` only once the
  // turns ahead of it in `turnQueues` have settled — by which point a
  // decision already cancelled it and removed its entry. That continuation
  // must find nothing left to remove, and must not re-announce run_4's
  // position on the strength of a removal that never happened.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "hold", title: "Write /tmp/somewhere" },
  ]);
  const lab = await stubLab(
    ["run_1", "run_2", "run_3", "run_4"].map((runId) => ({
      type: "start-run",
      runId,
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_no_op_cancel",
      agent: "claude",
      prompt: runId,
      grants: [],
    })),
  );
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);

  await until(
    () =>
      lab.events.some(
        (e) => e.runId === "run_1" && e.frames.some((f) => f.event.event === "permission-card"),
      ),
    "run_1 to become active",
  );
  expect(queuedPositions(lab, "run_4")).toEqual([3]);

  // run_2 is still only queued — cancelling it here removes its entry
  // immediately and revises everyone behind it.
  lab.send({ type: "decision", runId: "run_2", decision: { action: "cancel" } });
  await until(
    () =>
      lab.events.some(
        (e) => e.runId === "run_2" && e.frames.some((f) => f.event.event === "completed"),
      ),
    "run_2's cancelled ending",
  );
  expect(queuedPositions(lab, "run_4")).toEqual([3, 2]);

  // run_1 settling advances `turnQueues` to run_2's own continuation, whose
  // `sessionOfRun.delete` finds nothing left to remove — its own cancel
  // already did that. run_3's continuation follows immediately behind it and
  // becomes genuinely active, which is this test's proof that the whole
  // chain, including run_2's no-op, has finished running.
  lab.send({ type: "decision", runId: "run_1", decision: { action: "cancel" } });
  await until(
    () =>
      lab.events.some(
        (e) => e.runId === "run_3" && e.frames.some((f) => f.event.event === "permission-card"),
      ),
    "run_3 to become active",
  );
  expect(queuedPositions(lab, "run_4")).toEqual([3, 2, 1]);
});

/** A kernel host that records every call it is asked to make, and answers
 *  each with an empty result — enough for a command that carries no reply
 *  of its own back to the lab. */
function recordingKernelHost() {
  const calls: Array<{ method: string; params: unknown }> = [];
  const host: KernelHost = {
    call: async (method, params) => {
      calls.push({ method, params });
      return {};
    },
    on: () => {},
    stop: () => Promise.resolve(),
    get running() {
      return true;
    },
    stderrTail: () => "",
  };
  return { host, calls };
}

it("interrupts a kernel this machine's host is holding when the lab asks it to", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = recordingKernelHost();
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({ type: "kernel-interrupt", runId: "k_1", kernelId: "k_1" });

  await until(() => kernels.calls.length > 0, "the interrupt reaching this machine's kernel host");
  expect(kernels.calls).toEqual([{ method: "kernel.interrupt", params: { kernel_id: "k_1" } }]);
});

it("restarts a kernel this machine's host is holding when the lab asks it to", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = recordingKernelHost();
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({ type: "kernel-restart", runId: "k_1", kernelId: "k_1" });

  await until(() => kernels.calls.length > 0, "the restart reaching this machine's kernel host");
  expect(kernels.calls).toEqual([{ method: "kernel.restart", params: { kernel_id: "k_1" } }]);
});

it("does nothing with a kernel-execute command and a machine that holds no kernel host", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({
    type: "kernel-execute",
    runId: "cell_1",
    kernelId: "k_1",
    code: "1",
    cellId: "cell_1",
    sessionId: "se_1",
    taskId: "t_cmp",
    name: "main",
    language: "python",
    by: "u_ana",
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(lab.events).toEqual([]);
  expect(lab.cells).toEqual([]);
});

it("runs a REPL cell on this machine's kernel host and posts the cell straight back, under the id the lab minted", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const calls: Array<{ method: string; params: unknown }> = [];
  const host: KernelHost = {
    call: async (method, params) => {
      calls.push({ method, params });
      if (method !== "kernel.execute") return {};
      return {
        kernelId: "k_1",
        sessionId: "se_1",
        taskId: "t_cmp",
        name: "main",
        language: "python",
        environment: "python",
        executionCount: 4,
        source: "2 + 2",
        origin: { surface: "repl", by: "u_ana" },
        ok: true,
        wallMs: 3,
        ts: 1234,
        outputs: [{ kind: "execute_result", execution_count: 4, data: { "text/plain": "4" }, data_ref: {} }],
      };
    },
    on: () => {},
    stop: () => Promise.resolve(),
    get running() {
      return true;
    },
    stderrTail: () => "",
  };
  subsystem(lab.base, data, () => host);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({
    type: "kernel-execute",
    runId: "cell_1",
    kernelId: "k_1",
    code: "2 + 2",
    cellId: "cell_1",
    sessionId: "se_1",
    taskId: "t_cmp",
    name: "main",
    language: "python",
    by: "u_ana",
  });

  await until(() => lab.cells.length > 0, "the cell reaching the lab");
  expect(calls).toEqual([
    {
      method: "kernel.execute",
      params: {
        session_id: "se_1",
        task_id: "t_cmp",
        name: "main",
        language: "python",
        source: "2 + 2",
        origin: { surface: "repl", by: "u_ana" },
      },
    },
  ]);
  expect(lab.cells[0]).toMatchObject({ cellId: "cell_1", kernelId: "k_1", source: "2 + 2", ok: true });
});

it("records a REPL cell once even when an agent holds the same session's turn", async () => {
  // The host announces every cell it runs, this one included, and the run
  // taking the session's turn is one this announcement would be delivered
  // to. Both ways recorded, the same cell would be two rows in the Task's
  // notebook — the same source, the same outputs, one under the id the lab
  // minted and one under an id nothing else has ever seen.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ sleep: 800 }, { endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;

  const cellListeners: Array<(params: unknown) => void> = [];
  const ran = {
    kernelId: "k_1",
    sessionId: "se_1",
    taskId: "t_cmp",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 4,
    source: "2 + 2",
    origin: { surface: "repl", by: "u_ana" },
    ok: true,
    wallMs: 3,
    ts: 1234,
    outputs: [],
  };
  const host: KernelHost = {
    call: async (method) => {
      if (method === "host.hello")
        return { protocol: PROTOCOL_VERSION, environment: "python", reads: [] };
      if (method !== "kernel.execute") return {};
      // The host answers the call AND announces the cell, which is what the
      // real one does: one event, written twice, because the two ends of it
      // are waiting in different places.
      for (const listener of cellListeners) listener(ran);
      return ran;
    },
    on: (method, handler) => {
      if (method === "cell") cellListeners.push(handler);
    },
    stop: () => Promise.resolve(),
    get running() {
      return true;
    },
    stderrTail: () => "",
  };
  subsystem(lab.base, data, () => host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_repl_during"));
  await until(() => existsSync(named), "the session opening");

  lab.send({
    type: "kernel-execute",
    runId: "cell_9",
    kernelId: "k_1",
    code: "2 + 2",
    cellId: "cell_9",
    sessionId: "se_1",
    taskId: "t_cmp",
    name: "main",
    language: "python",
    by: "u_ana",
  });

  await until(() => lab.cells.length > 0, "the cell reaching the lab");
  // Long enough for a forwarded copy to have been batched and flushed: the
  // events this machine posts leave on a 50ms timer.
  await new Promise((resolve) => setTimeout(resolve, 200));

  expect(lab.cells).toHaveLength(1);
  expect(lab.cells[0]).toMatchObject({ cellId: "cell_9", source: "2 + 2" });
  const forwarded = lab.events
    .flatMap((post) => post.frames)
    .filter((frame) => frame.event.event === "cell");
  expect(forwarded).toEqual([]);
});

it("names no tool server when this machine's kernel host speaks another protocol, and still runs the turn", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  // A host from another build of this machine's own program. The wire shapes
  // either end writes are hand-written on both sides, and this number is what
  // a host says when it is no longer describing the same ones.
  const kernels = stubKernelHost(0, PROTOCOL_VERSION + 1);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_skew"));

  await until(() => existsSync(named), "the session opening");
  const params = JSON.parse(readFileSync(named, "utf8")) as {
    mcpServers: Array<{ name: string }>;
  };
  // No relay named, so no tool leads to a kernel that could never be
  // configured — and the session it was not named to still opened.
  expect(params.mcpServers).toEqual([]);
  expect(kernels.asked).toEqual(["host.hello"]);
  await until(
    () =>
      lab.events.some((post) =>
        post.frames.some(
          (frame) => frame.event.event === "completed" && frame.event.state.state === "completed",
        ),
      ),
    "the turn finishing",
  );
});

it("refuses the turn when this machine cannot name a socket short enough to bind", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  const was = process.env.TMPDIR;
  // A machine whose temporary directory leaves no room for a socket's name.
  // Nothing this machine can do about it and nothing that changes on the next
  // turn — so it ends the turn in words rather than opening a session with no
  // tool server and saying nothing anyone reads.
  process.env.TMPDIR = `/tmp/${"x".repeat(90)}`;
  try {
    subsystem(lab.base, data, () => kernels.host);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send(startRunOn("run_nowhere"));

    await until(
      () =>
        lab.events.some((post) =>
          post.frames.some(
            (frame) => frame.event.event === "completed" && frame.event.state.state === "failed",
          ),
        ),
      "the turn being refused",
    );
    const failure = lab.events
      .flatMap((post) => post.frames)
      .map((frame) => frame.event)
      .find(
        (event): event is Extract<RunEvent, { event: "completed" }> =>
          event.event === "completed" && event.state.state === "failed",
      )!;
    const reason = failure.state.state === "failed" ? failure.state.reason : "";
    expect(reason).toMatch(/unix socket's name/);
    expect(reason).toMatch(/bytes/);
    // Nothing was asked of the host: the name is decided before it is.
    expect(kernels.asked).toEqual([]);
  } finally {
    if (was === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = was;
  }
});

it("answers the lab's kernel-list ask with what this machine's kernel host reports", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const reported = [
    {
      id: "k_1",
      sessionId: "se_1",
      taskId: "t_cmp",
      name: "main",
      language: "python",
      state: "idle",
      incarnation: 1,
      executionCount: 2,
      queueDepth: 0,
      environment: "python",
    },
  ];
  const host: KernelHost = {
    call: async (method) => (method === "kernel.list" ? { kernels: reported } : {}),
    on: () => {},
    stop: () => Promise.resolve(),
    get running() {
      return true;
    },
    stderrTail: () => "",
  };
  subsystem(lab.base, data, () => host);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({ type: "kernel-list", runId: "klreq_1" });

  await until(() => lab.kernelListReplies.length > 0, "the kernel list reaching the lab");
  expect(lab.kernelListReplies).toEqual([{ requestId: "klreq_1", kernels: reported }]);
});

it("answers the lab's kernel-list ask with an empty list when this machine holds no kernel host", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({ type: "kernel-list", runId: "klreq_2" });

  await until(() => lab.kernelListReplies.length > 0, "the kernel list reaching the lab");
  expect(lab.kernelListReplies).toEqual([{ requestId: "klreq_2", kernels: [] }]);
});
