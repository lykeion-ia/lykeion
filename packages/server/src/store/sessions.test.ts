import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./sqlite";
import { migrate } from "./migrations";
import * as sessionsStore from "./sessions";
import {
  openSession,
  recordTurn,
  recordRunFrames,
  finishTurn,
  appendStep,
  taskTurnsForTask,
  runSnapshot,
  addGrant,
  listGrants,
  runtimeForTurn,
  sessionForTurn,
  dropGrantsForStudy,
  dropGrantsForRuntime,
} from "./sessions";
import type { ExecutionLogEntry } from "@lykeion/api";
import type { Store } from "./store";

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-store-sessions-"));
  dirs.push(dir);
  const store = openStore(join(dir, "workspace.db"));
  opened.push(store);
  migrate(store);
  return store;
}

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshTurn(
  store: Store,
  overrides: Partial<{
    studyId: string;
    runtimeId: string;
    agent: string;
    openedBy: string;
    taskId: string;
    prompt: string;
  }> = {},
): { sessionId: string; turnId: string } {
  const sessionId = openSession(store, {
    studyId: overrides.studyId ?? "s_1",
    runtimeId: overrides.runtimeId ?? "rt_1",
    agent: overrides.agent ?? "claude",
    openedBy: overrides.openedBy ?? "u_1",
    openedTs: 1,
  });
  const turnId = recordTurn(store, {
    sessionId,
    taskId: overrides.taskId ?? "t_1",
    prompt: overrides.prompt ?? "go",
    startedTs: 2,
  });
  return { sessionId, turnId };
}

it("initializes a fresh turn with an empty versioned recovery snapshot", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store);

  const row = store.get(
    `SELECT last_frame_seq, recovery_snapshot FROM turns WHERE id = ?`,
    [turnId],
  )!;
  expect(row.last_frame_seq).toBe(0);
  expect(JSON.parse(row.recovery_snapshot as string)).toEqual({
    version: 1,
    state: { state: "planning" },
    stream: [],
    live: {},
    reviewing: false,
  });
});

it("persists progressive state, plan, transcript, live, and review snapshots", () => {
  const store = freshStore();
  const { sessionId, turnId } = freshTurn(store);
  const plan = { steps: [{ title: "Inspect", done: false }], raw: "1. Inspect" };
  const entry = {
    ts: 4,
    toolUseId: "read-1",
    tool: "Read",
    input: { path: "counts.csv" },
    decision: "ran",
    result: "12 rows",
    isError: false,
  };

  recordRunFrames(store, turnId, [
    { seq: 1, event: { event: "plan-proposed", plan } },
    { seq: 2, event: { event: "state", state: { state: "executing", plan } } },
    { seq: 3, event: { event: "assistant-text", text: "Inspecting.", partial: false } },
    { seq: 4, event: { event: "log-entry", entry } },
    { seq: 5, event: { event: "live", live: { thinking: "Checking totals" } } },
    { seq: 6, event: { event: "reviewing" } },
  ], 10);

  const read = (sessionsStore as unknown as {
    runSnapshot?: (store: Store, runId: string) => unknown;
  }).runSnapshot;
  expect(read?.(store, turnId)).toEqual({
    runId: turnId,
    sequence: store.get(`SELECT seq FROM turns WHERE id = ?`, [turnId])!.seq,
    prompt: "go",
    agent: "claude",
    state: { state: "executing", plan },
    plan,
    stream: [
      { kind: "text", text: "Inspecting.", block: "interim" },
      { kind: "step", entry },
    ],
    live: { thinking: "Checking totals" },
    reviewing: true,
    lastEventSeq: 6,
    sessionId,
    runtimeId: "rt_1",
    openedBy: "u_1",
  });
});

