/**
 * A Task's notebook: every cell run against it, durable past the working
 * directory it ran in. A Task's workspace is swept once its work is done,
 * and what a kernel computed there has to outlive that sweep — this is
 * where it does.
 */
import type { CellOrigin, KernelMessage, Language, NotebookCell } from "@lykeion/api";
import type { Store } from "./store";
import { nextSeq } from "./migrations";

/**
 * Everything `recordCell` needs about one cell, short one field it does not
 * take from the caller: `ts`, which arrives as `recordCell`'s own third
 * argument rather than buried in this object — the moment being recorded is
 * a property of the call, not of the cell.
 */
export interface CellToRecord {
  /** The id this cell is recorded under. Minted here, from `nextSeq`, when
   *  absent — what an agent's cell, arriving with no id of its own on the
   *  wire, always leaves this. Given by a caller that already promised the
   *  id to someone waiting on it: `kernelExecute` mints one and hands it
   *  back before it ever asks a machine to run anything, and this is what
   *  lets the cell that eventually comes back be recorded under exactly the
   *  id it promised rather than a second one nobody who saw the first would
   *  recognise. */
  id?: string;
  taskId: string;
  sessionId: string;
  kernelId: string;
  name: string;
  language: Language;
  environment: string;
  executionCount: number;
  source: string;
  origin: CellOrigin;
  ok: boolean;
  wallMs: number;
  outputs: KernelMessage[];
  /** What this cell installed into the kernel that ran it and nowhere else.
   *  Absent where nothing was — see `NotebookCell.installed`. */
  installed?: string[];
  toolUseId?: string;
}

/**
 * One cell as it arrives from a machine: everything about the cell itself,
 * and nothing about where it is being filed. The Task and the session are
 * decided by this lab, from the run or the session the report came in on,
 * and are never read off the report.
 */
export interface ReportedCell {
  kernelId: string;
  name: string;
  language: Language;
  environment: string;
  executionCount: number;
  source: string;
  origin: CellOrigin;
  ok: boolean;
  wallMs: number;
  ts: number;
  outputs: KernelMessage[];
  installed?: string[];
  toolUseId?: string;
}

/** Whether one entry of a cell's `outputs` is a message this lab knows the
 *  shape of. Checked per element rather than only for the array around them,
 *  because these are stored as opaque JSON and read back straight into a
 *  browser: an entry naming a kind nothing recognizes has no payload the
 *  renderer can reach, and one naming a kind it does may have none either. */
function isKernelMessage(value: unknown): value is KernelMessage {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const isRecord = (field: unknown): boolean => field !== null && typeof field === "object";
  switch (v.kind) {
    case "stream":
      return typeof v.name === "string" && typeof v.text === "string";
    case "error":
      return (
        typeof v.ename === "string" &&
        typeof v.evalue === "string" &&
        Array.isArray(v.traceback) &&
        v.traceback.every((line) => typeof line === "string")
      );
    case "execute_result":
      return Number.isInteger(v.execution_count) && isRecord(v.data) && isRecord(v.data_ref);
    case "display_data":
      return isRecord(v.data) && isRecord(v.data_ref);
    default:
      return false;
  }
}

/**
 * One cell as this lab can record it, or `undefined` for anything that is not
 * one.
 *
 * Every cell reaching this store crossed a process this store did not write,
 * and the row it becomes is constrained: `origin_surface` is a CHECK, the
 * counters are whole numbers, and the outputs are read back into a browser.
 * A report that does not fit is refused here — where the caller can answer for
 * it — rather than at the INSERT, where the failure is a transaction rolled
 * back around whatever else was travelling with it.
 */
