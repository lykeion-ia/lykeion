/**
 * The record of how one cell ran, as this lab keeps it: whole, opaque, and
 * named by the hash of its own bytes.
 */
import {
  ENVELOPE_VERSION,
  canonicalJson,
  type CellCodeState,
  type ProvenanceEnvelope,
} from "@lykeion/api";
import { envelopeHash } from "@lykeion/api/provenance-hash";
import { nextSeq } from "./migrations";
import type { Store } from "./store";

/** Every status an envelope can carry once the cell it describes has
 *  finished. Written here rather than derived from the type, because what
 *  this set is for is refusing a value off the wire that the type cannot
 *  constrain. */
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

/**
 * One envelope as this lab can record it, or `undefined` for anything that
 * is not one.
 *
 * Refused here rather than at the INSERT, where the failure would be a
 * transaction rolled back around every valid frame travelling with it.
 *
 * A non-terminal status is refused rather than stored: the id is the hash of
 * the body, so a record that changed as its cell progressed would change
 * identity under every cell referencing it. Nothing that reaches this store
 * should still be running, and one that says it is did not come from a
 * writer that understood what it was writing.
 *
 * What is checked is the version this lab is being asked to keep, the
 * outcome, and that `identity.kernelId` and `identity.cellId` are there and
 * are strings. Those last two are checked for WELL-FORMEDNESS, not because
 * anything joins on them: a cell reaches its record through
 * `cells.provenance_id`, and `identity.cellId` is an id the kernel host
 * minted for itself that no row in this lab is keyed by.
 *
 * That is less than everything this lab reads back, deliberately.
 * `input.codeState` is read by `codeStateFor` and is not checked here: the
 * body is stored as the bytes its own id is over, so a field this lab does
 * not validate is also one it must not rewrite, and `codeStateFromBody`
 * answers a body it cannot make sense of by leaving that cell out of the
 * map rather than by failing the read.
 */
export function readReportedEnvelope(value: unknown): ProvenanceEnvelope | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.version !== ENVELOPE_VERSION) return undefined;
  const outputs = v.outputs as { status?: unknown; items?: unknown } | null | undefined;
  const identity = v.identity as Record<string, unknown> | null | undefined;
  if (
    outputs === null ||
    typeof outputs !== "object" ||
    typeof outputs.status !== "string" ||
    !TERMINAL.has(outputs.status) ||
    !Array.isArray(outputs.items) ||
    identity === null ||
    typeof identity !== "object" ||
    typeof identity.kernelId !== "string" ||
    typeof identity.cellId !== "string"
  ) {
    return undefined;
  }
  return value as ProvenanceEnvelope;
}

/**
 * Store one envelope and answer with the id it is filed under.
 *
 * The id is recomputed here rather than taken from whoever sent it: it
 * crossed a process this lab did not write, and an id trusted from the wire
 * is a claim rather than a fact about the bytes beside it.
 *
 * The bytes written are the canonical ones, which is what makes that check
 * mean anything afterwards: the row's own body hashes to the row's own id,
 * so a reader can ask the record whether it is what it says it is.
 *
 * The Task and the session come from the caller, never from the envelope —
 * the same rule `readReportedCell` states for a cell. They are decided by
 * the run the frame arrived on, and a record filed under a Task it named
 * for itself would be one a sender could file anywhere.
 */
export function recordEnvelope(
  store: Store,
  envelope: ProvenanceEnvelope,
  taskId: string,
  sessionId: string,
  ts: number,
): string {
  const body = canonicalJson(envelope);
  const id = envelopeHash(envelope);
  // Content-addressed, so a redelivered batch is the same row rather than a
  // conflict — and a daemon retries an immutable batch until it lands.
  store.run(
    `INSERT OR IGNORE INTO provenance_envelopes (id, version, body, task_id, session_id, ts, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, envelope.version, body, taskId, sessionId, ts, nextSeq(store)],
  );
  return id;
}

/** The envelope filed under `id`, or `undefined` where nothing wrote one. */
export function envelopeById(store: Store, id: string): ProvenanceEnvelope | undefined {
  const row = store.get(`SELECT body FROM provenance_envelopes WHERE id = ?`, [id]);
  return row === undefined ? undefined : (JSON.parse(row.body as string) as ProvenanceEnvelope);
}

/**
 * The part of each cell's record its header renders, for a set of cells at
 * once.
 *
 * One query rather than one per row: a notebook is read whole, and a fetch
 * per cell would make opening a Task cost a round trip per line of it. What
 * comes back is derived at read time and stored nowhere, so it cannot drift
 * from the envelope it was read out of.
 *
 * The join is inner, not left: a cell with no `provenance_id`, or one naming
 * an id nothing wrote, has nothing to lift, and filtering that at the join
 * keeps `codeStateFromBody`'s guard answering one question — whether a
 * stored body it was actually handed can be read — rather than also
 * standing in for every cell that never had one to begin with.
 *
 * What the write side checks is `version`, `outputs`, and that the two ids
 * under `identity` are well-formed — never `input.codeState`, which this
 * function is the only reader of. A stored body that gate let through with
 * nothing usable there is read the same way a cell with no envelope at all
 * already is: left out of the map, not thrown through it — a cell whose
 * record cannot be read this way would otherwise make every later read of
 * the Task it sits in fail the same way, for good.
 */
export function codeStateFor(store: Store, cellIds: string[]): Map<string, CellCodeState> {
  const out = new Map<string, CellCodeState>();
  if (cellIds.length === 0) return out;
  const holes = cellIds.map(() => "?").join(",");
  const rows = store.all(
    `SELECT c.id AS id, e.body AS body
       FROM cells c
       JOIN provenance_envelopes e ON e.id = c.provenance_id
      WHERE c.id IN (${holes})`,
    cellIds,
  );
  for (const row of rows) {
    const state = codeStateFromBody(row.body as string);
    if (state !== undefined) out.set(row.id as string, state);
  }
  return out;
}

/** One envelope's body read down to the state its cell's header renders, or
 *  `undefined` for a body this function cannot make sense of — malformed
 *  JSON, or JSON with no usable `input.codeState` under it. */
function codeStateFromBody(body: string): CellCodeState | undefined {
  try {
    const envelope = JSON.parse(body) as ProvenanceEnvelope;
    const { lineage, git } = envelope.input.codeState;
    const state: CellCodeState = { lineage: lineage.digest.slice(0, 8), index: lineage.index };
    if (git.status === "available") {
      state.git = { branch: git.value.branch, commit: git.value.commit, dirty: git.value.dirty };
    }
    return state;
  } catch {
    return undefined;
  }
}

/** Which record, if any, a cell names. Separate from `envelopeById` because
 *  a cell with no envelope and an envelope nothing wrote are two different
 *  absences, and a caller that collapsed them could not tell a cell from
 *  before this phase from one whose frame arrived unreadable. */
export function provenanceIdFor(store: Store, cellId: string): string | undefined {
  const row = store.get(`SELECT provenance_id FROM cells WHERE id = ?`, [cellId]);
  return (row?.provenance_id as string | null | undefined) ?? undefined;
}
