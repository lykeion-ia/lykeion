import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProvenanceEnvelope } from "@lykeion/api";
import { envelopeHash } from "@lykeion/api/provenance-hash";
import { cellsForToolUse, recordCell } from "./cells";
import { migrate } from "./migrations";
import {
  codeStateFor,
  envelopeById,
  provenanceIdFor,
  readReportedEnvelope,
  recordEnvelope,
} from "./provenance";
import { openStore } from "./sqlite";
import type { Store } from "./store";

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-store-provenance-"));
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

/** A cell filed under a Task, with only what a test asserts against given a
 *  name of its own — everything else `recordCell` requires is filled with an
 *  ordinary value nothing in this file inspects. */
function seedCell(
  store: Store,
  fields: { id: string; taskId: string; toolUseId?: string; provenanceId?: string },
): void {
  recordCell(
    store,
    {
      id: fields.id,
      taskId: fields.taskId,
      sessionId: "se_1",
      kernelId: "k_1",
      name: "main",
      language: "python",
      environment: "python",
      executionCount: 1,
      source: "x = 1",
      origin: { surface: "agent", by: "claude" },
      ok: true,
      wallMs: 5,
      outputs: [],
      ...(fields.toolUseId === undefined ? {} : { toolUseId: fields.toolUseId }),
      ...(fields.provenanceId === undefined ? {} : { provenanceId: fields.provenanceId }),
    },
    100,
  );
}