export function readReportedCell(value: unknown): ReportedCell | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const origin = v.origin as { surface?: unknown; by?: unknown } | null | undefined;
  // Epoch seconds and durations are whole numbers, and a counter is a count.
  const whole = (field: unknown): boolean => typeof field === "number" && Number.isInteger(field);
  if (
    typeof v.kernelId !== "string" ||
    typeof v.name !== "string" ||
    (v.language !== "python" && v.language !== "r") ||
    typeof v.environment !== "string" ||
    !whole(v.executionCount) ||
    typeof v.source !== "string" ||
    origin === null ||
    typeof origin !== "object" ||
    (origin.surface !== "agent" && origin.surface !== "repl") ||
    typeof origin.by !== "string" ||
    typeof v.ok !== "boolean" ||
    !whole(v.wallMs) ||
    !whole(v.ts) ||
    !Array.isArray(v.outputs) ||
    !v.outputs.every(isKernelMessage) ||
    // A list of names or nothing. Read to its element type like `outputs`
    // beside it, and for the same reason: this is stored as opaque JSON and
    // read straight back into a browser, so an array of anything at all
    // would put whatever a machine sent onto a notebook page.
    (v.installed !== undefined &&
      (!Array.isArray(v.installed) || !v.installed.every((n) => typeof n === "string"))) ||
    (v.toolUseId !== undefined && typeof v.toolUseId !== "string")
  )
    return undefined;
  // `[]` is folded to absent rather than refused. Absent-is-not-zero is a
  // rule about what a PRODUCER writes — the kernel host records the key only
  // when something was installed — and on this side of the wire the two say
  // the same thing, so refusing the cell over an empty array would cost a
  // researcher the whole cell to enforce a distinction nothing reads.
  const installed = Array.isArray(v.installed) && v.installed.length > 0
    ? (v.installed as string[])
    : undefined;
  return {
    kernelId: v.kernelId,
    name: v.name,
    language: v.language,
    environment: v.environment,
    executionCount: v.executionCount as number,
    source: v.source,
    origin: { surface: origin.surface, by: origin.by },
    ok: v.ok,
    wallMs: v.wallMs as number,
    ts: v.ts as number,
    outputs: v.outputs as KernelMessage[],
    ...(installed === undefined ? {} : { installed }),
    ...(v.toolUseId === undefined ? {} : { toolUseId: v.toolUseId as string }),
  };
}

/** Records one cell against the Task it ran in, and returns its durable id. */
export function recordCell(store: Store, cell: CellToRecord, ts: number): string {
  const seq = nextSeq(store);
  const id = cell.id ?? `cell_${seq}`;
  store.run(
    `INSERT INTO cells
       (id, task_id, session_id, kernel_id, name, language, environment, execution_count,
        source, origin_surface, origin_by, ok, wall_ms, ts, outputs, installed, tool_use_id, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      cell.taskId,
      cell.sessionId,
      cell.kernelId,
      cell.name,
      cell.language,
      cell.environment,
      cell.executionCount,
      cell.source,
      cell.origin.surface,
      cell.origin.by,
      cell.ok ? 1 : 0,
      cell.wallMs,
      ts,
      JSON.stringify(cell.outputs),
      // NULL, not `'[]'`: a cell that installed nothing and a cell whose
      // packages this lab could not name are both "nothing to show", and a
      // stored empty array would come back as a present-but-empty field that
      // `notebookFor` would then have to invent the absence back out of.
      cell.installed === undefined ? null : JSON.stringify(cell.installed),
      cell.toolUseId ?? null,
      seq,
    ],
  );
  return id;
}

/**
 * Every cell run against a Task, oldest first — ordered on insertion, never
 * on the execution counter a kernel reported: a restart resets that counter
 * to zero, and ordering on it would put a cell run after a restart before
 * every cell run before one.
 */
export function notebookFor(store: Store, taskId: string): NotebookCell[] {
  return store
    .all(
      `SELECT id, kernel_id, name, language, environment, execution_count, source,
              origin_surface, origin_by, ok, wall_ms, ts, outputs, installed, tool_use_id
         FROM cells
        WHERE task_id = ?
        ORDER BY seq ASC`,
      [taskId],
    )
    .map((row) => ({
      id: row.id as string,
      kernelId: row.kernel_id as string,
      name: row.name as string,
      language: row.language as Language,
      environment: row.environment as string,
      executionCount: row.execution_count as number,
      source: row.source as string,
      origin: {
        surface: row.origin_surface as CellOrigin["surface"],
        by: row.origin_by as string,
      },
      ok: row.ok === 1,
      wallMs: row.wall_ms as number,
      ts: row.ts as number,
      outputs: JSON.parse(row.outputs as string) as KernelMessage[],
      // Absent for every cell recorded before this column existed and for
      // every cell that installed nothing, which are the same answer to the
      // reader: there is nothing to show on this cell.
      ...(row.installed === null || row.installed === undefined
        ? {}
        : { installed: JSON.parse(row.installed as string) as string[] }),
      ...(row.tool_use_id === null ? {} : { toolUseId: row.tool_use_id as string }),
    }));
}
