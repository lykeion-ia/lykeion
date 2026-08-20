import { createHash } from "node:crypto";

/** The envelope format. Raised rather than migrated: a reader keeps every
 *  version it has ever been handed, because the record is immutable and the
 *  hash that names it is over the bytes of the version it was written in. */
export const ENVELOPE_VERSION = "lykeion.provenance.v1";

/** Why a fact this envelope has a place for is not in it.
 *
 *  Three statements, never collapsed into a missing key: something that was
 *  not captured, something that does not apply, and something nothing has
 *  built yet are three different things to learn about a cell. */
export type UnavailableReason = "not_captured" | "not_applicable" | "not_implemented";

export type Capturable<T> =
  | { status: "available"; value: T }
  | { status: "unavailable"; reason: UnavailableReason };

export interface GitState {
  repository: string;
  branch: string;
  commit: string;
  dirty: boolean;
}

/** Where a cell sits in the chain of cells that built the namespace it ran
 *  in. Always computable, which is why it is not optional: a kernel always
 *  knows which incarnation it is on and how many cells it has run. */
export interface Lineage {
  incarnation: number;
  /** Position in this incarnation's chain, from 0. */
  index: number;
  /** The previous cell's `provenanceId`. Absent on an incarnation's first
   *  cell, which has no predecessor — never an empty string. */
  parent?: string;
  digest: string;
}

export interface ProvenanceOutputItem {
  kind: string;
  label: string;
  sha256: string;
  size: number;
  /** Whether this payload was routed to the blob store on the machine that
   *  produced it, decided by size alone.
   *
   *  It does not say the bytes went there INSTEAD of on the cell. Nothing
   *  anywhere can fetch a blob back off the machine holding it, so the
   *  payload rides the cell's own outputs whichever way this field falls,
   *  and that is where every reader renders it from. What `true` records is
   *  the routing decision: a copy of these bytes was addressed by this hash
   *  and handed to that machine's store.
   *
   *  Nor is it a report that the write succeeded — that write happens after
   *  this field is already part of the envelope's hash, and cannot be what
   *  the field means without the hash depending on an outcome that has not
   *  happened when it is taken.
   *
   *  The hash is recorded whichever way this falls, because it is the join
   *  key. */
  stored: boolean;
}

export type ProvenanceStatus = "succeeded" | "failed" | "cancelled" | "interrupted";

export interface ProvenanceEnvelope {
  version: typeof ENVELOPE_VERSION;
  identity: {
    /** Which Study this cell belongs to. Absent where the process that wrote
     *  the envelope does not hold one: a kernel host is told the session and
     *  the Task a cell runs under and nothing above them, and a key holding
     *  "" would be the record naming a Study that does not exist. */
    studyId?: string;
    taskId: string;
    sessionId: string;
    kernelId: string;
    /** The id the kernel host minted for the cell — not a row key any lab is
     *  keyed by. The lab that receives this envelope records the cell under
     *  an id of its own choosing, so a reader joining a record back to its
     *  cell goes through `cells.provenance_id`, never through this field. */
    cellId: string;
  };
  input: {
    code: string;
    /** The directory the cell ran in. Absent for a kernel whose session was
     *  confined without a workspace — absent rather than "", by the same
     *  rule as `studyId` above: a record naming a directory nothing ran in
     *  is worse than one that names none. */
    cwd?: string;
    codeState: { lineage: Lineage; git: Capturable<GitState> };
  };
  environment: {
    host: { platform: string; arch: string; runtimes: Capturable<Record<string, string>> };
    kernel: {
      id: string;
      language: string;
      incarnation: number;
      processId: number;
      /** Epoch seconds, a whole number — same unit as every field below,
       *  despite the name not carrying the `*Ts` suffix the rest of this
       *  package uses for it. The envelope is a versioned, content-addressed
       *  wire format rather than another `@lykeion/api` record, so it keeps
       *  the field names the format was pinned under; renaming would move
       *  the canonical bytes and every hash computed over them. */
      processStartedAt: number;
    };
  };
  outputs: { status: ProvenanceStatus; items: ProvenanceOutputItem[] };
  /** All three are epoch seconds, whole numbers — not `*Ts`-suffixed for the
   *  same reason as `processStartedAt` above: the envelope's field names are
   *  part of its pinned wire shape, not this package's naming convention. */
  timestamps: { createdAt: number; startedAt: number; completedAt: number };
}

/**
 * The bytes an envelope's identity is computed over.
 *
 * Sorted keys at every depth, no insignificant space, and non-ASCII left
 * raw — the last matching Python's `ensure_ascii=False`, because a side that
 * escaped it would give the same envelope two identities depending on which
 * process wrote it. Array order is content rather than ordering to
 * normalise. An `undefined` property is never written: `JSON.stringify`
 * drops any object property whose value is `undefined` on its own, which is
 * the same absence the rest of the contract means by it.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sorted((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** An envelope's own hash, which is the id a cell references it by. */
export function envelopeHash(envelope: ProvenanceEnvelope): string {
  return createHash("sha256").update(canonicalJson(envelope), "utf8").digest("hex");
}
