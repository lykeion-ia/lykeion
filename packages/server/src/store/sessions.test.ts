import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./sqlite";
import { MIGRATIONS, migrate, nextSeq } from "./migrations";
import * as sessionsStore from "./sessions";
import { notebookFor } from "./cells";
import { envelopeById } from "./provenance";
import {
  openSession,
  recordTurn,
  recordRunFrames,
  finishTurn,
  activeTurnForTask,
  openTurnCountForTask,
  appendStep,
  taskTurnsForTask,
  runSnapshot,
  addGrant,
  listGrants,
  machineForTurn,
  sessionForTurn,
  dropGrantsForResearch,
  dropGrantsForMachine,
} from "./sessions";
import { type ProvenanceEnvelope } from "@lykeion/api";
import { envelopeHash } from "@lykeion/api/provenance-hash";
import type { ExecutionLogEntry, NotebookCell, RunEventFrame } from "@lykeion/api";
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
    researchId: string;
    machineId: string;
    agent: string;
    openedBy: string;
    taskId: string;
    prompt: string;
  }> = {},
): { sessionId: string; turnId: string } {
  const sessionId = openSession(store, {
    researchId: overrides.researchId ?? "s_1",
    machineId: overrides.machineId ?? "rt_1",
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
    machineId: "rt_1",
    openedBy: "u_1",
  });
});

it("folds a cell frame into the Task's notebook, keyed off the turn's own task, and leaves the transcript stream untouched", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store, { taskId: "t_notebook" });
  const cell: NotebookCell = {
    id: "wire-only",
    kernelId: "k_1",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 1,
    source: "1 + 1",
    origin: { surface: "agent", by: "a_claude" },
    ok: true,
    wallMs: 8,
    ts: 42,
    outputs: [{ kind: "stream", name: "stdout", text: "2\n" }],
    toolUseId: "tu_1",
  };

  const provenance = envelopeFor() as unknown as ProvenanceEnvelope;
  recordRunFrames(store, turnId, [{ seq: 1, event: { event: "cell", cell, provenance } }], 100);

  const notebook = notebookFor(store, "t_notebook");
  expect(notebook).toHaveLength(1);
  expect(notebook[0]).toEqual({
    ...cell,
    id: notebook[0]!.id,
    provenanceId: envelopeHash(provenance),
  });
  // The wire id is a placeholder the daemon minted for transit; the row
  // mints its own durable one rather than trusting it.
  expect(notebook[0]!.id).not.toBe("wire-only");
  // A cell lives in the `cells` table, found through `notebookFor` — not
  // replayed out of a turn's own recovery stream.
  expect(runSnapshot(store, turnId)?.stream).toEqual([]);
});

it("carries what an agent's cell installed into its kernel all the way onto the notebook", () => {
  // The agent's own cells reach this lab as run frames and the researcher's
  // reach it through `/daemon/cell`. This is the frame path's half: a field
  // the fold drops here is one that arrives at every other hop and is on no
  // notebook anybody can open.
  const store = freshStore();
  const { turnId } = freshTurn(store, { taskId: "t_installed" });
  const cell: NotebookCell = {
    id: "wire-only",
    kernelId: "k_1",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 1,
    source: "!pip install scanpy",
    origin: { surface: "agent", by: "a_claude" },
    ok: true,
    wallMs: 8,
    ts: 42,
    outputs: [],
    installed: ["anndata", "scanpy"],
  };

  recordRunFrames(
    store,
    turnId,
    [{ seq: 1, event: { event: "cell", cell, provenance: envelopeFor() as unknown as ProvenanceEnvelope } }],
    100,
  );

  expect(notebookFor(store, "t_installed")[0]!.installed).toEqual(["anndata", "scanpy"]);
});

it("drops a cell frame for a run that has already ended, the same as every other frame", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store, { taskId: "t_ended" });
  finishTurn(store, turnId, { endedTs: 50, status: "ok" });

  const accepted = recordRunFrames(
    store,
    turnId,
    [
      {
        seq: 1,
        event: {
          event: "cell",
          cell: {
            id: "c_1",
            kernelId: "k_1",
            name: "main",
            language: "python",
            environment: "python",
            executionCount: 1,
            source: "1 + 1",
            origin: { surface: "agent", by: "a_claude" },
            ok: true,
            wallMs: 8,
            ts: 42,
            outputs: [],
          },
          provenance: envelopeFor() as unknown as ProvenanceEnvelope,
        },
      },
    ],
    100,
  );

  expect(accepted).toEqual([]);
  expect(notebookFor(store, "t_ended")).toEqual([]);
});

