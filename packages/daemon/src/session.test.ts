import { afterEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionLogEntry, RunEvent } from "@lykeion/api";
import {
  startSession,
  type LiveSession,
  type McpServer,
  type StandingGrant,
  adapterEnvFor,
  sessionMetaFor,
} from "./session";
import { canonicalPath } from "./sandbox";

const STUB = join(import.meta.dirname, "test-support", "stub-acp-agent.ts");
const live: LiveSession[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of live.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A folder the researcher granted. A real directory, because the boundary
 *  is rendered from it and a path that will not resolve refuses the run. */
function grantedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-granted-"));
  dirs.push(dir);
  return dir;
}

async function session(
  script: unknown[],
  grants: StandingGrant[] = [],
  options: {
    cancelGraceMs?: number;
    mcpServers?: McpServer[];
    agent?: string;
    /** Added to the environment the daemon itself would hand the spawn, so a
     *  test can prove what happens when the researcher's own home variable is
     *  already set in the process this daemon is running as. */
    env?: Record<string, string>;
  } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "lykeion-sess-"));
  dirs.push(cwd);
  const dataDir = mkdtempSync(join(tmpdir(), "lykeion-sess-state-"));
  dirs.push(dataDir);
  const events: RunEvent[] = [];
  const granted: StandingGrant[] = [];
  // Inside the workspace, which is the one directory the boundary lets the
  // adapter write — a path anywhere else would be refused by the kernel
  // rather than answered.
  const opening = join(cwd, "session-new.json");
  const spawnedWith = join(cwd, "adapter-env.json");
  const s = await startSession({
    adapter: {
      command: process.execPath,
      args: ["--experimental-strip-types", STUB],
    },
    agent: options.agent ?? "stub",
    cwd,
    dataDir,
    grants,
    onEvent: (e) => events.push(e),
    onGrant: (g) => granted.push(g),
    env: {
      ...process.env,
      LYKEION_STUB_SCRIPT: JSON.stringify(script),
      LYKEION_STUB_SESSION_NEW_PARAMS: opening,
      LYKEION_STUB_ENV_MARKER: spawnedWith,
      ...(options.env ?? {}),
    },
    ...(options.mcpServers === undefined ? {} : { mcpServers: options.mcpServers }),
    ...(options.cancelGraceMs !== undefined ? { cancelGraceMs: options.cancelGraceMs } : {}),
  });
  live.push(s);
  /** What `session/new` actually carried, read back off the agent's own side
   *  of the wire — so a value dropped between the option and the call shows
   *  up here rather than passing on what was intended. */
  const newSessionParams = () => JSON.parse(readFileSync(opening, "utf8")) as Record<string, unknown>;
  /** The environment the adapter process was actually started with, read
   *  back from inside that process — the daemon's own env plus whatever the
   *  spawn added for this agent, as the adapter itself saw it. */
  const adapterEnv = () =>
    JSON.parse(readFileSync(spawnedWith, "utf8")) as Record<string, string | undefined>;
  return { s, events, granted, newSessionParams, adapterEnv };
}

const settled = (events: RunEvent[]) =>
  events.some((e) => e.event === "completed");

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("never settled");
}

it("names the kernel bridge to the agent it starts", async () => {
  const { newSessionParams } = await session([], [], {
    mcpServers: [
      { name: "notebook", command: "/x/bridge", args: ["--socket", "/w/sockets/k.sock"], env: [] },
    ],
  });
  expect(newSessionParams()).toMatchObject({
    mcpServers: [
      { name: "notebook", command: "/x/bridge", args: ["--socket", "/w/sockets/k.sock"], env: [] },
    ],
  });
});

it("tells an agent about no servers when it was given none", async () => {
  const { newSessionParams } = await session([]);
  expect(newSessionParams()).toMatchObject({ mcpServers: [] });
});

it("empties a claude session's settings sources and holds it to strict MCP config", async () => {
  // Both shipped claude adapters load the machine owner's user scope unless
  // told otherwise — their personal MCP servers and account connectors
  // included. Emptied settings sources close the filesystem scopes; strict
  // MCP config closes the CLI's own user-scope registry and the connectors
  // its account delivers. Together they hold the tools a run reaches to
  // exactly the ones named on session/new.
  const { newSessionParams } = await session([], [], { agent: "claude" });
  expect(newSessionParams()).toMatchObject({
    _meta: { claudeCode: { options: { settingSources: [], strictMcpConfig: true } } },
  });
});

it("adds no per-agent config for an agent it knows no channel for", async () => {
  const { newSessionParams, adapterEnv } = await session([]);
  expect(adapterEnv().CODEX_CONFIG).toBeUndefined();
  expect(newSessionParams()._meta).toBeUndefined();
});

it("confines an agent inside a boundary that still lets it start this machine's own program", async () => {
  // A tool server is started by the agent, inside the agent's own boundary.
  // One that could not read the program it is told to run is one it cannot
  // start, whatever the agent was told about it.
  const { s } = await session([]);
  expect(JSON.parse(s.boundary).readable).toContain(canonicalPath(process.argv[1] ?? ""));
});