it("keeps partial prose only in the active live tail and promotes it on settlement", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store);

  recordRunFrames(store, turnId, [
    { seq: 1, event: { event: "assistant-text", text: "Strong ", partial: true } },
    { seq: 2, event: { event: "live", live: { text: "Strong " } } },
    { seq: 3, event: { event: "assistant-text", text: "candidates", partial: true } },
    { seq: 4, event: { event: "live", live: { text: "Strong candidates" } } },
  ], 10);

  expect(runSnapshot(store, turnId)).toMatchObject({
    stream: [{ kind: "text", text: "Strong candidates", block: "interim" }],
    live: { text: "Strong candidates" },
    lastEventSeq: 4,
  });
  expect(store.all(
    `SELECT text, partial FROM turn_items WHERE turn_id = ? ORDER BY seq ASC`,
    [turnId],
  )).toEqual([
    { text: "Strong ", partial: 1 },
    { text: "candidates", partial: 1 },
  ]);

  recordRunFrames(store, turnId, [
    { seq: 5, event: { event: "completed", state: { state: "completed" } } },
  ], 11);

  expect(runSnapshot(store, turnId)).toMatchObject({
    state: { state: "completed" },
    stream: [{ kind: "text", text: "Strong candidates", block: "interim" }],
    live: {},
    lastEventSeq: 5,
  });
  expect(taskTurnsForTask(store, "t_1")[0]?.stream).toEqual([
    { kind: "text", text: "Strong candidates", block: "interim" },
  ]);
});

it("folds a compatibility whole-message frame over its partial chunks once", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store);

  recordRunFrames(store, turnId, [
    { seq: 1, event: { event: "assistant-text", text: "Strong ", partial: true } },
    { seq: 2, event: { event: "assistant-text", text: "candidates", partial: true } },
    { seq: 3, event: { event: "assistant-text", text: "Strong candidates", partial: false } },
  ], 10);

  expect(runSnapshot(store, turnId)?.stream).toEqual([
    { kind: "text", text: "Strong candidates", block: "interim" },
  ]);
  expect(store.all(
    `SELECT text, partial, block FROM turn_items
      WHERE turn_id = ? ORDER BY seq ASC`,
    [turnId],
  )).toEqual([
    { text: "Strong candidates", partial: 0, block: "interim" },
  ]);
  expect(store.get(`SELECT text FROM turns WHERE id = ?`, [turnId])).toEqual({
    text: "Strong candidates",
  });
});

it("persists ordered typed blocks inside one turn and recovery snapshot", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store);
  const failedStep = {
    ts: 4,
    toolUseId: "python-1",
    tool: "python",
    input: { code: "import sklearn" },
    decision: "ran",
    result: "ModuleNotFoundError: sklearn",
    isError: true,
  };

  recordRunFrames(store, turnId, [
    { seq: 1, event: { event: "assistant-thought", text: "Check ", partial: true } },
    { seq: 2, event: { event: "assistant-thought", text: "dependencies", partial: true } },
    { seq: 3, event: { event: "assistant-text", text: "I will inspect the data.", partial: true } },
    { seq: 4, event: { event: "log-entry", entry: failedStep } },
    { seq: 5, event: { event: "assistant-text", text: "I used a ", partial: true } },
    { seq: 6, event: { event: "assistant-text", text: "rank-based fallback.", partial: true } },
    { seq: 7, event: { event: "assistant-text-final" } },
  ], 10);

  const ordered = [
    { kind: "text", text: "Check dependencies", block: "thought" },
    { kind: "text", text: "I will inspect the data.", block: "interim" },
    { kind: "step", entry: failedStep },
    { kind: "text", text: "I used a rank-based fallback.", block: "final" },
  ];
  expect(runSnapshot(store, turnId)).toMatchObject({ runId: turnId, stream: ordered });

  recordRunFrames(store, turnId, [
    { seq: 8, event: { event: "completed", state: { state: "completed" } } },
  ], 11);
  const settled = taskTurnsForTask(store, "t_1")[0];
  expect(settled?.runId).toBe(turnId);
  expect(settled?.stream).toEqual(ordered);
});

it("records a failed turn reason as an error block without creating another turn", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store);
  recordRunFrames(store, turnId, [
    { seq: 1, event: { event: "assistant-text", text: "Trying once.", partial: true } },
    { seq: 2, event: { event: "completed", state: { state: "failed", reason: "adapter exited" } } },
  ], 10);
  const turns = taskTurnsForTask(store, "t_1");
  expect(turns).toHaveLength(1);
  expect(turns[0]?.runId).toBe(turnId);
  expect(turns[0]?.stream).toEqual([
    { kind: "text", text: "Trying once.", block: "interim" },
    { kind: "text", text: "adapter exited", block: "error" },
  ]);
});