/** The record a cell's frame carries beside it, as a kernel host builds one.
 *  Named by the hash of its own bytes, which is why the tests below compute
 *  that hash rather than naming a literal: a fixture whose id was written out
 *  by hand would stop being this envelope's id the moment a field moved. */
function envelopeFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "lykeion.provenance.v1",
    identity: {
      taskId: "t_provenance",
      sessionId: "se_1",
      kernelId: "k_1",
      cellId: "wire-only",
    },
    input: {
      code: "1 + 1",
      cwd: "/w",
      codeState: {
        lineage: { incarnation: 0, index: 0, digest: "d0" },
        git: { status: "unavailable", reason: "not_applicable" },
      },
    },
    environment: {
      host: {
        platform: "darwin",
        arch: "arm64",
        runtimes: { status: "unavailable", reason: "not_captured" },
      },
      kernel: {
        id: "k_1",
        language: "python",
        incarnation: 0,
        processId: 2,
        processStartedAt: 100,
      },
    },
    outputs: { status: "succeeded", items: [] },
    timestamps: { createdAt: 40, startedAt: 41, completedAt: 42 },
    ...overrides,
  };
}

/** A cell as a frame carries one, with the id the machine that ran it
 *  minted. */
function cellFor(): NotebookCell {
  return {
    id: "wire-only",
    kernelId: "k_1",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 1,
    source: "1 + 1",
    origin: { surface: "agent", by: "a_claude" },
    ok: true,
    wallMs: 8,
    ts: 42,
    outputs: [],
  };
}

it("keeps the record a cell's frame carried, and joins the cell to it", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store, { taskId: "t_provenance" });
  const provenance = envelopeFor();

  recordRunFrames(
    store,
    turnId,
    [{ seq: 1, event: { event: "cell", cell: cellFor(), provenance } }] as unknown as RunEventFrame[],
    100,
  );

  const cell = notebookFor(store, "t_provenance")[0]!;
  expect(cell.provenanceId).toBe(envelopeHash(provenance as never));
  expect(envelopeById(store, cell.provenanceId!)).toEqual(provenance);
});

it("files a record under the Task the frame arrived on, never the one it names for itself", () => {
  // A sender naming its own Task is a sender that can file a record anywhere.
  // The Task and the session come from the turn, the same as the cell's do.
  const store = freshStore();
  const { turnId, sessionId } = freshTurn(store, { taskId: "t_provenance" });

  recordRunFrames(
    store,
    turnId,
    [
      {
        seq: 1,
        event: {
          event: "cell",
          cell: cellFor(),
          provenance: envelopeFor({
            identity: {
              taskId: "t_somewhere_else",
              sessionId: "se_somewhere_else",
              kernelId: "k_1",
              cellId: "wire-only",
            },
          }),
        },
      },
    ] as unknown as RunEventFrame[],
    100,
  );

  const row = store.get(`SELECT task_id, session_id, ts FROM provenance_envelopes`)!;
  expect(row.task_id).toBe("t_provenance");
  expect(row.session_id).toBe(sessionId);
  // The moment the cell reports, not the moment the batch landed.
  expect(row.ts).toBe(42);
});

it("records a cell whose record this lab cannot read, with no join to one", () => {
  // A notebook missing the cell would be a worse record than one missing the
  // envelope behind it.
  const store = freshStore();
  const { turnId } = freshTurn(store, { taskId: "t_unreadable" });

  const said: unknown[][] = [];
  const reporting = console.error;
  console.error = (...args: unknown[]) => said.push(args);
  try {
    recordRunFrames(
      store,
      turnId,
      [
        {
          seq: 1,
          event: {
            event: "cell",
            cell: cellFor(),
            provenance: envelopeFor({ version: "lykeion.provenance.v9" }),
          },
        },
      ] as unknown as RunEventFrame[],
      100,
    );
  } finally {
    console.error = reporting;
  }

  // A body was there and this lab refused it. Nothing else anywhere would
  // surface that, so the fold says so the way it says it about a cell.
  expect(said.filter((args) => String(args[0]).includes("cannot read"))).toHaveLength(1);
  const notebook = notebookFor(store, "t_unreadable");
  expect(notebook).toHaveLength(1);
  expect("provenanceId" in notebook[0]!).toBe(false);
  expect(store.get(`SELECT id FROM provenance_envelopes`)).toBeUndefined();
});

