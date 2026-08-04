import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskTurn } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { useRun, type UseRun } from "./useRun";
import type { ViewTurn } from "../components/tasks/TaskTranscript";
import { takeRun, type PendingRun } from "../lib/pending-run";

/** What the Task surface needs to show and drive its transcript: the
 *  persisted turns, the turns finished in this view but not yet read back
 *  from the record, and the live run itself. */
export interface UseTaskRun {
  /** Persisted turns, excluding any turn still rendering live. */
  history: TaskTurn[];
  /** Turns completed in this view but not yet read back from the record. */
  viewTurns: ViewTurn[];
  /** Append a turn finished in this view, before the record catches up. */
  addViewTurn: (turn: ViewTurn) => void;
  /** The live run: state, stream, plan, permission and question cards. */
  run: UseRun;
  /** Re-read the persisted transcript now. */
  refresh: () => void;
  /** The handed-off prompt that has not started yet, for a title to fall
   *  back to before the deferred start fires. Null once it has. */
  pendingPrompt: string | null;
}

/**
 * Owns a Task's transcript and the run that drives it: the persisted turns
 * for `taskId` (empty for a Task nobody has spoken in yet), the turns
 * finished in this view but not yet read back from the record, and the live
 * run itself — including a run handed off from the Study composer, which this
 * hook auto-starts. The Task surface renders this state; it doesn't compute
 * any of it.
 *
 * `studyId` is absent for an unfiled Task. The transcript is read by task id
 * either way; only the run needs a Study, and `useRun` refuses to start
 * without one.
 */
export function useTaskRun(
  studyId: string | undefined,
  taskId: string,
  onTasksChanged?: () => void,
): UseTaskRun {
  const api = useApi();
  const runState = useRun(studyId, { taskId });

  const [history, setHistory] = useState<TaskTurn[]>([]);
  const [viewTurns, setViewTurns] = useState<ViewTurn[]>([]);
  const addViewTurn = useCallback(
    (turn: ViewTurn) => setViewTurns((ts) => [...ts, turn]),
    [],
  );

  // Load the persisted transcript. A Task created from the New Task form has
  // no turns at all, which is an ordinary state — an empty transcript, not a
  // failed load.
  useEffect(() => {
    let cancelled = false;
    setHistory([]);
    setViewTurns([]);
    api.getTask(taskId).then(
      (d) => {
        if (!cancelled) setHistory(d.turns);
      },
      () => {
        if (!cancelled) setHistory([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, taskId]);

  // Auto-start the pending run handed off from the Study composer.
  //
  // Two hazards meet here, and the fix has to clear BOTH. `takeRun` is one-shot,
  // so React StrictMode's dev double-mount (mount → simulated unmount →
  // remount) would let the DISCARDED first mount consume the prompt and leave
  // the settled remount with nothing — hence the ref latch, which holds the run
  // across the two invocations. But `useRun` tears down on unmount, so the
  // discarded mount's run is killed anyway; a latch that merely survives makes
  // the remount start the SAME prompt a second time. That second start is a
  // whole second agent turn — it spawns its own agent process, and `start`'s
  // own `teardown()` kills the first mid-flight, leaving a half-run turn in the
  // Task's transcript that no reopen can make sense of.
  //
  // So the start is DEFERRED by a macrotask and cancelled in cleanup: the
  // discarded mount schedules a start and then withdraws it, and only the
  // settled mount's start ever fires. The latch clears as it fires, so no
  // later re-run of this effect can replay a prompt that has already run.
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
    const timer = setTimeout(() => {
      handoffRef.current.run = null;
      start(pending.prompt, {
        planMode: pending.planMode,
        agent: pending.agent,
        model: pending.model,
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [taskId, start]);

  // A landed run advanced this Task — refresh the sidebar list AND the
  // persisted transcript.
  //
  // Refetching the transcript is what keeps the view the researcher is looking at
  // and the record a later open will replay from being two different things.
  // Without it the just-finished turn lives ONLY in this mount's ephemeral state
  // (`viewTurns` / the live block), so the first read of the persisted transcript
  // happened on some later remount — and any disagreement between the two showed
  // up as a transcript that changed when the conversation was reopened.
  //
  // Nothing is rendered twice, from either direction: the turn still on the live
  // surface is held OUT of the refetched transcript (it keeps rendering live,
  // with its run chrome, until the next send graduates it), and any turn the
  // transcript now carries is dropped from `viewTurns`. A turn that landed no
  // record — a stopped one — has no `runId`, can never be in the transcript, and
  // is therefore never pruned.
  const runRecord = runState.run;
  useEffect(() => {
    if (!runRecord) return;
    onTasksChanged?.();
    let cancelled = false;
    const liveRunId = runRecord.runId;
    api.getTask(taskId).then(
      (d) => {
        if (cancelled) return;
        setHistory(d.turns.filter((t) => t.runId !== liveRunId));
        const persisted = new Set(d.turns.map((t) => t.runId));
        setViewTurns((ts) =>
          ts.filter((t) => !t.runId || !persisted.has(t.runId)),
        );
      },
      () => {
        // Keep the ephemeral copy: it is all the researcher has if the record
        // cannot be read back.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [runRecord, onTasksChanged, api, taskId]);

  // Re-read the persisted transcript on demand — for a caller that wants the
  // record reflected without waiting on a run of its own to land here.
  const refresh = useCallback(() => {
    api.getTask(taskId).then(
      (d) => setHistory(d.turns),
      () => setHistory([]),
    );
  }, [api, taskId]);

  // Read straight off the latch, not through state: the latch is a ref
  // precisely so writing it never forces a render (see the hand-off effect's
  // comment above), and mirroring its value into state here would reinstate
  // that hazard from the read side. A render already in flight for any other
  // reason picks up whatever the ref holds at that instant, same as the latch
  // itself always has.
  const pendingPrompt = handoffRef.current.run?.prompt ?? null;

  return {
    history,
    viewTurns,
    addViewTurn,
    run: runState,
    refresh,
    pendingPrompt,
  };
}
