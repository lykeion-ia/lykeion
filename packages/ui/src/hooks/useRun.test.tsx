import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  ExecutionLogEntry,
  LykeionApi,
  RunEvent,
  RunHandle,
  StartRunInput,
} from "@lykeion/api";
import { ApiProvider } from "../api/ApiContext";
import { planOf, useRun } from "./useRun";

afterEach(() => {
  cleanup();
  // A no-op when a test never called `vi.useFakeTimers()` — restored
  // unconditionally so a grace-window test that does can never leak fake
  // time into whichever test runs after it.
  vi.useRealTimers();
});

function initialSnapshot(runId: string, prompt = "do it"): RunEvent {
  return {
    event: "snapshot",
    snapshot: {
      runId,
      sequence: 1,
      prompt,
      agent: "default",
      state: { state: "planning" },
      stream: [],
      live: {},
      reviewing: false,
      lastEventSeq: 0,
    },
  };
}

/**
 * A `startRun` that never resolves on its own — the caller gets `resolve`
 * back and decides when the late handle arrives, so a test can drive Stop
 * WHILE the round-trip is still in flight, the one window
 * `stalledApi`/`drivenApi` (both resolved before the test ever touches them)
 * cannot reach at all.
 */
function deferredApi(): {
  api: LykeionApi;
  resolveStart: () => void;
  closeCount: () => number;
  detachCount: () => number;
} {
  let resolve: (() => void) | null = null;
  let closes = 0;
  let detaches = 0;
  const handle: RunHandle = {
    runId: "run-deferred",
    onEvent() {
      return () => {};
    },
    submit() {},
    detach() {
      detaches += 1;
    },
    close() {
      closes += 1;
    },
  };
  const api = {
    startRun: (_input: StartRunInput) =>
      new Promise<RunHandle>((res) => {
        resolve = () => res(handle);
      }),
    listMembers: () => Promise.resolve([]),
  } as unknown as LykeionApi;
  return {
    api,
    resolveStart: () => resolve?.(),
    closeCount: () => closes,
    detachCount: () => detaches,
  };
}

/**
 * A run that emits `executing` and then goes silent — the "Running… (stuck)"
 * case (a hung CLI or a dropped event). It never completes on its own.
 */
function stalledApi(): { api: LykeionApi; submitted: string[] } {
  const submitted: string[] = [];
  const plan = { steps: [{ title: "work", done: false }], raw: "1. work" };
  const handle: RunHandle = {
    runId: "run-stalled",
    onEvent(cb: (e: RunEvent) => void) {
      setTimeout(
        () => {
          cb(initialSnapshot("run-stalled"));
          cb({ event: "state", state: { state: "executing", plan } });
        },
        0,
      );
      return () => {};
    },
    submit(d) {
      submitted.push(d.action);
    },
    detach() {},
    close() {},
  };
  const api = {
    startRun: (_input: StartRunInput) => Promise.resolve(handle),
    listMembers: () => Promise.resolve([]),
  } as unknown as LykeionApi;
  return { api, submitted };
}

/** A step's output as one string, so the probe below can print it. A record
 *  carrying typed pieces prints the text ones; the assertions here are about
 *  what reached the hook, not about how a step is drawn. */
