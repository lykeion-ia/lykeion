import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryApi,
  type ActiveRunSnapshot,
  type AgentCli,
  type LykeionApi,
  type ResumedRun,
  type RunDecision,
  type RunEvent,
  type RunHandle,
  type TaskDetail,
  type TaskTurn,
} from "@lykeion/api";
import App from "../App";
import { stashRun } from "../lib/pending-run";
import { currentTaskStatus } from "../test/task-row-menu";

afterEach(cleanup);

const ROUTE = "#/studies/s_cmp/tasks/t_3";
const CMP5_TITLE = "Fit orientation tuning curves per neuron";

const CLIS: AgentCli[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    version: "1",
    available: true,
    machineId: "rt_1",
    sessionReady: true,
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    version: "1",
    available: true,
    machineId: "rt_1",
    sessionReady: true,
  },
];

const plan = (name: string) => ({
  steps: [{ title: `${name} step`, done: false, status: "in_progress" as const }],
  raw: `1. ${name} step`,
});

const questionSnapshot: ActiveRunSnapshot = {
  runId: "run-codex",
  sequence: 4,
  prompt: "Codex live prompt",
  agent: "codex",
  state: {
    state: "awaiting-question",
    plan: plan("Codex"),
    request: {
      requestId: "question-codex",
      header: "Depth",
      question: "How deep should Codex go?",
      options: [{ label: "Fast" }, { label: "Thorough" }],
      multiSelect: false,
    },
  },
  plan: plan("Codex"),
  stream: [{ kind: "text", text: "Codex is working" }],
  live: { thinking: "Codex thinking" },
  reviewing: false,
  lastEventSeq: 8,
};

function resumed(snapshot: ActiveRunSnapshot) {
  const submitted: RunDecision[] = [];
  const subscribers = new Set<(event: RunEvent) => void>();
  const detach = vi.fn(() => subscribers.clear());
  const handle: ResumedRun = {
    runId: snapshot.runId,
    snapshot,
    onEvent(cb) {
      subscribers.add(cb);
      queueMicrotask(() => cb({ event: "snapshot", snapshot }));
      return () => subscribers.delete(cb);
    },
    submit(decision) {
      submitted.push(decision);
    },
    detach,
    close() {},
  };
  return {
    handle,
    submitted,
    detach,
    emit(event: RunEvent) {
      act(() => subscribers.forEach((cb) => cb(event)));
    },
  };
}

