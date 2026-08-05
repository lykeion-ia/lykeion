import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type {
  ActiveRunSnapshot,
  ExecutionLogEntry,
  LiveTurn,
  PermissionDecision,
  PermissionRequest,
  Plan,
  QuestionRequest,
  RunDecision,
  RunEvent,
  RunHandle,
  RunRecord,
  TurnItem,
  TurnState,
} from "@lykeion/api";
import { useApi } from "../api/ApiContext";

/** Options `start` accepts: opt into plan mode (default off — a plain send is
 * a normal run), pick the agent/model, and optionally show a different prompt
 * than the text sent to the core. */
interface StartOptions {
  planMode?: boolean;
  agent?: string | null;
  model?: string | null;
  displayPrompt?: string;
}

/** One independently rendered and controlled Task turn. */
export interface ManagedRun {
  runId: string;
  sequence: number;
  prompt: string;
  /** The provider recorded when this turn started, never the current composer choice. */
  agent: string;
  state: TurnState;
  plan: Plan | null;
  stream: TurnItem[];
  live: LiveTurn;
  run: RunRecord | null;
  running: boolean;
  reviewing: boolean;
  /** True only once the core has supplied a terminal frame/snapshot. */
  settled: boolean;
  messages: string[];
  log: ExecutionLogEntry[];
  pendingCard: PermissionRequest | null;
  pendingQuestion: QuestionRequest | null;
  approvePlan: () => void;
  rejectPlan: (reason?: string) => void;
  decide: (requestId: string, decision: PermissionDecision) => void;
  answerQuestion: (requestId: string, selected: string[]) => void;
  cancel: () => void;
}

/** A start that failed before the core assigned a run id. */
export interface RunStartError {
  message: string;
  prompt: string;
}

/**
 * The Task run manager. `runs` is the source of truth: every active or
 * not-yet-reconciled terminal turn has its own keyed entry and actions.
 *
 * The singleton fields below remain as a compatibility projection of the
 * newest entry for callers outside the Task surface while they migrate. They
 * never collapse or remove siblings from `runs`.
 */
export interface UseRun {
  runs: ManagedRun[];
  /** Only the `startRun` request itself holds this flag; active siblings do not. */
  starting: boolean;
  startError: RunStartError | null;
  /** A recoverable failure to discover/reattach the Task's active runs. */
  recoveryError: string | null;
  /** True only while a resume attempt is currently in flight. */
  recovering: boolean;
  /** Attach every recoverable run for this Task. Resolves false when stale. */
  resume: () => Promise<boolean>;
  /** Remove blocks whose matching settled turns have been read successfully. */
  reconcile: (persistedRunIds: ReadonlySet<string>) => void;
  start: (prompt: string, opts?: StartOptions) => void;
  reset: () => void;

  state: TurnState | null;
  messages: string[];
  prompt: string | null;
  plan: Plan | null;
  pendingCard: PermissionRequest | null;
  pendingQuestion: QuestionRequest | null;
  log: ExecutionLogEntry[];
  liveStream: TurnItem[];
  live: LiveTurn;
  run: RunRecord | null;
  running: boolean;
  reviewing: boolean;
  approvePlan: () => void;
  rejectPlan: (reason?: string) => void;
  decide: (requestId: string, decision: PermissionDecision) => void;
  answerQuestion: (requestId: string, selected: string[]) => void;
  cancel: () => void;
}

/** The plan a turn state carries, if any. */
export function planOf(s: TurnState): Plan | null {
  const withSteps = (p: Plan | undefined): Plan | null =>
    p && p.steps.length > 0 ? p : null;
  switch (s.state) {
    case "awaiting-plan-approval":
    case "executing":
      return withSteps(s.plan);
    case "awaiting-permission":
      return withSteps(s.plan);
    default:
      return null;
  }
}

function isTerminal(state: TurnState["state"]): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

interface RunEntry {
  runId: string;
  sequence: number;
  prompt: string;
  agent: string;
  state: TurnState;
  plan: Plan | null;
  stream: TurnItem[];
  live: LiveTurn;
  run: RunRecord | null;
  reviewing: boolean;
  settled: boolean;
}

type RunEntries = Record<string, RunEntry>;

type RunAction =
  | { type: "clear" }
  | { type: "attach"; entry: RunEntry }
  | { type: "event"; runId: string; event: RunEvent }
  | { type: "cancel"; runId: string }
  | { type: "remove"; runIds: ReadonlySet<string> };

function entryFromSnapshot(snapshot: ActiveRunSnapshot): RunEntry {
  return {
    runId: snapshot.runId,
    sequence: snapshot.sequence,
    prompt: snapshot.prompt,
    agent: snapshot.agent,
    state: snapshot.state,
    plan: snapshot.plan ?? planOf(snapshot.state),
    stream: snapshot.stream,
    live: snapshot.live,
    run: null,
    reviewing: snapshot.reviewing,
    settled: isTerminal(snapshot.state.state),
  };
}