it("records a cell whose frame carried no record at all", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store, { taskId: "t_norecord" });

  const said: unknown[][] = [];
  const reporting = console.error;
  console.error = (...args: unknown[]) => said.push(args);
  try {
    recordRunFrames(
      store,
      turnId,
      [{ seq: 1, event: { event: "cell", cell: cellFor() } }] as unknown as RunEventFrame[],
      100,
    );
  } finally {
    console.error = reporting;
  }

  expect("provenanceId" in notebookFor(store, "t_norecord")[0]!).toBe(false);
  // Silence, not a complaint: a daemon built before this field sends none,
  // and saying so on every cell it forwards would be noise on every line.
  expect(said).toEqual([]);
});

it("commits the valid frames around a run event the fold switch does not recognize, and keeps accepting frames after it", () => {
  // This whole loop runs inside one transaction shared with the rest of the
  // batch (`http.ts`'s `/daemon/run/events` handler wraps `recordRunFrames`
  // in `store.tx`), so throwing on a frame naming an event this build does
  // not know would roll every valid frame in the batch back with it, and the
  // daemon would retry that exact same immutable batch forever behind it. An
  // unrecognized event is logged and treated as a no-op instead: the batch
  // still commits, and the run still accepts frames afterward.
  const store = freshStore();
  const { turnId } = freshTurn(store, { taskId: "t_guard" });
  const bogus = [
    { seq: 1, event: { event: "plan-proposed", plan: { steps: [{ title: "Inspect", done: false }] } } },
    { seq: 2, event: { event: "made-up-event" } },
    { seq: 3, event: { event: "reviewing" } },
  ] as unknown as RunEventFrame[];

  const said: unknown[][] = [];
  const reporting = console.error;
  console.error = (...args: unknown[]) => said.push(args);
  let accepted: RunEventFrame[];
  try {
    accepted = recordRunFrames(store, turnId, bogus, 100);
  } finally {
    console.error = reporting;
  }

  expect(accepted.map((f) => f.seq)).toEqual([1, 2, 3]);
  const snapshot = runSnapshot(store, turnId);
  expect(snapshot?.plan).toEqual({ steps: [{ title: "Inspect", done: false }] });
  expect(snapshot?.reviewing).toBe(true);
  expect(snapshot?.lastEventSeq).toBe(3);
  expect(said.some((args) => String(args[0]).includes("made-up-event"))).toBe(true);

  // The run's cursor moved past the whole batch, unrecognized frame
  // included — a later frame is accepted rather than rejected as a gap.
  const more = recordRunFrames(
    store,
    turnId,
    [{ seq: 4, event: { event: "live", live: { thinking: "still going" } } }],
    101,
  );
  expect(more.map((f) => f.seq)).toEqual([4]);
  expect(runSnapshot(store, turnId)?.live).toEqual({ thinking: "still going" });
});