function resultText(result: ExecutionLogEntry["result"]): string {
  if (typeof result === "string") return result;
  if (!result) return "";
  return result.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function Harness({ api }: { api: LykeionApi }) {
  return (
    <ApiProvider api={api}>
      <Probe />
    </ApiProvider>
  );
}

function Probe() {
  const run = useRun("s1", { taskId: "t1" });
  return (
    <div>
      <span data-testid="state">{run.state?.state ?? "none"}</span>
      <span data-testid="running">{String(run.running)}</span>
      <span data-testid="starting">{String(run.starting)}</span>
      <span data-testid="reviewing">{String(run.reviewing)}</span>
      <span data-testid="unacknowledged">
        {String(
          run.state?.state === "cancelled" && !!run.state.unacknowledged,
        )}
      </span>
      <span data-testid="plan-status">
        {(run.plan?.steps ?? []).map((s) => s.status ?? "none").join(",")}
      </span>
      {/* One element per recorded assistant message — the real surface paints
          exactly one bubble per entry, so counting these counts bubbles. */}
      {run.messages.map((m, i) => (
        <span key={i} data-testid="bubble">
          {m}
        </span>
      ))}
      {run.live.text != null && (
        <span data-testid="live-text">{run.live.text}</span>
      )}
      {run.log.map((entry) => (
        <span key={entry.toolUseId} data-testid="log-entry">
          {entry.toolUseId}:{entry.decision}:{resultText(entry.result)}:{String(entry.isError)}
        </span>
      ))}
      <span data-testid="live-stream">
        {run.liveStream
          .map((item) =>
            item.kind === "text"
              ? `text:${item.text}`
              : `step:${item.entry.toolUseId}:${item.entry.decision}:${resultText(item.entry.result)}`,
          )
          .join("|")}
      </span>
      <span data-testid="block-stream">
        {run.liveStream.map((item) => item.kind === "text" ? (item.block ?? "legacy") : "tool").join("|")}
      </span>
      <span data-testid="landed-stream">
        {(run.run?.stream ?? [])
          .map((item) => item.kind === "text" ? `text:${item.text}:${item.block ?? "legacy"}` : `step:${item.entry.toolUseId}`)
          .join("|")}
      </span>
      <button type="button" onClick={() => run.start("do it")}>
        start
      </button>
      <button type="button" onClick={run.cancel}>
        stop
      </button>
    </div>
  );
}

/**
 * A run whose events are pushed manually, one at a time, so a test can inspect
 * the surface MID-TURN — between a fragment and the whole message that ends it.
 */
function drivenApi(): { api: LykeionApi; emit: (e: RunEvent) => void } {
  let cb: ((e: RunEvent) => void) | null = null;
  const handle: RunHandle = {
    runId: "run-driven",
    onEvent(fn: (e: RunEvent) => void) {
      cb = fn;
      queueMicrotask(() => fn(initialSnapshot("run-driven")));
      return () => {
        cb = null;
      };
    },
    submit() {},
    detach() {},
    close() {},
  };
  const api = {
    startRun: (_input: StartRunInput) => Promise.resolve(handle),
    listMembers: () => Promise.resolve([]),
  } as unknown as LykeionApi;
  return { api, emit: (e: RunEvent) => cb?.(e) };
}

/**
 * A run whose events reach every current subscriber, not just the latest
 * one — the way `memory.ts`/`http.ts` actually fan a run's stream out.
 * `cancel()`'s own grace watch registers a second, independent subscriber on
 * the same handle after the render-driving one is gone, so a test of it
 * needs more than the single-callback fakes above.
 */
function multiSubApi(): {
  api: LykeionApi;
  emit: (e: RunEvent) => void;
  submitted: string[];
  closeCount: () => number;
} {
  const subs = new Set<(e: RunEvent) => void>();
  const submitted: string[] = [];
  let closes = 0;
  const handle: RunHandle = {
    runId: "run-multi",
    onEvent(cb: (e: RunEvent) => void) {
      subs.add(cb);
      queueMicrotask(() => cb(initialSnapshot("run-multi")));
      return () => subs.delete(cb);
    },
    submit(d) {
      submitted.push(d.action);
    },
    detach() {},
    close() {
      closes += 1;
    },
  };
  const api = {
    startRun: (_input: StartRunInput) => Promise.resolve(handle),
    listMembers: () => Promise.resolve([]),
  } as unknown as LykeionApi;
  return {
    api,
    emit: (e: RunEvent) => subs.forEach((cb) => cb(e)),
    submitted,
    closeCount: () => closes,
  };
}

it("Stop releases a stalled run so the surface is never bricked", async () => {
  const user = userEvent.setup();
  const { api, submitted } = stalledApi();
  render(<Harness api={api} />);

  await user.click(screen.getByRole("button", { name: "start" }));
  // The run reaches `executing` and then goes silent.
  await act(() => new Promise((r) => setTimeout(r, 10)));
  expect(screen.getByTestId("state")).toHaveTextContent("executing");
  expect(screen.getByTestId("running")).toHaveTextContent("true");

  // Without Stop the surface would stay `running` forever (composer disabled,
  // every send swallowed). Stop must always end the turn locally.
  await user.click(screen.getByRole("button", { name: "stop" }));
  expect(screen.getByTestId("state")).toHaveTextContent("cancelled");
  expect(screen.getByTestId("running")).toHaveTextContent("false");
  // The core still gets told, so it can clean the turn up its own way.
  expect(submitted).toContain("cancel");
});

it("unmount during an in-flight startRun detaches the late handle without cancelling", async () => {
  // While the request is awaiting a handle there is no run id to stop. The
  // composer is disabled by `starting`; navigation invalidates the response,
  // and its eventual observer is detached without sending a cancellation.
  const user = userEvent.setup();
  const { api, resolveStart, closeCount, detachCount } = deferredApi();
  const view = render(<Harness api={api} />);

  await user.click(screen.getByRole("button", { name: "start" }));
  expect(screen.getByTestId("starting")).toHaveTextContent("true");
  expect(screen.getByTestId("state")).toHaveTextContent("none");
  expect(screen.getByTestId("running")).toHaveTextContent("false");
  view.unmount();

  // The round-trip finally resolves after the observer surface is gone.
  await act(async () => {
    resolveStart();
  });

  expect(detachCount()).toBe(1);
  expect(closeCount()).toBe(0);
});

it("warns instead of silently hanging when an event tag drifts", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const handle: RunHandle = {
    runId: "run-drift",
    onEvent(cb: (e: RunEvent) => void) {
      setTimeout(() => {
        cb(initialSnapshot("run-drift"));
        cb({ event: "totally-unknown" } as unknown as RunEvent);
      }, 0);
      return () => {};
    },
    submit() {},
    detach() {},
    close() {},
  };
  const api = {
    startRun: () => Promise.resolve(handle),
    listMembers: () => Promise.resolve([]),
  } as unknown as LykeionApi;

  const user = userEvent.setup();
  render(<Harness api={api} />);
  await user.click(screen.getByRole("button", { name: "start" }));
  await act(() => new Promise((r) => setTimeout(r, 10)));

  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining("unhandled run event"),
    expect.anything(),
  );
  warn.mockRestore();
});

