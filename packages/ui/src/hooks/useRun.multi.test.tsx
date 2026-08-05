import { StrictMode, useEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ActiveRunSnapshot,
  LykeionApi,
  ResumedRun,
  RunDecision,
  RunEvent,
  RunHandle,
} from "@lykeion/api";
import { createInMemoryApi } from "@lykeion/api";
import { ApiProvider } from "../api/ApiContext";
import { useRun } from "./useRun";

afterEach(cleanup);

const snapshot = (
  runId: string,
  sequence: number,
  agent: string,
  prompt: string,
): ActiveRunSnapshot => ({
  runId,
  sequence,
  agent,
  prompt,
  state: { state: "executing", plan: { steps: [], raw: "" } },
  stream: [{ kind: "text", text: `${prompt} snapshot` }],
  live: { text: `${prompt} live` },
  reviewing: false,
  lastEventSeq: 4,
});

function resumedHandle(initial: ActiveRunSnapshot) {
  const subscribers = new Set<(event: RunEvent) => void>();
  const submitted: RunDecision[] = [];
  const detach = vi.fn(() => subscribers.clear());
  const close = vi.fn(() => subscribers.clear());
  const handle: ResumedRun = {
    runId: initial.runId,
    snapshot: initial,
    onEvent(cb) {
      subscribers.add(cb);
      queueMicrotask(() => cb({ event: "snapshot", snapshot: initial }));
      return () => subscribers.delete(cb);
    },
    submit(decision) {
      submitted.push(decision);
    },
    detach,
    close,
  };
  return {
    handle,
    submitted,
    detach,
    close,
    emit(event: RunEvent) {
      act(() => subscribers.forEach((cb) => cb(event)));
    },
  };
}