function mergeStep(stream: TurnItem[], entry: ExecutionLogEntry): TurnItem[] {
  const index = stream.findIndex(
    (item) => item.kind === "step" && item.entry.toolUseId === entry.toolUseId,
  );
  if (index === -1) return [...stream, { kind: "step", entry }];
  const next = [...stream];
  next[index] = { kind: "step", entry };
  return next;
}

function promoteLiveText(stream: TurnItem[], live: LiveTurn): TurnItem[] {
  const text = live.text;
  if (!text) return stream;
  const last = stream[stream.length - 1];
  if (last?.kind === "text" && last.text === text) return stream;
  return [...stream, { kind: "text", text }];
}

function applyEvent(entry: RunEntry, event: RunEvent): RunEntry {
  switch (event.event) {
    case "snapshot":
      // A recovery snapshot is an authoritative REPLACEMENT, including empty
      // live channels and a shortened/rebuilt stream.
      return entryFromSnapshot(event.snapshot);
    case "state": {
      const nextPlan = planOf(event.state);
      return {
        ...entry,
        state: event.state,
        plan: nextPlan ?? entry.plan,
      };
    }
    case "assistant-text":
      // Partial text is already represented by the replace-only live tail.
      return event.partial
        ? entry
        : {
            ...entry,
            stream: [...entry.stream, { kind: "text", text: event.text }],
          };
    case "plan-proposed":
      return { ...entry, plan: event.plan };
    case "permission-card":
      return {
        ...entry,
        state: {
          state: "awaiting-permission",
          ...(entry.plan ? { plan: entry.plan } : {}),
          request: event.request,
        },
      };
    case "question-asked":
      return {
        ...entry,
        state: {
          state: "awaiting-question",
          ...(entry.plan ? { plan: entry.plan } : {}),
          request: event.request,
        },
      };
    case "log-entry":
      return { ...entry, stream: mergeStep(entry.stream, event.entry) };
    case "live":
      return { ...entry, live: event.live };
    case "reviewing":
      return { ...entry, reviewing: true };
    case "completed": {
      // ACP may finish after sending only partial assistant-text frames. Their
      // assembled prose lives solely in the replace-only live tail, so land it
      // at the end before clearing that tail. An identical final text frame is
      // already the last stream item and must remain a single message.
      const stream = promoteLiveText(entry.stream, entry.live);
      const landedRun = event.run ?? entry.run;
      const run = landedRun
        ? {
            ...landedRun,
            stream: promoteLiveText(landedRun.stream ?? entry.stream, entry.live),
          }
        : null;
      return {
        ...entry,
        stream,
        state: event.state,
        live: {},
        reviewing: false,
        settled: true,
        run,
      };
    }
    default:
      console.warn("[useRun] unhandled run event — tag drift?", event);
      return entry;
  }
}

function reducer(state: RunEntries, action: RunAction): RunEntries {
  switch (action.type) {
    case "clear":
      return {};
    case "attach":
      return { ...state, [action.entry.runId]: action.entry };
    case "event": {
      const current = state[action.runId];
      if (!current) {
        if (action.event.event !== "snapshot") return state;
        return {
          ...state,
          [action.runId]: entryFromSnapshot(action.event.snapshot),
        };
      }
      const next = applyEvent(current, action.event);
      if (next === current) return state;
      return { ...state, [action.runId]: next };
    }
    case "cancel": {
      const current = state[action.runId];
      if (!current || isTerminal(current.state.state)) return state;
      return {
        ...state,
        [action.runId]: {
          ...current,
          state: { state: "cancelled" },
          live: {},
          reviewing: false,
          // Local Stop releases the surface immediately, but persistence is
          // not confirmed until the terminal frame arrives.
          settled: false,
        },
      };
    }
    case "remove": {
      let changed = false;
      const next = { ...state };
      for (const runId of action.runIds) {
        if (!(runId in next)) continue;
        delete next[runId];
        changed = true;
      }
      return changed ? next : state;
    }
  }
}

interface AttachedHandle {
  handle: RunHandle;
  unsubscribe: () => void;
  /** False only for a fresh handle still awaiting its first server snapshot. */
  authoritative: boolean;
}

/**
 * Own every live run for one Task. Handles are observer resources: Task
 * changes and unmounts always `detach()`, never `close()`/cancel.
 */
