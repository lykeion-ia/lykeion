import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./sqlite";
import { migrate } from "./migrations";
import { notebookFor, readReportedCell, recordCell, type CellToRecord } from "./cells";
import type { Store } from "./store";

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-store-cells-"));
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

/** A cell to record, with every field defaulted except the ones a test
 *  names — the shape `recordCell` takes, short `ts`, which every call in
 *  this file supplies separately as its own third argument. */
function frameFor(overrides: Partial<CellToRecord> = {}): CellToRecord {
  return {
    taskId: "tk_1",
    sessionId: "sess_1",
    kernelId: "k_1",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 1,
    source: "1 + 1",
    origin: { surface: "agent", by: "a_claude" },
    ok: true,
    wallMs: 12,
    outputs: [],
    ...overrides,
  };
}

it("keeps a cell against the Task that ran it", () => {
  const store = freshStore();
  recordCell(store, frameFor({ taskId: "tk_1", source: "x = 1", executionCount: 1 }), 1000);
  recordCell(store, frameFor({ taskId: "tk_1", source: "print(x)", executionCount: 2 }), 1001);
  expect(notebookFor(store, "tk_1").map((c) => c.source)).toEqual(["x = 1", "print(x)"]);
});

it("orders cells by insertion, not by the counter a kernel reported", () => {
  // A restart resets the counter to zero. Ordering on it would put a cell
  // run after a restart before every cell run before one.
  const store = freshStore();
  recordCell(store, frameFor({ taskId: "tk_1", source: "first", executionCount: 7 }), 1000);
  recordCell(store, frameFor({ taskId: "tk_1", source: "after a restart", executionCount: 1 }), 1001);
  expect(notebookFor(store, "tk_1").map((c) => c.source)).toEqual(["first", "after a restart"]);
});

it("keeps a cell's tool call so it can be found from the Execution Log", () => {
  const store = freshStore();
  recordCell(store, frameFor({ taskId: "tk_1", toolUseId: "tu_9" }), 1000);
  expect(notebookFor(store, "tk_1")[0]!.toolUseId).toBe("tu_9");
});

it("leaves the tool call absent on a cell the researcher typed", () => {
  const store = freshStore();
  recordCell(store, frameFor({ taskId: "tk_1", origin: { surface: "repl", by: "u_1" } }), 1000);
  expect("toolUseId" in notebookFor(store, "tk_1")[0]!).toBe(false);
});

it("mints a durable id distinct from the kernel identity", () => {
  const store = freshStore();
  const id = recordCell(store, frameFor(), 1000);
  expect(id).toBe(notebookFor(store, "tk_1")[0]!.id);
  expect(id).not.toBe("k_1");
});

it("stamps the recorded moment from its own argument, not from any field on the cell", () => {
  const store = freshStore();
  recordCell(store, frameFor(), 4242);
  expect(notebookFor(store, "tk_1")[0]!.ts).toBe(4242);
});

it("keeps two Tasks' cells apart", () => {
  const store = freshStore();
  recordCell(store, frameFor({ taskId: "tk_1", source: "in tk_1" }), 1000);
  recordCell(store, frameFor({ taskId: "tk_2", source: "in tk_2" }), 1001);
  expect(notebookFor(store, "tk_1").map((c) => c.source)).toEqual(["in tk_1"]);
  expect(notebookFor(store, "tk_2").map((c) => c.source)).toEqual(["in tk_2"]);
});

it("round-trips a cell's outputs, snake-cased fields included", () => {
  const store = freshStore();
  recordCell(
    store,
    frameFor({
      outputs: [
        { kind: "stream", name: "stdout", text: "2\n" },
        {
          kind: "execute_result",
          execution_count: 1,
          data: { "text/plain": "2" },
          data_ref: {},
        },
      ],
    }),
    1000,
  );
  expect(notebookFor(store, "tk_1")[0]!.outputs).toEqual([
    { kind: "stream", name: "stdout", text: "2\n" },
    { kind: "execute_result", execution_count: 1, data: { "text/plain": "2" }, data_ref: {} },
  ]);
});

it("keeps what a cell installed into its kernel, on the cell that installed it", () => {
  // The far end of the whole wire. An inline install is gone from the machine
  // the moment that kernel restarts, so the cell is the only place the fact
  // can be kept at all — and it is exactly where a researcher scrolling back
  // next week goes looking for why an import that worked has stopped.
  const store = freshStore();
  recordCell(store, frameFor({ installed: ["anndata", "scanpy"] }), 1000);
  expect(notebookFor(store, "tk_1")[0]!.installed).toEqual(["anndata", "scanpy"]);
});

it("leaves the field off a cell that installed nothing", () => {
  // Absent is not zero, at the end of the wire as at the start of it: a
  // reader shows this where it is present, and `[]` on every ordinary cell
  // would put the surface on every row of every notebook in this lab.
  const store = freshStore();
  recordCell(store, frameFor(), 1000);
  expect("installed" in notebookFor(store, "tk_1")[0]!).toBe(false);
});

it("leaves the field off a cell recorded before this lab kept the answer", () => {
  // Every cell written before the column existed reads NULL, which is the
  // same answer as a cell that installed nothing: there is nothing to show
  // here. An invented `[]` would be this lab claiming it looked.
  const store = freshStore();
  recordCell(store, frameFor(), 1000);
  store.run(`UPDATE cells SET installed = NULL`);
  expect("installed" in notebookFor(store, "tk_1")[0]!).toBe(false);
});

/** One cell as a machine reports it, every field defaulted except the ones a
 *  test names — the shape `readReportedCell` is handed off the wire, which
 *  differs from `CellToRecord` in carrying its own `ts` and naming no Task. */
function reportFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kernelId: "k_1",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 1,
    source: "1 + 1",
    origin: { surface: "agent", by: "a_claude" },
    ok: true,
    wallMs: 12,
    ts: 42,
    outputs: [],
    ...overrides,
  };
}

it("reads a reported cell's installed packages as a list of names", () => {
  expect(readReportedCell(reportFor({ installed: ["scanpy"] }))?.installed).toEqual(["scanpy"]);
});

it("refuses a report whose installed packages are not names", () => {
  // Stored as opaque JSON and read straight back into a browser, the same as
  // `outputs` — so an array of anything at all would put whatever a machine
  // sent onto a notebook page.
  expect(readReportedCell(reportFor({ installed: "scanpy" }))).toBeUndefined();
  expect(readReportedCell(reportFor({ installed: [1, 2] }))).toBeUndefined();
  expect(readReportedCell(reportFor({ installed: [{ name: "scanpy" }] }))).toBeUndefined();
});

it("folds an empty installed list to no field rather than losing the cell over it", () => {
  // Absent-is-not-zero is a rule about what a producer WRITES. On this side
  // the two say the same thing, and refusing the cell would cost a researcher
  // the whole row to enforce a distinction nothing here reads.
  const read = readReportedCell(reportFor({ installed: [] }));
  expect(read).toBeDefined();
  expect("installed" in read!).toBe(false);
});