it("commits the valid frames around a cell frame this lab cannot record, and keeps accepting frames after it", () => {
  // A `cell` frame is recognized by the switch and then written into a
  // constrained row: `origin_surface` is a CHECK, and a frame carrying no
  // cell at all reaches the same INSERT with nothing to put in it. Either
  // one throwing would take the whole batch's transaction with it and leave
  // the daemon retrying that same immutable batch forever — the failure the
  // unrecognized-event case above already refuses to be.
  const store = freshStore();
  const { turnId } = freshTurn(store, { taskId: "t_badcell" });
  const bogus = [
    { seq: 1, event: { event: "reviewing" } },
    {
      seq: 2,
      event: {
        event: "cell",
        cell: {
          id: "c_1",
          kernelId: "k_1",
          name: "main",
          language: "python",
          environment: "python",
          executionCount: 1,
          source: "1 + 1",
          // Neither `agent` nor `repl`, which is what the column allows.
          origin: { surface: "somewhere else", by: "a_claude" },
          ok: true,
          wallMs: 8,
          ts: 42,
          outputs: [],
        },
      },
    },
    { seq: 3, event: { event: "cell" } },
    { seq: 4, event: { event: "live", live: { thinking: "still going" } } },
  ] as unknown as RunEventFrame[];

  const said: unknown[][] = [];
  const reporting = console.error;
  console.error = (...args: unknown[]) => said.push(args);
  let accepted: RunEventFrame[];
  try {
    accepted = recordRunFrames(store, turnId, bogus, 100);
  } finally {
    console.error = reporting;
  }

  expect(accepted.map((f) => f.seq)).toEqual([1, 2, 3, 4]);
  expect(notebookFor(store, "t_badcell")).toEqual([]);
  const snapshot = runSnapshot(store, turnId);
  expect(snapshot?.reviewing).toBe(true);
  expect(snapshot?.live).toEqual({ thinking: "still going" });
  expect(snapshot?.lastEventSeq).toBe(4);
  expect(said.filter((args) => String(args[0]).includes("cannot record"))).toHaveLength(2);

  // The run's cursor moved past the whole batch, so the frames behind it are
  // accepted rather than rejected as a gap.
  const more = recordRunFrames(
    store,
    turnId,
    [{ seq: 5, event: { event: "assistant-text", text: "done", partial: false } }],
    101,
  );
  expect(more.map((f) => f.seq)).toEqual([5]);
});

it("records a cell whose outputs are messages it knows, and refuses one whose are not", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store, { taskId: "t_outputs" });
  const cell = {
    id: "wire-only",
    kernelId: "k_1",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 1,
    source: "plot()",
    origin: { surface: "agent", by: "a_claude" },
    ok: true,
    wallMs: 8,
    ts: 42,
  };

  const said: unknown[][] = [];
  const reporting = console.error;
  console.error = (...args: unknown[]) => said.push(args);
  try {
    recordRunFrames(
      store,
      turnId,
      [
        {
          seq: 1,
          event: {
            event: "cell",
            cell: { ...cell, outputs: [{ kind: "stream", name: "stdout", text: "ok\n" }] },
          },
        },
        // A payload the renderer would reach into and find nothing in.
        {
          seq: 2,
          event: { event: "cell", cell: { ...cell, outputs: [{ kind: "display_data" }] } },
        },
      ] as unknown as RunEventFrame[],
      100,
    );
  } finally {
    console.error = reporting;
  }

  const notebook = notebookFor(store, "t_outputs");
  expect(notebook).toHaveLength(1);
  expect(notebook[0]!.outputs).toEqual([{ kind: "stream", name: "stdout", text: "ok\n" }]);
  expect(said.filter((args) => String(args[0]).includes("cannot record"))).toHaveLength(1);
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
    { kind: "text", text: "Check dependencies", block: "thinking" },
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

/**
 * The block role was renamed `thought` → `thinking`, and the value is stored,
 * not derived: every transcript recorded before the rename carries the old
 * string in `turn_items.block`. Left unconverted it stops matching the check
 * that routes thinking into its own channel — so an old thought would render
 * as ordinary prose AND be copied to the clipboard as though it were the
 * answer, which is exactly what that channel exists to prevent.
 */