export function useRun(
  studyId: string | undefined,
  owner: { taskId: string },
): UseRun {
  const api = useApi();
  const { taskId } = owner;
  const [entries, dispatch] = useReducer(reducer, {});
  const [pendingStarts, setPendingStarts] = useState(0);
  const [startError, setStartError] = useState<RunStartError | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const controls = useRef(new Map<string, AttachedHandle>());
  const epoch = useRef(0);
  const recoveryAttempt = useRef(0);

  const release = useCallback((runId: string) => {
    const attached = controls.current.get(runId);
    if (!attached) return;
    controls.current.delete(runId);
    attached.unsubscribe();
    attached.handle.detach();
  }, []);

  const detachAll = useCallback(() => {
    for (const runId of [...controls.current.keys()]) release(runId);
  }, [release]);

  const attach = useCallback(
    (handle: RunHandle, entry?: RunEntry) => {
      const existing = controls.current.get(handle.runId);
      if (existing) {
        if (entry && !existing.authoritative) {
          // Recovery authority replaces a fresh observer that has not yet
          // received its snapshot. Keeping that observer would allow its late
          // provisional stream to overwrite the recovered gate again.
          release(handle.runId);
        } else {
          // Once the retained observer has delivered a snapshot, its reducer
          // state may already include frames newer than a duplicate recovery
          // response captured earlier. Keep that state and detach only the
          // duplicate observer; dispatching its snapshot would rewind the run.
          if (existing.handle !== handle) handle.detach();
          return;
        }
      }

      if (entry) dispatch({ type: "attach", entry });
      // Install the control before subscribing because RunHandle permits an
      // implementation to deliver its current frame synchronously from
      // onEvent(). The wrapper lets release() win that race without leaking
      // the unsubscribe function returned a moment later.
      let unsubscribe: (() => void) | null = null;
      controls.current.set(handle.runId, {
        handle,
        unsubscribe: () => unsubscribe?.(),
        authoritative: entry !== undefined,
      });
      const subscribed = handle.onEvent((event) => {
        if (event.event === "snapshot") {
          const attached = controls.current.get(handle.runId);
          if (attached?.handle === handle) attached.authoritative = true;
        }
        dispatch({ type: "event", runId: handle.runId, event });
        if (
          event.event === "completed" ||
          (event.event === "snapshot" &&
            isTerminal(event.snapshot.state.state))
        )
          release(handle.runId);
      });
      unsubscribe = subscribed;
      if (!controls.current.has(handle.runId)) subscribed();
    },
    [release],
  );

  const resume = useCallback(async (): Promise<boolean> => {
    const mine = epoch.current;
    const attempt = ++recoveryAttempt.current;
    setRecoveryError(null);
    setRecovering(true);
    let resumed;
    try {
      resumed = await api.resumeRuns(taskId);
    } catch (error: unknown) {
      if (mine !== epoch.current || attempt !== recoveryAttempt.current)
        return false;
      setRecoveryError(
        error instanceof Error ? error.message : String(error),
      );
      setRecovering(false);
      return false;
    }
    if (mine !== epoch.current || attempt !== recoveryAttempt.current) {
      for (const handle of resumed) handle.detach();
      return false;
    }
    for (const handle of resumed) attach(handle, entryFromSnapshot(handle.snapshot));
    setRecoveryError(null);
    setRecovering(false);
    return true;
  }, [api, taskId, attach]);

  const start = useCallback(
    (prompt: string, opts?: StartOptions) => {
      const trimmed = prompt.trim();
      if (!trimmed || studyId === undefined) return;
      const mine = epoch.current;
      setPendingStarts((count) => count + 1);
      setStartError(null);

      void api
        .startRun({
          studyId,
          taskId,
          prompt: trimmed,
          options: {
            planMode: opts?.planMode ?? false,
            agent: opts?.agent ?? undefined,
            model: opts?.model ?? undefined,
          },
        })
        .then((handle) => {
          if (mine !== epoch.current) {
            handle.detach();
            return;
          }
          // Fresh streams are snapshot-first, exactly like resumed streams.
          // Until that authoritative frame arrives there is no durable
          // sequence (or server-confirmed prompt/agent/state) to render.
          attach(handle);
        })
        .catch((error: unknown) => {
          if (mine !== epoch.current) return;
          setStartError({
            message: error instanceof Error ? error.message : String(error),
            prompt: (opts?.displayPrompt ?? prompt).trim(),
          });
        })
        .finally(() => {
          if (mine === epoch.current)
            setPendingStarts((count) => Math.max(0, count - 1));
        });
    },
    [api, studyId, taskId, attach],
  );

  const submit = useCallback((runId: string, decision: RunDecision) => {
    controls.current.get(runId)?.handle.submit(decision);
  }, []);

  const cancelById = useCallback(
    (runId: string) => {
      submit(runId, { action: "cancel" });
      dispatch({ type: "cancel", runId });
    },
    [submit],
  );

  const reconcile = useCallback(
    (persistedRunIds: ReadonlySet<string>) => {
      for (const runId of persistedRunIds) release(runId);
      dispatch({ type: "remove", runIds: persistedRunIds });
    },
    [release],
  );

  const reset = useCallback(() => {
    epoch.current += 1;
    recoveryAttempt.current += 1;
    detachAll();
    dispatch({ type: "clear" });
    setPendingStarts(0);
    setStartError(null);
    setRecoveryError(null);
    setRecovering(false);
  }, [detachAll]);

  // Task identity owns the observer lifetime. StrictMode's simulated cleanup
  // takes the same path as navigation: detach every handle and invalidate any
  // response that has not arrived yet, without cancelling a run.
  useEffect(() => {
    epoch.current += 1;
    recoveryAttempt.current += 1;
    const mine = epoch.current;
    detachAll();
    dispatch({ type: "clear" });
    setPendingStarts(0);
    setStartError(null);
    setRecoveryError(null);
    setRecovering(false);
    return () => {
      if (epoch.current === mine) epoch.current += 1;
      detachAll();
    };
  }, [studyId, taskId, detachAll]);

  const runs = useMemo<ManagedRun[]>(
    () =>
      Object.values(entries)
        .sort((a, b) => a.sequence - b.sequence)
        .map((entry) => ({
          runId: entry.runId,
          sequence: entry.sequence,
          prompt: entry.prompt,
          agent: entry.agent,
          state: entry.state,
          plan: entry.plan,
          stream: entry.stream,
          live: entry.live,
          run: entry.run,
          running: !isTerminal(entry.state.state),
          reviewing: entry.reviewing,
          settled: entry.settled,
          messages: entry.stream
            .filter((item): item is Extract<TurnItem, { kind: "text" }> => item.kind === "text")
            .map((item) => item.text),
          log: entry.stream
            .filter((item): item is Extract<TurnItem, { kind: "step" }> => item.kind === "step")
            .map((item) => item.entry),
          pendingCard:
            entry.state.state === "awaiting-permission"
              ? entry.state.request
              : null,
          pendingQuestion:
            entry.state.state === "awaiting-question"
              ? entry.state.request
              : null,
          approvePlan: () => submit(entry.runId, { action: "approve-plan" }),
          rejectPlan: (reason?: string) =>
            submit(entry.runId, { action: "reject-plan", reason }),
          decide: (requestId: string, decision: PermissionDecision) =>
            submit(entry.runId, { action: "permission", requestId, decision }),
          answerQuestion: (requestId: string, selected: string[]) =>
            submit(entry.runId, {
              action: "answer-question",
              requestId,
              answer: { selected },
            }),
          cancel: () => cancelById(entry.runId),
        })),
    [entries, submit, cancelById],
  );

  const latest = runs[runs.length - 1];
  const cancel = useCallback(() => {
    const runId = runs[runs.length - 1]?.runId;
    if (runId) cancelById(runId);
  }, [runs, cancelById]);
  const approvePlan = useCallback(() => {
    const runId = runs[runs.length - 1]?.runId;
    if (runId) submit(runId, { action: "approve-plan" });
  }, [runs, submit]);
  const rejectPlan = useCallback(
    (reason?: string) => {
      const runId = runs[runs.length - 1]?.runId;
      if (runId) submit(runId, { action: "reject-plan", reason });
    },
    [runs, submit],
  );
  const decide = useCallback(
    (requestId: string, decision: PermissionDecision) => {
      const runId = runs[runs.length - 1]?.runId;
      if (runId) submit(runId, { action: "permission", requestId, decision });
    },
    [runs, submit],
  );
  const answerQuestion = useCallback(
    (requestId: string, selected: string[]) => {
      const runId = runs[runs.length - 1]?.runId;
      if (runId)
        submit(runId, {
          action: "answer-question",
          requestId,
          answer: { selected },
        });
    },
    [runs, submit],
  );

  return {
    runs,
    starting: pendingStarts > 0,
    startError,
    recoveryError,
    recovering,
    resume,
    reconcile,
    start,
    reset,
    state: latest?.state ?? null,
    messages: latest?.messages ?? [],
    prompt: latest?.prompt ?? null,
    plan: latest?.plan ?? null,
    pendingCard: latest?.pendingCard ?? null,
    pendingQuestion: latest?.pendingQuestion ?? null,
    log: latest?.log ?? [],
    liveStream: latest?.stream ?? [],
    live: latest?.live ?? {},
    run: latest?.run ?? null,
    running: latest?.running ?? false,
    reviewing: latest?.reviewing ?? false,
    approvePlan,
    rejectPlan,
    decide,
    answerQuestion,
    cancel,
  };
}