it("turns the agent's prose into assistant-text and finishes completed", async () => {
  const { s, events } = await session([
    { emit: "agent_message_chunk", text: "counting " },
    { emit: "agent_message_chunk", text: "reads" },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  const text = events.filter((e) => e.event === "assistant-text");
  expect(text.map((e) => (e as { text: string }).text)).toEqual(["counting ", "reads"]);
  expect(events.at(-1)).toEqual({ event: "completed", state: { state: "completed" } });
});

it("carries thinking on its own channel, never glued to prose", async () => {
  const { s, events } = await session([
    { emit: "agent_thought_chunk", text: "weighing it up" },
    { emit: "agent_message_chunk", text: "done" },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  const live = events.filter((e) => e.event === "live") as Array<{ live: { thinking?: string } }>;
  expect(live.at(-1)?.live.thinking).toBe("weighing it up");
  const thoughts = events.filter((e) => e.event === "assistant-thought") as Array<{ text: string }>;
  expect(thoughts.map((thought) => thought.text).join("")).toBe("weighing it up");
  const prose = events.filter((e) => e.event === "assistant-text") as Array<{ text: string }>;
  expect(prose.map((p) => p.text).join("")).toBe("done");
  expect(events.filter((e) => e.event === "assistant-text-final")).toHaveLength(1);
});

it("drops Codex's thought chunks, on the live channel and the transcript alike", async () => {
  const { s, events } = await session(
    [
      { emit: "agent_thought_chunk", text: "weighing it up" },
      { emit: "agent_message_chunk", text: "done" },
    ],
    [],
    { agent: "codex" },
  );
  s.prompt("go");
  await until(() => settled(events));
  expect(events.filter((e) => e.event === "assistant-thought")).toEqual([]);
  const live = events.filter((e) => e.event === "live") as Array<{ live: { thinking?: string } }>;
  expect(live.every((e) => e.live.thinking === undefined)).toBe(true);
  // The prose either side of it is untouched: what is dropped is the thought
  // channel, not the turn.
  const prose = events.filter((e) => e.event === "assistant-text") as Array<{ text: string }>;
  expect(prose.map((p) => p.text).join("")).toBe("done");
});

it("joins a cell to the kernel call whose input is the cell's source, at most once", async () => {
  const { s, events } = await session([
    {
      emit: "tool_call",
      toolCallId: "toolu_k1",
      title: "mcp__notebook__execute_python_cell",
      rawInput: { code: "1 + 1" },
    },
    { emit: "tool_call_update", toolCallId: "toolu_k1", status: "completed", content: "2" },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  expect(s.claimKernelCall("1 + 1")).toBe("toolu_k1");
  // Claimed once: a second cell with the same source needs a call of its own,
  // and answering the same call twice would join two cells to one step.
  expect(s.claimKernelCall("1 + 1")).toBeUndefined();
});

it("joins a shell cell to its call by the command carried inside the source", async () => {
  const { s, events } = await session([
    {
      emit: "tool_call",
      toolCallId: "exec-9f",
      title: "mcp__notebook__execute_shell_cell",
      rawInput: { command: "echo eleven rows" },
    },
    { emit: "tool_call_update", toolCallId: "exec-9f", status: "completed", content: "eleven rows" },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  // The kernel runs a shell command wrapped in a subprocess template, so the
  // cell's source carries the command without being equal to it.
  const source = "import subprocess as _r\n_r.run(['/bin/sh', '-c', 'echo eleven rows'])\n";
  expect(s.claimKernelCall(source)).toBe("exec-9f");
});

it("joins a cell to the one still-pending kernel call when its input answers nothing", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "t-read", title: "Read counts.csv", rawInput: { path: "counts.csv" } },
    { emit: "tool_call", toolCallId: "exec-p", title: "mcp__notebook__execute_python_cell" },
    { sleep: 200 },
    { emit: "tool_call_update", toolCallId: "exec-p", status: "completed", content: "" },
  ]);
  s.prompt("go");
  await until(
    () =>
      events.filter((e) => e.event === "log-entry").length >= 2 && !settled(events),
  );
  // Two calls are pending, but only one names the kernel server — an
  // adapter that carried no input for the call still gets its cell joined.
  expect(s.claimKernelCall("x = 1")).toBe("exec-p");
  await until(() => settled(events));
});

it("forgets last turn's kernel calls when a new turn begins", async () => {
  const script = [
    {
      emit: "tool_call",
      toolCallId: "toolu_k1",
      title: "mcp__notebook__execute_python_cell",
      rawInput: { code: "1 + 1" },
    },
    { emit: "tool_call_update", toolCallId: "toolu_k1", status: "completed", content: "2" },
  ];
  const { s, events } = await session(script);
  s.prompt("go");
  await until(() => settled(events));
  expect(s.claimKernelCall("1 + 1")).toBe("toolu_k1");
  s.prompt("again");
  await until(() => events.filter((e) => e.event === "completed").length === 2);
  // The turn's log was reset and replayed, so the call is claimable afresh
  // rather than still spent from the turn before.
  expect(s.claimKernelCall("1 + 1")).toBe("toolu_k1");
});

it("turns a tool call and its result into one logical log entry that ran", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "t1", title: "Read counts.csv", rawInput: { path: "counts.csv" } },
    { emit: "tool_call_update", toolCallId: "t1", status: "completed", content: "12 rows" },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  const entries = events.filter((e) => e.event === "log-entry") as Array<{
    entry: { toolUseId: string; title?: string; decision: string; result?: string; isError: boolean };
  }>;
  expect(entries.map(({ entry }) => entry.decision)).toEqual(["pending", "ran"]);
  const last = entries.at(-1)!.entry;
  expect(last.toolUseId).toBe("t1");
  expect(last.title).toBe("Read counts.csv");
  expect(last.decision).toBe("ran");
  expect(last.result).toBe("12 rows");
  expect(last.isError).toBe(false);
});

it("shows an ungated tool announcement before its terminal result", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "t-live", title: "Read counts.csv", rawInput: { path: "counts.csv" } },
    { sleep: 100 },
    { emit: "tool_call_update", toolCallId: "t-live", status: "completed", content: "12 rows" },
  ]);
  s.prompt("go");

  await until(() => events.some((e) => e.event === "log-entry"));
  expect(settled(events)).toBe(false);
  const announced = events.find((e) => e.event === "log-entry");
  expect(announced).toMatchObject({
    event: "log-entry",
    entry: { toolUseId: "t-live", decision: "pending", isError: false },
  });

  await until(() => settled(events));
  const entries = events.flatMap((e) => (e.event === "log-entry" ? [e.entry] : []));
  expect(entries.at(-1)).toMatchObject({
    toolUseId: "t-live",
    decision: "ran",
    result: "12 rows",
    isError: false,
  });
});

it("resets tool identity state between turns in one session", async () => {
  const { s, events } = await session([
    [
      { emit: "tool_call", toolCallId: "shared", title: "Read first.csv", rawInput: { path: "first.csv" } },
      { emit: "tool_call_update", toolCallId: "shared", status: "completed", content: "first result" },
    ],
    [
      { emit: "tool_call", toolCallId: "shared", title: "Read second.csv", rawInput: { path: "second.csv" } },
      { emit: "tool_call_update", toolCallId: "shared", status: "completed", content: "second result" },
    ],
  ]);

  s.prompt("first");
  await until(() => events.filter((e) => e.event === "completed").length === 1);
  s.prompt("second");
  await until(() => events.filter((e) => e.event === "completed").length === 2);

  const entries = events.flatMap((e) => (e.event === "log-entry" ? [e.entry] : []));
  expect(entries.map((entry) => [entry.decision, entry.result])).toEqual([
    ["pending", undefined],
    ["ran", "first result"],
    ["pending", undefined],
    ["ran", "second result"],
  ]);
});

it("proposes a plan and waits for approval before the agent proceeds", async () => {
  const { s, events } = await session([
    { emit: "plan", entries: [{ content: "Load the data", status: "pending" }] },
    { emit: "agent_message_chunk", text: "after" },
  ]);
  s.prompt("go");
  await until(() => events.some((e) => e.event === "plan-proposed"));
  const proposed = events.find((e) => e.event === "plan-proposed") as { plan: { steps: Array<{ title: string }> } };
  expect(proposed.plan.steps.map((st) => st.title)).toEqual(["Load the data"]);
});

it("raises a permission card and does not answer it by itself", async () => {
  const { s, events } = await session([{ ask: "permission", toolCallId: "t1", title: "Write out.csv" }]);
  s.prompt("go");
  await until(() => events.some((e) => e.event === "permission-card"));
  expect(settled(events)).toBe(false);
  const card = events.find((e) => e.event === "permission-card") as { request: { id: string; tool: string } };
  s.decide({ action: "permission", requestId: card.request.id, decision: { decision: "allow", scope: "once" } });
  await until(() => settled(events));
});