function manualHandle(runId: string) {
  const subscribers = new Set<(event: RunEvent) => void>();
  const detach = vi.fn(() => subscribers.clear());
  const handle: RunHandle = {
    runId,
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
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function Probe({ taskId = "task-a" }: { taskId?: string }) {
  const manager = useRun("study-a", { taskId });
  useEffect(() => {
    void manager.resume();
  }, [manager.resume]);
  return (
    <div>
      <span data-testid="starting">{String(manager.starting)}</span>
      {manager.runs.map((run) => (
        <section key={run.runId} data-testid={`run-${run.runId}`}>
          <span>{run.sequence}</span>
          <span>{run.agent}</span>
          <span>{run.prompt}</span>
          <span data-testid={`state-${run.runId}`}>{run.state.state}</span>
          <span data-testid={`stream-${run.runId}`}>
            {run.stream
              .map((item) =>
                item.kind === "text" ? item.text : item.entry.toolUseId,
              )
              .join("|")}
          </span>
          <span data-testid={`live-${run.runId}`}>{run.live.text ?? ""}</span>
          <button type="button" onClick={run.approvePlan}>
            approve {run.runId}
          </button>
          <button type="button" onClick={run.cancel}>
            stop {run.runId}
          </button>
        </section>
      ))}
    </div>
  );
}

describe("the keyed Task run manager", () => {
  it.each(["resume-first", "start-first"] as const)(
    "keeps an authoritative recovered entry when a same-run start resolves %s",
    async (promiseOrder) => {
      const resumeResult = deferred<ResumedRun[]>();
      const startResult = deferred<RunHandle>();
      const authoritative = resumedHandle({
        ...snapshot("run-shared", 17, "claude", "authoritative prompt"),
        state: {
          state: "awaiting-permission",
          request: {
            id: "permission-shared",
            access: { kind: "read-path", target: "results.csv" },
            tool: "Read",
          },
        },
      });
      const provisional = manualHandle("run-shared");
      const api = {
        ...createInMemoryApi(),
        resumeRuns: vi.fn(() => resumeResult.promise),
        startRun: vi.fn(() => startResult.promise),
      } as unknown as LykeionApi;

      function RaceProbe() {
        const manager = useRun("study-a", { taskId: "task-a" });
        useEffect(() => {
          void manager.resume();
        }, [manager.resume]);
        const run = manager.runs[0];
        return (
          <div>
            <button
              type="button"
              onClick={() => manager.start("provisional prompt", { agent: "codex" })}
            >
              start
            </button>
            <span data-testid="race-starting">{String(manager.starting)}</span>
            <span data-testid="race-sequence">{run?.sequence ?? "none"}</span>
            <span data-testid="race-prompt">{run?.prompt ?? "none"}</span>
            <span data-testid="race-state">{run?.state.state ?? "none"}</span>
          </div>
        );
      }

      const user = userEvent.setup();
      render(
        <ApiProvider api={api}>
          <RaceProbe />
        </ApiProvider>,
      );
      await waitFor(() => expect(api.resumeRuns).toHaveBeenCalledTimes(1));
      await user.click(screen.getByRole("button", { name: "start" }));

      if (promiseOrder === "resume-first") {
        await act(async () => resumeResult.resolve([authoritative.handle]));
        await waitFor(() =>
          expect(screen.getByTestId("race-prompt")).toHaveTextContent(
            "authoritative prompt",
          ),
        );
        await act(async () => startResult.resolve(provisional.handle));
      } else {
        await act(async () => startResult.resolve(provisional.handle));
        await waitFor(() =>
          expect(screen.getByTestId("race-starting")).toHaveTextContent("false"),
        );
        await act(async () => resumeResult.resolve([authoritative.handle]));
      }

      await waitFor(() =>
        expect(screen.getByTestId("race-state")).toHaveTextContent(
          "awaiting-permission",
        ),
      );
      expect(screen.getByTestId("race-sequence")).toHaveTextContent("17");
      expect(screen.getByTestId("race-prompt")).toHaveTextContent(
        "authoritative prompt",
      );
      expect(provisional.detach).toHaveBeenCalledTimes(1);
      expect(authoritative.detach).not.toHaveBeenCalled();

      // A late frame from the losing start handle must be inert. In the
      // start-first ordering this specifically proves recovery replaced that
      // observer instead of only replacing the reducer entry for one render.
      provisional.emit({
        event: "snapshot",
        snapshot: snapshot(
          "run-shared",
          99,
          "codex",
          "late provisional snapshot",
        ),
      });
      expect(screen.getByTestId("race-state")).toHaveTextContent(
        "awaiting-permission",
      );
      expect(screen.getByTestId("race-sequence")).toHaveTextContent("17");
      expect(screen.getByTestId("race-prompt")).toHaveTextContent(
        "authoritative prompt",
      );
    },
  );

  it("keeps a newer fresh snapshot and later frame when an older recovered duplicate resolves", async () => {
    const resumeResult = deferred<ResumedRun[]>();
    const startResult = deferred<RunHandle>();
    const staleRecovered = resumedHandle({
      ...snapshot("run-shared-newer", 21, "claude", "captured recovery"),
      state: { state: "planning" },
      stream: [{ kind: "text", text: "stale recovered text" }],
      lastEventSeq: 1,
    });
    const fresh = manualHandle("run-shared-newer");
    const api = {
      ...createInMemoryApi(),
      resumeRuns: vi.fn(() => resumeResult.promise),
      startRun: vi.fn(() => startResult.promise),
    } as unknown as LykeionApi;

    function NewerFreshProbe() {
      const manager = useRun("study-a", { taskId: "task-a" });
      useEffect(() => {
        void manager.resume();
      }, [manager.resume]);
      const run = manager.runs[0];
      return (
        <div>
          <button type="button" onClick={() => manager.start("fresh prompt")}>
            start newer fresh
          </button>
          <span data-testid="newer-state">{run?.state.state ?? "none"}</span>
          <span data-testid="newer-stream">
            {run?.stream
              .map((item) =>
                item.kind === "text" ? item.text : item.entry.toolUseId,
              )
              .join("|") ?? ""}
          </span>
        </div>
      );
    }

    const user = userEvent.setup();
    render(
      <ApiProvider api={api}>
        <NewerFreshProbe />
      </ApiProvider>,
    );
    await waitFor(() => expect(api.resumeRuns).toHaveBeenCalledTimes(1));
    await user.click(
      screen.getByRole("button", { name: "start newer fresh" }),
    );
    await act(async () => startResult.resolve(fresh.handle));

    fresh.emit({
      event: "snapshot",
      snapshot: {
        ...snapshot("run-shared-newer", 21, "codex", "fresh prompt"),
        state: { state: "executing", plan: { steps: [], raw: "" } },
        stream: [{ kind: "text", text: "fresh snapshot text" }],
        lastEventSeq: 3,
      },
    });
    fresh.emit({
      event: "assistant-text",
      text: "fresh later frame",
      partial: false,
    });
    expect(screen.getByTestId("newer-state")).toHaveTextContent("executing");
    expect(screen.getByTestId("newer-stream")).toHaveTextContent(
      "fresh snapshot text|fresh later frame",
    );

    await act(async () => resumeResult.resolve([staleRecovered.handle]));

    expect(screen.getByTestId("newer-state")).toHaveTextContent("executing");
    expect(screen.getByTestId("newer-stream")).toHaveTextContent(
      "fresh snapshot text|fresh later frame",
    );
    expect(fresh.detach).not.toHaveBeenCalled();
    expect(staleRecovered.detach).toHaveBeenCalledTimes(1);
  });

  it("waits for a fresh run's authoritative snapshot instead of guessing its durable sequence", async () => {
    const startResult = deferred<RunHandle>();
    const fresh = manualHandle("run-fresh");
    const api = {
      ...createInMemoryApi(),
      resumeRuns: vi.fn(async () => []),
      startRun: vi.fn(() => startResult.promise),
    } as unknown as LykeionApi;

    function FreshProbe() {
      const manager = useRun("study-a", { taskId: "task-a" });
      return (
        <div>
          <button type="button" onClick={() => manager.start("fresh prompt")}>
            start fresh
          </button>
          <span data-testid="fresh-starting">{String(manager.starting)}</span>
          {manager.runs.map((run) => (
            <span key={run.runId} data-testid="fresh-run">
              {run.sequence}:{run.prompt}
            </span>
          ))}
        </div>
      );
    }

    const user = userEvent.setup();
    render(
      <ApiProvider api={api}>
        <FreshProbe />
      </ApiProvider>,
    );
    await user.click(screen.getByRole("button", { name: "start fresh" }));
    await act(async () => startResult.resolve(fresh.handle));
    await waitFor(() =>
      expect(screen.getByTestId("fresh-starting")).toHaveTextContent("false"),
    );

    expect(screen.queryByTestId("fresh-run")).not.toBeInTheDocument();

    fresh.emit({
      event: "snapshot",
      snapshot: snapshot("run-fresh", 42, "claude", "server prompt"),
    });
    expect(await screen.findByTestId("fresh-run")).toHaveTextContent(
      "42:server prompt",
    );
  });

  it("releases a handle on a terminal authoritative snapshot without removing its terminal state", async () => {
    const terminal = resumedHandle(
      snapshot("run-terminal", 8, "claude", "terminal prompt"),
    );
    const api = {
      ...createInMemoryApi(),
      resumeRuns: vi.fn(async () => [terminal.handle]),
    } as unknown as LykeionApi;
    render(
      <ApiProvider api={api}>
        <Probe />
      </ApiProvider>,
    );
    await screen.findByTestId("run-run-terminal");

    terminal.emit({
      event: "snapshot",
      snapshot: {
        ...snapshot("run-terminal", 8, "claude", "terminal prompt"),
        state: { state: "cancelled", unacknowledged: true },
      },
    });

    expect(screen.getByTestId("state-run-terminal")).toHaveTextContent(
      "cancelled",
    );
    expect(screen.getByTestId("run-run-terminal")).toBeInTheDocument();
    expect(terminal.detach).toHaveBeenCalledTimes(1);
  });

  it("hydrates two runs, replaces one from a snapshot, and keeps later events independent", async () => {
    const first = resumedHandle(snapshot("run-a", 3, "claude", "alpha"));
    const second = resumedHandle(snapshot("run-b", 4, "codex", "beta"));
    const api = {
      ...createInMemoryApi(),
      resumeRuns: vi.fn(async () => [first.handle, second.handle]),
    } as unknown as LykeionApi;
    const user = userEvent.setup();
    render(
      <ApiProvider api={api}>
        <Probe />
      </ApiProvider>,
    );

    await screen.findByTestId("run-run-a");
    expect(screen.getByTestId("run-run-b")).toBeInTheDocument();
    expect(screen.getByTestId("stream-run-a")).toHaveTextContent(
      "alpha snapshot",
    );
    expect(screen.getByTestId("stream-run-b")).toHaveTextContent(
      "beta snapshot",
    );

    first.emit({
      event: "snapshot",
      snapshot: {
        ...snapshot("run-a", 3, "claude", "alpha"),
        stream: [{ kind: "text", text: "authoritative" }],
        live: {},
        lastEventSeq: 7,
      },
    });
    first.emit({
      event: "assistant-text",
      text: "later once",
      partial: false,
    });

    expect(screen.getByTestId("stream-run-a")).toHaveTextContent(
      "authoritative|later once",
    );
    expect(screen.getByTestId("stream-run-a")).not.toHaveTextContent(
      "alpha snapshot",
    );
    expect(screen.getByTestId("stream-run-b")).toHaveTextContent(
      "beta snapshot",
    );

    await user.click(screen.getByRole("button", { name: "approve run-b" }));
    await user.click(screen.getByRole("button", { name: "stop run-a" }));
    expect(second.submitted).toEqual([{ action: "approve-plan" }]);
    expect(first.submitted).toEqual([{ action: "cancel" }]);
    expect(screen.getByTestId("run-run-b")).toBeInTheDocument();
  });

  it("detaches every observer on StrictMode cleanup without cancelling", async () => {
    const handles: ReturnType<typeof resumedHandle>[] = [];
    const api = {
      ...createInMemoryApi(),
      resumeRuns: vi.fn(async () => {
        const next = resumedHandle(snapshot("run-a", 1, "claude", "alpha"));
        handles.push(next);
        return [next.handle];
      }),
    } as unknown as LykeionApi;

    const view = render(
      <StrictMode>
        <ApiProvider api={api}>
          <Probe />
        </ApiProvider>
      </StrictMode>,
    );
    await waitFor(() => expect(api.resumeRuns).toHaveBeenCalled());
    await screen.findByTestId("run-run-a");
    view.unmount();

    await waitFor(() =>
      expect(handles.every((run) => run.detach.mock.calls.length > 0)).toBe(
        true,
      ),
    );
    expect(handles.every((run) => run.close.mock.calls.length === 0)).toBe(
      true,
    );
    expect(handles.flatMap((run) => run.submitted)).toEqual([]);
  });

  it("detaches a stale resume response after the Task changes", async () => {
    const stale = resumedHandle(snapshot("run-old", 1, "claude", "old"));
    let resolveOld!: (runs: ResumedRun[]) => void;
    const api = {
      ...createInMemoryApi(),
      resumeRuns: vi.fn((taskId: string) => {
        if (taskId === "task-a") {
          return new Promise<ResumedRun[]>((resolve) => {
            resolveOld = resolve;
          });
        }
        return Promise.resolve([]);
      }),
    } as unknown as LykeionApi;
    const view = render(
      <ApiProvider api={api}>
        <Probe taskId="task-a" />
      </ApiProvider>,
    );
    await waitFor(() => expect(api.resumeRuns).toHaveBeenCalledWith("task-a"));

    view.rerender(
      <ApiProvider api={api}>
        <Probe taskId="task-b" />
      </ApiProvider>,
    );
    await act(async () => resolveOld([stale.handle]));

    expect(stale.detach).toHaveBeenCalledTimes(1);
    expect(stale.close).not.toHaveBeenCalled();
    expect(screen.queryByTestId("run-run-old")).not.toBeInTheDocument();
  });

  it("re-enables starts after each handle arrives and never replaces siblings", async () => {
    const handles: RunHandle[] = [];
    const resolvers: Array<(handle: RunHandle) => void> = [];
    const api = {
      ...createInMemoryApi(),
      resumeRuns: vi.fn(async () => []),
      startRun: vi.fn(
        () =>
          new Promise<RunHandle>((resolve) => {
            resolvers.push(resolve);
          }),
      ),
    } as unknown as LykeionApi;

    function StartProbe() {
      const manager = useRun("study-a", { taskId: "task-a" });
      return (
        <div>
          <span data-testid="starting">{String(manager.starting)}</span>
          <span data-testid="run-ids">
            {manager.runs.map((run) => run.runId).join(",")}
          </span>
          <button
            type="button"
            disabled={manager.starting}
            onClick={() => manager.start(`prompt-${resolvers.length + 1}`, { agent: "claude" })}
          >
            send
          </button>
        </div>
      );
    }
    const user = userEvent.setup();
    render(
      <ApiProvider api={api}>
        <StartProbe />
      </ApiProvider>,
    );

    await user.click(screen.getByRole("button", { name: "send" }));
    expect(screen.getByTestId("starting")).toHaveTextContent("true");
    const first = resumedHandle(snapshot("run-new-a", 1, "claude", "first"));
    handles.push(first.handle);
    await act(async () => resolvers[0]!(first.handle));
    expect(screen.getByTestId("starting")).toHaveTextContent("false");

    await user.click(screen.getByRole("button", { name: "send" }));
    const second = resumedHandle(snapshot("run-new-b", 2, "codex", "second"));
    handles.push(second.handle);
    await act(async () => resolvers[1]!(second.handle));

    expect(screen.getByTestId("run-ids")).toHaveTextContent(
      "run-new-a,run-new-b",
    );
  });
});
