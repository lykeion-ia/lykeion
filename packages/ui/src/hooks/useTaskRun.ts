import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Task, TaskDetail, TaskTurn, TurnState } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { useRun, type UseRun } from "./useRun";
import type { ViewTurn } from "../components/tasks/TaskTranscript";
import { takeRun, type PendingRun } from "../lib/pending-run";

/** What the Task surface needs to show and drive its transcript. */
export interface UseTaskRun {
  history: TaskTurn[];
  /** UI-only terminal detail that the persisted TaskTurn schema cannot carry. */
  terminalStatusByRunId: Readonly<Record<string, CancelledTurnState>>;
  viewTurns: ViewTurn[];
  addViewTurn: (turn: ViewTurn) => void;
  /** Keyed live-run manager, including independently actionable blocks. */
  run: UseRun;
  refresh: () => void;
  pendingPrompt: string | null;
  /** False until active-run discovery has succeeded for the current Task. */
  recoveryReady: boolean;
  recoveryError: string | null;
  retryRecovery: () => void;
}

type CancelledTurnState = Extract<TurnState, { state: "cancelled" }>;

function persistedIds(detail: TaskDetail): Set<string> {
  return new Set(detail.turns.map((turn) => turn.runId));
}

/**
 * Own a Task's settled transcript and every live run. Recovery deliberately
 * happens before the history read: subscriptions are attached first, then a
 * settled read is allowed to replace any run that completed in that window.
 */
export function useTaskRun(
  studyId: string | undefined,
  taskId: string,
  onTasksChanged?: () => void,
  onTaskRefreshed?: (task: Task) => void,
): UseTaskRun {
  const api = useApi();
  const runState = useRun(studyId, { taskId });
  const [history, setHistory] = useState<TaskTurn[]>([]);
  const [terminalStatusByRunId, setTerminalStatusByRunId] = useState<
    Record<string, CancelledTurnState>
  >({});
  const [viewTurns, setViewTurns] = useState<ViewTurn[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const addViewTurn = useCallback(
    (turn: ViewTurn) => setViewTurns((turns) => [...turns, turn]),
    [],
  );

  const applyHistory = useCallback(
    (detail: TaskDetail) => {
      const ids = persistedIds(detail);
      const cancelled = detail.turns.flatMap((turn) => {
        const state = runState.terminalStateFor(turn.runId);
        return state?.state === "cancelled"
          ? [{ runId: turn.runId, state }]
          : [];
      });
      if (cancelled.length > 0) {
        setTerminalStatusByRunId((current) => {
          const next = { ...current };
          for (const run of cancelled) next[run.runId] = run.state;
          return next;
        });
      }
      // Retain the Task record from the same authoritative read before the
      // matching optimistic completion block is removed.
      onTaskRefreshed?.(detail.task);
      runState.reconcile(ids);
      setHistory(detail.turns);
      setViewTurns((turns) =>
        turns.filter((turn) => !turn.runId || !ids.has(turn.runId)),
      );
    },
    [runState.reconcile, onTaskRefreshed],
  );

  // Resume and subscribe first. The subsequent transcript is authoritative
  // for any run that settled while those observers were being attached.
  const resume = runState.resume;
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    setViewTurns([]);
    setTerminalStatusByRunId({});
    setHydrated(false);
    void (async () => {
      const current = await resume();
      if (!current || cancelled) return;
      try {
        const detail = await api.getTask(taskId);
        if (cancelled) return;
        applyHistory(detail);
      } catch {
        if (!cancelled) setHistory([]);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, taskId, resume, applyHistory, recoveryAttempt]);
  const retryRecovery = useCallback(() => {
    setRecoveryAttempt((attempt) => attempt + 1);
  }, []);

  // Auto-start a pending Study-composer handoff. Deferral keeps React
  // StrictMode's discarded mount from consuming and starting the one-shot
  // handoff before the settled mount exists.
  const start = runState.start;
  const handoffRef = useRef<{ taskId: string; run: PendingRun | null }>({
    taskId: "",
    run: null,
  });
  useEffect(() => {
    if (handoffRef.current.taskId !== taskId) {
      handoffRef.current = { taskId, run: takeRun(taskId) ?? null };
    }
    const pending = handoffRef.current.run;
    if (!pending) return;
    if (!hydrated) return;
    const timer = setTimeout(() => {
      handoffRef.current.run = null;
      start(pending.prompt, {
        planMode: pending.planMode,
        agent: pending.agent,
        model: pending.model,
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [taskId, start, hydrated]);

  // One completion can finish while siblings remain live. Refresh once for
  // that run, and remove only blocks whose `runId` is actually present in the
  // successful read. A failed read changes nothing, leaving the terminal
  // block as the researcher's only copy.
  const completionRefreshes = useRef<{
    taskId: string;
    seen: Set<string>;
    pending: Set<string>;
    running: boolean;
  }>({ taskId, seen: new Set(), pending: new Set(), running: false });
  if (completionRefreshes.current.taskId !== taskId) {
    completionRefreshes.current = {
      taskId,
      seen: new Set(),
      pending: new Set(),
      running: false,
    };
  }
  const settledRunIds = useMemo(
    () => runState.runs.filter((run) => run.settled).map((run) => run.runId),
    [runState.runs],
  );
  const settledKey = settledRunIds.join("|");
  const flushCompletionRefreshes = useCallback(async () => {
    const queue = completionRefreshes.current;
    if (queue.running) return;
    queue.running = true;
    try {
      while (
        completionRefreshes.current === queue &&
        queue.pending.size > 0
      ) {
        queue.pending.clear();
        onTasksChanged?.();
        let detail: TaskDetail;
        try {
          detail = await api.getTask(taskId);
        } catch {
          // The corresponding terminal blocks remain. A later sibling gets
          // its own queued attempt rather than reviving this failed batch.
          continue;
        }
        if (completionRefreshes.current !== queue) return;
        applyHistory(detail);
      }
    } finally {
      if (completionRefreshes.current === queue) queue.running = false;
    }
  }, [api, taskId, onTasksChanged, applyHistory]);
  useEffect(() => {
    if (!hydrated) return;
    const queue = completionRefreshes.current;
    for (const runId of settledRunIds) {
      if (queue.seen.has(runId)) continue;
      queue.seen.add(runId);
      queue.pending.add(runId);
    }
    void flushCompletionRefreshes();
  }, [hydrated, settledKey, settledRunIds, flushCompletionRefreshes]);

  const refresh = useCallback(() => {
    const generation = completionRefreshes.current;
    api.getTask(taskId).then(
      (detail) => {
        // Task changes replace the queue object, so an older Task's manual
        // read cannot overwrite the current Task after resolving late.
        if (completionRefreshes.current !== generation) return;
        applyHistory(detail);
      },
      () => {
        // An on-demand refresh is also non-destructive on failure.
      },
    );
  }, [api, taskId, applyHistory]);

  const pendingPrompt = handoffRef.current.run?.prompt ?? null;

  return {
    history,
    terminalStatusByRunId,
    viewTurns,
    addViewTurn,
    run: runState,
    refresh,
    pendingPrompt,
    recoveryReady: hydrated,
    recoveryError: runState.recoveryError,
    retryRecovery,
  };
}