it("makes permission and question cards recoverable without a separate state frame", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store);
  const permission = {
    id: "perm-1",
    access: { kind: "write-path" as const, target: "results.csv" },
    tool: "Write",
  };
  const question = {
    requestId: "q-1",
    header: "Library",
    question: "Which library?",
    options: [{ label: "Brunello" }],
    multiSelect: false,
  };

  recordRunFrames(store, turnId, [
    { seq: 1, event: { event: "permission-card", request: permission } },
  ], 10);
  let recovery = JSON.parse(
    store.get(`SELECT recovery_snapshot FROM turns WHERE id = ?`, [turnId])!
      .recovery_snapshot as string,
  );
  expect(recovery.state).toEqual({ state: "awaiting-permission", request: permission });

  recordRunFrames(store, turnId, [
    { seq: 2, event: { event: "question-asked", request: question } },
  ], 11);
  recovery = JSON.parse(
    store.get(`SELECT recovery_snapshot FROM turns WHERE id = ?`, [turnId])!
      .recovery_snapshot as string,
  );
  expect(recovery.state).toEqual({ state: "awaiting-question", request: question });
});

it("ignores duplicate frames and rejects a sequence gap without changing the snapshot", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store);
  const first = { seq: 1, event: { event: "assistant-text" as const, text: "one", partial: false } };

  recordRunFrames(store, turnId, [first], 10);
  recordRunFrames(store, turnId, [first], 11);

  expect(store.get(`SELECT text, last_frame_seq FROM turns WHERE id = ?`, [turnId])).toEqual({
    text: "one",
    last_frame_seq: 1,
  });
  const before = store.get(`SELECT recovery_snapshot FROM turns WHERE id = ?`, [turnId])!
    .recovery_snapshot;
  expect(() =>
    recordRunFrames(store, turnId, [
      { seq: 3, event: { event: "assistant-text", text: "three", partial: false } },
    ], 12),
  ).toThrow(/frame sequence gap.*expected 2.*received 3/i);
  expect(store.get(`SELECT text, last_frame_seq, recovery_snapshot FROM turns WHERE id = ?`, [turnId]))
    .toEqual({ text: "one", last_frame_seq: 1, recovery_snapshot: before });
});

it("persists a completed terminal snapshot before settling the turn", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store);
  store.run(`
    CREATE TRIGGER require_terminal_recovery_before_settle
    BEFORE UPDATE OF ended_ts ON turns
    WHEN NEW.ended_ts IS NOT NULL AND (
      json_extract(NEW.recovery_snapshot, '$.state.state') != 'completed'
      OR NEW.last_frame_seq != 1
    )
    BEGIN
      SELECT RAISE(ABORT, 'terminal snapshot missing');
    END`);

  recordRunFrames(store, turnId, [
    { seq: 1, event: { event: "completed", state: { state: "completed" } } },
  ], 42);

  const row = store.get(
    `SELECT ended_ts, status, last_frame_seq, recovery_snapshot FROM turns WHERE id = ?`,
    [turnId],
  )!;
  expect(row).toMatchObject({ ended_ts: 42, status: "ok", last_frame_seq: 1 });
  expect(JSON.parse(row.recovery_snapshot as string)).toMatchObject({
    version: 1,
    state: { state: "completed" },
    live: {},
    reviewing: false,
  });
});

it("treats completion as a terminal boundary for trailing and later frames", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store);

  recordRunFrames(store, turnId, [
    { seq: 1, event: { event: "assistant-text", text: "kept", partial: false } },
    { seq: 2, event: { event: "completed", state: { state: "completed" } } },
    { seq: 3, event: { event: "assistant-text", text: "same-batch-late", partial: false } },
  ], 42);
  recordRunFrames(store, turnId, [
    { seq: 3, event: { event: "assistant-text", text: "later-request", partial: false } },
  ], 43);

  expect(
    store.get(`SELECT text, ended_ts, status, last_frame_seq FROM turns WHERE id = ?`, [turnId]),
  ).toEqual({ text: "kept", ended_ts: 42, status: "ok", last_frame_seq: 2 });
});