it("leaves the permission gate as soon as the researcher answers it", async () => {
  const { s, events } = await session([
    { ask: "permission", toolCallId: "t1", title: "Write out.csv" },
    { sleep: 500 },
  ]);
  s.prompt("go");
  await until(() => events.some((event) => event.event === "permission-card"));
  const card = events.find((event) => event.event === "permission-card") as {
    request: { id: string };
  };

  s.decide({
    action: "permission",
    requestId: card.request.id,
    decision: { decision: "allow", scope: "once" },
  });

  await until(() =>
    events.some(
      (event) => event.event === "state" && event.state.state === "planning",
    ),
  );
  expect(settled(events)).toBe(false);
});

it("answers a card with an option the agent itself offered, so an approved call actually runs", async () => {
  // An agent names its own permission options, and no two name them alike.
  // Answering with an id this machine invented selects nothing: the call is
  // never decided, and the researcher who pressed Allow watches it fail
  // anyway. The only answer that means anything is one of the agent's own.
  const { s, events } = await session([
    { ask: "permission", toolCallId: "t1", title: "Write out.csv", followUpContent: "wrote it" },
  ]);
  s.prompt("go");
  await until(() => events.some((event) => event.event === "permission-card"));
  const card = events.find((event) => event.event === "permission-card") as {
    request: { id: string };
  };

  s.decide({
    action: "permission",
    requestId: card.request.id,
    decision: { decision: "allow", scope: "once" },
  });
  await until(() => settled(events));

  const step = events
    .flatMap((event) => (event.event === "log-entry" ? [event.entry] : []))
    .filter((entry) => entry.toolUseId === "t1").at(-1);
  expect(step).toBeDefined();
  expect(step!.decision).toBe("allowed-once");
  expect(step!.isError).not.toBe(true);
});

it("refuses a card visibly when the agent offered nothing this machine can answer with", async () => {
  const { s, events } = await session([
    { ask: "permission", toolCallId: "t1", title: "Write out.csv", options: [] },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  const step = events
    .flatMap((event) => (event.event === "log-entry" ? [event.entry] : []))
    .filter((entry) => entry.toolUseId === "t1").at(-1);
  expect(step?.isError).toBe(true);
  expect(String(step?.result)).toMatch(/offered no/i);
});

it("never asks about a folder the Study already granted", async () => {
  // The standing grant is the whole point: a researcher who said "this
  // Study" once must not be asked the same question next session.
  const granted = grantedDir();
  const { s, events } = await session(
    [{ ask: "permission", toolCallId: "t1", title: `Write ${granted}/out.csv` }],
    [{ path: granted, mode: "write" }],
  );
  s.prompt("go");
  await until(() => settled(events));
  expect(events.some((e) => e.event === "permission-card")).toBe(false);
});

it("records a denied tool as one that never ran, not one that ran and failed", async () => {
  const { s, events } = await session([{ ask: "permission", toolCallId: "t1", title: "Write out.csv" }]);
  s.prompt("go");
  await until(() => events.some((e) => e.event === "permission-card"));
  const card = events.find((e) => e.event === "permission-card") as { request: { id: string } };
  s.decide({ action: "permission", requestId: card.request.id, decision: { decision: "deny" } });
  await until(() => settled(events));
  const entries = events.filter((e) => e.event === "log-entry") as Array<{
    entry: { toolUseId: string; decision: string };
  }>;
  const last = entries.at(-1)!.entry;
  expect(last.toolUseId).toBe("t1");
  expect(last.decision).toBe("denied");
});

it("emits a denial immediately even when the adapter sends no follow-up", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "t1", title: "Write out.csv", rawInput: { path: "out.csv" } },
    { ask: "permission", toolCallId: "t1", title: "Write out.csv", followUp: false },
  ]);
  s.prompt("go");
  await until(() => events.some((e) => e.event === "permission-card"));
  const card = events.find((e) => e.event === "permission-card") as { request: { id: string } };
  s.decide({ action: "permission", requestId: card.request.id, decision: { decision: "deny" } });

  const entries = events.flatMap((e) => (e.event === "log-entry" ? [e.entry] : []));
  expect(entries.map((entry) => entry.decision)).toEqual(["pending", "denied"]);
  expect(entries.at(-1)).toMatchObject({ toolUseId: "t1", decision: "denied", isError: true });
  await until(() => settled(events));
});

it("keeps a later adapter follow-up consistent with the denial already shown", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "t1", title: "Write out.csv", rawInput: { path: "out.csv" } },
    { ask: "permission", toolCallId: "t1", title: "Write out.csv", followUpContent: "permission denied" },
  ]);
  s.prompt("go");
  await until(() => events.some((e) => e.event === "permission-card"));
  const card = events.find((e) => e.event === "permission-card") as { request: { id: string } };
  s.decide({ action: "permission", requestId: card.request.id, decision: { decision: "deny" } });
  await until(() => settled(events));

  const entries = events.flatMap((e) => (e.event === "log-entry" && e.entry.toolUseId === "t1" ? [e.entry] : []));
  expect(entries.map((entry) => entry.decision)).toEqual(["pending", "denied", "denied"]);
  expect(entries.at(-1)).toMatchObject({ decision: "denied", isError: true, result: "permission denied" });
});

it.each([
  ["once", "allowed-once", false],
  ["once", "allowed-once", true],
  ["conversation", "allowed-conversation", false],
  ["conversation", "allowed-conversation", true],
  ["study", "allowed-study", false],
  ["study", "allowed-study", true],
] as const)("records one approved %s-scoped tool with decision %s when follow-up is %s", async (
  scope,
  expected,
  followUp,
) => {
  const { s, events } = await session([
    {
      emit: "tool_call",
      toolCallId: "t1",
      title: "Write /work/out.csv",
      rawInput: { path: "/work/out.csv" },
    },
    {
      ask: "permission",
      toolCallId: "t1",
      title: "Write /work/out.csv",
      followUp,
      ...(followUp ? { followUpContent: "created /work/out.csv" } : {}),
    },
  ]);
  s.prompt("go");
  await until(() => events.some((e) => e.event === "permission-card"));
  const card = events.find((e) => e.event === "permission-card") as { request: { id: string } };
  s.decide({
    action: "permission",
    requestId: card.request.id,
    decision: { decision: "allow", scope },
  });
  await until(() => settled(events));

  const entries = events.flatMap((e) => (e.event === "log-entry" && e.entry.toolUseId === "t1" ? [e.entry] : []));
  expect(entries.map((entry) => entry.decision)).toEqual(
    followUp ? ["pending", expected, expected] : ["pending", expected],
  );
  if (followUp) expect(entries.at(-1)?.result).toBe("created /work/out.csv");
  expect(entries.some((entry) => entry.decision === "ran")).toBe(false);
});

it("remembers a conversation-scope grant for the rest of this session, without reaching the Study", async () => {
  const { s, events, granted } = await session([
    { ask: "permission", toolCallId: "t1", title: "Write /work/out.csv" },
    { ask: "permission", toolCallId: "t2", title: "Write /work/out.csv" },
  ]);
  s.prompt("go");
  await until(() => events.some((e) => e.event === "permission-card"));
  const card = events.find((e) => e.event === "permission-card") as { request: { id: string } };
  s.decide({
    action: "permission",
    requestId: card.request.id,
    decision: { decision: "allow", scope: "conversation" },
  });
  await until(() => settled(events));
  expect(events.filter((e) => e.event === "permission-card").length).toBe(1);
  expect(granted).toEqual([]);
});