it("streams partial prose via the live tail, then paints ONE bubble", async () => {
  // The regression: with the real CLI (which emits deltas) the runner forwards
  // BOTH partial fragments and the reassembled whole message as `assistant-text`.
  // If the surface appended every one, two fragments + the whole message would
  // paint THREE bubbles and each fragment would ALSO show in the live tail.
  // The fix: append only whole messages (`partial: false`); fragments are shown
  // solely by the `live` snapshot's `text` tail.
  const user = userEvent.setup();
  const { api, emit } = drivenApi();
  render(<Harness api={api} />);

  await user.click(screen.getByRole("button", { name: "start" }));
  // Let the `startRun` promise resolve so the event listener is attached.
  await act(() => new Promise((r) => setTimeout(r, 0)));

  // The turn types itself out: two fragments, each accompanied by a `live`
  // snapshot carrying the accumulating text.
  await act(async () => {
    emit({ event: "assistant-text", text: "Strong ", partial: true });
    emit({ event: "live", live: { text: "Strong " } });
    emit({ event: "assistant-text", text: "candidates", partial: true });
    emit({ event: "live", live: { text: "Strong candidates" } });
  });

  // MID-TURN the partial chunks have coalesced into one typed prose block.
  expect(screen.getByTestId("live-text")).toHaveTextContent(
    "Strong candidates",
  );
  expect(screen.queryAllByTestId("bubble")).toHaveLength(1);
  expect(screen.getByTestId("block-stream")).toHaveTextContent("interim");

  // The runner reassembles the run of fragments and re-emits the whole message.
  await act(async () => {
    emit({
      event: "assistant-text",
      text: "Strong candidates",
      partial: false,
    });
  });

  // Exactly ONE bubble for the message — not three — after the adapter's
  // compatibility whole-message frame as well.
  const bubbles = screen.getAllByTestId("bubble");
  expect(bubbles).toHaveLength(1);
  expect(bubbles[0]).toHaveTextContent(/^Strong candidates$/);
  expect(screen.getByTestId("live-stream")).toHaveTextContent(
    /^text:Strong candidates$/,
  );
});

