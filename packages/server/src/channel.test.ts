import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store/sqlite";
import { migrate } from "./store/migrations";
import { createChannel, type Send } from "./channel";
import type { Store } from "./store/store";

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-channel-"));
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

/** Append the way a write path does — the row first, then the fan-out with
 *  the sequence the database assigned. */
function append(store: Store, channel: ReturnType<typeof createChannel>, kind: string): number {
  const seq = store.tx(() => {
    store.run(`INSERT INTO change_log (ts, kind, payload, actor_id) VALUES (?, ?, ?, ?)`, [
      1_800_000_000,
      kind,
      JSON.stringify({ kind }),
      "u_1",
    ]);
    return store.get(`SELECT last_insert_rowid() AS seq`)!.seq as number;
  });
  channel.publish({ seq, kind, payload: { kind } });
  return seq;
}

it("delivers an appended change to every open subscriber", () => {
  const store = freshStore();
  const channel = createChannel(store, 100);
  const a: Send[] = [];
  const b: Send[] = [];
  channel.subscribe(undefined, (s) => a.push(s));
  channel.subscribe(undefined, (s) => b.push(s));

  append(store, channel, "task-updated");

  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);
  expect(a[0]).toEqual({ type: "change", message: { seq: 1, kind: "task-updated", payload: { kind: "task-updated" } } });
});

it("replays exactly the changes a cursor missed, in order", () => {
  const store = freshStore();
  const channel = createChannel(store, 100);
  const first = append(store, channel, "one");
  append(store, channel, "two");
  append(store, channel, "three");

  const seen: Send[] = [];
  channel.subscribe(first, (s) => seen.push(s));

  // Exactly the two it missed — not the one it already had, and not a
  // replay of everything.
  expect(seen.map((s) => (s.type === "change" ? s.message.kind : s.type))).toEqual([
    "two",
    "three",
  ]);
});

it("replays nothing to a cursor that is already current", () => {
  const store = freshStore();
  const channel = createChannel(store, 100);
  const last = append(store, channel, "one");
  const seen: Send[] = [];
  channel.subscribe(last, (s) => seen.push(s));
  expect(seen).toEqual([]);
});

it("tells a cursor outside the retention window to resynchronise", () => {
  // A partial replay leaves a gap the client cannot detect, so it must not
  // be offered one: `resync` and no change events at all.
  const store = freshStore();
  const channel = createChannel(store, 2);
  for (const kind of ["one", "two", "three", "four", "five"]) append(store, channel, kind);

  const seen: Send[] = [];
  channel.subscribe(1, (s) => seen.push(s));

  expect(seen).toEqual([{ type: "resync" }]);
});

it("replays the whole window to the oldest cursor that can still have it all", () => {
  // One short of the oldest surviving change. Everything it missed is still
  // in the log, so it gets all of it and no resync — a resync here would
  // throw away a client's place for nothing.
  const store = freshStore();
  const channel = createChannel(store, 3);
  for (const kind of ["one", "two", "three", "four", "five"]) append(store, channel, kind);
  const oldest = store.get(`SELECT MIN(seq) AS s FROM change_log`)!.s as number;

  const seen: Send[] = [];
  channel.subscribe(oldest - 1, (s) => seen.push(s));

  expect(seen.map((s) => (s.type === "change" ? s.message.seq : s.type))).toEqual([
    oldest,
    oldest + 1,
    oldest + 2,
  ]);
});

it("resynchronises the first cursor that has fallen one change too far behind", () => {
  // Two short of the oldest surviving change: the one immediately before it
  // is gone. This is the exact cursor at which a replay would start with a
  // hole in it, and the client would have no way to know.
  const store = freshStore();
  const channel = createChannel(store, 3);
  for (const kind of ["one", "two", "three", "four", "five"]) append(store, channel, kind);
  const oldest = store.get(`SELECT MIN(seq) AS s FROM change_log`)!.s as number;

  const seen: Send[] = [];
  channel.subscribe(oldest - 2, (s) => seen.push(s));

  expect(seen).toEqual([{ type: "resync" }]);
});

it("keeps the log to its retention window", () => {
  const store = freshStore();
  const channel = createChannel(store, 3);
  for (let i = 0; i < 10; i++) append(store, channel, `k${i}`);
  expect(store.all(`SELECT seq FROM change_log`)).toHaveLength(3);
});

it("stops delivering to a subscriber that has unsubscribed", () => {
  const store = freshStore();
  const channel = createChannel(store, 100);
  const seen: Send[] = [];
  const stop = channel.subscribe(undefined, (s) => seen.push(s));
  append(store, channel, "one");
  stop();
  append(store, channel, "two");
  expect(seen).toHaveLength(1);
});