it("preserves outside-workspace provenance in active and settled snapshots", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store);
  const entry = {
    ts: 4,
    toolUseId: "write-escape",
    tool: "Write",
    input: { file_path: "/tmp/out.csv" },
    decision: "ran",
    result: "written",
    isError: false,
    outsideWorkspace: true,
  };

  recordRunFrames(store, turnId, [
    { seq: 1, event: { event: "log-entry", entry } },
  ], 10);
  expect(runSnapshot(store, turnId)?.stream).toEqual([{ kind: "step", entry }]);

  recordRunFrames(store, turnId, [
    { seq: 2, event: { event: "completed", state: { state: "completed" } } },
  ], 11);
  expect(taskTurnsForTask(store, "t_1")[0].stream).toEqual([{ kind: "step", entry }]);
});

it("reads the Task's active snapshot with its session ownership", () => {
  const store = freshStore();
  const first = freshTurn(store, { agent: "claude", runtimeId: "rt_1", openedBy: "u_1" });
  const sibling = freshTurn(store, {
    taskId: "t_2",
    agent: "codex",
    runtimeId: "rt_2",
    openedBy: "u_2",
  });
  finishTurn(store, sibling.turnId, { endedTs: 8, status: "ok" });
  const settled = freshTurn(store, {
    taskId: "t_3",
    agent: "claude",
    runtimeId: "rt_3",
    openedBy: "u_3",
  });
  finishTurn(store, settled.turnId, { endedTs: 9, status: "ok" });

  const read = (sessionsStore as unknown as {
    activeRunSnapshotsForTask?: (store: Store, taskId: string) => Array<Record<string, unknown>>;
  }).activeRunSnapshotsForTask;
  const snapshots = read?.(store, "t_1");
  expect(snapshots?.map(({ runId, agent, sessionId, runtimeId, openedBy }) => ({
    runId, agent, sessionId, runtimeId, openedBy,
  }))).toEqual([
    {
      runId: first.turnId,
      agent: "claude",
      sessionId: first.sessionId,
      runtimeId: "rt_1",
      openedBy: "u_1",
    },
  ]);
});

it("returns only settled Task turns with their durable sequence in transcript order", () => {
  const store = freshStore();
  const first = freshTurn(store, { prompt: "first" });
  finishTurn(store, first.turnId, { endedTs: 7, status: "ok" });
  const second = recordTurn(store, {
    sessionId: first.sessionId, taskId: "t_1", prompt: "second", startedTs: 3,
  });
  finishTurn(store, second, { endedTs: 8, status: "ok" });
  recordTurn(store, {
    sessionId: first.sessionId, taskId: "t_1", prompt: "still running", startedTs: 4,
  });
  const expectedSequences = store
    .all(`SELECT seq FROM turns WHERE id IN (?, ?) ORDER BY seq ASC`, [first.turnId, second])
    .map((row) => row.seq);

  const turns = taskTurnsForTask(store, "t_1");

  expect(turns.map(({ prompt, sequence }) => ({ prompt, sequence }))).toEqual([
    { prompt: "first", sequence: expectedSequences[0] },
    { prompt: "second", sequence: expectedSequences[1] },
  ]);
});

it("settles a turn's ended_ts and status", () => {
  const store = freshStore();
  const sessionId = openSession(store, {
    studyId: "s_1", runtimeId: "rt_1", agent: "claude", openedBy: "u_1", openedTs: 1,
  });
  const turnId = recordTurn(store, { sessionId, taskId: "t_1", prompt: "go", startedTs: 1 });

  finishTurn(store, turnId, { endedTs: 42, status: "ok" });

  expect(store.get(`SELECT status, ended_ts FROM turns WHERE id = ?`, [turnId])).toEqual({
    status: "ok",
    ended_ts: 42,
  });
});

