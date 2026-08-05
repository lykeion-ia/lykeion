import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionLogEntry, RunEvent } from "@lykeion/api";
import { startSession, type LiveSession, type StandingGrant } from "./session";

const STUB = join(import.meta.dirname, "test-support", "stub-acp-agent.ts");
const live: LiveSession[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const s of live.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function session(
  script: unknown[],
  grants: StandingGrant[] = [],
  options: { cancelGraceMs?: number } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "lykeion-sess-"));
  dirs.push(cwd);
  const events: RunEvent[] = [];
  const granted: StandingGrant[] = [];
  const s = await startSession({
    adapter: {
      command: process.execPath,
      args: ["--experimental-strip-types", STUB],
    },
    cwd,
    grants,
    onEvent: (e) => events.push(e),
    onGrant: (g) => granted.push(g),
    env: { ...process.env, LYKEION_STUB_SCRIPT: JSON.stringify(script) },
    ...(options.cancelGraceMs !== undefined ? { cancelGraceMs: options.cancelGraceMs } : {}),
  });
  live.push(s);
  return { s, events, granted };
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

it("never asks about a folder the Study already granted", async () => {
  // The standing grant is the whole point: a researcher who said "this
  // Study" once must not be asked the same question next session.
  const { s, events } = await session(
    [{ ask: "permission", toolCallId: "t1", title: "Write /granted/out.csv" }],
    [{ path: "/granted", mode: "write" }],
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
      cwd: tmpdir(),
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
  const { s, events } = await session(
    [
      [
        { sleep: 150 },
        { ask: "permission", toolCallId: "granted-tool", title: "Write /work/out.csv" },
        { endTurn: "end_turn" },
      ],
      [{ emit: "agent_message_chunk", text: "second turn content" }, { endTurn: "end_turn" }],
    ],
    [{ path: "/work", mode: "write" }],
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
