import { expect, it } from "vitest";
import type { RunEventFrame } from "@lykeion/api";
import { createRunRelay } from "./run-relay";

it("keeps a still-running run's commands available for a fresh attach to replay", () => {
  const relay = createRunRelay();
  relay.enqueue("rt_1", { type: "start-run", runId: "run_1" });

  const replayed: string[] = [];
  relay.attach("rt_1", (_seq, c) => replayed.push(c.type));
  expect(replayed).toEqual(["start-run"]);
});

it("drops a completed run's commands once nothing can legitimately replay them", () => {
  const relay = createRunRelay();
  relay.enqueue("rt_1", { type: "start-run", runId: "run_1" });
  relay.publish("run_1", [{ seq: 1, event: { event: "completed", state: { state: "completed" } } }]);

  const replayed: string[] = [];
  relay.attach("rt_1", (_seq, c) => replayed.push(c.type));
  expect(replayed).toEqual([]);
});

it("only drops the completed run's own commands, leaving a sibling run's alone", () => {
  const relay = createRunRelay();
  relay.enqueue("rt_1", { type: "start-run", runId: "run_1" });
  relay.enqueue("rt_1", { type: "start-run", runId: "run_2" });
  relay.publish("run_1", [{ seq: 1, event: { event: "completed", state: { state: "completed" } } }]);

  const replayed: string[] = [];
  relay.attach("rt_1", (_seq, c) => replayed.push(c.runId));
  expect(replayed).toEqual(["run_2"]);
});

it("keeps a completed run's frames retrievable for a subscriber that arrives after its last one has gone", () => {
  const relay = createRunRelay();
  const unsubscribe = relay.subscribe("run_1", undefined, () => {});
  relay.publish("run_1", [{ seq: 1, event: { event: "completed", state: { state: "completed" } } }]);
  unsubscribe();

  // A subscriber joining after the run ended, and after the run's only
  // other viewer left, must still see what happened — the buffer is not
  // deleted the instant it has nobody watching, only made eligible to age
  // out once far more completed, unwatched runs than this one are waiting.
  const replayed: RunEventFrame[] = [];
  relay.subscribe("run_1", 0, (f) => replayed.push(f));
  expect(replayed).toEqual([{ seq: 1, event: { event: "completed", state: { state: "completed" } } }]);
});

it("keeps a completed run's buffer while a subscriber is still attached to it", () => {
  const relay = createRunRelay();
  relay.subscribe("run_1", undefined, () => {});
  relay.publish("run_1", [{ seq: 1, event: { event: "completed", state: { state: "completed" } } }]);

  const replayed: RunEventFrame[] = [];
  relay.subscribe("run_1", 0, (f) => replayed.push(f));
  expect(replayed).toEqual([{ seq: 1, event: { event: "completed", state: { state: "completed" } } }]);
});

it("keeps a run's history and completion signal for a subscriber who was never attached before it finished", () => {
  // The ordinary path once a browser can open a finished run's page:
  // nobody was watching the moment it ended, and the first subscriber ever
  // arrives after the fact.
  const relay = createRunRelay();
  relay.publish("run_1", [
    { seq: 1, event: { event: "assistant-text", text: "hi", partial: false } },
    { seq: 2, event: { event: "completed", state: { state: "completed" } } },
  ]);

  const replayed: RunEventFrame[] = [];
  relay.subscribe("run_1", 0, (f) => replayed.push(f));
  expect(replayed).toEqual([
    { seq: 1, event: { event: "assistant-text", text: "hi", partial: false } },
    { seq: 2, event: { event: "completed", state: { state: "completed" } } },
  ]);
});

it("evicts the oldest unwatched completed run once more than the retention limit are waiting", () => {
  const relay = createRunRelay();
  // One more than RETIRED_RUN_LIMIT (200): the 201st completion is what
  // pushes the very first one out.
  for (let i = 0; i < 201; i++) {
    relay.publish(`run_${i}`, [{ seq: 1, event: { event: "completed", state: { state: "completed" } } }]);
  }

  const oldest: RunEventFrame[] = [];
  relay.subscribe("run_0", 0, (f) => oldest.push(f));
  expect(oldest).toEqual([]);

  const newest: RunEventFrame[] = [];
  relay.subscribe("run_200", 0, (f) => newest.push(f));
  expect(newest).toHaveLength(1);
});

it("retires a completed run from its runtime's live set", () => {
  const relay = createRunRelay();
  relay.attach("rt_1", () => {});
  relay.enqueue("rt_1", { type: "start-run", runId: "run_1" });
  expect(relay.liveFor("rt_1")).toEqual(["run_1"]);

  relay.publish("run_1", [{ seq: 1, event: { event: "completed", state: { state: "completed" } } }]);
  expect(relay.liveFor("rt_1")).toEqual([]);
});

it("does not count a run as live until its start-run has actually reached a connected daemon", () => {
  // A run enqueued while the command stream is down (reconnecting, or never
  // opened yet) sits in the queue, undelivered — the daemon that would run
  // it has never heard of it, so it must not be reconciled away as "no
  // longer held" the moment that daemon does connect and reports nothing.
  const relay = createRunRelay();
  relay.enqueue("rt_1", { type: "start-run", runId: "run_1" });
  expect(relay.liveFor("rt_1")).toEqual([]);
  expect(relay.reconcile("rt_1", [])).toEqual([]);
});

it("counts a run as live once a fresh attach replays its still-queued start-run", () => {
  const relay = createRunRelay();
  relay.enqueue("rt_1", { type: "start-run", runId: "run_1" });
  relay.attach("rt_1", () => {});
  expect(relay.liveFor("rt_1")).toEqual(["run_1"]);
});

it("counts a run as live immediately when a subscriber is already attached to receive it", () => {
  const relay = createRunRelay();
  relay.attach("rt_1", () => {});
  relay.enqueue("rt_1", { type: "start-run", runId: "run_1" });
  expect(relay.liveFor("rt_1")).toEqual(["run_1"]);
});

it("starts a run's own sequence at 1 before it has produced anything", () => {
  const relay = createRunRelay();
  expect(relay.nextSeqFor("run_never_published")).toBe(1);
});

it("continues a run's own sequence past whatever its buffer already holds", () => {
  const relay = createRunRelay();
  relay.publish("run_1", [
    { seq: 1, event: { event: "assistant-text", text: "one", partial: true } },
    { seq: 2, event: { event: "assistant-text", text: "two", partial: true } },
  ]);
  expect(relay.nextSeqFor("run_1")).toBe(3);
});