it("does not duplicate a compatibility whole frame after recovery between delta frames", async () => {
  const user = userEvent.setup();
  const { api, emit } = drivenApi();
  render(<Harness api={api} />);

  await user.click(screen.getByRole("button", { name: "start" }));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => {
    emit({
      event: "snapshot",
      snapshot: {
        runId: "run-driven",
        sequence: 1,
        prompt: "do it",
        agent: "codex",
        state: { state: "planning" },
        stream: [
          { kind: "text", text: "Strong candidates", block: "interim" },
        ],
        live: { text: "Strong candidates" },
        reviewing: false,
        lastEventSeq: 4,
      },
    });
    emit({
      event: "assistant-text",
      text: "Strong candidates",
      partial: false,
    });
  });

  expect(screen.getByTestId("live-stream")).toHaveTextContent(
    /^text:Strong candidates$/,
  );
  expect(screen.getAllByTestId("bubble")).toHaveLength(1);
});

it("keeps cancelled prose interim without an explicit final marker", async () => {
  const user = userEvent.setup();
  const { api, emit } = drivenApi();
  render(<Harness api={api} />);

  await user.click(screen.getByRole("button", { name: "start" }));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => {
    emit({ event: "assistant-text", text: "unfinished answer", partial: true });
    emit({ event: "completed", state: { state: "cancelled" } });
  });

  expect(screen.getByTestId("block-stream")).toHaveTextContent(/^interim$/);
  expect(screen.getByTestId("live-stream")).toHaveTextContent(
    /^text:unfinished answer$/,
  );
});

it("preserves repeated identical text blocks when a terminal record lags the stream", async () => {
  const user = userEvent.setup();
  const { api, emit } = drivenApi();
  render(<Harness api={api} />);

  await user.click(screen.getByRole("button", { name: "start" }));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const step = {
    ts: 1,
    toolUseId: "tool-1",
    tool: "Read",
    input: {},
    decision: "ran",
    isError: false,
  } as const;
  await act(async () => {
    emit({ event: "assistant-text", text: "Repeated", partial: false });
    emit({ event: "log-entry", entry: step });
    emit({ event: "assistant-text", text: "Repeated", partial: false });
    emit({ event: "assistant-text-final" });
    emit({
      event: "completed",
      state: { state: "completed" },
      run: {
        runId: "run-driven",
        ts: 1,
        command: "do it",
        status: "ok",
        code: [],
        outputs: [],
        stream: [
          { kind: "text", text: "Repeated", block: "interim" },
          { kind: "step", entry: step },
        ],
      },
    });
  });

  expect(screen.getByTestId("live-stream")).toHaveTextContent(
    /^text:Repeated\|step:tool-1:ran:\|text:Repeated$/,
  );
  expect(screen.getByTestId("block-stream")).toHaveTextContent(
    /^interim\|tool\|final$/,
  );
  expect(screen.getByTestId("landed-stream")).toHaveTextContent(
    /^text:Repeated:interim\|step:tool-1\|text:Repeated:final$/,
  );
});

