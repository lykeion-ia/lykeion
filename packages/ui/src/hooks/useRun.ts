import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ExecutionLogEntry,
  LiveTurn,
  PermissionDecision,
  Plan,
  PermissionRequest,
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
 *  a normal run), pick the agent/model, and optionally show a different
 *  `displayPrompt` than the text actually sent to the core. */
interface StartOptions {
  planMode?: boolean;
  agent?: string | null;
  model?: string | null;
  displayPrompt?: string;
}

/** Everything the Task surface needs to drive and render one live run. */
export interface UseRun {
  /** The current turn state, or `null` before any run has started. */
  state: TurnState | null;
  /** Assistant messages, in arrival order. */
  messages: string[];
  /** The researcher's own message for the current run — the DISPLAYED
   *  prompt, rendered as the user's turn in the stream. Equal to the sent
   *  prompt unless `start` was called with `displayPrompt` (e.g. a stitched
   *  subagent hand-back sent to the agent but not shown to the researcher).
   *  `null` before any send. */
  prompt: string | null;
  /** The proposed plan (kept visible through execution), or `null`. */
  plan: Plan | null;
  /** The permission card awaiting a decision, or `null`. */
  pendingCard: PermissionRequest | null;
  /** The clarifying question awaiting an answer, or `null`. */
  pendingQuestion: QuestionRequest | null;
  /** The authoritative execution log, in arrival order. */
  log: ExecutionLogEntry[];
  /**
   * The CURRENT turn's ordered stream — the same `TurnItem[]` shape the landed
   * record carries, accumulated live from the ordered events (prose messages
   * and tool steps, in arrival order). It exists so the live turn renders
   * through the very same `blocksOf` a reopened one does, instead of a second
   * renderer that can drift from it.
   *
   * Cleared when a new run starts and on `reset` — NEVER in `teardown`, which
   * `cancel` calls synchronously: clearing it there wipes every card the
   * instant the researcher presses Stop.
   */
  liveStream: TurnItem[];
  /**
   * The in-flight tail: partial prose, thinking, and each running tool's
   * stdout. Each snapshot REPLACES its predecessor (never merged, never
   * appended) — the core sends whole state, and the last snapshot of a turn is
   * `{}`, which is what tells this surface to stop drawing a tail.
   *
   * An adapter with `caps.partial_text: false` sends no `live` events at all,
   * so this simply stays `{}` and the turn renders as whole blocks.
   */
  live: LiveTurn;
  /** The completed run record, once it lands. */
  run: RunRecord | null;
  /** True while a run is in flight (not yet completed or failed). */
  running: boolean;
  /** True while the Reviewer is checking a just-finished turn — a live phase
   *  between the last step and the run fully landing (task runs only). Drives
   *  the run strip's "Reviewing" pill. */
  reviewing: boolean;
  /**
   * Kick off a run. `planMode` (default `false`) is the per-message send mode:
   * the default plain send is a NORMAL run — the agent executes directly under
   * a synthesized approved plan; passing `true` (the composer's "Plan first")
   * gates the run through plan → approve → execute.
   *
   * `prompt` is always what's sent to the core (and recorded as the run's
   * command) — never altered. `opts.displayPrompt`, when given, is what's
   * shown in the researcher's own message bubble instead; this lets a caller
   * stitch extra context (e.g. a subagent hand-back) into what the agent
   * receives without that context leaking into the researcher's visible
   * message. Omit it and the displayed prompt is just `prompt`, unchanged.
   */
  start: (prompt: string, opts?: StartOptions) => void;
  approvePlan: () => void;
  rejectPlan: (reason?: string) => void;
  decide: (requestId: string, decision: PermissionDecision) => void;
  /** Answer a clarifying question. An empty `selected` is a deliberate skip. */
  answerQuestion: (requestId: string, selected: string[]) => void;
  cancel: () => void;
  /** Clear the surface back to the empty (pre-run) state. */
  reset: () => void;
}

/** The plan a turn state carries, if any. Exported so other live-run
 *  subscriptions (e.g. a delegated subagent's child run) can mirror this
 *  canonical `RunEvent` → state mapping instead of re-deriving it. */