/** Every card raised, in the order they were put in front of the researcher. */
const cardsOf = (events: RunEvent[]) =>
  events.flatMap((e) => (e.event === "permission-card" ? [e.request] : []));

/** The batch counter carried by the most recent `awaiting-permission` state. */
const queueOf = (events: RunEvent[]) =>
  events
    .flatMap((e) =>
      e.event === "state" && e.state.state === "awaiting-permission" ? [e.state] : [],
    )
    .at(-1)?.queue;

/** Whether this session's LATEST word is that it is back at work rather than
 *  waiting on anyone — the state that ends a gate. Read from the last state
 *  and not from any of them, because every turn opens on `planning`: a search
 *  for one anywhere in the stream matches before a card has even been raised. */
const leftTheGate = (events: RunEvent[]) => {
  const last = events.flatMap((e) => (e.event === "state" ? [e.state.state] : [])).at(-1);
  return last === "executing" || last === "planning";
};

/** What each call's log entry ended up saying about how it was decided. */
const decisionsOf = (events: RunEvent[]) => {
  const final = new Map<string, string>();
  for (const e of events) if (e.event === "log-entry") final.set(e.entry.toolUseId, e.entry.decision);
  return final;
};

/** Answers whichever card is on screen now, then waits for this session to
 *  move on from it — to the next card, or off the gate entirely. */
async function decideShown(
  s: LiveSession,
  events: RunEvent[],
  verdict: "allow" | "deny",
): Promise<void> {
  const before = cardsOf(events).length;
  const card = cardsOf(events).at(-1)!;
  s.decide({
    action: "permission",
    requestId: card.id,
    decision: verdict === "allow" ? { decision: "allow", scope: "once" } : { decision: "deny" },
  });
  await until(
    () => cardsOf(events).length > before || leftTheGate(events) || settled(events),
  );
}

it("raises one card at a time when a turn asks for several calls at once", async () => {
  const { s, events } = await session([
    {
      askAll: [
        { toolCallId: "t1", title: "Write /work/a.csv" },
        { toolCallId: "t2", title: "Write /work/b.csv" },
        { toolCallId: "t3", title: "Write /work/c.csv" },
        { toolCallId: "t4", title: "Write /work/d.csv" },
      ],
    },
  ]);
  s.prompt("go");
  await until(() => queueOf(events)?.total === 4);

  // The defect this exists for: four requests in flight at once used to emit
  // four cards into one slot, and three were overwritten before anyone saw
  // them — then refused, in the researcher's name, when the turn was stopped.
  expect(cardsOf(events)).toHaveLength(1);
  expect(queueOf(events)).toEqual({ position: 1, total: 4 });
});

it("advances to the next card instead of leaving the gate, until the batch is done", async () => {
  const { s, events } = await session([
    {
      askAll: [
        { toolCallId: "t1", title: "Write /work/a.csv" },
        { toolCallId: "t2", title: "Write /work/b.csv" },
        { toolCallId: "t3", title: "Write /work/c.csv" },
      ],
    },
  ]);
  s.prompt("go");
  await until(() => queueOf(events)?.total === 3);

  const counters = [queueOf(events)];
  await decideShown(s, events, "allow");
  counters.push(queueOf(events));
  await decideShown(s, events, "allow");
  counters.push(queueOf(events));

  expect(counters).toEqual([
    { position: 1, total: 3 },
    { position: 2, total: 3 },
    { position: 3, total: 3 },
  ]);
  // One card per call, in the order they were asked — none skipped, none
  // shown twice.
  expect(cardsOf(events).map((card) => card.tool)).toEqual(["t1", "t2", "t3"]);
  // Still held: the third card is unanswered, so this session has not told
  // anyone it is back at work.
  expect(leftTheGate(events)).toBe(false);

  await decideShown(s, events, "allow");
  await until(() => settled(events));
  expect(leftTheGate(events)).toBe(true);
});

it("gives each call in a batch the decision made about it, and no other", async () => {
  const { s, events } = await session([
    {
      askAll: [
        { toolCallId: "t1", title: "Write /work/a.csv" },
        { toolCallId: "t2", title: "Write /work/b.csv" },
        { toolCallId: "t3", title: "Write /work/c.csv" },
        { toolCallId: "t4", title: "Write /work/d.csv" },
      ],
    },
  ]);
  s.prompt("go");
  await until(() => queueOf(events)?.total === 4);

  await decideShown(s, events, "allow");
  await decideShown(s, events, "deny");
  await decideShown(s, events, "deny");
  await decideShown(s, events, "allow");
  await until(() => settled(events));

  // Read off what each call's row finally says. An answer given to one card
  // has to land on that call and nothing else.
  const decisions = decisionsOf(events);
  expect([
    decisions.get("t1"),
    decisions.get("t2"),
    decisions.get("t3"),
    decisions.get("t4"),
  ]).toEqual(["allowed-once", "denied", "denied", "allowed-once"]);
});

it("tells the researcher the batch grew when a call joins one already on screen", async () => {
  const { s, events } = await session([
    {
      askAll: [
        { toolCallId: "t1", title: "Write /work/a.csv" },
        { toolCallId: "t2", title: "Write /work/b.csv", delayMs: 250 },
      ],
    },
  ]);
  s.prompt("go");
  await until(() => cardsOf(events).length === 1);
  // A lone gate places itself in no batch, because there is not one yet.
  expect(queueOf(events)).toBeUndefined();

  await until(() => queueOf(events) !== undefined);
  // Same card, still unanswered — but the researcher is now told it is one of
  // two, rather than deciding it believing it is the only thing being asked.
  expect(queueOf(events)).toEqual({ position: 1, total: 2 });
  expect(cardsOf(events)).toHaveLength(1);
});

it("settles every card in an open batch when the turn ends, not just the visible one", async () => {
  const { s, events } = await session([
    {
      askAll: [
        { toolCallId: "t1", title: "Write /work/a.csv" },
        { toolCallId: "t2", title: "Write /work/b.csv" },
        { toolCallId: "t3", title: "Write /work/c.csv" },
      ],
    },
  ]);
  s.prompt("go");
  await until(() => queueOf(events)?.total === 3);
  s.cancel();
  await until(() => settled(events));

  // A card nobody was ever shown is not a call the researcher refused. All
  // three were abandoned at the gate, and each says so on its own row.
  const decisions = decisionsOf(events);
  expect([decisions.get("t1"), decisions.get("t2"), decisions.get("t3")]).toEqual([
    "cancelled",
    "cancelled",
    "cancelled",
  ]);
});

it("drops a queued card an answer to its sibling already covered", async () => {
  const { s, events } = await session([
    {
      askAll: [
        { toolCallId: "t1", title: "Write /work/out.csv" },
        { toolCallId: "t2", title: "Write /work/out.csv" },
      ],
    },
  ]);
  s.prompt("go");
  await until(() => queueOf(events)?.total === 2);
  const card = cardsOf(events).at(-1)!;
  s.decide({
    action: "permission",
    requestId: card.id,
    decision: { decision: "allow", scope: "conversation" },
  });
  await until(() => settled(events));

  // `t2` was queued behind `t1` and asks for the same path. The grant `t1`
  // created covers it, so it is allowed on that consent rather than raised as
  // a second question about something just answered.
  const decisions = decisionsOf(events);
  expect([decisions.get("t1"), decisions.get("t2")]).toEqual([
    "allowed-conversation",
    "allowed-conversation",
  ]);
  expect(cardsOf(events)).toHaveLength(1);
});