it("keeps thought, interim, tool, final, and turn error blocks in one run", async () => {
  const user = userEvent.setup();
  const { api, emit } = drivenApi();
  render(<Harness api={api} />);
  await user.click(screen.getByRole("button", { name: "start" }));
  await act(() => new Promise((r) => setTimeout(r, 0)));
  await act(async () => {
    emit({ event: "assistant-thought", text: "Plan", partial: true });
    emit({ event: "assistant-text", text: "Trying.", partial: true });
    emit({ event: "log-entry", entry: { ts: 1, toolUseId: "tool-1", tool: "python", input: {}, decision: "ran", result: "boom", isError: true } });
    emit({ event: "assistant-text", text: "Fallback result.", partial: true });
    emit({ event: "assistant-text-final" });
  });
  expect(screen.getByTestId("block-stream")).toHaveTextContent("thought|interim|tool|final");
  await act(async () => {
    emit({ event: "completed", state: { state: "failed", reason: "review failed" } });
  });
  expect(screen.getByTestId("block-stream")).toHaveTextContent("thought|interim|tool|final|error");
  expect(screen.getByTestId("state")).toHaveTextContent("failed");
});

it("does not duplicate finalized prose when completion promotes the matching live tail", async () => {
  const user = userEvent.setup();
  const { api, emit } = drivenApi();
  render(<Harness api={api} />);

  await user.click(screen.getByRole("button", { name: "start" }));
  await act(() => new Promise((r) => setTimeout(r, 0)));
  await act(async () => {
    emit({ event: "assistant-text", text: "final answer", partial: false });
    emit({ event: "live", live: { text: "final answer" } });
    emit({ event: "completed", state: { state: "completed" } });
  });

  expect(screen.getAllByTestId("bubble")).toHaveLength(1);
  expect(screen.getByTestId("live-stream")).toHaveTextContent(
    "text:final answer",
  );
  expect(screen.queryByTestId("live-text")).not.toBeInTheDocument();
});

it("merges tool updates by identity without moving the live card", async () => {
  const user = userEvent.setup();
  const { api, emit } = drivenApi();
  render(<Harness api={api} />);
  await user.click(screen.getByRole("button", { name: "start" }));
  await act(() => new Promise((r) => setTimeout(r, 0)));

  const base = {
    ts: 1,
    toolUseId: "write-1",
    tool: "Write",
    input: { path: "out.csv" },
    isError: false,
  };
  await act(async () => {
    emit({ event: "assistant-text", text: "before", partial: false });
    emit({ event: "log-entry", entry: { ...base, decision: "pending" } });
    emit({ event: "assistant-text", text: "after", partial: false });
  });
  expect(screen.getAllByTestId("log-entry")).toHaveLength(1);
  expect(screen.getByTestId("log-entry")).toHaveTextContent("write-1:pending::false");

  await act(async () => {
    emit({ event: "log-entry", entry: { ...base, decision: "allowed-once" } });
    emit({
      event: "log-entry",
      entry: { ...base, decision: "allowed-once", result: "created out.csv" },
    });
  });

  expect(screen.getAllByTestId("log-entry")).toHaveLength(1);
  expect(screen.getByTestId("log-entry")).toHaveTextContent(
    "write-1:allowed-once:created out.csv:false",
  );
  expect(screen.getByTestId("live-stream")).toHaveTextContent(
    "text:before|step:write-1:allowed-once:created out.csv|text:after",
  );
});