export function planOf(s: TurnState): Plan | null {
  // A normal (non-plan) run executes under a SYNTHESIZED empty plan — the core
  // approves a step-less default plan so the approval machine still guards
  // every permission card. That empty plan is not a researcher-facing plan
  // and must never render a card: only a plan that carries steps is one the
  // researcher approved or is being asked to.
  const withSteps = (p: Plan | undefined): Plan | null =>
    p && p.steps.length > 0 ? p : null;
  switch (s.state) {
    case "awaiting-plan-approval":
    case "executing":
      return withSteps(s.plan);
    case "awaiting-permission":
      // A gate raised during `Planning` (before any plan exists) serialises
      // without `plan` at all — fall back to `null` rather than `undefined`
      // so callers can keep using `p ?? <prior plan>` uniformly.
      return withSteps(s.plan);
    default:
      return null;
  }
}

/**
 * Manage a live run for one Task. A Task is a chat, so the Task is the only
 * owner a run can have. Calls `api.startRun`, subscribes to its event stream,
 * and folds each event into React state. Decisions go back through the
 * handle; the handle is closed on unmount and whenever the Task changes, so a
 * stale run can never bleed into the next surface.
 *
 * `studyId` is absent for an unfiled Task: it has no workspace, artifacts or
 * kernel, so there is nothing for a run to happen in. `start` says so by
 * refusing — the Task surface files the Task before it ever calls this.
 */
