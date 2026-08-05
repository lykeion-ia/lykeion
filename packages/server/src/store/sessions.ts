import type {
  ActiveRunSnapshot,
  LiveTurn,
  Plan,
  RunEventFrame,
  TaskTurn,
  TurnItem,
  TurnState,
} from "@lykeion/api";
import type { Row, Store } from "./store";
import { nextSeq } from "./migrations";

/** A folder a Study's owner has granted standing access to on one runtime.
 *  Scoped to (study, runtime) rather than to the Study alone: the path only
 *  means anything on the filesystem of the machine it names. */
export interface StandingGrant {
  path: string;
  mode: "read" | "write";
}

interface RecoverySnapshotV1 {
  version: 1;
  state: TurnState;
  plan?: Plan;
  stream: TurnItem[];
  live: LiveTurn;
  reviewing: boolean;
}

export class RunFrameSequenceGapError extends Error {}

/** An authoritative run snapshot plus the durable session ownership Task 2
 *  needs to authorize and reconnect its transport. */
export interface StoredRunSnapshot extends ActiveRunSnapshot {
  sessionId: string;
  runtimeId: string;
  openedBy: string;
}

const INITIAL_RECOVERY: RecoverySnapshotV1 = {
  version: 1,
  state: { state: "planning" },
  stream: [],
  live: {},
  reviewing: false,
};

function parseRecovery(raw: string): RecoverySnapshotV1 {
  const parsed = JSON.parse(raw) as Partial<RecoverySnapshotV1>;
  if (parsed.version !== 1)
    throw new Error(`unsupported turn recovery snapshot version: ${String(parsed.version)}`);
  return parsed as RecoverySnapshotV1;
}

function planCarriedBy(state: TurnState): Plan | undefined {
  switch (state.state) {
    case "awaiting-plan-approval":
    case "executing":
      return state.plan;
    case "awaiting-permission":
    case "awaiting-question":
      return state.plan;
    default:
      return undefined;
  }
}

