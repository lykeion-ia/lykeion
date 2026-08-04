import { afterEach, expect, it, vi } from "vitest";
import { createRetryLoop } from "./retry";
import { LabRefused } from "./lab";

// Only the timers are faked. `setImmediate` stays real, so `flush` below is
// a genuine turn of the event loop rather than something the fake clock has
// to be told to deliver — the two would otherwise have to be advanced in the
// right order for a test to see what a promise chain did.
function useTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
});

/** An attempt whose settling this test decides, so a stop can be timed to
 *  land while a call to the lab is genuinely in flight. */
function heldAttempt(): { attempt: () => Promise<void>; fail(err: Error): void; succeed(): void } {
  let fail!: (err: Error) => void;
  let succeed!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    succeed = resolve;
    fail = reject;
  });
  return { attempt: () => promise, fail, succeed };
}

it("arms no wait for a failure that arrives after it was stopped", async () => {
  useTimers();
  const lines: string[] = [];
  const held = heldAttempt();
  const loop = createRetryLoop({ onRefused: () => {}, log: (line) => lines.push(line) });

  const run = loop.run("http://lab.uni.edu", "report", held.attempt);
  await flush();

  // The stop lands while the call is still out. Nothing exists to cancel:
  // the wait that would hold this process open has not been made yet.
  loop.stop();
  held.fail(new Error("socket hang up"));
  await flush();

  expect(vi.getTimerCount()).toBe(0);
  expect(lines).toEqual([]);
  await run;
});

it("ends the wait it is already sitting in when it is stopped", async () => {
  useTimers();
  const loop = createRetryLoop({ onRefused: () => {}, log: () => {} });
  const run = loop.run("http://lab.uni.edu", "heartbeat", () =>
    Promise.reject(new Error("connection refused")),
  );
  await flush();
  expect(vi.getTimerCount()).toBe(1);

  loop.stop();
  await flush();
  expect(vi.getTimerCount()).toBe(0);
  await run;
});

it("keeps trying a lab that is failing, backing off further each time", async () => {
  useTimers();
  const lines: string[] = [];
  let calls = 0;
  const loop = createRetryLoop({ onRefused: () => {}, log: (line) => lines.push(line) });

  const run = loop.run("http://lab.uni.edu", "heartbeat", () => {
    calls += 1;
    return calls < 3 ? Promise.reject(new Error("connection refused")) : Promise.resolve();
  });
  await vi.runAllTimersAsync();
  await run;

  expect(calls).toBe(3);
  expect(lines).toEqual([
    "heartbeat to http://lab.uni.edu failed: connection refused — retrying in 1000ms",
    "heartbeat to http://lab.uni.edu failed: connection refused — retrying in 2000ms",
  ]);
});

it("hands over and stops when the lab says it does not know this machine", async () => {
  useTimers();
  const refusals: string[] = [];
  const loop = createRetryLoop({ onRefused: (err) => refusals.push(err.message), log: () => {} });

  await loop.run("http://lab.uni.edu", "heartbeat", () =>
    Promise.reject(new LabRefused("that lab no longer recognizes this machine")),
  );

  expect(refusals).toEqual(["that lab no longer recognizes this machine"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not start an attempt at all once it has been stopped", async () => {
  useTimers();
  let calls = 0;
  const loop = createRetryLoop({ onRefused: () => {}, log: () => {} });
  loop.stop();
  await loop.run("http://lab.uni.edu", "heartbeat", () => {
    calls += 1;
    return Promise.resolve();
  });
  expect(calls).toBe(0);
  expect(loop.stopping).toBe(true);
});