export function useRun(
  studyId: string | undefined,
  owner: { taskId: string },
): UseRun {
  const api = useApi();
  const { taskId } = owner;

  const [state, setState] = useState<TurnState | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [pendingCard, setPendingCard] = useState<PermissionRequest | null>(
    null,
  );
  const [pendingQuestion, setPendingQuestion] =
    useState<QuestionRequest | null>(null);
  const [log, setLog] = useState<ExecutionLogEntry[]>([]);
  const [liveStream, setLiveStream] = useState<TurnItem[]>([]);
  const [live, setLive] = useState<LiveTurn>({});
  const [run, setRun] = useState<RunRecord | null>(null);
  const [reviewing, setReviewing] = useState(false);

  const handleRef = useRef<RunHandle | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  // Bumped on every start/teardown so a slow `startRun` promise from a
  // superseded run never attaches its listener.
  const token = useRef(0);

  const teardown = useCallback(() => {
    token.current += 1;
    unsubRef.current?.();
    unsubRef.current = null;
    handleRef.current?.close();
    handleRef.current = null;
  }, []);

  const onEvent = useCallback((e: RunEvent) => {
    switch (e.event) {
      case "state": {
        setState(e.state);
        const p = planOf(e.state);
        if (p) setPlan(p);
        setPendingCard(
          e.state.state === "awaiting-permission" ? e.state.request : null,
        );
        setPendingQuestion(
          e.state.state === "awaiting-question" ? e.state.request : null,
        );
        break;
      }
      case "assistant-text":
        // Append ONLY whole messages. A partial fragment (`e.partial`) is
        // already rendered from the `live` snapshot's `text` tail — appending it
        // here too would paint one bubble per chunk AND duplicate the tail.
        // The core re-emits the reassembled whole message with
        // `partial: false` at the seam that ends the fragment run.
        if (!e.partial) {
          setMessages((m) => [...m, e.text]);
          setLiveStream((s) => [...s, { kind: "text", text: e.text }]);
        }
        break;
      case "plan-proposed":
        setPlan(e.plan);
        break;
      case "permission-card":
        setPendingCard(e.request);
        break;
      case "question-asked":
        setPendingQuestion(e.request);
        break;
      case "log-entry":
        // Fires ONCE per entry, at creation — never again when the tool's
        // result merges in. Appending by arrival is therefore exactly right,
        // and a card drawn from here has no `result` until the landed record
        // replaces the whole stream.
        setLog((l) => [...l, e.entry]);
        setLiveStream((s) => [...s, { kind: "step", entry: e.entry }]);
        break;
      case "live":
        // A snapshot REPLACES its predecessor — never merge or append.
        setLive(e.live);
        break;
      case "reviewing":
        // The turn finished executing; the Reviewer is now checking it. Cleared
        // when the run lands (`completed`), or on reset/new turn.
        setReviewing(true);
        break;
      case "completed":
        setState(e.state);
        setReviewing(false);
        setPendingCard(null);
        setPendingQuestion(null);
        // The tail belongs to a turn that is over: whatever was in flight has
        // already become a recorded message or a merged result. `liveStream`
        // stays — the run's own `stream` takes over where it exists, and where
        // it doesn't (a stream cut short) it is all the surface has.
        setLive({});
        if (e.run) setRun(e.run);
        // The run is over — drop the event subscription so a finished run
        // stops receiving the global run-event fan-out.
        unsubRef.current?.();
        unsubRef.current = null;
        break;
      default:
        // The core's event tags must match the TS `RunEvent` union exactly.
        // Without this arm a drifted tag is swallowed silently and the surface
        // hangs at its last state ("Running…" forever) with no diagnostic.
        console.warn("[useRun] unhandled run event — tag drift?", e);
        break;
    }
  }, []);

  const start = useCallback(
    (prompt: string, opts?: StartOptions) => {
      const trimmed = prompt.trim();
      if (!trimmed) return;
      // No Study, no workspace to run in. The Task surface files an unfiled
      // Task on the first send and starts the turn once the Study has landed,
      // so reaching here without one means the send raced its own filing —
      // and starting anyway would run the turn nowhere.
      if (studyId === undefined) return;

      teardown();
      setState({ state: "planning" });
      setMessages([]);
      // The DISPLAYED prompt may differ from what's sent below (e.g. a
      // stitched subagent hand-back) — see the `displayPrompt` doc above.
      setPrompt((opts?.displayPrompt ?? prompt).trim());
      setPlan(null);
      setPendingCard(null);
      setPendingQuestion(null);
      setLog([]);
      // A new turn starts empty: the previous turn's cards and its tail must
      // not bleed into this one. This — not `teardown` — is where the live
      // state is dropped, so a stopped turn keeps what it drew until the
      // researcher actually moves on.
      setLiveStream([]);
      setLive({});
      setRun(null);
      setReviewing(false);

      const mine = token.current;
      api
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
          if (mine !== token.current) {
            handle.close();
            return;
          }
          handleRef.current = handle;
          unsubRef.current = handle.onEvent(onEvent);
        })
        .catch((err: unknown) => {
          if (mine !== token.current) return;
          setState({
            state: "failed",
            reason: err instanceof Error ? err.message : String(err),
          });
        });
    },
    [api, studyId, taskId, onEvent, teardown],
  );

  const submit = useCallback((decision: RunDecision) => {
    handleRef.current?.submit(decision);
  }, []);

  const approvePlan = useCallback(
    () => submit({ action: "approve-plan" }),
    [submit],
  );
  const rejectPlan = useCallback(
    (reason?: string) => submit({ action: "reject-plan", reason }),
    [submit],
  );
  const decide = useCallback(
    (requestId: string, decision: PermissionDecision) =>
      submit({ action: "permission", requestId, decision }),
    [submit],
  );
  const answerQuestion = useCallback(
    (requestId: string, selected: string[]) =>
      submit({ action: "answer-question", requestId, answer: { selected } }),
    [submit],
  );
  // Stop a run and ALWAYS release the surface. The cancel is submitted so the
  // core can end the turn its own way, but we also tear the stream down and end
  // the turn locally: a run whose events stop arriving (dead stream, hung CLI,
  // dropped tag) would otherwise pin `running` true forever, which disables the
  // composer and silently swallows every later send — bricking the chat until
  // a reload.
  const cancel = useCallback(() => {
    handleRef.current?.submit({ action: "cancel" });
    teardown();
    setState((s) =>
      s === null || s.state === "completed" || s.state === "failed"
        ? s
        : { state: "failed", reason: "stopped" },
    );
    setPendingCard(null);
    setPendingQuestion(null);
  }, [teardown]);

  // Tear the live run down and clear the surface — the "New" affordance. Any
  // in-flight run is closed (best-effort cancel) by teardown.
  const reset = useCallback(() => {
    teardown();
    setState(null);
    setMessages([]);
    setPrompt(null);
    setPlan(null);
    setPendingCard(null);
    setPendingQuestion(null);
    setLog([]);
    setLiveStream([]);
    setLive({});
    setRun(null);
    setReviewing(false);
  }, [teardown]);

  // Reset the visible surface whenever the Task changes.
  useEffect(() => {
    setState(null);
    setMessages([]);
    setPrompt(null);
    setPlan(null);
    setPendingCard(null);
    setPendingQuestion(null);
    setLog([]);
    setLiveStream([]);
    setLive({});
    setRun(null);
    setReviewing(false);
  }, [studyId, taskId]);

  // Tear down the live run on unmount / Task change.
  useEffect(() => teardown, [studyId, taskId, teardown]);

  const running =
    state !== null && state.state !== "completed" && state.state !== "failed";

  return {
    state,
    messages,
    prompt,
    plan,
    pendingCard,
    pendingQuestion,
    log,
    liveStream,
    live,
    run,
    running,
    reviewing,
    start,
    approvePlan,
    rejectPlan,
    decide,
    answerQuestion,
    cancel,
    reset,
  };
}