it("migrates a transcript recorded as `thought` to `thinking`", () => {
  const store = freshStore();
  const { turnId } = freshTurn(store);
  recordRunFrames(
    store,
    turnId,
    [
      {
        seq: 1,
        event: { event: "assistant-thought", text: "Weighing two options.", partial: false },
      },
    ],
    10,
  );

  // Put a pre-rename workspace back together: the rows, AND the JSON snapshot
  // derived from them. A settled turn takes no more frames, so nothing would
  // ever rebuild that snapshot on its own — migrating only the rows would
  // leave every reader still loading `thought`.
  store.run(`UPDATE turn_items SET block = 'thought' WHERE block = 'thinking'`);
  store.run(
    `UPDATE turns SET recovery_snapshot =
       REPLACE(recovery_snapshot, '"block":"thinking"', '"block":"thought"')`,
  );
  // Run the rename itself rather than re-entering `migrate`, which applies
  // whatever sits above the highest version already recorded — so a migration
  // added after this one would leave this asserting nothing.
  const rename = MIGRATIONS.find((migration) => migration.version === 19);
  if (!rename) throw new Error("the rename is no longer version 19");
  rename.up(store);

  // The snapshot readers actually load...
  expect(runSnapshot(store, turnId)?.stream).toEqual([
    { kind: "text", text: "Weighing two options.", block: "thinking" },
  ]);
  // ...and the rows it is rebuilt from.
  expect(
    store.get(`SELECT block FROM turn_items WHERE turn_id = ?`, [turnId]),
  ).toEqual({ block: "thinking" });
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

it("recovers a gate still holding its place in the batch it was raised with", () => {
  // A turn can raise several permission-gated calls at once, and they are put
  // to the researcher one at a time. A reload mid-batch has to come back to
  // the same question AND the same standing in the batch — a card recovered
  // as if it were the only one asks for a decision under a description that
  // stopped being true.
  const store = freshStore();
  const { turnId } = freshTurn(store);
  const request = {
    id: "perm-2",
    access: { kind: "write-path" as const, target: "results.csv" },
    tool: "t2",
  };

  recordRunFrames(store, turnId, [
    { seq: 1, event: { event: "permission-card", request } },
    {
      seq: 2,
      event: {
        event: "state",
        state: { state: "awaiting-permission", request, queue: { position: 2, total: 4 } },
      },
    },
  ], 10);

  const recovery = JSON.parse(
    store.get(`SELECT recovery_snapshot FROM turns WHERE id = ?`, [turnId])!
      .recovery_snapshot as string,
  );
  expect(recovery.state).toEqual({
    state: "awaiting-permission",
    request,
    queue: { position: 2, total: 4 },
  });
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
  const first = freshTurn(store, { agent: "claude", machineId: "rt_1", openedBy: "u_1" });
  const sibling = freshTurn(store, {
    taskId: "t_2",
    agent: "codex",
    machineId: "rt_2",
    openedBy: "u_2",
  });
  finishTurn(store, sibling.turnId, { endedTs: 8, status: "ok" });
  const settled = freshTurn(store, {
    taskId: "t_3",
    agent: "claude",
    machineId: "rt_3",
    openedBy: "u_3",
  });
  finishTurn(store, settled.turnId, { endedTs: 9, status: "ok" });

  const read = (sessionsStore as unknown as {
    activeRunSnapshotsForTask?: (store: Store, taskId: string) => Array<Record<string, unknown>>;
  }).activeRunSnapshotsForTask;
  const snapshots = read?.(store, "t_1");
  expect(snapshots?.map(({ runId, agent, sessionId, machineId, openedBy }) => ({
    runId, agent, sessionId, machineId, openedBy,
  }))).toEqual([
    {
      runId: first.turnId,
      agent: "claude",
      sessionId: first.sessionId,
      machineId: "rt_1",
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
    researchId: "s_1", machineId: "rt_1", agent: "claude", openedBy: "u_1", openedTs: 1,
  });
  const turnId = recordTurn(store, { sessionId, taskId: "t_1", prompt: "go", startedTs: 1 });

  finishTurn(store, turnId, { endedTs: 42, status: "ok" });

  expect(store.get(`SELECT status, ended_ts FROM turns WHERE id = ?`, [turnId])).toEqual({
    status: "ok",
    ended_ts: 42,
  });
});

it("resolves the machine a turn's session belongs to, and nothing for an unknown turn", () => {
  const store = freshStore();
  const sessionId = openSession(store, {
    researchId: "s_1", machineId: "rt_1", agent: "claude", openedBy: "u_1", openedTs: 1,
  });
  const turnId = recordTurn(store, { sessionId, taskId: "t_1", prompt: "go", startedTs: 1 });

  expect(machineForTurn(store, turnId)).toBe("rt_1");
  expect(machineForTurn(store, "run_nonexistent")).toBeUndefined();
});

it("appends a step to a turn's transcript, storing its input as JSON", () => {
  const store = freshStore();
  const sessionId = openSession(store, {
    researchId: "s_1", machineId: "rt_1", agent: "claude", openedBy: "u_1", openedTs: 1,
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

it("grants a Research standing access to a folder on one machine, and lists it back", () => {
  const store = freshStore();

  addGrant(store, {
    researchId: "s_1", machineId: "rt_1", path: "/work/rna-seq", mode: "write", grantedBy: "u_1", grantedTs: 1,
  });

  expect(listGrants(store, "s_1", "rt_1")).toEqual([{ path: "/work/rna-seq", mode: "write" }]);
  // Scoped to the (research, machine) pair the grant named — neither a
  // different Research nor a different machine sees it.
  expect(listGrants(store, "s_1", "rt_2")).toEqual([]);
  expect(listGrants(store, "s_2", "rt_1")).toEqual([]);
});

it("does not duplicate a grant already standing for the same Research, machine, path, and mode", () => {
  const store = freshStore();

  addGrant(store, {
    researchId: "s_1", machineId: "rt_1", path: "/work/rna-seq", mode: "write", grantedBy: "u_1", grantedTs: 1,
  });
  addGrant(store, {
    researchId: "s_1", machineId: "rt_1", path: "/work/rna-seq", mode: "write", grantedBy: "u_1", grantedTs: 2,
  });

  expect(listGrants(store, "s_1", "rt_1")).toEqual([{ path: "/work/rna-seq", mode: "write" }]);
  // A different mode on the same path is a different grant, not a repeat —
  // read and write are not interchangeable, so both stand.
  addGrant(store, {
    researchId: "s_1", machineId: "rt_1", path: "/work/rna-seq", mode: "read", grantedBy: "u_1", grantedTs: 3,
  });
  expect(listGrants(store, "s_1", "rt_1")).toEqual([
    { path: "/work/rna-seq", mode: "write" },
    { path: "/work/rna-seq", mode: "read" },
  ]);
});

it("resolves a turn's Research, machine, and opener through its session, and nothing for an unknown turn", () => {
  const store = freshStore();
  const sessionId = openSession(store, {
    researchId: "s_1", machineId: "rt_1", agent: "claude", openedBy: "u_1", openedTs: 1,
  });
  const turnId = recordTurn(store, { sessionId, taskId: "t_1", prompt: "go", startedTs: 1 });

  expect(sessionForTurn(store, turnId)).toEqual({ researchId: "s_1", machineId: "rt_1", openedBy: "u_1" });
  expect(sessionForTurn(store, "run_nonexistent")).toBeUndefined();
});

it("drops every grant a Research holds, leaving another Research's alone", () => {
  const store = freshStore();
  addGrant(store, {
    researchId: "s_1", machineId: "rt_1", path: "/work/rna-seq", mode: "write", grantedBy: "u_1", grantedTs: 1,
  });
  addGrant(store, {
    researchId: "s_2", machineId: "rt_1", path: "/work/other", mode: "read", grantedBy: "u_1", grantedTs: 1,
  });

  dropGrantsForResearch(store, "s_1");

  expect(listGrants(store, "s_1", "rt_1")).toEqual([]);
  expect(listGrants(store, "s_2", "rt_1")).toEqual([{ path: "/work/other", mode: "read" }]);
});

it("drops every grant standing on a machine, leaving another machine's alone", () => {
  const store = freshStore();
  addGrant(store, {
    researchId: "s_1", machineId: "rt_1", path: "/work/rna-seq", mode: "write", grantedBy: "u_1", grantedTs: 1,
  });
  addGrant(store, {
    researchId: "s_1", machineId: "rt_2", path: "/work/other", mode: "read", grantedBy: "u_1", grantedTs: 1,
  });

  dropGrantsForMachine(store, "rt_1");

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

it("reports the agent a settled turn ran on", () => {
  // The composer of a reopened Task reads this to know which agent it is
  // talking to, and therefore whose models it may offer. Nothing else
  // durably records it: a run's snapshot is gone once the run is not active.
  const store = freshStore();
  const { turnId } = freshTurn(store, { agent: "codex" });
  finishTurn(store, turnId, { endedTs: 20, status: "ok" });

  expect(taskTurnsForTask(store, "t_1")[0]!.agent).toBe("codex");
});

it("gives each turn its own session's agent, never the Task's first", () => {
  // A Task can be worked on by more than one agent over its life — the
  // second session is a different conversation, and the transcript has to
  // say so. This is what reading the agent off the session buys: a copy
  // stamped per turn could be written once and then describe every turn
  // after it.
  const store = freshStore();
  const first = freshTurn(store, { agent: "claude" });
  finishTurn(store, first.turnId, { endedTs: 20, status: "ok" });
  const second = freshTurn(store, { agent: "codex" });
  finishTurn(store, second.turnId, { endedTs: 30, status: "ok" });

  expect(taskTurnsForTask(store, "t_1").map((t) => t.agent)).toEqual(["claude", "codex"]);
});

it("keeps a Task working while a sibling turn is still outstanding", () => {
  // A turn settling does not mean the Task is waiting on a person: a
  // researcher who typed ahead has more turns queued behind this one, and a
  // Task that says "in review" while it is still working asks them to look at
  // something that is not finished.
  const store = freshStore();
  // A real Task row, because what is under test is the status written onto
  // one. Every other test here works on turns alone and never needs it.
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq)
     VALUES ('u_1', 'owner@example.test', 'Owner', 'x', 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO studies (id, key, title, created_by, created_ts, updated_ts, seq)
     VALUES ('s_1', 'ONE', 'One', 'u_1', 1, 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO tasks
       (id, number, study_id, stage, title, status, priority, created_by,
        created_ts, updated_ts, seq)
     VALUES ('t_1', 1, 's_1', 'background', 'Typed ahead', 'in-progress',
             'no-priority', 'u_1', 1, 1, ?)`,
    [nextSeq(store)],
  );
  const first = freshTurn(store, { prompt: "first" });
  const second = recordTurn(store, {
    sessionId: first.sessionId, taskId: "t_1", prompt: "second", startedTs: 4,
  });

  finishTurn(store, first.turnId, { endedTs: 7, status: "ok" });
  expect(store.get(`SELECT status FROM tasks WHERE id = ?`, ["t_1"])?.status).toBe("in-progress");

  finishTurn(store, second, { endedTs: 8, status: "ok" });
  expect(store.get(`SELECT status FROM tasks WHERE id = ?`, ["t_1"])?.status).toBe("in-review");
});

it("a recorded turn puts its Task In Progress, from Todo and from Done alike", () => {
  // The other half of the rule the test above ends on. A turn in flight IS
  // the work in progress, whatever the Task said before it started — which is
  // also what reopens a Task after an explicit Done, since `finishTurn`'s own
  // `status <> 'done'` guard would otherwise hold it Done for good.
  const store = freshStore();
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq)
     VALUES ('u_1', 'owner@example.test', 'Owner', 'x', 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO studies (id, key, title, created_by, created_ts, updated_ts, seq)
     VALUES ('s_1', 'ONE', 'One', 'u_1', 1, 1, ?)`,
    [nextSeq(store)],
  );
  store.run(
    `INSERT INTO tasks
       (id, number, study_id, stage, title, status, priority, created_by,
        created_ts, updated_ts, seq)
     VALUES ('t_1', 1, 's_1', 'background', 'Never started', 'todo',
             'no-priority', 'u_1', 1, 1, ?)`,
    [nextSeq(store)],
  );
  const statusNow = () =>
    store.get(`SELECT status FROM tasks WHERE id = ?`, ["t_1"])?.status;

  const first = freshTurn(store);
  expect(statusNow()).toBe("in-progress");
  finishTurn(store, first.turnId, { endedTs: 7, status: "ok" });
  expect(statusNow()).toBe("in-review");

  store.run(`UPDATE tasks SET status = 'done' WHERE id = 't_1'`);
  recordTurn(store, {
    sessionId: first.sessionId, taskId: "t_1", prompt: "more", startedTs: 8,
  });
  expect(statusNow()).toBe("in-progress");
});

it("counts what a Task still has outstanding, so a queue can be bounded and placed", () => {
  const store = freshStore();
  const first = freshTurn(store, { prompt: "first" });
  expect(openTurnCountForTask(store, "t_1")).toBe(1);
  recordTurn(store, { sessionId: first.sessionId, taskId: "t_1", prompt: "second", startedTs: 4 });
  expect(openTurnCountForTask(store, "t_1")).toBe(2);
  finishTurn(store, first.turnId, { endedTs: 7, status: "ok" });
  expect(openTurnCountForTask(store, "t_1")).toBe(1);
});

it("names the session a Task is already working in, so a later turn joins it", () => {
  // What makes a second send queue rather than run beside the first: it lands
  // on the session that is already open, whatever agent the picker last named.
  const store = freshStore();
  const first = freshTurn(store, { agent: "claude", machineId: "rt_1", prompt: "first" });
  expect(activeTurnForTask(store, "t_1")).toEqual({
    runId: first.turnId,
    sessionId: first.sessionId,
    agent: "claude",
  });
  finishTurn(store, first.turnId, { endedTs: 7, status: "ok" });
  expect(activeTurnForTask(store, "t_1")).toBeUndefined();
});