it("settles a card still open when the turn ends, instead of leaving it a ghost", async () => {
  const { s, events } = await session([{ ask: "permission", toolCallId: "t1", title: "Write /work/out.csv" }]);
  s.prompt("go");
  await until(() => events.some((e) => e.event === "permission-card"));
  // Checked before awaiting close(): the connection's own teardown is
  // asynchronous (it waits on the adapter process actually exiting), so an
  // assertion made only after `await` would also pass if nothing but that
  // teardown eventually settled the card — this catches `close()` failing to
  // settle it itself, up front, before any of that has had a chance to run.
  const closing = s.close();
  const entries = events.filter((e) => e.event === "log-entry") as Array<{
    entry: { toolUseId: string; decision: string };
  }>;
  const last = entries.at(-1)?.entry;
  expect(last?.toolUseId).toBe("t1");
  expect(last?.decision).toBe("cancelled");
  await closing;
});

it("stops a turn and lands it cancelled, not failed", async () => {
  const { s, events } = await session([
    { emit: "agent_message_chunk", text: "working" },
    { endTurn: "cancelled" },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  expect(events.at(-1)).toEqual({ event: "completed", state: { state: "cancelled" } });
});

it("does not finalize prose cut off by cancellation", async () => {
  const { s, events } = await session([
    { emit: "agent_message_chunk", text: "unfinished answer" },
    { wait: "cancel", timeoutMs: 5000 },
  ]);
  s.prompt("go");
  await until(() => events.some((event) => event.event === "assistant-text"));
  s.cancel();
  await until(() => settled(events));

  expect(events.filter((event) => event.event === "assistant-text-final")).toEqual([]);
  expect(events.at(-1)).toEqual({ event: "completed", state: { state: "cancelled" } });
});

it("turns a card that was still open into a cancelled log entry when the researcher stops the turn", async () => {
  const { s, events } = await session([{ ask: "permission", toolCallId: "t1", title: "Write out.csv" }]);
  s.prompt("go");
  await until(() => events.some((e) => e.event === "permission-card"));
  s.cancel();
  await until(() => settled(events));

  const entries = events.filter((e) => e.event === "log-entry") as Array<{
    entry: { toolUseId: string; decision: string; result?: string };
  }>;
  const entry = entries.at(-1)!.entry;
  expect(entry.decision).toBe("cancelled");
  expect("result" in entry).toBe(false);
});

it("stops a turn via a submitted cancel decision, the same way a direct cancel() does", async () => {
  const { s, events } = await session([{ ask: "permission", toolCallId: "t1", title: "Write out.csv" }]);
  s.prompt("go");
  await until(() => events.some((e) => e.event === "permission-card"));
  s.decide({ action: "cancel" });
  await until(() => settled(events));

  const entries = events.filter((e) => e.event === "log-entry") as Array<{
    entry: { toolUseId: string; decision: string; result?: string };
  }>;
  const entry = entries.at(-1)!.entry;
  expect(entry.decision).toBe("cancelled");
  expect("result" in entry).toBe(false);
});

it("reports a grant answered for the Study, so it can outlive this session", async () => {
  const { s, events, granted } = await session([
    { ask: "permission", toolCallId: "t1", title: "Write /work/out.csv" },
  ]);
  s.prompt("go");
  await until(() => events.some((e) => e.event === "permission-card"));
  const card = events.find((e) => e.event === "permission-card") as { request: { id: string } };
  s.decide({
    action: "permission",
    requestId: card.request.id,
    decision: { decision: "allow", scope: "study" },
  });
  await until(() => settled(events));
  expect(granted).toEqual([{ path: "/work/out.csv", mode: "write" }]);
});

it("fails the turn with the adapter's own words when it will not start", async () => {
  await expect(
    startSession({
      adapter: { command: process.execPath, args: ["-e", "process.stderr.write('bad flag\\n');process.exit(3)"] },
      agent: "stub",
      cwd: tmpdir(),
      dataDir: tmpdir(),
      grants: [],
      onEvent: () => {},
      onGrant: () => {},
    }),
  ).rejects.toThrow(/bad flag/);
});

it("lands an ordinary cancelled ending, unflagged, when the adapter confirms within its own grace period", async () => {
  // `{ wait: "cancel" }` catches the notify and reports the honest
  // `stopReason: "cancelled"` back — a grace period generous next to that
  // real round trip must change nothing about how the turn lands.
  const { s, events } = await session([{ wait: "cancel", timeoutMs: 5000 }], [], {
    cancelGraceMs: 2000,
  });
  s.prompt("go");
  s.cancel();
  await until(() => settled(events));
  expect(events.at(-1)).toEqual({ event: "completed", state: { state: "cancelled" } });
});

it("ends the turn itself, flagged unacknowledged, when the adapter does not confirm within its grace period", async () => {
  // The stub is busy regardless of the notify — the one way to reach a
  // state a real adapter that ignores `session/cancel` would leave this
  // session in.
  const { s, events } = await session([{ sleep: 150 }, { endTurn: "end_turn" }], [], {
    cancelGraceMs: 20,
  });
  s.prompt("go");
  s.cancel();
  await until(() => settled(events));
  expect(events.at(-1)).toEqual({
    event: "completed",
    state: { state: "cancelled", unacknowledged: true },
  });

  // The adapter's own real ending arrives later still (~150ms in, well past
  // the 20ms grace) — it must not double-emit `completed` for a turn this
  // session already ended itself.
  await new Promise((r) => setTimeout(r, 250));
  expect(events.filter((e) => e.event === "completed")).toHaveLength(1);
});

it("leaves the adapter running past the grace period, rather than closing the connection under it", async () => {
  // "Exactly one completed frame" alone cannot tell apart leaving the
  // subprocess running from closing the connection under it — closing
  // would reject the pending `session/prompt` call, which `finished`
  // suppresses identically. What actually tells them apart is whether the
  // stub can still be heard from at all afterward: it keeps running its
  // own script here, well past its turn's grace-triggered ending, and that
  // still reaches this session.
  const { s, events } = await session(
    [{ sleep: 50 }, { emit: "agent_message_chunk", text: "still-running" }, { endTurn: "end_turn" }],
    [],
    { cancelGraceMs: 20 },
  );
  s.prompt("go");
  s.cancel();
  await until(() => settled(events));
  expect(events.at(-1)).toEqual({
    event: "completed",
    state: { state: "cancelled", unacknowledged: true },
  });

  await until(() =>
    events.some((e) => e.event === "assistant-text" && e.text === "still-running"),
  );
});

it("does not let an abandoned turn's late settlement or permission request reach the turn that superseded it", async () => {
  // Turn one is abandoned by its own 20ms grace, then keeps running in the
  // background: at 150ms it raises a card, emits a chunk, and settles for
  // real with `cancelled` — a shape turn two, still running its own slower
  // script at that point, must never inherit or have a card attributed to
  // it. Its ordinary chunk is a different matter: ACP gives no way to
  // attribute it to one turn over the other, so it is allowed to surface —
  // mislabelled, but visible, rather than the alternative of losing
  // whatever the turn now running is legitimately producing at the same
  // time, which suppressing it indiscriminately would also do.
  const { s, events } = await session(
    [
      [
        { sleep: 150 },
        { ask: "permission", toolCallId: "orphan-tool", title: "Write orphan.csv" },
        { emit: "agent_message_chunk", text: "orphan-text" },
        { endTurn: "cancelled" },
      ],
      [{ sleep: 250 }, { endTurn: "end_turn" }],
    ],
    [],
    { cancelGraceMs: 20 },
  );
  s.prompt("first");
  s.cancel();
  await until(() => settled(events));
  expect(events.at(-1)).toEqual({
    event: "completed",
    state: { state: "cancelled", unacknowledged: true },
  });

  // A second turn starts on the same session well before the first call's
  // own late activity (still ~130ms away) ever arrives.
  s.prompt("second");
  await until(() => events.filter((e) => e.event === "completed").length === 2);

  // The second turn landed on its OWN terms — completed, from its own
  // `end_turn` — not `cancelled`, which is what the first call's late,
  // unrelated settlement would report if it reached this turn instead.
  expect(events.at(-1)).toEqual({ event: "completed", state: { state: "completed" } });

  // Give the first call's late card, its "orphan-text" chunk, and its real
  // ending time to actually arrive (all land around 150ms — comfortably
  // past by now).
  await new Promise((r) => setTimeout(r, 150));

  // Still exactly two `completed` frames — the abandoned call's late,
  // unrelated ending never adds a third. No card was ever raised live for
  // it either — refused visibly instead, rather than left answerable in a
  // turn it has nothing to do with.
  expect(events.filter((e) => e.event === "completed")).toHaveLength(2);
  expect(events.some((e) => e.event === "permission-card")).toBe(false);
  expect(
    events.some(
      (e) =>
        e.event === "log-entry" && e.entry.toolUseId === "orphan-tool" && e.entry.decision === "denied",
    ),
  ).toBe(true);

  // Its ordinary prose, though, is not silently lost.
  expect(
    events.some((e) => e.event === "assistant-text" && e.text.includes("orphan-text")),
  ).toBe(true);
});

it("does not leave the abandoned call's own permission request deadlocked in the gap before a successor starts", async () => {
  // Between grace expiry and a successor's own prompt(), the abandoned
  // turn is the only epoch there is — a check for a STALE OTHER epoch
  // alone reads false there, since there is nothing else yet to compare it
  // against. A permission request reaching this session in that exact gap
  // needs a different guard: left unrefused, it would raise a card nobody
  // can ever answer, and the abandoned call it belongs to would never
  // settle either — which would make every later turn on this session
  // permanently unable to get an ordinary permission answered too.
  const { s, events } = await session(
    [
      [
        { sleep: 30 },
        { ask: "permission", toolCallId: "gap-tool", title: "Write gap.csv" },
        { endTurn: "end_turn" },
      ],
    ],
    [],
    { cancelGraceMs: 20 },
  );
  s.prompt("go");
  s.cancel();
  await until(() => settled(events));
  expect(events.at(-1)).toEqual({
    event: "completed",
    state: { state: "cancelled", unacknowledged: true },
  });

  // The abandoned call's own permission request lands in the gap — refused
  // visibly rather than left open — and its own real ending follows it;
  // neither hangs.
  await until(() => events.some((e) => e.event === "log-entry" && e.entry.toolUseId === "gap-tool"));
  expect(events.some((e) => e.event === "permission-card")).toBe(false);

  // The refusal remains the call's sole visible record. A later adapter
  // report for the same identity is merged internally rather than surfaced
  // as a contradictory or duplicate entry.
  const gapEntries = (): ExecutionLogEntry[] =>
    events.flatMap((e) => (e.event === "log-entry" && e.entry.toolUseId === "gap-tool" ? [e.entry] : []));
  expect(gapEntries()).toHaveLength(1);
  expect(gapEntries()[0]?.decision).toBe("denied");
});

it("still shows a successor's own output, and still honours a standing grant, for a request stuck in the ambiguous window", async () => {
  const granted = grantedDir();
  const { s, events } = await session(
    [
      [
        { sleep: 150 },
        { ask: "permission", toolCallId: "granted-tool", title: `Write ${granted}/out.csv` },
        { endTurn: "end_turn" },
      ],
      [{ emit: "agent_message_chunk", text: "second turn content" }, { endTurn: "end_turn" }],
    ],
    [{ path: granted, mode: "write" }],
    { cancelGraceMs: 20 },
  );
  s.prompt("first");
  s.cancel();
  await until(() => settled(events));

  s.prompt("second");
  await until(() => events.filter((e) => e.event === "completed").length === 2);

  // The successor's own output is not lost.
  expect(
    events.some((e) => e.event === "assistant-text" && e.text.includes("second turn content")),
  ).toBe(true);

  // Wait on the request having actually been answered rather than on a
  // clock: the stub only reports `granted-tool` once its permission call
  // has returned, so this entry existing is proof the request arrived and
  // was let through. A fixed sleep would let both assertions below hold
  // vacuously, by ending before the request was ever made.
  await until(() =>
    events.some((e) => e.event === "log-entry" && e.entry.toolUseId === "granted-tool"),
  );

  // A standing grant answers it the same way it would for a live turn — an
  // ambiguous attribution does not override the researcher's own prior
  // consent — so it is never denied, and no card is ever raised for it.
  expect(events.some((e) => e.event === "permission-card")).toBe(false);
  expect(
    events.some(
      (e) =>
        e.event === "log-entry" && e.entry.toolUseId === "granted-tool" && e.entry.decision === "denied",
    ),
  ).toBe(false);
});

// --- what a tool call is, what it was given, and what it produced ---------

const stepsOf = (events: RunEvent[]): ExecutionLogEntry[] =>
  events.flatMap((e) => (e.event === "log-entry" ? [e.entry] : []));

const lastStep = (events: RunEvent[], toolUseId: string): ExecutionLogEntry =>
  stepsOf(events).filter((entry) => entry.toolUseId === toolUseId).at(-1)!;

it("records the adapter's own kind as the call's tool, never its title", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "t1", kind: "read", title: "Read File" },
    { emit: "tool_call_update", toolCallId: "t1", status: "completed", content: "rows" },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  const entry = lastStep(events, "t1");
  expect(entry.tool).toBe("read");
  expect(entry.title).toBe("Read File");
});

