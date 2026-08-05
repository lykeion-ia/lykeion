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
  /** Terminal state retained synchronously until history reconciliation. */
  terminalStateFor: (runId: string) => TurnState | undefined;
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
  /** Contiguous delta text awaiting an optional compatibility whole frame. */
  partialText: string | null;
}

type RunEntries = Record<string, RunEntry>;

type RunAction =
  | { type: "clear" }
  | { type: "attach"; entry: RunEntry }
  | { type: "event"; runId: string; event: RunEvent }
  | { type: "cancel"; runId: string }
  | { type: "remove"; runIds: ReadonlySet<string> };

function partialTextFromSnapshot(snapshot: ActiveRunSnapshot): string | null {
  if (isTerminal(snapshot.state.state)) return null;
  const liveText = snapshot.live.text;
  const last = snapshot.stream[snapshot.stream.length - 1];
  return liveText &&
    last?.kind === "text" &&
    (last.block === undefined || last.block === "interim") &&
    last.text === liveText
    ? liveText
    : null;
}

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
    // A reload may land after durable delta chunks but before the adapter's
    // compatibility whole-message frame. The live tail and the ordered last
    // interim block together identify that exact pending assembly without
    // adding partial metadata to the public snapshot contract.
    partialText: partialTextFromSnapshot(snapshot),
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

function appendBlock(stream: TurnItem[], text: string, block: "thought" | "interim" | "error"): TurnItem[] {
  const last = stream[stream.length - 1];
  if (last?.kind === "text" && last.block === block)
    return [...stream.slice(0, -1), { ...last, text: last.text + text }];
  return [...stream, { kind: "text", text, block }];
}

function promoteLiveText(stream: TurnItem[], live: LiveTurn): TurnItem[] {
  const text = live.text;
  if (!text) return stream;
  const last = stream[stream.length - 1];
  if (last?.kind === "text" && last.text === text) return stream;
  return [...stream, { kind: "text", text, block: "interim" }];
}

function markFinalText(stream: TurnItem[]): TurnItem[] {
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const item = stream[index];
    if (item?.kind !== "text" || item.block === "thought" || item.block === "error") continue;
    const next = [...stream];
    next[index] = { ...item, block: "final" };
    return next;
  }
  return stream;
}

function mergeTerminalStream(landed: TurnItem[] | undefined, observed: TurnItem[]): TurnItem[] {
  if (!landed || landed.length === 0) return observed;
  const merged = [...landed];
  const textOccurrences = new Map<string, number>();
  for (const item of observed) {
    if (item.kind === "step") {
      const index = merged.findIndex(
        (candidate) => candidate.kind === "step" && candidate.entry.toolUseId === item.entry.toolUseId,
      );
      if (index === -1) merged.push(item);
      else merged[index] = item;
      continue;
    }
    const occurrence = (textOccurrences.get(item.text) ?? 0) + 1;
    textOccurrences.set(item.text, occurrence);
    let seen = 0;
    const index = merged.findIndex((candidate) => {
      if (candidate.kind !== "text" || candidate.text !== item.text) return false;
      seen += 1;
      return seen === occurrence;
    });
    if (index === -1) merged.push(item);
    else merged[index] = item;
  }
  return merged;
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
      if (event.partial)
        return {
          ...entry,
          stream: appendBlock(entry.stream, event.text, "interim"),
          partialText: (entry.partialText ?? "") + event.text,
        };
      if (entry.partialText === event.text)
        return { ...entry, partialText: null };
      return {
        ...entry,
        stream: [...entry.stream, { kind: "text", text: event.text, block: "interim" }],
        partialText: null,
      };
    case "assistant-thought":
      return {
        ...entry,
        stream: appendBlock(entry.stream, event.text, "thought"),
        partialText: null,
      };
    case "assistant-text-final":
      return { ...entry, stream: markFinalText(entry.stream), partialText: null };
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
      return {
        ...entry,
        stream: mergeStep(entry.stream, event.entry),
        partialText: null,
      };
    case "live":
      return { ...entry, live: event.live };
    case "reviewing":
      return { ...entry, reviewing: true };
    case "completed": {
      // Only assistant-text-final assigns final semantics. A terminal frame
      // alone cannot distinguish a complete answer from prose cut off by Stop.
      // Legacy snapshots that carried only live.text still land as interim.
      let stream = entry.stream;
      if (stream.length === 0) stream = promoteLiveText(stream, entry.live);
      if (event.state.state === "failed" && event.state.reason)
        stream = appendBlock(stream, event.state.reason, "error");
      const landedRun = event.run ?? entry.run;
      const run = landedRun
        ? {
            ...landedRun,
            // The subscribed stream already includes every frame observed
            // after the last durable snapshot. A completion-carried record
            // can lag that cursor, so the locally folded typed blocks are the
            // authoritative terminal view until history refresh replaces it.
            stream: mergeTerminalStream(landedRun.stream, stream),
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
        partialText: null,
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
  const terminalStates = useRef(new Map<string, TurnState>());
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
        if (event.event === "completed")
          terminalStates.current.set(handle.runId, event.state);
        else if (
          event.event === "snapshot" &&
          isTerminal(event.snapshot.state.state)
        )
          terminalStates.current.set(handle.runId, event.snapshot.state);
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
      terminalStates.current.set(runId, { state: "cancelled" });
      submit(runId, { action: "cancel" });
      dispatch({ type: "cancel", runId });
    },
    [submit],
  );

  const reconcile = useCallback(
    (persistedRunIds: ReadonlySet<string>) => {
      for (const runId of persistedRunIds) release(runId);
      for (const runId of persistedRunIds) terminalStates.current.delete(runId);
      dispatch({ type: "remove", runIds: persistedRunIds });
    },
    [release],
  );

  const reset = useCallback(() => {
    epoch.current += 1;
    recoveryAttempt.current += 1;
    detachAll();
    terminalStates.current.clear();
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
    terminalStates.current.clear();
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
  const terminalStateFor = useCallback(
    (runId: string) => terminalStates.current.get(runId),
    [],
  );
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
    terminalStateFor,
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