describe("the Task page with recovered live turns", () => {
  it("hydrates a recovered Task run without presenting its provider", async () => {
    const base = createInMemoryApi();
    const codex = resumed(questionSnapshot);
    const api: LykeionApi = {
      ...base,
      listAgentClis: async () => CLIS,
      resumeRuns: vi.fn(async () => [codex.handle]),
    };
    window.location.hash = ROUTE;
    render(<App api={api} />);

    const block = await screen.findByTestId("live-turn");
    expect(within(block).queryByTestId("run-provider")).not.toBeInTheDocument();
    expect(within(block).queryByText("Codex")).not.toBeInTheDocument();
    expect(api.resumeRuns).toHaveBeenCalledWith("t_3");
    expect(within(block).getByTestId("run-strip")).toHaveTextContent(
      "Step 1 of 1",
    );
    expect(within(block).getByText("How deep should Codex go?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  });

  it("restores and reports a rejected start without creating a ghost turn, then clears the error on retry", async () => {
    const base = createInMemoryApi();
    const subscribers = new Set<(event: RunEvent) => void>();
    const successful: RunHandle = {
      runId: "run-after-retry",
      onEvent(cb) {
        subscribers.add(cb);
        queueMicrotask(() =>
          cb({
            event: "snapshot",
            snapshot: {
              runId: "run-after-retry",
              sequence: 3,
              prompt: "preserve this prompt",
              agent: "claude",
              state: { state: "planning" },
              stream: [],
              live: {},
              reviewing: false,
              lastEventSeq: 0,
            },
          }),
        );
        return () => subscribers.delete(cb);
      },
      submit() {},
      detach() {
        subscribers.clear();
      },
      close() {},
    };
    let attempts = 0;
    const api: LykeionApi = {
      ...base,
      resumeRuns: async () => [],
      startRun: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("machine unavailable");
        return successful;
      },
    };
    const user = userEvent.setup();
    window.location.hash = ROUTE;
    render(<App api={api} />);

    const composer = await screen.findByLabelText("Message the agent");
    await user.type(composer, "preserve this prompt");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "machine unavailable",
    );
    expect(composer).toHaveValue("preserve this prompt");
    expect(screen.queryByTestId("live-turn")).not.toBeInTheDocument();
    expect(composer).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(screen.getByTestId("live-turn")).toHaveAttribute(
        "data-run-id",
        "run-after-retry",
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(composer).toHaveValue("");
  });

  it("shows a retryable recovery failure and blocks the composer and pending handoff until success", async () => {
    const base = createInMemoryApi();
    const handoff = resumed({
      runId: "run-after-recovery",
      sequence: 3,
      prompt: "resume only after recovery",
      agent: "claude",
      state: { state: "planning" },
      stream: [],
      live: {},
      reviewing: false,
      lastEventSeq: 0,
    });
    stashRun("t_3", {
      prompt: "resume only after recovery",
      planMode: false,
      agent: "claude",
      model: null,
    });
    let recoveryAttempts = 0;
    const api: LykeionApi = {
      ...base,
      resumeRuns: vi.fn(async () => {
        recoveryAttempts += 1;
        if (recoveryAttempts === 1) throw new Error("relay unavailable");
        return [];
      }),
      startRun: vi.fn(async () => handoff.handle),
    };
    const user = userEvent.setup();
    window.location.hash = ROUTE;
    render(<App api={api} />);

    const composer = await screen.findByLabelText("Message the agent");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "relay unavailable",
    );
    expect(composer).toBeDisabled();
    expect(api.startRun).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Retry recovery" }),
    );

    await waitFor(() => expect(api.resumeRuns).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(composer).toBeEnabled());
    expect(screen.queryByText("relay unavailable")).not.toBeInTheDocument();
  });

  it("retains the refreshed Task status before removing a reconciled live completion", async () => {
    const base = createInMemoryApi();
    const stale = await base.getTask("t_5");
    const live = resumed({
      runId: "run-status-refresh",
      sequence: 1,
      prompt: "finish this task",
      agent: "claude",
      state: { state: "executing", plan: { steps: [], raw: "" } },
      stream: [{ kind: "text", text: "working" }],
      live: {},
      reviewing: false,
      lastEventSeq: 1,
    });
    const settledTurn: TaskTurn = {
      runId: "run-status-refresh",
      sequence: 1,
      ts: 10,
      prompt: "finish this task",
      messages: ["done"],
      stream: [{ kind: "text", text: "done" }],
      status: "ok",
      code: [],
      outputs: [],
    };
    let settled = false;
    const api: LykeionApi = {
      ...base,
      resumeRuns: vi.fn(async (taskId: string) =>
        taskId === "t_5" ? [live.handle] : [],
      ),
      getTask: vi.fn(async (taskId: string): Promise<TaskDetail> => {
        if (taskId !== "t_5") return base.getTask(taskId);
        if (!settled) return stale;
        return {
          ...stale,
          task: {
            ...stale.task,
            status: "in-review",
            runCount: stale.task.runCount + 1,
          },
          turns: [...stale.turns, settledTurn],
        };
      }),
    };
    window.location.hash = "#/studies/s_cmp/tasks/t_5";
    render(<App api={api} />);
    expect(await screen.findByTestId("live-turn")).toHaveAttribute(
      "data-run-id",
      "run-status-refresh",
    );

    settled = true;
    live.emit({ event: "completed", state: { state: "completed" } });

    await waitFor(() =>
      expect(screen.queryByTestId("live-turn")).not.toBeInTheDocument(),
    );
    expect(await currentTaskStatus(userEvent.setup(), CMP5_TITLE)).toBe(
      "In Review",
    );
  });

  it("does not let an older delayed Task query overwrite the reconciled completion status", async () => {
    const base = createInMemoryApi();
    const stale = await base.getTask("t_5");
    const live = resumed({
      runId: "run-delayed-status",
      sequence: 1,
      prompt: "finish despite the delayed read",
      agent: "claude",
      state: { state: "executing", plan: { steps: [], raw: "" } },
      stream: [{ kind: "text", text: "working" }],
      live: {},
      reviewing: false,
      lastEventSeq: 1,
    });
    const settledTurn: TaskTurn = {
      runId: "run-delayed-status",
      sequence: 1,
      ts: 11,
      prompt: "finish despite the delayed read",
      messages: ["done"],
      stream: [{ kind: "text", text: "done" }],
      status: "ok",
      code: [],
      outputs: [],
    };
    const refreshed: TaskDetail = {
      ...stale,
      task: {
        ...stale.task,
        status: "in-review",
        runCount: stale.task.runCount + 1,
        // The transport currently exposes coarse integer timestamps, so the
        // completed Task and an older in-flight read can legitimately tie.
        updatedTs: stale.task.updatedTs,
      },
      turns: [...stale.turns, settledTurn],
    };
    let resolveOldRead!: (detail: TaskDetail) => void;
    const oldRead = new Promise<TaskDetail>((resolve) => {
      resolveOldRead = resolve;
    });
    let reads = 0;
    const api: LykeionApi = {
      ...base,
      resumeRuns: vi.fn(async (taskId: string) =>
        taskId === "t_5" ? [live.handle] : [],
      ),
      getTask: vi.fn((taskId: string): Promise<TaskDetail> => {
        if (taskId !== "t_5") return base.getTask(taskId);
        reads += 1;
        if (reads === 1) return oldRead;
        if (reads === 2) return Promise.resolve(stale);
        return Promise.resolve(refreshed);
      }),
    };
    window.location.hash = "#/studies/s_cmp/tasks/t_5";
    render(<App api={api} />);
    expect(await screen.findByTestId("live-turn")).toHaveAttribute(
      "data-run-id",
      "run-delayed-status",
    );

    live.emit({ event: "completed", state: { state: "completed" } });

    await waitFor(() =>
      expect(screen.queryByTestId("live-turn")).not.toBeInTheDocument(),
    );
    expect(await currentTaskStatus(userEvent.setup(), CMP5_TITLE)).toBe(
      "In Review",
    );

    await act(async () => resolveOldRead(stale));

    // The stale read carried the pre-completion status; the row still reads
    // the reconciled one.
    expect(await currentTaskStatus(userEvent.setup(), CMP5_TITLE)).toBe(
      "In Review",
    );
  });
});