/** Opens a fresh session and returns its id. */
export function openSession(
  store: Store,
  params: {
    studyId: string;
    runtimeId: string;
    agent: string;
    openedBy: string;
    openedTs: number;
  },
): string {
  const seq = nextSeq(store);
  const id = `sess_${seq}`;
  store.run(
    `INSERT INTO sessions (id, study_id, runtime_id, agent, opened_by, opened_ts, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, params.studyId, params.runtimeId, params.agent, params.openedBy, params.openedTs, seq],
  );
  return id;
}

/**
 * The session already open for this Task on this runtime and agent, or
 * `undefined` when this is the Task's first turn there. A session carries no
 * Task of its own — it is found through the turn that already ties one to
 * it, which is what a second turn on the same Task reuses rather than
 * opening a fresh session (and losing the agent's conversation state) for
 * every prompt.
 */
export function liveSessionFor(
  store: Store,
  taskId: string,
  runtimeId: string,
  agent: string,
): string | undefined {
  const row = store.get(
    `SELECT s.id AS id
       FROM sessions s
       JOIN turns t ON t.session_id = s.id
      WHERE t.task_id = ? AND s.runtime_id = ? AND s.agent = ? AND s.ended_ts IS NULL
      ORDER BY s.seq DESC
      LIMIT 1`,
    [taskId, runtimeId, agent],
  );
  return row ? (row.id as string) : undefined;
}

/**
 * The Study and runtime a turn's session belongs to, and the member who
 * opened it, or `undefined` when no turn has that id at all. This is the
 * one query every other durable lookup on a turn's session is built from —
 * `runtimeForTurn` below included — so there is a single join to keep in
 * step rather than one copy per caller.
 */
export function sessionForTurn(
  store: Store,
  turnId: string,
): { studyId: string; runtimeId: string; openedBy: string } | undefined {
  const row = store.get(
    `SELECT s.study_id AS study_id, s.runtime_id AS runtime_id, s.opened_by AS opened_by
       FROM turns t
       JOIN sessions s ON s.id = t.session_id
      WHERE t.id = ?`,
    [turnId],
  );
  return row
    ? { studyId: row.study_id as string, runtimeId: row.runtime_id as string, openedBy: row.opened_by as string }
    : undefined;
}

/**
 * The runtime a turn's session actually belongs to, or `undefined` when no
 * turn has that id at all. This is the durable check a daemon-authenticated
 * route uses to confirm a run id it was handed really was started on the
 * machine now presenting it — durable, rather than read off whatever the
 * relay happens to still be holding in memory, because that is what still
 * answers correctly across a server restart, for a run whose turn is still
 * `running`.
 */
export function runtimeForTurn(store: Store, turnId: string): string | undefined {
  return sessionForTurn(store, turnId)?.runtimeId;
}

/**
 * The member who owns the machine a turn's session runs on, or `undefined`
 * when no turn has that id. This is the durable check a cookie-authenticated
 * route uses to confirm a run id a browser was handed really belongs to a
 * machine the signed-in caller paired — the run id itself carries no owner
 * of its own, only the session and, through it, the runtime does. Not
 * scoped to a runtime still paired: watching a run's own history is not the
 * same privilege as spending the machine on a new one, so a runtime removed
 * after the fact does not take the run's transcript away from the person
 * who owned it.
 */
export function runtimeOwnerForTurn(store: Store, turnId: string): string | undefined {
  const row = store.get(
    `SELECT r.owner_id AS owner_id
       FROM turns t
       JOIN sessions s ON s.id = t.session_id
       JOIN runtimes r ON r.id = s.runtime_id
      WHERE t.id = ?`,
    [turnId],
  );
  return row ? (row.owner_id as string) : undefined;
}

/** Records a fresh turn — a run — as `running` and returns its id, which is
 *  what the rest of the system calls a run's id. */
export function recordTurn(
  store: Store,
  params: {
    sessionId: string;
    taskId: string;
    prompt: string;
    startedTs: number;
  },
): string {
  const seq = nextSeq(store);
  const id = `run_${seq}`;
  store.run(
    `INSERT INTO turns
       (id, session_id, task_id, prompt, started_ts, status, seq, last_frame_seq, recovery_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    [
      id,
      params.sessionId,
      params.taskId,
      params.prompt,
      params.startedTs,
      "running",
      seq,
      JSON.stringify(INITIAL_RECOVERY),
    ],
  );
  return id;
}

/**
 * The values `turns.status` actually holds. `"cancelled-unacknowledged"` is
 * a store-internal encoding — free to add without a migration, since the
 * column is plain TEXT — of the same fact the wire contract carries as
 * `RunSummary.status: "cancelled"` plus a separate `unacknowledged: true`;
 * `runHistory` (`../api/sessions.ts`) is the one place that translates
 * between the two.
 */
export type TurnStatus = "ok" | "failed" | "cancelled" | "cancelled-unacknowledged";

/** Settles a turn once its run has ended, one way or the other. */
export function finishTurn(
  store: Store,
  turnId: string,
  params: { endedTs: number; status: TurnStatus },
): void {
  store.tx(() => {
    const turn = store.get(`SELECT task_id, ended_ts FROM turns WHERE id = ?`, [turnId]);
    if (!turn || turn.ended_ts !== null) return;
    store.run(`UPDATE turns SET ended_ts = ?, status = ? WHERE id = ?`, [
      params.endedTs,
      params.status,
      turnId,
    ]);
    const latestSettled = store.get(
      `SELECT status
         FROM turns
        WHERE task_id = ? AND ended_ts IS NOT NULL
        ORDER BY seq DESC
        LIMIT 1`,
      [turn.task_id],
    );
    const taskRunStatus = latestSettled?.status === "ok" ? "ok" : "failed";
    store.run(
      `UPDATE tasks
          SET run_count = run_count + 1,
              last_run_status = ?,
              updated_ts = ?,
              status = CASE
                WHEN ? = 'ok' AND status <> 'done' THEN 'in-review'
                ELSE status
              END
        WHERE id = ?`,
      [taskRunStatus, params.endedTs, params.status, turn.task_id],
    );
  });
}

/** Ends the logical session a turn belongs to. The ACP subprocess may still
 *  be winding down on its machine; this boundary only says no later turn may
 *  reuse conversation state whose stop was never acknowledged. */
export function endSessionForTurn(store: Store, turnId: string, endedTs: number): void {
  store.run(
    `UPDATE sessions SET ended_ts = ?
      WHERE id = (SELECT session_id FROM turns WHERE id = ?) AND ended_ts IS NULL`,
    [endedTs, turnId],
  );
}

/** Inserts or enriches one logical Execution Log entry and returns its id.
 *  Repeated frames for the same ACP tool-call identity retain their original
 *  transcript position. `input` is stored as JSON — the column has no
 *  structure of its own, the same way `labels`/`links`/`subtasks` hold a
 *  Task's JSON columns. */
export function appendStep(
  store: Store,
  params: {
    turnId: string;
    ts: number;
    toolUseId: string;
    tool: string;
    title?: string;
    input: unknown;
    decision: string;
    result?: string;
    isError: boolean;
    outsideWorkspace?: boolean;
  },
): string {
  const existing = store.get(
    `SELECT id, title, result, outside_workspace FROM turn_steps
      WHERE turn_id = ? AND tool_use_id = ?
      ORDER BY seq ASC LIMIT 1`,
    [params.turnId, params.toolUseId],
  );
  if (existing) {
    store.run(
      `UPDATE turn_steps
          SET ts = ?, tool = ?, title = ?, input = ?, decision = ?, result = ?, is_error = ?,
              outside_workspace = ?
        WHERE id = ?`,
      [
        params.ts,
        params.tool,
        params.title ?? existing.title,
        JSON.stringify(params.input),
        params.decision,
        params.result ?? existing.result,
        params.isError ? 1 : 0,
        params.outsideWorkspace === undefined
          ? existing.outside_workspace
          : params.outsideWorkspace
            ? 1
            : null,
        existing.id,
      ],
    );
    const item = store.get(`SELECT id FROM turn_items WHERE step_id = ? LIMIT 1`, [existing.id]);
    if (!item) {
      const itemSeq = nextSeq(store);
      store.run(
        `INSERT INTO turn_items (id, turn_id, kind, step_id, seq)
         VALUES (?, ?, 'step', ?, ?)`,
        [`item_${itemSeq}`, params.turnId, existing.id, itemSeq],
      );
    }
    return existing.id as string;
  }

  const seq = nextSeq(store);
  const id = `step_${seq}`;
  store.run(
    `INSERT INTO turn_steps
       (id, turn_id, ts, tool_use_id, tool, title, input, decision, result, is_error,
        outside_workspace, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      params.turnId,
      params.ts,
      params.toolUseId,
      params.tool,
      params.title ?? null,
      JSON.stringify(params.input),
      params.decision,
      params.result ?? null,
      params.isError ? 1 : 0,
      params.outsideWorkspace ? 1 : null,
      seq,
    ],
  );
  const itemSeq = nextSeq(store);
  store.run(
    `INSERT INTO turn_items (id, turn_id, kind, step_id, seq)
     VALUES (?, ?, 'step', ?, ?)`,
    [`item_${itemSeq}`, params.turnId, id, itemSeq],
  );
  return id;
}

/** Appends one more fragment of the assistant's prose onto a turn's
 *  accumulated text — the way `assistant-text` events arrive, one chunk at a
 *  time, so a reload mid-turn already has something to show before the turn
 *  ends. */
export function appendTurnText(store: Store, turnId: string, text: string, partial = false): void {
  store.run(`UPDATE turns SET text = text || ? WHERE id = ?`, [text, turnId]);
  const seq = nextSeq(store);
  store.run(
    `INSERT INTO turn_items (id, turn_id, kind, text, partial, seq)
     VALUES (?, ?, 'text', ?, ?, ?)`,
    [`item_${seq}`, turnId, text, partial ? 1 : 0, seq],
  );
}

function turnStream(store: Store, turnId: string, includePartial = true): TurnItem[] {
  const stream: TurnItem[] = [];
  let joiningPartial = false;
  const items = store.all(
    `SELECT i.kind, i.text, i.partial,
            s.ts, s.tool_use_id, s.tool, s.title, s.input, s.decision, s.result, s.is_error,
            s.outside_workspace
       FROM turn_items i
       LEFT JOIN turn_steps s ON s.id = i.step_id
      WHERE i.turn_id = ?
      ORDER BY i.seq ASC`,
    [turnId],
  );
  for (const item of items) {
    if (item.kind === "text") {
      if (item.partial === 1 && !includePartial) continue;
      if (item.partial === 1 && joiningPartial) {
        const current = stream.at(-1);
        if (current?.kind === "text") current.text += item.text as string;
      } else {
        stream.push({ kind: "text", text: item.text as string });
      }
      joiningPartial = item.partial === 1;
      continue;
    }
    joiningPartial = false;
    stream.push({
      kind: "step",
      entry: {
        ts: item.ts as number,
        toolUseId: item.tool_use_id as string,
        tool: item.tool as string,
        ...(item.title === null ? {} : { title: item.title as string }),
        input: JSON.parse(item.input as string) as unknown,
        decision: item.decision as string,
        ...(item.result === null ? {} : { result: item.result as string }),
        isError: item.is_error === 1,
        ...(item.outside_workspace === 1 ? { outsideWorkspace: true } : {}),
      },
    });
  }
  return stream;
}

/**
 * Folds a contiguous daemon-frame batch into the turn's transcript and
 * versioned recovery snapshot. Already-recorded frames are idempotent;
 * missing sequence numbers are rejected before any new frame is written.
 * The batch is one transaction, and a completion's terminal recovery state
 * is stored before the turn receives its ended timestamp and final status.
 */
export function recordRunFrames(
  store: Store,
  turnId: string,
  frames: RunEventFrame[],
  nowTs: number,
): RunEventFrame[] {
  const row = store.get(
    `SELECT ended_ts, last_frame_seq, recovery_snapshot FROM turns WHERE id = ?`,
    [turnId],
  );
  if (!row) throw new Error(`no such turn: ${turnId}`);
  if (row.ended_ts !== null) return [];

  let expected = (row.last_frame_seq as number) + 1;
  const accepted: RunEventFrame[] = [];
  let terminalAccepted = false;
  for (const frame of frames) {
    if (terminalAccepted) break;
    // A daemon retries an unacknowledged batch verbatim. Frames already
    // folded into the row — including a repeat inside this batch — are a
    // no-op, not a second transcript append.
    if (frame.seq < expected) continue;
    if (frame.seq > expected)
      throw new RunFrameSequenceGapError(
        `frame sequence gap for ${turnId}: expected ${expected}, received ${frame.seq}`,
      );
    accepted.push(frame);
    expected += 1;
    terminalAccepted = frame.event.event === "completed";
  }
  if (accepted.length === 0) return [];

  store.tx(() => {
    let recovery = parseRecovery(row.recovery_snapshot as string);
    for (const frame of accepted) {
      const { event } = frame;
      switch (event.event) {
        case "snapshot":
          recovery = {
            version: 1,
            state: event.snapshot.state,
            ...(event.snapshot.plan === undefined ? {} : { plan: event.snapshot.plan }),
            stream: event.snapshot.stream,
            live: event.snapshot.live,
            reviewing: event.snapshot.reviewing,
          };
          break;
        case "state": {
          recovery.state = event.state;
          const plan = planCarriedBy(event.state);
          if (plan !== undefined) recovery.plan = plan;
          break;
        }
        case "assistant-text":
          appendTurnText(store, turnId, event.text, event.partial);
          recovery.stream = turnStream(store, turnId, false);
          break;
        case "plan-proposed":
          recovery.plan = event.plan;
          break;
        case "permission-card":
          recovery.state = {
            state: "awaiting-permission",
            ...(recovery.plan === undefined ? {} : { plan: recovery.plan }),
            request: event.request,
          };
          break;
        case "question-asked":
          recovery.state = {
            state: "awaiting-question",
            ...(recovery.plan === undefined ? {} : { plan: recovery.plan }),
            request: event.request,
          };
          break;
        case "log-entry":
          appendStep(store, {
            turnId,
            ts: event.entry.ts,
            toolUseId: event.entry.toolUseId,
            tool: event.entry.tool,
            ...(event.entry.title !== undefined ? { title: event.entry.title } : {}),
            input: event.entry.input,
            decision: event.entry.decision,
            ...(event.entry.result !== undefined ? { result: event.entry.result } : {}),
            isError: event.entry.isError,
            ...(event.entry.outsideWorkspace === undefined
              ? {}
              : { outsideWorkspace: event.entry.outsideWorkspace }),
          });
          recovery.stream = turnStream(store, turnId, false);
          break;
        case "live":
          recovery.live = event.live;
          break;
        case "reviewing":
          recovery.reviewing = true;
          break;
        case "completed":
          recovery.state = event.state;
          recovery.stream = turnStream(store, turnId);
          recovery.live = {};
          recovery.reviewing = false;
          break;
      }

      // This write precedes settlement below deliberately. A trigger, reader,
      // or restarted process can never observe an ended row whose terminal
      // recovery state and frame cursor still describe the preceding frame.
      store.run(
        `UPDATE turns SET last_frame_seq = ?, recovery_snapshot = ? WHERE id = ?`,
        [frame.seq, JSON.stringify(recovery), turnId],
      );

      if (event.event === "completed") {
        finishTurn(store, turnId, {
          endedTs: nowTs,
          status:
            event.state.state === "failed"
              ? "failed"
              : event.state.state === "cancelled"
                ? event.state.unacknowledged
                  ? "cancelled-unacknowledged"
                  : "cancelled"
                : "ok",
        });
        if (event.state.state === "cancelled" && event.state.unacknowledged)
          endSessionForTurn(store, turnId, nowTs);
      }
    }
  });
  return accepted;
}

function storedRunSnapshot(row: Row): StoredRunSnapshot {
  const recovery = parseRecovery(row.recovery_snapshot as string);
  return {
    runId: row.id as string,
    sequence: row.seq as number,
    prompt: row.prompt as string,
    agent: row.agent as string,
    state: recovery.state,
    ...(recovery.plan === undefined ? {} : { plan: recovery.plan }),
    stream: recovery.stream,
    live: recovery.live,
    reviewing: recovery.reviewing,
    lastEventSeq: row.last_frame_seq as number,
    sessionId: row.session_id as string,
    runtimeId: row.runtime_id as string,
    openedBy: row.opened_by as string,
  };
}

/** The authoritative durable snapshot for one run, active or settled. */
export function runSnapshot(store: Store, runId: string): StoredRunSnapshot | undefined {
  const row = store.get(
    `SELECT t.id, t.seq, t.prompt, t.last_frame_seq, t.recovery_snapshot, t.session_id,
            s.agent, s.runtime_id, s.opened_by
       FROM turns t
       JOIN sessions s ON s.id = t.session_id
      WHERE t.id = ?`,
    [runId],
  );
  return row ? storedRunSnapshot(row) : undefined;
}

/** Every still-active turn on a Task in durable turn order. */
export function activeRunSnapshotsForTask(store: Store, taskId: string): StoredRunSnapshot[] {
  return store
    .all(
      `SELECT t.id, t.seq, t.prompt, t.last_frame_seq, t.recovery_snapshot, t.session_id,
              s.agent, s.runtime_id, s.opened_by
         FROM turns t
         JOIN sessions s ON s.id = t.session_id
        WHERE t.task_id = ? AND t.ended_ts IS NULL
        ORDER BY t.seq ASC`,
      [taskId],
    )
    .map(storedRunSnapshot);
}

/** Every durable active run owned by one runtime, in turn order. */
export function activeRunIdsForRuntime(store: Store, runtimeId: string): string[] {
  return store
    .all(
      `SELECT t.id
         FROM turns t
         JOIN sessions s ON s.id = t.session_id
        WHERE s.runtime_id = ? AND t.ended_ts IS NULL
        ORDER BY t.seq ASC`,
      [runtimeId],
    )
    .map((row) => row.id as string);
}

/** Every durable, settled turn on a Task in transcript order, including its
 *  accumulated prose and execution steps. */
export function taskTurnsForTask(store: Store, taskId: string): TaskTurn[] {
  return store
    .all(
      `SELECT id, seq, prompt, started_ts, status, text FROM turns
        WHERE task_id = ? AND ended_ts IS NOT NULL
        ORDER BY seq ASC`,
      [taskId],
    )
    .map((row) => {
      const text = row.text as string;
      const stream = turnStream(store, row.id as string);
      return {
        runId: row.id as string,
        sequence: row.seq as number,
        ts: row.started_ts as number,
        prompt: row.prompt as string,
        messages: text === "" ? [] : [text],
        ...(stream.length === 0 ? {} : { stream }),
        status: row.status === "ok" ? "ok" as const : "failed" as const,
        code: [],
        outputs: [],
      };
    });
}

/**
 * Every settled turn filed against a Task, oldest first. A turn still
 * running is not a past run yet — it is the one a live `RunHandle` is
 * watching — so it is left out until `finishTurn` gives it an end time.
 */
export function turnsForTask(
  store: Store,
  taskId: string,
): Array<{ id: string; prompt: string; startedTs: number; status: string }> {
  return store
    .all(
      `SELECT id, prompt, started_ts, status FROM turns
        WHERE task_id = ? AND ended_ts IS NOT NULL
        ORDER BY seq ASC`,
      [taskId],
    )
    .map((row) => ({
      id: row.id as string,
      prompt: row.prompt as string,
      startedTs: row.started_ts as number,
      status: row.status as string,
    }));
}

/** The grants standing for a Study on one runtime, in the order they were
 *  granted. A revoked grant is not returned — revocation removes it from
 *  what a future run carries, not just from what a person sees listed. */
export function listGrants(store: Store, studyId: string, runtimeId: string): StandingGrant[] {
  return store
    .all(
      `SELECT path, mode FROM folder_grants
        WHERE study_id = ? AND runtime_id = ? AND revoked_ts IS NULL
        ORDER BY seq ASC`,
      [studyId, runtimeId],
    )
    .map((row) => ({ path: row.path as string, mode: row.mode as "read" | "write" }));
}

/** Drops every grant a Study holds, on whichever runtime each was granted —
 *  what a deleted Study takes down with it: a grant for a Study that no
 *  longer exists means nothing. */
export function dropGrantsForStudy(store: Store, studyId: string): void {
  store.run(`DELETE FROM folder_grants WHERE study_id = ?`, [studyId]);
}

/** Drops every grant standing on a runtime, across whichever Studies granted
 *  one — what a removed machine takes down with it: the path a grant names
 *  only ever meant anything on that machine's own filesystem. */
export function dropGrantsForRuntime(store: Store, runtimeId: string): void {
  store.run(`DELETE FROM folder_grants WHERE runtime_id = ?`, [runtimeId]);
}

/** Grants a Study standing access to a folder on one runtime, and returns
 *  the grant's id. */
export function addGrant(
  store: Store,
  params: {
    studyId: string;
    runtimeId: string;
    path: string;
    mode: "read" | "write";
    grantedBy: string;
    grantedTs: number;
  },
): string {
  const seq = nextSeq(store);
  const id = `fg_${seq}`;
  // No unique index backs this table, so idempotence is enforced in the
  // statement instead: a live grant already standing for the same
  // (study, runtime, path, mode) already covers what
  // this one asks for, and answering a card "for the Study" a second time
  // (a live session's own re-raised card, covered by a standing grant of a
  // different scope, or simply the same card answered twice) must not pile
  // up a second row for it. `nextSeq` is still spent on a write this ends up
  // skipping — harmless, just not free, the same tradeoff `config-surface.ts`'s
  // upserts already make.
  store.run(
    `INSERT INTO folder_grants (id, study_id, runtime_id, path, mode, granted_by, granted_ts, seq)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM folder_grants
         WHERE study_id = ? AND runtime_id = ? AND path = ? AND mode = ? AND revoked_ts IS NULL
      )`,
    [
      id,
      params.studyId,
      params.runtimeId,
      params.path,
      params.mode,
      params.grantedBy,
      params.grantedTs,
      seq,
      params.studyId,
      params.runtimeId,
      params.path,
      params.mode,
    ],
  );
  return id;
}