it("keeps an immediate denial as one card while merging its later error detail", async () => {
  const user = userEvent.setup();
  const { api, emit } = drivenApi();
  render(<Harness api={api} />);
  await user.click(screen.getByRole("button", { name: "start" }));
  await act(() => new Promise((r) => setTimeout(r, 0)));

  const base = {
    ts: 1,
    toolUseId: "write-denied",
    tool: "Write",
    input: { path: "out.csv" },
  };
  await act(async () => {
    emit({ event: "log-entry", entry: { ...base, decision: "pending", isError: false } });
    emit({ event: "log-entry", entry: { ...base, decision: "denied", isError: true } });
  });
  expect(screen.getAllByTestId("log-entry")).toHaveLength(1);
  expect(screen.getByTestId("log-entry")).toHaveTextContent("write-denied:denied::true");

  await act(async () => {
    emit({
      event: "log-entry",
      entry: { ...base, decision: "denied", result: "permission denied", isError: true },
    });
  });
  expect(screen.getAllByTestId("log-entry")).toHaveLength(1);
  expect(screen.getByTestId("log-entry")).toHaveTextContent(
    "write-denied:denied:permission denied:true",
  );
  expect(screen.getByTestId("live-stream")).toHaveTextContent(
    "step:write-denied:denied:permission denied",
  );
});

it("tracks live plan-step status and the Reviewing phase", async () => {
  const user = userEvent.setup();
  const { api, emit } = drivenApi();
  render(<Harness api={api} />);
  await user.click(screen.getByRole("button", { name: "start" }));
  await act(() => new Promise((r) => setTimeout(r, 0)));

  // A live executing snapshot with per-step status → the strip's current step.
  const plan = {
    steps: [
      { title: "a", done: true, status: "completed" as const },
      { title: "b", done: false, status: "in_progress" as const },
      { title: "c", done: false, status: "pending" as const },
    ],
    raw: "",
  };
  await act(async () => {
    emit({ event: "state", state: { state: "executing", plan } });
  });
  expect(screen.getByTestId("plan-status")).toHaveTextContent(
    "completed,in_progress,pending",
  );
  expect(screen.getByTestId("reviewing")).toHaveTextContent("false");

  // The Reviewer phase flips on, then clears when the run lands.
  await act(async () => {
    emit({ event: "reviewing" });
  });
  expect(screen.getByTestId("reviewing")).toHaveTextContent("true");

  await act(async () => {
    emit({ event: "completed", state: { state: "completed" } });
  });
  expect(screen.getByTestId("reviewing")).toHaveTextContent("false");
});

