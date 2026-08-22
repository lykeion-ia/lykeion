import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryApi,
  type ActiveRunSnapshot,
  type LykeionApi,
  type ResumedRun,
  type RunEvent,
  type RunHandle,
  type TaskDetail,
  type TaskTurn,
} from "@lykeion/api";
import { ApiProvider } from "../api/ApiContext";
import { stashRun } from "../lib/pending-run";
import { useTaskRun } from "./useTaskRun";

afterEach(cleanup);

const activeSnapshot = (runId = "run-live"): ActiveRunSnapshot => ({
  runId,
  sequence: 3,
  origin: "user",
  prompt: "resume this turn",
  agent: "claude",
  state: { state: "executing", plan: { steps: [], raw: "" } },
  stream: [{ kind: "text", text: "working" }],
  live: {},
  reviewing: false,
  lastEventSeq: 2,
});

function recoverable(snapshot: ActiveRunSnapshot) {
  const subscribers = new Set<(event: RunEvent) => void>();
  const detach = vi.fn(() => subscribers.clear());
  const handle: ResumedRun = {
    runId: snapshot.runId,
    snapshot,
    onEvent(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    submit() {},
    detach,
    close() {},
  };
  return {
    handle,
    detach,
    emit(event: RunEvent) {
      act(() => subscribers.forEach((cb) => cb(event)));
    },
    emitBeforeCommit(event: RunEvent) {
      subscribers.forEach((cb) => cb(event));
    },
  };
}

const wrapper = (api: LykeionApi) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <ApiProvider api={api}>{children}</ApiProvider>;
  };