it("records a call that names no kind as other", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "t1", title: "`python3 -c \"print(42)\"`" },
    { emit: "tool_call_update", toolCallId: "t1", status: "completed", content: "42" },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  expect(lastStep(events, "t1").tool).toBe("other");
});

it("records a kind outside the closed set as other", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "t1", kind: "telepathy", title: "Guess" },
    { emit: "tool_call_update", toolCallId: "t1", status: "completed", content: "no" },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  expect(lastStep(events, "t1").tool).toBe("other");
});

it("lets a later rawInput merge over an empty one rather than latching it", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "t1", kind: "read", title: "Read File", rawInput: {} },
    {
      emit: "tool_call_update",
      toolCallId: "t1",
      status: "in_progress",
      rawInput: { file_path: "/data/counts.csv" },
    },
    { emit: "tool_call_update", toolCallId: "t1", status: "completed", content: "rows" },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  expect(lastStep(events, "t1").input).toEqual({ file_path: "/data/counts.csv" });
});

it("keeps a populated input when a later update carries an empty one", async () => {
  const { s, events } = await session([
    {
      emit: "tool_call",
      toolCallId: "t1",
      kind: "read",
      title: "Read File",
      rawInput: { file_path: "/data/counts.csv" },
    },
    { emit: "tool_call_update", toolCallId: "t1", status: "completed", content: "rows", rawInput: {} },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  expect(lastStep(events, "t1").input).toEqual({ file_path: "/data/counts.csv" });
});

it("keeps every text block of an output, not only the first", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "t1", kind: "execute", title: "python3" },
    {
      emit: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      blocks: [
        { type: "content", content: { type: "text", text: "first" } },
        { type: "content", content: { type: "text", text: "second" } },
      ],
    },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  expect(lastStep(events, "t1").result).toBe("firstsecond");
});

