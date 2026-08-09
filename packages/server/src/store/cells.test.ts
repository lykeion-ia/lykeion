import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./sqlite";
import { migrate } from "./migrations";
import { notebookFor, recordCell, type CellToRecord } from "./cells";
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