describe("Task transcript recovery", () => {
  it("subscribes before history and lets a settled race replace only its live block", async () => {
    const base = createInMemoryApi();
    const original = await base.getTask("t_3");
    const resumed = recoverable(activeSnapshot());
    const order: string[] = [];
    let resolveHistory!: (detail: TaskDetail) => void;
    const settledTurn: TaskTurn = {
      runId: "run-live",
      origin: "user",
      sequence: 3,
      ts: 30,
      prompt: "resume this turn",
      messages: ["persisted answer"],
      stream: [{ kind: "text", text: "persisted answer" }],
      status: "ok",
      code: [],
      outputs: [],
    };
    const api: LykeionApi = {
      ...base,
      async resumeRuns() {
        order.push("resume");
        const originalOnEvent = resumed.handle.onEvent;
        resumed.handle.onEvent = (cb) => {
          order.push("subscribe");
          return originalOnEvent(cb);
        };
        return [resumed.handle];
      },
      getTask() {
        order.push("history");
        return new Promise<TaskDetail>((resolve) => {
          resolveHistory = resolve;
        });
      },
    };

    const { result } = renderHook(
      () => useTaskRun("s_cmp", "t_3"),
      { wrapper: wrapper(api) },
    );
    await waitFor(() => expect(order).toEqual(["resume", "subscribe", "history"]));
    expect(result.current.run.runs.map((run) => run.runId)).toEqual([
      "run-live",
    ]);

    resumed.emit({ event: "completed", state: { state: "completed" } });
    await act(async () =>
      resolveHistory({ ...original, turns: [...original.turns, settledTurn] }),
    );

    await waitFor(() =>
      expect(result.current.history.map((turn) => turn.runId)).toContain(
        "run-live",
      ),
    );
    expect(result.current.run.runs).toEqual([]);
    expect(
      result.current.history.filter((turn) => turn.runId === "run-live"),
    ).toHaveLength(1);
  });

  it("retains cancellation status when history reconciles before the terminal render commits", async () => {
    const base = createInMemoryApi();
    const original = await base.getTask("t_3");
    const resumed = recoverable(activeSnapshot("run-race-cancelled"));
    let resolveHistory!: (detail: TaskDetail) => void;
    const settledTurn: TaskTurn = {
      runId: "run-race-cancelled",
      origin: "user",
      sequence: 3,
      ts: 30,
      prompt: "resume this turn",
      messages: [],
      status: "failed",
      code: [],
      outputs: [],
    };
    const api: LykeionApi = {
      ...base,
      resumeRuns: async () => [resumed.handle],
      getTask: () =>
        new Promise<TaskDetail>((resolve) => {
          resolveHistory = resolve;
        }),
    };
    const { result } = renderHook(() => useTaskRun("s_cmp", "t_3"), {
      wrapper: wrapper(api),
    });
    await waitFor(() => expect(result.current.run.runs).toHaveLength(1));

    await act(async () => {
      resumed.emitBeforeCommit({
        event: "completed",
        state: { state: "cancelled" },
      });
      resolveHistory({ ...original, turns: [...original.turns, settledTurn] });
      await Promise.resolve();
    });

    expect(result.current.run.runs).toEqual([]);
    expect(result.current.terminalStatusByRunId["run-race-cancelled"]).toEqual(
      { state: "cancelled" },
    );
  });

  it("retains a terminal block when its completion refresh fails", async () => {
    const base = createInMemoryApi();
    const original = await base.getTask("t_3");
    const resumed = recoverable(activeSnapshot("run-retained"));
    let reads = 0;
    const onTasksChanged = vi.fn();
    const api: LykeionApi = {
      ...base,
      resumeRuns: async () => [resumed.handle],
      getTask: async () => {
        reads += 1;
        if (reads === 1) return original;
        throw new Error("history unavailable");
      },
    };
    const { result } = renderHook(
      () => useTaskRun("s_cmp", "t_3", onTasksChanged),
      { wrapper: wrapper(api) },
    );
    await waitFor(() =>
      expect(result.current.run.runs.map((run) => run.runId)).toEqual([
        "run-retained",
      ]),
    );

    resumed.emit({ event: "completed", state: { state: "completed" } });

    await waitFor(() => expect(reads).toBe(2));
    expect(resumed.detach).toHaveBeenCalledTimes(1);
    expect(onTasksChanged).toHaveBeenCalledTimes(1);
    expect(result.current.run.runs).toHaveLength(1);
    expect(result.current.run.runs[0]?.state.state).toBe("completed");
    expect(result.current.history).toEqual(original.turns);
  });

  it("promotes partial-only live prose into a retained terminal stream when history refresh fails", async () => {
    const base = createInMemoryApi();
    const original = await base.getTask("t_3");
    const resumed = recoverable(activeSnapshot("run-partial-only"));
    let reads = 0;
    const api: LykeionApi = {
      ...base,
      resumeRuns: async () => [resumed.handle],
      getTask: async () => {
        reads += 1;
        if (reads === 1) return original;
        throw new Error("history unavailable");
      },
    };
    const { result } = renderHook(
      () => useTaskRun("s_cmp", "t_3"),
      { wrapper: wrapper(api) },
    );
    await waitFor(() => expect(result.current.run.runs).toHaveLength(1));

    resumed.emit({
      event: "assistant-text",
      text: "partial ",
      partial: true,
    });
    resumed.emit({ event: "live", live: { text: "partial " } });
    resumed.emit({
      event: "assistant-text",
      text: "only",
      partial: true,
    });
    resumed.emit({ event: "live", live: { text: "partial only" } });
    resumed.emit({
      event: "completed",
      state: { state: "completed" },
      run: {
        runId: "run-partial-only",
        ts: 1,
        command: "resume this turn",
        status: "ok",
        code: [],
        outputs: [],
        stream: [{ kind: "text", text: "working" }],
      },
    });

    await waitFor(() => expect(reads).toBe(2));
    expect(result.current.run.runs).toHaveLength(1);
    expect(
      result.current.run.runs[0]?.stream.map((item) =>
        item.kind === "text" ? `text:${item.text}` : "step",
      ),
    ).toEqual(["text:working", "text:partial only"]);
    expect(
      result.current.run.runs[0]?.run?.stream?.map((item) =>
        item.kind === "text" ? `text:${item.text}` : "step",
      ),
    ).toEqual(["text:working", "text:partial only"]);
    expect(result.current.run.runs[0]?.live).toEqual({});
  });

  it("preserves the full unacknowledged cancellation presentation through reconciliation", async () => {
    const base = createInMemoryApi();
    const original = await base.getTask("t_3");
    const resumed = recoverable(activeSnapshot("run-unacknowledged"));
    const settledTurn: TaskTurn = {
      runId: "run-unacknowledged",
      origin: "user",
      sequence: 3,
      ts: 30,
      prompt: "resume this turn",
      messages: [],
      status: "failed",
      code: [],
      outputs: [],
    };
    let reads = 0;
    const api: LykeionApi = {
      ...base,
      resumeRuns: async () => [resumed.handle],
      getTask: async () => {
        reads += 1;
        return reads === 1
          ? original
          : { ...original, turns: [...original.turns, settledTurn] };
      },
    };
    const { result } = renderHook(
      () => useTaskRun("s_cmp", "t_3"),
      { wrapper: wrapper(api) },
    );
    await waitFor(() => expect(result.current.run.runs).toHaveLength(1));

    resumed.emit({
      event: "completed",
      state: { state: "cancelled", unacknowledged: true },
    });

    await waitFor(() => expect(result.current.run.runs).toHaveLength(0));
    expect(result.current.terminalStatusByRunId["run-unacknowledged"]).toEqual(
      { state: "cancelled", unacknowledged: true },
    );
  });

  it("keeps recovery unresolved and a pending handoff parked until retry succeeds", async () => {
    const base = createInMemoryApi();
    const startHandle: RunHandle = {
      runId: "run-after-recovery",
      onEvent() {
        return () => {};
      },
      submit() {},
      detach() {},
      close() {},
    };
    stashRun("t_3", {
      prompt: "park this handoff",
      planMode: false,
      agent: "claude",
      model: null,
    });
    let attempts = 0;
    const api: LykeionApi = {
      ...base,
      resumeRuns: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("recovery unavailable");
        return [];
      }),
      startRun: vi.fn(async () => startHandle),
    };
    const { result } = renderHook(
      () => useTaskRun("s_cmp", "t_3"),
      { wrapper: wrapper(api) },
    );

    await waitFor(() =>
      expect(result.current.recoveryError).toContain("recovery unavailable"),
    );
    expect(result.current.recoveryReady).toBe(false);
    expect(api.startRun).not.toHaveBeenCalled();

    act(() => result.current.retryRecovery());

    await waitFor(() => expect(result.current.recoveryReady).toBe(true));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(1));
    expect(api.resumeRuns).toHaveBeenCalledTimes(2);
    expect(api.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "park this handoff" }),
    );
  });

  it("serializes sibling completion refreshes so a later settlement cannot discard an earlier success", async () => {
    const base = createInMemoryApi();
    const original = await base.getTask("t_3");
    const first = recoverable(activeSnapshot("run-first"));
    const second = recoverable({
      ...activeSnapshot("run-second"),
      sequence: 4,
    });
    let reads = 0;
    let resolveFirstRefresh!: (detail: TaskDetail) => void;
    const firstTurn: TaskTurn = {
      runId: "run-first",
      origin: "user",
      sequence: 3,
      ts: 30,
      prompt: "resume this turn",
      messages: ["first persisted"],
      status: "ok",
      code: [],
      outputs: [],
    };
    const api: LykeionApi = {
      ...base,
      resumeRuns: async () => [first.handle, second.handle],
      getTask: async () => {
        reads += 1;
        if (reads === 1) return original;
        if (reads === 2) {
          return new Promise<TaskDetail>((resolve) => {
            resolveFirstRefresh = resolve;
          });
        }
        throw new Error("second refresh unavailable");
      },
    };
    const { result } = renderHook(
      () => useTaskRun("s_cmp", "t_3"),
      { wrapper: wrapper(api) },
    );
    await waitFor(() => expect(result.current.run.runs).toHaveLength(2));

    first.emit({ event: "completed", state: { state: "completed" } });
    await waitFor(() => expect(reads).toBe(2));
    second.emit({ event: "completed", state: { state: "completed" } });
    await act(async () =>
      resolveFirstRefresh({ ...original, turns: [...original.turns, firstTurn] }),
    );

    await waitFor(() => expect(reads).toBe(3));
    expect(result.current.run.runs.map((run) => run.runId)).toEqual([
      "run-second",
    ]);
    expect(result.current.history.map((turn) => turn.runId)).toContain(
      "run-first",
    );
  });

  it("ignores an on-demand refresh that resolves after the Task changes", async () => {
    const base = createInMemoryApi();
    const firstDetail = await base.getTask("t_3");
    const secondDetail = await base.getTask("t_4");
    const currentTurn: TaskTurn = {
      runId: "run-current-task",
      origin: "user",
      sequence: 1,
      ts: 40,
      prompt: "current Task prompt",
      messages: ["current Task answer"],
      status: "ok",
      code: [],
      outputs: [],
    };
    const staleTurn: TaskTurn = {
      runId: "run-stale-task",
      origin: "user",
      sequence: 9,
      ts: 90,
      prompt: "stale Task prompt",
      messages: ["stale Task answer"],
      status: "ok",
      code: [],
      outputs: [],
    };
    let firstReads = 0;
    let resolveStaleRefresh!: (detail: TaskDetail) => void;
    const api: LykeionApi = {
      ...base,
      resumeRuns: async () => [],
      getTask(taskId) {
        if (taskId === "t_3") {
          firstReads += 1;
          if (firstReads === 1) return Promise.resolve(firstDetail);
          return new Promise<TaskDetail>((resolve) => {
            resolveStaleRefresh = resolve;
          });
        }
        return Promise.resolve({ ...secondDetail, turns: [currentTurn] });
      },
    };
    const { result, rerender } = renderHook(
      ({ taskId }) => useTaskRun("s_cmp", taskId),
      {
        initialProps: { taskId: "t_3" },
        wrapper: wrapper(api),
      },
    );
    await waitFor(() => expect(firstReads).toBe(1));

    act(() => result.current.refresh());
    await waitFor(() => expect(firstReads).toBe(2));
    rerender({ taskId: "t_4" });
    await waitFor(() =>
      expect(result.current.history.map((turn) => turn.runId)).toEqual([
        "run-current-task",
      ]),
    );

    await act(async () =>
      resolveStaleRefresh({ ...firstDetail, turns: [staleTurn] }),
    );
    expect(result.current.history.map((turn) => turn.runId)).toEqual([
      "run-current-task",
    ]);
    expect(result.current.run.runs).toEqual([]);
  });
});
