import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./sqlite";
import { migrate } from "./migrations";
import {
  openSession,
  recordTurn,
  finishTurn,
  appendStep,
  addGrant,
  listGrants,
  runtimeForTurn,
  sessionForTurn,
  dropGrantsForStudy,
  dropGrantsForRuntime,
} from "./sessions";
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