it("keeps a diff block's path and both its sides", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "t1", kind: "edit", title: "Edit `/data/notes.md`" },
    {
      emit: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      blocks: [
        { type: "diff", path: "/data/notes.md", oldText: "one\n", newText: "two\n" },
      ],
    },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  expect(lastStep(events, "t1").result).toEqual([
    { type: "diff", path: "/data/notes.md", oldText: "one\n", newText: "two\n" },
  ]);
});

it("keeps a terminal block's output", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "t1", kind: "execute", title: "bash" },
    {
      emit: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      blocks: [{ type: "terminal", terminalId: "term-1", output: "12 rows\n" }],
    },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  expect(lastStep(events, "t1").result).toEqual([{ type: "terminal", output: "12 rows\n" }]);
});

it("names a resource link as a reference rather than passing it off as content", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "t1", kind: "read", title: "Read" },
    {
      emit: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      blocks: [{ type: "resource_link", uri: "file:///data/counts.csv", name: "counts.csv" }],
    },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  expect(lastStep(events, "t1").result).toEqual([
    { type: "resource", uri: "file:///data/counts.csv", name: "counts.csv" },
  ]);
});

it("names a block type it cannot draw rather than dropping it", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "t1", kind: "other", title: "Something" },
    {
      emit: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      blocks: [{ type: "hologram", frames: 3 }],
    },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  expect(lastStep(events, "t1").result).toEqual([{ type: "other", blockType: "hologram" }]);
});

it("tells a call that produced no output apart from one whose output was never reported", async () => {
  const { s, events } = await session([
    { emit: "tool_call", toolCallId: "empty", kind: "execute", title: "true" },
    { emit: "tool_call_update", toolCallId: "empty", status: "completed", blocks: [] },
    { emit: "tool_call", toolCallId: "silent", kind: "execute", title: "true" },
    { emit: "tool_call_update", toolCallId: "silent", status: "completed" },
  ]);
  s.prompt("go");
  await until(() => settled(events));
  expect(lastStep(events, "empty").result).toBe("");
  expect(lastStep(events, "silent").result).toBeUndefined();
});

// --- what an agent lets a session change ----------------------------------

/** A session opened against a stub that advertises `advertises`, with
 *  whatever it was asked to set recorded in a file the test reads back. */
async function advertisingSession(
  advertises: unknown,
  extra: { model?: string } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "lykeion-opt-"));
  dirs.push(cwd);
  const dataDir = mkdtempSync(join(tmpdir(), "lykeion-opt-state-"));
  dirs.push(dataDir);
  const setMarker = join(cwd, "sets.log");
  const events: RunEvent[] = [];
  const s = await startSession({
    adapter: { command: process.execPath, args: ["--experimental-strip-types", STUB] },
    agent: "stub",
    cwd,
    dataDir,
    grants: [],
    onEvent: (e) => events.push(e),
    onGrant: () => {},
    env: {
      ...process.env,
      LYKEION_STUB_SCRIPT: JSON.stringify([]),
      LYKEION_STUB_ADVERTISES: JSON.stringify(advertises),
      LYKEION_STUB_SET_MARKER: setMarker,
    },
    ...extra,
  });
  live.push(s);
  const sets = (): string[] =>
    existsSync(setMarker) ? readFileSync(setMarker, "utf8").trim().split("\n").filter(Boolean) : [];
  return { s, events, sets };
}

it("puts an agent into its ordinary working mode, never its full-access one", async () => {
  const { sets } = await advertisingSession({
    configOptions: [
      {
        id: "mode",
        category: "mode",
        currentValue: "read-only",
        options: [
          { id: "read-only", name: "Read only" },
          { id: "agent", name: "Agent" },
          { id: "agent-full-access", name: "Full access" },
        ],
      },
    ],
  });
  expect(sets()).toEqual(["session/set_config_option mode agent"]);
});

it("sends the researcher's choice over the method the session advertised", async () => {
  const { sets } = await advertisingSession(
    {
      models: {
        currentModelId: "sonnet",
        availableModels: [
          { modelId: "opus", name: "Opus" },
          { modelId: "sonnet", name: "Sonnet" },
        ],
      },
    },
    { model: "opus" },
  );
  expect(sets()).toEqual(["session/set_model model opus"]);
});

it("says nothing to an agent about a value it never offered", async () => {
  const { sets } = await advertisingSession(
    {
      models: { currentModelId: "sonnet", availableModels: [{ modelId: "sonnet", name: "Sonnet" }] },
    },
    { model: "a-model-this-agent-has-never-heard-of" },
  );
  expect(sets()).toEqual([]);
});

it("starts a turn normally against an agent that advertises nothing at all", async () => {
  const { s, events, sets } = await advertisingSession({});
  s.prompt("go");
  await until(() => settled(events));
  expect(sets()).toEqual([]);
  expect(events.at(-1)).toEqual({ event: "completed", state: { state: "completed" } });
});

// --- the boundary belongs to the session, not to whoever called it --------

it("confines the adapter itself, so an unconfined spawn is not something a caller can ask for", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lykeion-confine-"));
  dirs.push(cwd);
  const dataDir = mkdtempSync(join(tmpdir(), "lykeion-confine-state-"));
  dirs.push(dataDir);
  const outside = join(dataDir, "escaped.txt");
  const events: RunEvent[] = [];
  const s = await startSession({
    adapter: { command: process.execPath, args: ["--experimental-strip-types", STUB] },
    agent: "stub",
    cwd,
    dataDir,
    grants: [],
    onEvent: (e) => events.push(e),
    onGrant: () => {},
    // The stub writes this marker the moment a prompt arrives. Inside the
    // boundary it cannot: the path is this machine's own state directory.
    env: {
      ...process.env,
      LYKEION_STUB_SCRIPT: JSON.stringify([]),
      LYKEION_STUB_PROMPT_MARKER: outside,
    },
  });
  live.push(s);
  s.prompt("go");
  await until(() => settled(events));
  expect(existsSync(outside)).toBe(false);
});

