import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../store/sqlite";
import { migrate } from "../store/migrations";
import { readConfig } from "../config";
import { createChannel } from "../channel";
import { createRunRelay } from "../run-relay";
import { createRevertRegistry } from "../run-revert";
import { changeRecorder } from "./changes";
import type { Deps } from "./index";
import type { Store } from "../store/store";
import type { Send } from "../channel";

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-changes-"));
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

const NOW = 1_800_000_000;

function depsFor(store: Store): Deps {
  const actor = { userId: "u_1", role: "owner" } as const;
  const channel = createChannel(store, 1000);
  return {
    store,
    actor,
    now: () => NOW,
    config: readConfig({}),
    channel,
    runs: createRunRelay(),
    reverts: createRevertRegistry(),
    changes: changeRecorder({ store, actorId: actor.userId, now: () => NOW, channel }),
  };
}

it("flushes a change recorded in a transaction that committed", () => {
  const store = freshStore();
  const deps = depsFor(store);
  const { record, flush } = changeRecorder({ store, actorId: deps.actor.userId, now: deps.now, channel: deps.channel });
  const seen: Send[] = [];
  deps.channel.subscribe(undefined, (s) => seen.push(s));

  store.tx(() => record("study-created", { studyId: "s_1" }));
  flush();

  expect(seen).toEqual([
    { type: "change", message: { seq: 1, kind: "study-created", payload: { studyId: "s_1" } } },
  ]);
});

it("never flushes a change whose transaction rolled back, even though it reaches every subscriber the earlier one did", () => {
  // One request, two writes: the first commits, the second's transaction
  // throws partway through. Both call `record`, so both land in the same
  // pending queue — `flush` is what has to tell them apart.
  const store = freshStore();
  const deps = depsFor(store);
  const { record, flush } = changeRecorder({ store, actorId: deps.actor.userId, now: deps.now, channel: deps.channel });
  const seen: Send[] = [];
  deps.channel.subscribe(undefined, (s) => seen.push(s));

  store.tx(() => record("study-created", { studyId: "s_kept" }));

  expect(() =>
    store.tx(() => {
      record("study-created", { studyId: "s_lost" });
      throw new Error("boom");
    }),
  ).toThrow("boom");

  flush();

  expect(seen).toEqual([
    { type: "change", message: { seq: 1, kind: "study-created", payload: { studyId: "s_kept" } } },
  ]);
});

it("never flushes a rolled-back change whose sequence a later one was given", () => {
  // The counter behind AUTOINCREMENT is an ordinary table, so a rollback
  // takes it back too and the next insert is handed the same sequence. A
  // flush that only asked whether the sequence is present in the log would
  // find it, and announce the change that never happened.
  const store = freshStore();
  const deps = depsFor(store);
  const { record, flush } = deps.changes;
  const seen: Send[] = [];
  deps.channel.subscribe(undefined, (s) => seen.push(s));

  expect(() =>
    store.tx(() => {
      record("study-created", { studyId: "s_lost" });
      throw new Error("boom");
    }),
  ).toThrow("boom");
  store.tx(() => record("task-created", { taskId: "t_kept" }));

  const rows = store.all(`SELECT seq FROM change_log`);
  expect(rows).toHaveLength(1);

  flush();

  expect(seen).toEqual([
    {
      type: "change",
      message: { seq: rows[0].seq as number, kind: "task-created", payload: { taskId: "t_kept" } },
    },
  ]);
});

it("leaves the log itself holding only the committed row", () => {
  const store = freshStore();
  const deps = depsFor(store);
  const { record } = changeRecorder({ store, actorId: deps.actor.userId, now: deps.now, channel: deps.channel });

  store.tx(() => record("study-created", { studyId: "s_kept" }));
  expect(() =>
    store.tx(() => {
      record("study-created", { studyId: "s_lost" });
      throw new Error("boom");
    }),
  ).toThrow("boom");

  expect(store.all(`SELECT kind FROM change_log`).map((r) => r.kind)).toEqual([
    "study-created",
  ]);
});
