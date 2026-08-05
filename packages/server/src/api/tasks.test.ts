import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLykeionError } from "@lykeion/api";
import { openStore } from "../store/sqlite";
import { migrate, nextSeq } from "../store/migrations";
import { readConfig } from "../config";
import { createChannel } from "../channel";
import { createRunRelay } from "../run-relay";
import { changeRecorder } from "./changes";
import { tasksApi } from "./tasks";
import type { Deps } from "./index";
import type { Store } from "../store/store";

// `conformance.test.ts` wires only `studiesConformance` and `tasksConformance`
// against this server — `taskChatConformance`, where `pinned` and
// `lastRunStatus` are actually asserted, stays unwired because its prompt-
// driven test needs `startRun`, which this server still answers
// `unsupported`. That leaves `toTask`'s handling of `pinned`, `lastRunStatus`
// and `runtimeId` unreached by anything that runs against a live server —
// these tests close that gap directly against `tasksApi`.

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-tasks-"));
  dirs.push(dir);
  const store = openStore(join(dir, "workspace.db"));
  opened.push(store);
  migrate(store);
  return store;
}

afterEach(() => {
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      // best effort — a stuck close must not strand the rest of cleanup.
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort — nothing here is worth failing an already-passed test.
    }
  }
});

const NOW = 1_800_000_000;

function addOwner(store: Store, id: string): void {
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, `${id}@lab.example`, id, "x", NOW, nextSeq(store)],
  );
  store.run(`INSERT INTO members (user_id, role, joined_ts, seq) VALUES (?, 'owner', ?, ?)`, [
    id,
    NOW,
    nextSeq(store),
  ]);
}

function depsFor(store: Store): Deps {
  const actor = { userId: "u_owner", role: "owner" } as const;
  const channel = createChannel(store, 1000);
  return {
    store,
    actor,
    now: () => NOW,
    config: readConfig({}),
    // A real channel rather than a stub: it is the cheapest place to leave
    // the recorder's publish path actually exercised.
    channel,
    runs: createRunRelay(),
    changes: changeRecorder({ store, actorId: actor.userId, now: () => NOW, channel }),
  };
}

it("a Task's pinned flag reads back true when set, and is absent — not false — when it never was pinned", async () => {
  const store = freshStore();
  addOwner(store, "u_owner");
  const tasks = tasksApi(depsFor(store));

  const fresh = await tasks.createTask({ stage: "background", title: "Never pinned" });
  expect("pinned" in fresh).toBe(false);

  const pinned = await tasks.updateTask(fresh.id, { pinned: true });
  expect(pinned.pinned).toBe(true);

  const unpinned = await tasks.updateTask(fresh.id, { pinned: false });
  expect("pinned" in unpinned).toBe(false);
});

it("lastRunStatus and runtimeId are absent on a Task nothing has run yet, and read back once a column holds a value", async () => {
  const store = freshStore();
  addOwner(store, "u_owner");
  const tasks = tasksApi(depsFor(store));

  const created = await tasks.createTask({ stage: "background", title: "Untouched" });
  expect("lastRunStatus" in created).toBe(false);
  expect("runtimeId" in created).toBe(false);

  // No handler writes these two columns — recording a run needs a machine
  // this server does not have — so the write is seeded directly, the way a
  // run-recording handler would.
  store.run(`UPDATE tasks SET last_run_status = 'ok', runtime_id = 'rt_1' WHERE id = ?`, [
    created.id,
  ]);

  const after = await tasks.getTask(created.id);
  expect(after.task.lastRunStatus).toBe("ok");
  expect(after.task.runtimeId).toBe("rt_1");
});

it("createTask names the unknown study rather than surfacing a raw foreign-key failure", async () => {
  // `tasks.study_id` is a foreign key to `studies.id`, and this store runs
  // with `PRAGMA foreign_keys = ON`. Without a check ahead of the INSERT,
  // an unknown studyId does not fail cleanly — it throws whatever SQLite's
  // own constraint-violation error looks like, which reaches the RPC layer
  // as an uncaught exception (a 500) instead of a `not-found` a caller can
  // branch on the way `updateTask` already lets one for the same mistake.
  const store = freshStore();
  addOwner(store, "u_owner");
  const tasks = tasksApi(depsFor(store));

  const err = await tasks
    .createTask({ studyId: "s_nope", stage: "background", title: "Orphaned" })
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  expect(isLykeionError(err) && err.code).toBe("not-found");
  expect((err as Error).message).toMatch(/no such study: s_nope/);

  // And nothing was written: a failed create leaves no row a later number
  // could collide with, or a later list could turn up.
  expect(await tasks.listTasks()).toEqual([]);
});