it("refuses to open a session at all where this platform cannot be confined", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lykeion-noback-"));
  dirs.push(cwd);
  const dataDir = mkdtempSync(join(tmpdir(), "lykeion-noback-state-"));
  dirs.push(dataDir);
  const spawned = join(cwd, "spawned.txt");
  await expect(
    startSession({
      adapter: { command: process.execPath, args: ["--experimental-strip-types", STUB] },
      agent: "stub",
      cwd,
      dataDir,
      grants: [],
      platform: "linux",
      onEvent: () => {},
      onGrant: () => {},
      env: { ...process.env, LYKEION_STUB_SCRIPT: JSON.stringify([]), LYKEION_STUB_SESSION_NEW_MARKER: spawned },
    }),
  ).rejects.toThrow(/linux/);
  expect(existsSync(spawned)).toBe(false);
});

it("gives a run a temporary directory inside the one directory it may write", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "lykeion-tmp-"));
  dirs.push(cwd);
  const dataDir = mkdtempSync(join(tmpdir(), "lykeion-tmp-state-"));
  dirs.push(dataDir);
  const reported = join(cwd, "reported.txt");

  // An adapter that says where it was told to put a scratch file, then stops.
  // The session never opens; what is under test is what reached the child.
  await expect(
    startSession({
      adapter: {
        command: process.execPath,
        args: [
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(reported)}, process.env.TMPDIR ?? "");process.exit(3)`,
        ],
      },
      agent: "stub",
      cwd,
      dataDir,
      grants: [],
      onEvent: () => {},
      onGrant: () => {},
    }),
  ).rejects.toThrow();

  const told = readFileSync(reported, "utf8");
  expect(told).toBe(join(cwd, ".lykeion", "tmp"));
  expect(existsSync(told)).toBe(true);
  // The machine's shared temporary directory is not what a run is handed.
  expect(told).not.toBe(tmpdir());
});

it("clears a bundle a CLI replanted since the daemon started, before it opens the session", async () => {
  // The sweep runs from `installAgentHomes` once per daemon start, which
  // cannot reach a home the CLI plants into afterwards — the ordinary case on
  // a machine that has never run Lykeion, where the first process in that
  // home is a probe cycle's, minutes before anybody opens anything. Asking
  // again here is what keeps "a session reports zero skills" true for every
  // session in a daemon's life rather than only the first.
  //
  // Against the real home root, because that is the wiring under test — the
  // one this stub agent would use. Removed again whichever way this goes.
  const stubHome = join(homedir(), ".lykeion", "agents", "stub");
  const planted = join(stubHome, "skills", ".system");
  mkdirSync(planted, { recursive: true });
  writeFileSync(join(planted, "skill-creator.md"), "planted since the daemon started");
  try {
    await session([]);
    expect(existsSync(join(planted, "skill-creator.md"))).toBe(false);
  } finally {
    rmSync(stubHome, { recursive: true, force: true });
  }
});

it("says whose installation it could not clear when it refuses a session over one", async () => {
  // Refusing is the right answer — a home this machine cannot read is one it
  // cannot promise anything about — but the filesystem's own words for it are
  // `ENOTDIR: not a directory, scandir '…'`, which name neither Lykeion nor
  // the agent nor why a session that had nothing to do with that directory
  // did not open. A file where the bundle directory belongs is the portable
  // way to make the read fail; a directory nobody may enter is the real one.
  const stubHome = join(homedir(), ".lykeion", "agents", "stub");
  mkdirSync(join(stubHome, "skills"), { recursive: true });
  writeFileSync(join(stubHome, "skills", ".system"), "not a directory");
  try {
    await expect(session([])).rejects.toThrow(/Lykeion refused to open a stub session/);
    await expect(session([])).rejects.toThrow(stubHome);
    // And the reason the filesystem gave is still in there, since it is the
    // only part that says what actually went wrong.
    await expect(session([])).rejects.toThrow(/ENOTDIR|not a directory/);
  } finally {
    rmSync(stubHome, { recursive: true, force: true });
  }
});

it("points each agent at an installation of ours rather than the researcher's", () => {
  expect(adapterEnvFor("claude")).toEqual({
    CLAUDE_CONFIG_DIR: join(homedir(), ".lykeion", "agents", "claude"),
  });
  expect(adapterEnvFor("codex")).toEqual({
    CODEX_HOME: join(homedir(), ".lykeion", "agents", "codex"),
  });
});

/**
 * The two above are assertions about a pure function. These are the same
 * claim read back out of the process that was actually spawned — the only
 * place the guarantee is really made, since `adapterEnvFor` returning the
 * right pair proves nothing about whether the spawn let it win.
 *
 * Poisoned deliberately: the daemon's own environment names the researcher's
 * installation, which is exactly what a researcher who exports
 * `CLAUDE_CONFIG_DIR` in their shell profile and then starts the daemon from
 * that shell hands this. `startSession` spreads the per-agent environment
 * last, so ours is what the adapter sees; a reordering of that spread passes
 * every pure-function test in this file and fails here.
 */
it("hands a claude adapter our home even when the daemon's own environment names the researcher's", async () => {
  const { adapterEnv } = await session([], [], {
    agent: "claude",
    env: { CLAUDE_CONFIG_DIR: join(homedir(), ".claude") },
  });
  expect(adapterEnv().CLAUDE_CONFIG_DIR).toBe(join(homedir(), ".lykeion", "agents", "claude"));
});

it("hands a codex adapter our home even when the daemon's own environment names the researcher's", async () => {
  const { adapterEnv } = await session([], [], {
    agent: "codex",
    env: { CODEX_HOME: join(homedir(), ".codex") },
  });
  expect(adapterEnv().CODEX_HOME).toBe(join(homedir(), ".lykeion", "agents", "codex"));
});

it("no longer argues with codex's own configuration over MCP servers", () => {
  // There is no researcher's config.toml in reach to out-merge: the whole of
  // what codex is told about tool servers is the file Lykeion wrote.
  expect(adapterEnvFor("codex")).not.toHaveProperty("CODEX_CONFIG");
});

it("adds nothing to the environment of an agent nobody has declared", () => {
  expect(adapterEnvFor("gemini")).toEqual({});
});

it("tells claude to offer no skills at all", async () => {
  const meta = (await sessionMetaFor("claude")) as { claudeCode: { options: Record<string, unknown> } };
  expect(meta.claudeCode.options.extraArgs).toEqual({ "disable-slash-commands": null });
  // Defence in depth, not the mechanism: the researcher's settings are out of
  // reach entirely now, but a session that stops closing them is one
  // regression away from reading them again.
  expect(meta.claudeCode.options.settingSources).toEqual([]);
  expect(meta.claudeCode.options.strictMcpConfig).toBe(true);
});

it("carries no session meta for an agent that has no such channel", async () => {
  expect(await sessionMetaFor("codex")).toBeUndefined();
  expect(await sessionMetaFor("gemini")).toBeUndefined();
});