it("resolves the runtime a turn's session belongs to, and nothing for an unknown turn", () => {
  const store = freshStore();
  const sessionId = openSession(store, {
    studyId: "s_1", runtimeId: "rt_1", agent: "claude", openedBy: "u_1", openedTs: 1,
  });
  const turnId = recordTurn(store, { sessionId, taskId: "t_1", prompt: "go", startedTs: 1 });

  expect(runtimeForTurn(store, turnId)).toBe("rt_1");
  expect(runtimeForTurn(store, "run_nonexistent")).toBeUndefined();
});

it("appends a step to a turn's transcript, storing its input as JSON", () => {
  const store = freshStore();
  const sessionId = openSession(store, {
    studyId: "s_1", runtimeId: "rt_1", agent: "claude", openedBy: "u_1", openedTs: 1,
  });
  const turnId = recordTurn(store, { sessionId, taskId: "t_1", prompt: "go", startedTs: 1 });

  const stepId = appendStep(store, {
    turnId, ts: 5, toolUseId: "tu_1", tool: "Read", input: { path: "/a" }, decision: "ran", isError: false,
  });

  const row = store.get(`SELECT * FROM turn_steps WHERE id = ?`, [stepId])!;
  expect(row.tool_use_id).toBe("tu_1");
  expect(row.title).toBeNull();
  expect(row.is_error).toBe(0);
  expect(JSON.parse(row.input as string)).toEqual({ path: "/a" });
});

it("grants a Study standing access to a folder on one runtime, and lists it back", () => {
  const store = freshStore();

  addGrant(store, {
    studyId: "s_1", runtimeId: "rt_1", path: "/work/rna-seq", mode: "write", grantedBy: "u_1", grantedTs: 1,
  });

  expect(listGrants(store, "s_1", "rt_1")).toEqual([{ path: "/work/rna-seq", mode: "write" }]);
  // Scoped to the (study, runtime) pair the grant named — neither a
  // different Study nor a different runtime sees it.
  expect(listGrants(store, "s_1", "rt_2")).toEqual([]);
  expect(listGrants(store, "s_2", "rt_1")).toEqual([]);
});

it("does not duplicate a grant already standing for the same Study, runtime, path, and mode", () => {
  const store = freshStore();

  addGrant(store, {
    studyId: "s_1", runtimeId: "rt_1", path: "/work/rna-seq", mode: "write", grantedBy: "u_1", grantedTs: 1,
  });
  addGrant(store, {
    studyId: "s_1", runtimeId: "rt_1", path: "/work/rna-seq", mode: "write", grantedBy: "u_1", grantedTs: 2,
  });

  expect(listGrants(store, "s_1", "rt_1")).toEqual([{ path: "/work/rna-seq", mode: "write" }]);
  // A different mode on the same path is a different grant, not a repeat —
  // read and write are not interchangeable, so both stand.
  addGrant(store, {
    studyId: "s_1", runtimeId: "rt_1", path: "/work/rna-seq", mode: "read", grantedBy: "u_1", grantedTs: 3,
  });
  expect(listGrants(store, "s_1", "rt_1")).toEqual([
    { path: "/work/rna-seq", mode: "write" },
    { path: "/work/rna-seq", mode: "read" },
  ]);
});

it("resolves a turn's Study, runtime, and opener through its session, and nothing for an unknown turn", () => {
  const store = freshStore();
  const sessionId = openSession(store, {
    studyId: "s_1", runtimeId: "rt_1", agent: "claude", openedBy: "u_1", openedTs: 1,
  });
  const turnId = recordTurn(store, { sessionId, taskId: "t_1", prompt: "go", startedTs: 1 });

  expect(sessionForTurn(store, turnId)).toEqual({ studyId: "s_1", runtimeId: "rt_1", openedBy: "u_1" });
  expect(sessionForTurn(store, "run_nonexistent")).toBeUndefined();
});