describe("cancel's late-completion watch", () => {
  // The grace period itself is judged by the daemon (`session.ts`'s
  // `cancelTurn`), not here — this surface only ever watches for whatever
  // `completed` frame the turn's own ending eventually carries and adopts
  // it verbatim. No client-side clock is involved, so none of these tests
  // touch fake timers.

  it("adopts an ordinary confirmed stop, unflagged, from a completed frame that arrives after Stop", async () => {
    const { api, emit, closeCount } = multiSubApi();
    render(<Harness api={api} />);

    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    // The surface returns at once — the researcher never waits on this.
    expect(screen.getByTestId("state")).toHaveTextContent("cancelled");
    expect(screen.getByTestId("unacknowledged")).toHaveTextContent("false");
    expect(closeCount()).toBe(0);

    // The turn's own genuine ending arrives afterward, confirmed.
    await act(async () => {
      emit({ event: "completed", state: { state: "cancelled" } });
    });

    expect(screen.getByTestId("state")).toHaveTextContent("cancelled");
    expect(screen.getByTestId("unacknowledged")).toHaveTextContent("false");
    expect(closeCount()).toBe(0);
  });

  it("flags the turn unacknowledged when the late completed frame says so", async () => {
    // Stands in for the daemon's own grace running out on the adapter —
    // from this surface's point of view, it is just another completed
    // frame, adopted exactly as it arrives.
    const { api, emit } = multiSubApi();
    render(<Harness api={api} />);

    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    expect(screen.getByTestId("unacknowledged")).toHaveTextContent("false");

    await act(async () => {
      emit({
        event: "completed",
        state: { state: "cancelled", unacknowledged: true },
      });
    });

    expect(screen.getByTestId("state")).toHaveTextContent("cancelled");
    expect(screen.getByTestId("unacknowledged")).toHaveTextContent("true");
  });

  it("adopts a completed frame that arrives after Stop, since the turn genuinely finished despite the request to stop it", async () => {
    // A deliberate choice, not a side effect: the surface reports whatever
    // the turn actually landed as, even once the researcher has already
    // moved on from having asked it to stop. An adapter that was already
    // nearly done may simply finish rather than report `cancelled`, and
    // "Run stopped" would misdescribe a turn that produced a real result.
    const { api, emit } = multiSubApi();
    render(<Harness api={api} />);

    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    expect(screen.getByTestId("state")).toHaveTextContent("cancelled");

    await act(async () => {
      emit({ event: "completed", state: { state: "completed" } });
    });

    expect(screen.getByTestId("state")).toHaveTextContent("completed");
  });

  it("adopts a failed frame that arrives after Stop, for the same reason", async () => {
    // A researcher who stopped a turn that then genuinely failed for its
    // own reasons must be told it failed, not left reading "Run stopped"
    // over an error the request to stop had nothing to do with.
    const { api, emit } = multiSubApi();
    render(<Harness api={api} />);

    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(screen.getByRole("button", { name: "stop" }));

    await act(async () => {
      emit({ event: "completed", state: { state: "failed", reason: "boom" } });
    });

    expect(screen.getByTestId("state")).toHaveTextContent("failed");
  });

  it("does not close a stopped turn when another turn starts", async () => {
    const { api, closeCount } = multiSubApi();
    render(<Harness api={api} />);

    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    fireEvent.click(screen.getByRole("button", { name: "stop" }));
    expect(screen.getByTestId("state")).toHaveTextContent("cancelled");
    // The watch is still open — nothing has closed the handle yet, since no
    // completed frame for the stopped turn has arrived.
    expect(closeCount()).toBe(0);

    // A new turn starts before the old one's own ending ever arrives. It is a
    // sibling now, not a reason to cancel/close the older turn.
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(closeCount()).toBe(0);
    expect(screen.getByTestId("unacknowledged")).toHaveTextContent("false");
  });

  it("accepts a completed frame delivered synchronously on subscribe", async () => {
    // Neither of this codebase's own RunHandles do this today, but the
    // contract's `onEvent` doc never rules it out — and delivering it
    // synchronously, inside the very `handle.onEvent` call the watcher
    // registers with, races the assignment of that call's own return value.
    let subscribeCount = 0;
    let unsubscribeCalls = 0;
    let closes = 0;
    const handle: RunHandle = {
      runId: "run-sync",
      onEvent(cb) {
        subscribeCount += 1;
        if (subscribeCount === 1) {
          cb(initialSnapshot("run-sync"));
          cb({ event: "completed", state: { state: "completed" } });
        }
        return () => {
          unsubscribeCalls += 1;
        };
      },
      submit() {},
      detach() {},
      close() {
        closes += 1;
      },
    };
    const api = {
      startRun: (_input: StartRunInput) => Promise.resolve(handle),
      listMembers: () => Promise.resolve([]),
    } as unknown as LykeionApi;

    const view = render(<Harness api={api} />);
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    await act(() => new Promise((r) => setTimeout(r, 0)));
    expect(screen.getByTestId("state")).toHaveTextContent("completed");
    view.unmount();
    expect(unsubscribeCalls).toBe(1);
    expect(closes).toBe(0);
  });
});

describe("planOf", () => {
  it("keeps the sticky plan when a permission card has no plan", () => {
    // A gate raised during planning serialises without `plan`.
    expect(
      planOf({
        state: "awaiting-permission",
        request: {
          id: "perm-1",
          access: { kind: "read-path", target: "." },
          tool: "Read",
        },
      }),
    ).toBeNull();
  });
});