const envelope = () =>
  ({
    version: "lykeion.provenance.v1",
    identity: {
      studyId: "st_1",
      taskId: "tk_1",
      sessionId: "se_1",
      kernelId: "k_1",
      cellId: "cell_1",
    },
    input: {
      code: "x = 1\n",
      cwd: "/w",
      codeState: {
        lineage: { incarnation: 0, index: 0, digest: "d0".padEnd(64, "9") },
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
    timestamps: { createdAt: 100, startedAt: 101, completedAt: 102 },
  }) as ProvenanceEnvelope;

describe("readReportedEnvelope", () => {
  it("reads one that fits", () => {
    expect(readReportedEnvelope(envelope())).toBeDefined();
  });

  it("refuses a version it does not know", () => {
    expect(readReportedEnvelope({ ...envelope(), version: "lykeion.provenance.v9" })).toBeUndefined();
  });

  it("refuses one whose status was never terminal", () => {
    const running = envelope() as { outputs: { status: string } };
    running.outputs.status = "running";
    expect(readReportedEnvelope(running)).toBeUndefined();
  });

  it("refuses anything that is not an object", () => {
    expect(readReportedEnvelope("no")).toBeUndefined();
    expect(readReportedEnvelope(null)).toBeUndefined();
  });
});

describe("recordEnvelope", () => {
  it("stores under the hash of its own bytes", () => {
    const store = freshStore();
    const body = envelope();
    expect(recordEnvelope(store, body, "tk_1", "se_1", 100)).toBe(envelopeHash(body));
  });

  it("reads back byte-identical", () => {
    const store = freshStore();
    const body = envelope();
    const id = recordEnvelope(store, body, "tk_1", "se_1", 100)!;
    expect(envelopeById(store, id)).toEqual(body);
  });

  it("is idempotent under redelivery", () => {
    // A daemon retries an immutable batch. A second arrival of one envelope
    // is the same record, not a conflict to throw on.
    const store = freshStore();
    const body = envelope();
    const first = recordEnvelope(store, body, "tk_1", "se_1", 100);
    expect(() => recordEnvelope(store, body, "tk_1", "se_1", 100)).not.toThrow();
    expect(recordEnvelope(store, body, "tk_1", "se_1", 100)).toBe(first);
  });

  it("names a record by its own bytes, never by an id sent beside them", () => {
    // The envelope crossed a process this lab did not write, and an id that
    // arrived with it is a claim rather than a fact about the bytes under it.
    // A sender that named its own would otherwise decide what this lab files
    // its record under — and every cell joined to that name would point at a
    // record whose bytes do not hash to it.
    const store = freshStore();
    const claimed = "0".repeat(64);
    const body = { ...envelope(), id: claimed } as unknown as ProvenanceEnvelope;
    expect(recordEnvelope(store, body, "tk_1", "se_1", 100)).toBe(envelopeHash(body));
    expect(envelopeById(store, claimed)).toBeUndefined();
  });

  it("answers undefined for an id nothing wrote", () => {
    expect(envelopeById(freshStore(), "0".repeat(64))).toBeUndefined();
  });
});

describe("the join", () => {
  it("finds the cells one tool call produced", () => {
    const store = freshStore();
    // Two cells on one call is ordinary: an agent runs a cell, reads it,
    // runs another inside the same call.
    seedCell(store, { id: "cell_1", taskId: "tk_1", toolUseId: "toolu_1" });
    seedCell(store, { id: "cell_2", taskId: "tk_1", toolUseId: "toolu_1" });
    seedCell(store, { id: "cell_3", taskId: "tk_1", toolUseId: "toolu_2" });

    expect(cellsForToolUse(store, "toolu_1", "tk_1").map((c) => c.id)).toEqual(["cell_1", "cell_2"]);
  });

  it("answers empty for a call that ran no cells", () => {
    expect(cellsForToolUse(freshStore(), "toolu_read", "tk_1")).toEqual([]);
  });

  it("does not reach across Tasks on a repeated tool call id", () => {
    // Ids are minted per session and are not expected to collide. An
    // unscoped join would make a collision a cross-Task leak rather than a
    // wrong row, which is the difference worth a WHERE clause.
    const store = freshStore();
    seedCell(store, { id: "cell_mine", taskId: "tk_1", toolUseId: "toolu_x" });
    seedCell(store, { id: "cell_theirs", taskId: "tk_2", toolUseId: "toolu_x" });

    expect(cellsForToolUse(store, "toolu_x", "tk_1").map((c) => c.id)).toEqual(["cell_mine"]);
  });

  it("lifts the code state a header renders out of the envelope", () => {
    const store = freshStore();
    const body = envelope();
    const id = recordEnvelope(store, body, "tk_1", "se_1", 100)!;
    seedCell(store, { id: "cell_1", taskId: "tk_1", provenanceId: id });

    expect(codeStateFor(store, ["cell_1"]).get("cell_1")).toEqual({
      lineage: "d0".padEnd(64, "9").slice(0, 8),
      index: 0,
    });
  });

  it("lifts the git arm where the envelope had one", () => {
    const store = freshStore();
    const body = envelope() as { input: { codeState: { git: unknown } } };
    body.input.codeState.git = {
      status: "available",
      value: { repository: "/r", branch: "trunk", commit: "c".repeat(40), dirty: true },
    };
    const id = recordEnvelope(store, body as never, "tk_1", "se_1", 100)!;
    seedCell(store, { id: "cell_1", taskId: "tk_1", provenanceId: id });

    expect(codeStateFor(store, ["cell_1"]).get("cell_1")?.git).toEqual({
      branch: "trunk",
      commit: "c".repeat(40),
      dirty: true,
    });
  });

  it("has nothing to say about a cell with no envelope", () => {
    const store = freshStore();
    seedCell(store, { id: "cell_1", taskId: "tk_1" });
    expect(codeStateFor(store, ["cell_1"]).has("cell_1")).toBe(false);
  });

  it("has nothing to say about a cell whose stored envelope carries no code state", () => {
    // `readReportedEnvelope` checks `version`, `outputs`, and the two names
    // a cell joins a record by — never `input.codeState`, which this is the
    // only reader of. A body that gate let through with nothing usable there
    // is read the same way a cell with no envelope at all already is.
    const store = freshStore();
    const malformed = { ...envelope(), input: { code: "x = 1" } } as unknown as ProvenanceEnvelope;
    const id = recordEnvelope(store, malformed, "tk_1", "se_1", 100)!;
    seedCell(store, { id: "cell_1", taskId: "tk_1", provenanceId: id });
    expect(codeStateFor(store, ["cell_1"]).has("cell_1")).toBe(false);
  });

  it("names the record a cell references", () => {
    const store = freshStore();
    const id = recordEnvelope(store, envelope(), "tk_1", "se_1", 100)!;
    seedCell(store, { id: "cell_1", taskId: "tk_1", provenanceId: id });
    expect(provenanceIdFor(store, "cell_1")).toBe(id);
  });

  it("answers undefined for a cell that names none, and for one that does not exist", () => {
    // Two different absences, and neither is an error: a cell from before
    // this phase has no record, and a cell id nothing minted has no cell.
    const store = freshStore();
    seedCell(store, { id: "cell_1", taskId: "tk_1" });
    expect(provenanceIdFor(store, "cell_1")).toBeUndefined();
    expect(provenanceIdFor(store, "cell_gone")).toBeUndefined();
  });
});