it("drops every grant a Study holds, leaving another Study's alone", () => {
  const store = freshStore();
  addGrant(store, {
    studyId: "s_1", runtimeId: "rt_1", path: "/work/rna-seq", mode: "write", grantedBy: "u_1", grantedTs: 1,
  });
  addGrant(store, {
    studyId: "s_2", runtimeId: "rt_1", path: "/work/other", mode: "read", grantedBy: "u_1", grantedTs: 1,
  });

  dropGrantsForStudy(store, "s_1");

  expect(listGrants(store, "s_1", "rt_1")).toEqual([]);
  expect(listGrants(store, "s_2", "rt_1")).toEqual([{ path: "/work/other", mode: "read" }]);
});

it("drops every grant standing on a runtime, leaving another runtime's alone", () => {
  const store = freshStore();
  addGrant(store, {
    studyId: "s_1", runtimeId: "rt_1", path: "/work/rna-seq", mode: "write", grantedBy: "u_1", grantedTs: 1,
  });
  addGrant(store, {
    studyId: "s_1", runtimeId: "rt_2", path: "/work/other", mode: "read", grantedBy: "u_1", grantedTs: 1,
  });

  dropGrantsForRuntime(store, "rt_1");

  expect(listGrants(store, "s_1", "rt_1")).toEqual([]);
  expect(listGrants(store, "s_1", "rt_2")).toEqual([{ path: "/work/other", mode: "read" }]);
});

it("reads a step's typed output parts back as they were written", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store);
  const parts = [
    { type: "diff" as const, path: "/data/notes.md", oldText: "one\n", newText: "two\n" },
    { type: "text" as const, text: "edited" },
  ];

  recordRunFrames(
    store,
    turnId,
    [
      {
        seq: 1,
        event: {
          event: "log-entry" as const,
          entry: {
            ts: 4,
            toolUseId: "edit-1",
            tool: "edit",
            input: { file_path: "/data/notes.md" },
            decision: "ran",
            result: parts,
            isError: false,
          },
        },
      },
    ],
    10,
  );
  finishTurn(store, turnId, { endedTs: 11, status: "ok" });

  const [turn] = taskTurnsForTask(store, "t_1");
  expect(turn.stream).toEqual([
    {
      kind: "step",
      entry: {
        ts: 4,
        toolUseId: "edit-1",
        tool: "edit",
        input: { file_path: "/data/notes.md" },
        decision: "ran",
        result: parts,
        isError: false,
      },
    },
  ]);
});

it("keeps a step that produced no output apart from one whose output was never reported", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store);

  appendStep(store, {
    turnId, ts: 5, toolUseId: "empty", tool: "execute", input: {}, decision: "ran",
    result: "", isError: false,
  });
  appendStep(store, {
    turnId, ts: 6, toolUseId: "silent", tool: "execute", input: {}, decision: "ran",
    isError: false,
  });
  finishTurn(store, turnId, { endedTs: 7, status: "ok" });

  const [turn] = taskTurnsForTask(store, "t_1");
  const entries = (turn.stream ?? []).flatMap((item) => (item.kind === "step" ? [item.entry] : []));
  expect(entries.map((entry) => entry.result)).toEqual(["", undefined]);
});

it("gives back the same step it was given, for every shape an output takes", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store);
  const shapes: Array<ExecutionLogEntry["result"]> = [
    "12 rows",
    "",
    undefined,
    [{ type: "diff", path: "/data/a.md", oldText: "one\n", newText: "two\n" }],
    [{ type: "terminal", output: "done\n" }],
    [{ type: "resource", uri: "file:///data/a.csv", name: "a.csv" }],
    [{ type: "other", blockType: "hologram" }],
  ];
  const sent: ExecutionLogEntry[] = shapes.map((result, i) => ({
    ts: 4 + i,
    toolUseId: `tu-${i}`,
    tool: "other",
    input: { i },
    decision: "ran",
    ...(result === undefined ? {} : { result }),
    isError: false,
  }));

  recordRunFrames(
    store,
    turnId,
    sent.map((entry, i) => ({ seq: i + 1, event: { event: "log-entry" as const, entry } })),
    10,
  );
  finishTurn(store, turnId, { endedTs: 20, status: "ok" });

  const [turn] = taskTurnsForTask(store, "t_1");
  expect((turn.stream ?? []).flatMap((item) => (item.kind === "step" ? [item.entry] : []))).toEqual(
    sent,
  );
});
