import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FINDING_CLASS_LABELS,
  SEVERITY_LABELS,
  titleFromPrompt,
  type Finding,
  type Severity,
  type Study,
  type Task,
  type TaskStatus,
} from "@lykeion/api";
import { useApi, useInvalidateData } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { useRuntimeBlocker } from "../hooks/useRuntimeBlocker";
import { useStickToBottom } from "../hooks/useStickToBottom";
import { useTaskRun } from "../hooks/useTaskRun";
import type { ManagedRun } from "../hooks/useRun";
import { StatusIcon } from "../components/StatusIcon";
import { Composer } from "../components/tasks/Composer";
import { PermissionCard } from "../components/tasks/PermissionCard";
import { QuestionCard } from "../components/tasks/QuestionCard";
import { PlanCard } from "../components/tasks/PlanCard";
import { TaskSidebar } from "../components/tasks/TaskSidebar";
import { DeleteTaskModal } from "../components/tasks/DeleteTaskModal";
import { TaskTabs, type TaskTab } from "../components/tasks/TaskTabs";
import { RunStrip } from "../components/tasks/RunStrip";
import {
  ArtifactsPanel,
  toFileItem,
  type ArtifactGroup,
} from "../components/tasks/ArtifactsPanel";
import { NotebookPanel } from "../components/tasks/NotebookPanel";
import {
  RightPaneTabs,
  tabAfterClose,
  type RightPaneTab,
} from "../components/tasks/RightPaneTabs";
import { ArtifactPane } from "../components/tasks/ArtifactPane";
import { ModelSwitcher } from "../components/tasks/ModelSwitcher";
import {
  TaskTranscript,
  StreamView,
  UserBubble,
} from "../components/tasks/TaskTranscript";
import { RailRow, TurnRail } from "../components/tasks/TurnRail";
import { AssistantMessage } from "../components/tasks/AssistantMessage";
import { modelOptionOf, noChoiceReason } from "../lib/agent-options";
import { nameChatAfterFirstMessage } from "../lib/task-naming";
import { useRouter, type Route } from "../router";
import {
  closeTaskTab,
  openTaskTab,
  renameTaskTab,
  taskTabsFor,
  useTaskTabs,
} from "../lib/task-tabs";
import {
  closeNotebookTab,
  openNotebookTab,
  useNotebookTabs,
} from "../lib/notebook-tabs";
import "./screens.css";
import "./task.css";

/**
 * The states a run is LIVE in, and what the run line says in each. Stop is not
 * here — it lives in the composer, replacing Send for as long as the run holds
 * the surface (see `Composer`'s `running`/`onStop`). That covers strictly more
 * than this line did: `useRun`'s `running` also spans
 * `awaiting-plan-approval`, so every state that disables the composer has a
 * way out of the run.
 */
const RUN_LINE_LABEL = {
  planning: "Planning…",
  executing: "Running…",
  "awaiting-permission": "Waiting for your decision…",
  "awaiting-question": "Waiting for your answer…",
} as const;
type LiveRunState = keyof typeof RUN_LINE_LABEL;

/**
 * The title `newTask` mints under. A chat started from the sidebar's New has
 * no prompt to take a title from yet, so it lands under this placeholder and
 * the FIRST send writes the real one — see `titleFromFirstSend`.
 */
const NEW_TASK_TITLE = "New task";

/** One run owns one complete piece of live chrome. Keeping this boundary
 * keyed by `runId` prevents its gates and streamed output from leaking into
 * another Task's transcript. */
function LiveRunBlock({
  run,
  onOpenNotebook,
}: {
  run: ManagedRun;
  onOpenNotebook?: () => void;
}) {
  const landedStream = run.run?.stream;
  const stream =
    landedStream && landedStream.length > 0 ? landedStream : run.stream;
  const stdoutFor = (toolUseId?: string) =>
    toolUseId
      ? run.live.toolStdout?.find((output) => output.toolUseId === toolUseId)
          ?.text
      : undefined;
  const planPending = run.state.state === "awaiting-plan-approval";
  const card = run.pendingCard;
  const question = run.pendingQuestion;

  return (
    <div
      className="conv-live live-turn"
      aria-live="polite"
      aria-atomic="false"
      role="log"
      data-testid="live-turn"
      data-run-id={run.runId}
    >
      <UserBubble prompt={run.prompt} />
      {/* ONE rail for the whole reply: the blocks that have landed and the tail
          still arriving. The tail is the newest thing the agent has said, so it
          belongs at the bottom of the same timeline — hung off the rail it will
          join, not dangling beside it until the turn ends and it snaps into
          place. Thinking keeps its own marker here for the same reason it keeps
          its own channel: it is not the answer. */}
      <TurnRail>
        <StreamView
          stream={stream}
          stdoutFor={landedStream ? undefined : stdoutFor}
        />

        {run.live.thinking && !stream.some((item) => item.kind === "text" && item.block === "thinking") ? (
          <RailRow marker="thinking">
            <div className="live-thinking" data-testid="live-thinking">
              {run.live.thinking}
            </div>
          </RailRow>
        ) : null}
        {run.live.text && !stream.some((item) => item.kind === "text" && item.block !== "thinking" && item.block !== "error") ? (
          <RailRow marker="running">
            <div className="live-text" data-testid="live-text">
              <AssistantMessage text={run.live.text} live />
            </div>
          </RailRow>
        ) : null}
      </TurnRail>

      {run.plan && (
        <PlanCard
          plan={run.plan}
          pending={planPending}
          onApprove={run.approvePlan}
          onReject={() => run.rejectPlan()}
        />
      )}

      {run.state.state === "awaiting-permission" && card && (
        <PermissionCard
          request={card}
          queue={run.pendingQueue}
          onAllow={(scope) =>
            run.decide(card.id, { decision: "allow", scope })
          }
          onDeny={() => run.decide(card.id, { decision: "deny" })}
        />
      )}

      {run.state.state === "awaiting-question" && question && (
        <QuestionCard
          request={question}
          onAnswer={(selected) =>
            run.answerQuestion(question.requestId, selected)
          }
        />
      )}

      <RunStrip
        plan={run.plan}
        reviewing={run.reviewing}
        onOpenNotebook={onOpenNotebook}
      />

      {run.state.state in RUN_LINE_LABEL && (
        <div className="run-line" role="status" data-testid="run-line">
          <span className="run-dot" aria-hidden="true" />
          {RUN_LINE_LABEL[run.state.state as LiveRunState]}
        </div>
      )}
      {run.state.state === "completed" && (
        <div className="run-line run-line--done">
          <StatusIcon status="done" />
          Run complete
        </div>
      )}
      {run.state.state === "failed" && (
        <div className="run-line run-line--failed">
          Run failed — {run.state.reason}
        </div>
      )}
      {run.state.state === "cancelled" && (
        <div
          className={
            run.state.unacknowledged
              ? "run-line run-line--unacknowledged"
              : "run-line run-line--cancelled"
          }
        >
          {run.state.unacknowledged
            ? "The agent has not confirmed it stopped — it may still be running."
            : "Run stopped"}
        </div>
      )}
    </div>
  );
}

/**
 * The Task surface — one Task, which is one chat. The left pane lists the
 * Study's Tasks, the breadcrumb carries the open ones as tabs, and the middle
 * column is the conversation: the persisted transcript, the live turn, and the
 * composer that appends the next one.
 *
 * There is one surface, and every Task opens on it. A Task nobody has spoken
 * in yet draws the same conversation with an empty transcript — no entry
 * screen stands in front of it, because the chat IS the Task and a surface
 * asking you to start one is a step between you and work you already opened.
 * The Reviewer's findings render inline in the thread with Resolve, which is
 * the Done-gate.
 *
 * An unfiled Task opens here too, at `#/tasks/:taskId`, and it is the same
 * conversation — the transcript is read by task id, and the composer is live.
 * What it does not have is a Study, and with it the workspace: no Task list to
 * put in the left pane, no artifacts or kernel for the inspector, no findings.
 * Those affordances are left OFF rather than shown against nothing. Its first
 * send asks which Study and files it on the way — see `send` below.
 */
export function TaskScreen({
  studyId,
  taskId,
  railView = "context",
  onOwnRail,
  railSlot,
}: {
  /** The Study this surface is addressed under, or absent for an unfiled
   *  Task, which is addressed by id alone. */
  studyId?: string;
  taskId: string;
  railView?: "nav" | "context";
  /** Report that this surface owns the left slot — the shell hands the slot to
   *  the sidebar and raises the rail-switch FABs while it is mounted. */
  onOwnRail?: (ownsRail: boolean) => void;
  /** The shell's left-rail slot; the sidebar is portaled here so it swaps with
   *  the app Rail and the TabBar keeps its fixed position. */
  railSlot?: HTMLElement | null;
}) {
  const api = useApi();
  const { navigate } = useRouter();
  const invalidate = useInvalidateData();
  // Absent for an unfiled Task: there is no Study to read, and asking for one
  // by an id we do not have would be an error we would then have to explain
  // away. `null` is the honest answer to "which Study is this under".
  const studyQuery = usePromise(
    async () => (studyId === undefined ? null : api.getStudy(studyId)),
    [api, studyId],
  );
  const clisQuery = usePromise(() => api.listAgentClis(), [api]);
  // Every Study, as destinations for a sidebar row's "Move to study".
  const allStudies = usePromise(() => api.listStudies(), [api]);
  // The `/` skills the composer can reference.
  const skills = usePromise(() => api.listSkills(), [api]);
  const clis = clisQuery.data ?? [];
  // Only the blocker: `machineNames` names machines on the CLI dock's tiles,
  // and this surface no longer carries one.
  const { blocker } = useRuntimeBlocker();

  // The Study's Tasks — the sidebar list. Held here rather than read off
  // `studyQuery` so a rename, a pin or a landed turn can refresh it without
  // re-rendering the whole screen from a new Study read.
  const [tasks, setTasks] = useState<Task[]>([]);
  const openTabs = useTaskTabs(studyId);
  const openNotebooks = useNotebookTabs(studyId);

  const refreshTasks = useCallback(() => {
    if (studyId === undefined) {
      setTasks([]);
      return;
    }
    api.getStudy(studyId).then(
      (d) => setTasks(d.tasks),
      () => setTasks([]),
    );
  }, [api, studyId]);

  useEffect(() => {
    refreshTasks();
  }, [refreshTasks]);

  // The Task itself, read by id: an unfiled Task belongs to no Study, so the
  // Study's task list cannot answer for it and `getTask` is the only read that
  // can. `taskNonce` re-reads it after a write of our own (mark done, filing).
  const [taskNonce, setTaskNonce] = useState(0);
  const taskReadAuthority = useRef(0);
  const taskQuery = usePromise(
    async () => {
      const authorityAtStart = taskReadAuthority.current;
      return {
        detail: await api.getTask(taskId),
        authorityAtStart,
      };
    },
    [api, taskId, taskNonce],
  );

  // Hold the last record each read landed, so a RE-read does not blank the
  // page. `usePromise` clears its data the instant its deps change, and this
  // surface re-reads on every write of its own — mark done, rename, filing —
  // so without this each of them unmounts the transcript, the live block and
  // the composer for a commit: a blank screen, a lost scroll position, and a
  // `role="log"` region built again from scratch. Keyed by the id the record
  // belongs to, so moving to another Task shows that Task or nothing, never
  // the one before it.
  const [heldTask, setHeldTask] = useState<Task | null>(null);
  const [heldStudy, setHeldStudy] = useState<Study | null>(null);
  const retainAuthoritativeTask = useCallback((next: Task) => {
    taskReadAuthority.current += 1;
    setHeldTask(next);
  }, []);
  useEffect(() => {
    const read = taskQuery.data;
    if (!read || read.authorityAtStart !== taskReadAuthority.current) return;
    setHeldTask(read.detail.task);
  }, [taskQuery.data]);
  useEffect(() => {
    const read = studyQuery.data?.study;
    if (read) setHeldStudy(read);
  }, [studyQuery.data]);
  // The retained record may come from useTaskRun's newer reconciliation read
  // while this screen's independent query still carries the pre-completion
  // status. Its authority counter invalidates screen reads that were already
  // in flight, independent of coarse/equal server timestamps.
  const task =
    (heldTask?.id === taskId ? heldTask : undefined) ??
    taskQuery.data?.detail.task;
  const study =
    studyQuery.data?.study ??
    (heldStudy !== null && heldStudy.id === studyId ? heldStudy : undefined);

  // A run belongs to the Task's Study, not to the Study named in the URL. The
  // two agree everywhere except in the moment just after a send files an
  // unfiled Task: the Task acquires a Study before the address catches up, and
  // the turn has to start in the workspace it was actually filed into.
  const runStudyId = task?.studyId ?? studyId;

  // The persisted transcript, the turns completed here but not yet read back,
  // and the live run — all owned by the hook, not this screen.
  const {
    history,
    terminalStatusByRunId,
    viewTurns,
    run: runState,
    pendingPrompt,
    recoveryReady,
    recoveryError,
    retryRecovery,
  } = useTaskRun(runStudyId, taskId, refreshTasks, retainAuthoritativeTask);

  // Follow the live reply to the bottom while pinned. The signature must grow
  // on every token so streaming prose (and thinking, and tool stdout) keeps
  // the transcript pinned to the tail — see `useStickToBottom`'s jsdoc for
  // the pin rule. Never fights a researcher who has scrolled up to read
  // something older.
  const liveSignature = runState.runs
    .map((run) => {
      const landedLen = run.run?.stream?.length ?? 0;
      const streamLen = landedLen > 0 ? landedLen : run.stream.length;
      const stdoutLen = (run.live.toolStdout ?? []).reduce(
        (total, output) => total + output.text.length,
        0,
      );
      return [
        run.runId,
        streamLen,
        run.live.text?.length ?? 0,
        run.live.thinking?.length ?? 0,
        stdoutLen,
      ].join(":");
    })
    .join("|");
  const stickDep = [
    history.length,
    viewTurns.length,
    liveSignature,
  ].join("|");
  const stick = useStickToBottom<HTMLDivElement>(stickDep);

  // The composer's draft text, owned here (not by `Composer`'s internal
  // state) so Edit can refill it from a past prompt — and so a send held back
  // by the Study picker leaves the text exactly where the researcher left it.
  // `inputRef` lets Edit focus the textarea after refilling it.
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (!runState.startError) return;
    setDraft((current) => current || runState.startError?.prompt || "");
  }, [runState.startError]);

  /**
   * How much of the screen the inspector has: none, a column beside the
   * conversation, or the whole thing. One value rather than a pair, because
   * the states are ordered — the toggle walks them — and a pair can express
   * combinations that have no meaning ("focused but closed").
   *
   * The chrome follows this: the header is split exactly when `split` puts two
   * surfaces on screen, and is one bar in the other two.
   */
  const [paneMode, setPaneMode] = useState<"closed" | "split" | "focus">(
    "closed",
  );
  const rightPaneOpen = paneMode !== "closed";
  // Everything the inspector can show, Notebook included. It is a tab here and
  // nowhere else: there is no second place a Notebook can be opened, so there
  // is no state that can put one on screen twice.
  const [rightPaneTab, setRightPaneTab] = useState<
    "files" | "artifact" | "notebook"
  >("files");
  /**
   * Whether `Files` is one of the open tabs — the same shape as the artifact's
   * `openArtifactPath !== null`, because it is now the same kind of thing: a
   * surface opened into the pane, not the pane itself.
   *
   * It used to be neither state nor tab, just always there, and the pane's
   * answer to every question — where it opened, what a Task change reset it to,
   * where a closed notebook left it. That made it the one tab that could not be
   * put away, in a strip whose whole rule is that what was opened can be closed.
   */
  const [filesOpen, setFilesOpen] = useState(false);
  const [openArtifactPath, setOpenArtifactPath] = useState<string | null>(null);
  /**
   * The Task a notebook tab is navigating to, held across that one move.
   *
   * Selecting another Task's notebook goes to that Task, and what it asked for
   * was the NOTEBOOK — but arriving anywhere else must not open one (see the
   * reset below). One is a request, the other is a side effect, and the route
   * change looks identical from the arriving side; this is what tells them
   * apart. A ref rather than state: it is consumed by the effect that runs on
   * arrival and never read during a render.
   */
  const notebookOnArrival = useRef<string | null>(null);

  const showInPane = useCallback(
    (tab: "files" | "artifact" | "notebook") => {
      setRightPaneTab(tab);
      setPaneMode((mode) => (mode === "closed" ? "split" : mode));
    },
    [],
  );
  const openArtifact = useCallback(
    (path: string) => {
      setOpenArtifactPath(path);
      showInPane("artifact");
    },
    [showInPane],
  );
  // The one way `Files` gets onto the strip: the sidebar's Files row, and the
  // breadcrumb's toggle, which opens the inspector by opening something into it.
  const openFiles = useCallback(() => {
    setFilesOpen(true);
    showInPane("files");
  }, [showInPane]);

  // Which agent this Task is talking to, and the model the next turn runs on.
  //
  // A Task is one continuous conversation, so the agent is not chosen here:
  // it is read off the conversation itself. The newest turn's agent is where
  // the next turn has to go, and whose models the switcher must list —
  // offering another agent's models would be a promise this surface cannot
  // keep. A live run is newer authority than the settled transcript, and only
  // a Task nobody has spoken in yet has neither, which is the one case that
  // falls back to the lab's first available CLI.
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const lastAgent =
    runState.runs[runState.runs.length - 1]?.agent ??
    history[history.length - 1]?.agent ??
    null;
  // Matched on id alone, availability deliberately not consulted: an agent
  // whose machine has gone offline is still the one this Task is mid-
  // conversation with, and quietly resolving to a different one would put
  // another agent's models on screen — the exact defect this resolution
  // exists to prevent. The composer's runtime blocker is what reports a
  // machine that is not there.
  const effectiveCli =
    clis.find((c) => c.id === lastAgent) ??
    clis.find((c) => c.available) ??
    clis[0];
  const effectiveCliId = effectiveCli?.id ?? null;
  const modelOption = modelOptionOf(effectiveCli);
  // What the breadcrumb names. The same chain, then the Task's own record —
  // which is the one thing that still answers on a reload, before the
  // transcript this reads from has arrived — and only then the agent the next
  // turn would go to.
  //
  // The rule the first two links keep is that this never names an agent a
  // past turn did not run on, and the order is what keeps it: any history at
  // all wins, so `effectiveCliId` is reached only for a Task with no live
  // run, no transcript and no record — the one case where there is no past
  // run to misname. It is the value `start()` is handed rather than a second
  // opinion about it, so the head of the Task and the dispatch cannot drift.
  // A Task nobody has spoken in is still on its way to an agent, and naming
  // it is the honest drawing of that; the first turn to land promotes
  // `lastAgent` and this link never answers for that Task again.
  const taskAgent = lastAgent ?? task?.agent ?? effectiveCliId;
  const agentName = clis.find((c) => c.id === taskAgent)?.name;
  // A model picked for one agent is dropped when the Task turns out to be on
  // another that does not offer it — the same invariant `StudyScreen`'s
  // `selectCli` keeps, held here as a derivation rather than an effect
  // because the switch is something the transcript does to this screen
  // rather than something a control on it did.
  const effectiveModel =
    (selectedModel !== null && modelOption?.choices.some((c) => c.value === selectedModel)
      ? selectedModel
      : modelOption?.currentValue) ?? null;

  // Reviewer findings for this Task (loaded on open and after a run completes).
  const [findings, setFindings] = useState<Finding[]>([]);
  // Local lifecycle state: the status this surface has just written for the
  // open Task, and any refusal the core answered a status write with.
  const [localStatus, setLocalStatus] = useState<TaskStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // The Task a researcher has asked to delete, held while they confirm it.
  // Null whenever nothing is waiting on that answer.
  const [pendingDelete, setPendingDelete] = useState<Task | null>(null);
  // A send held back until the researcher says which Study to file this Task
  // into. Null whenever no send is waiting on an answer.
  const [filing, setFiling] = useState<{
    prompt: string;
    planMode: boolean;
  } | null>(null);
  // The answered send, parked until the filing write is visible on the Task.
  const [pendingSend, setPendingSend] = useState<{
    taskId: string;
    prompt: string;
    planMode: boolean;
  } | null>(null);

  const settledKey = runState.runs
    .filter((run) => run.settled)
    .map((run) => run.runId)
    .join("|");
  useEffect(() => {
    // The Reviewer works inside a Study's workspace, so an unfiled Task has
    // nothing to have been flagged on — and nothing to ask about.
    if (studyId === undefined) {
      setFindings([]);
      return;
    }
    let cancelled = false;
    api.reviewFindings(studyId, taskId).then(
      (fs) => {
        if (!cancelled) setFindings(fs);
      },
      () => {
        if (!cancelled) setFindings([]);
      },
    );
    return () => {
      cancelled = true;
    };
    // Reload when the Task changes or a run lands (findings may appear).
  }, [api, studyId, taskId, settledKey]);

  // Reset per-Task view state whenever the Task changes. Keyed on the Task
  // alone, deliberately not on the Study: the one time a Task's Study changes
  // under a mounted surface is the moment a send files it, and everything
  // reset here — the parked send above all — is exactly what that send is
  // waiting on.
  //
  // The inspector is NOT among them. It is a place to work in rather than a
  // property of one conversation, so it survives the move in the state the
  // reader left it: open stays open, closed stays closed. Closing it on every
  // arrival meant reopening it on every arrival — a toll charged for moving
  // between two Tasks of one Study, which is the ordinary way of working here.
  //
  // What does not survive is what the pane was SHOWING. A notebook is the
  // record of one Task's run and does not follow the reader to another; the
  // artifact is a path out of the Task's own conversation, which left standing
  // drew a tab for another Task's file and read it against this Study. So the
  // pane lands on `Files` — the one surface that means the same thing wherever
  // it opens, being no Task's file in particular — and `Files` is reopened here
  // if the reader had closed it, because a pane that stays open needs something
  // to be open ON, and a strip with nothing on it names nothing.
  //
  // The exception is the move that asked for a notebook: a notebook tab
  // navigating here says so through `notebookOnArrival`, and arrives on the
  // notebook because that IS what was clicked — opening the pane if it was
  // shut, and leaving `Files` exactly as it found it.
  useEffect(() => {
    setLocalStatus(null);
    setStatusError(null);
    setOpenArtifactPath(null);
    const asked = notebookOnArrival.current === taskId;
    notebookOnArrival.current = null;
    // `rightPaneOpen` is the pane as it stood on the Task being left: this runs
    // on arrival, before anything here has touched it.
    setFilesOpen((open) => (asked ? open : open || rightPaneOpen));
    setPaneMode((mode) => (asked && mode === "closed" ? "split" : mode));
    setRightPaneTab(asked ? "notebook" : "files");
    setFiling(null);
    setPendingSend(null);
  }, [taskId]);

  // The Task surface holds the left slot while it has a sidebar to put there.
  // An unfiled Task has no Study, hence no Task list, so it leaves the slot to
  // the app Rail rather than claiming it for an empty pane.
  const ownsRail = studyId !== undefined;
  useEffect(() => {
    onOwnRail?.(ownsRail);
  }, [onOwnRail, ownsRail]);
  useEffect(() => () => onOwnRail?.(false), [onOwnRail]);

  // The Task's display title — from the record, then the transcript, then the
  // live prompt, defaulting to the mint-time placeholder for one that has not
  // loaded yet.
  const taskTitle =
    task?.title ??
    history[0]?.prompt ??
    runState.runs[0]?.prompt ??
    pendingPrompt ??
    NEW_TASK_TITLE;

  // Register/refresh this Task as an open breadcrumb tab. The Study goes in
  // too, and is reconciled by `openTaskTab`: filing moves the tab from the
  // unfiled strip into its new Study's, which is where the surface has just
  // navigated.
  useEffect(() => {
    openTaskTab({ studyId, taskId, title: taskTitle });
  }, [studyId, taskId, taskTitle]);

  const resolveFinding = useCallback(
    (findingId: string) => {
      if (studyId === undefined) return;
      api.resolveFinding(studyId, taskId, findingId).then(
        (fs) => setFindings(fs),
        () => {},
      );
    },
    [api, studyId, taskId],
  );

  /** Take the name a summary wrote and put it everywhere this surface shows
   *  a title. The change channel repaints every other tab in the lab; this is
   *  what repaints the strip in front of the researcher who sent the
   *  message. */
  const adoptTitle = useCallback(
    (title: string) => {
      renameTaskTab(taskId, title);
      refreshTasks();
      setTaskNonce((n) => n + 1);
      invalidate();
    },
    [taskId, refreshTasks, invalidate],
  );

  /**
   * Name a chat after the message that started it.
   *
   * A Task minted from a composer takes the cut-down prompt as its title, but
   * one started from the sidebar's New is minted before there is any prompt to
   * take — so it lands under a placeholder, and the first send is where the
   * real title is WRITTEN. The title stays an authored field: nothing derives
   * it at render time, a rename replaces it for good, and a second turn leaves
   * it alone.
   *
   * The cut prompt goes in straight away and the lab is asked, in the same
   * breath, for something better. The ask takes a second or two and may come
   * back with nothing, which is exactly why the cut is written first rather
   * than waited on: the chat is named the whole time, and a summary — if one
   * arrives — replaces a name nobody has touched.
   *
   * Guarded on both halves of "this chat has never been spoken in": no run has
   * landed, and the title is still the one `newTask` minted. A Task the
   * researcher named themselves — through the New Task form, or a rename that
   * happened to land on the placeholder — keeps the name they gave it.
   */
  const titleFromFirstSend = useCallback(
    (text: string) => {
      if (!task || task.runCount !== 0 || task.title !== NEW_TASK_TITLE) return;
      const title = titleFromPrompt(text);
      if (!title) return;
      api.updateTask(taskId, { title }).then(
        () => {
          adoptTitle(title);
          nameChatAfterFirstMessage(api, taskId, text, effectiveCliId, adoptTitle);
        },
        () => {
          // Best-effort: the chat runs either way, and it keeps the
          // placeholder rather than losing the send over a naming write.
          // Nothing is asked to summarize either — the lab replaces a derived
          // name and this one was never written.
        },
      );
    },
    [api, task, taskId, adoptTitle, effectiveCliId],
  );

  const start = runState.start;
  const startTurn = useCallback(
    (text: string, planMode: boolean) => {
      // The composer's draft is owned here — clear it on send the same way
      // `Composer`'s own internal state would.
      setDraft("");
      // Whatever status this surface last wrote was about the previous body
      // of work. A real new turn on this same mounted Task reopens it; if
      // start later fails, the retained durable Task still supplies the status
      // rather than this local one.
      setLocalStatus(null);
      titleFromFirstSend(text);
      start(text, { planMode, agent: effectiveCliId, model: effectiveModel });
    },
    [
      titleFromFirstSend,
      start,
      effectiveCliId,
      effectiveModel,
    ],
  );

  /**
   * Send a message. A filed Task starts the turn straight away. An unfiled one
   * has no workspace to run in, so the send opens the Study picker instead and
   * resumes there: filing is a step inside the work rather than a precondition
   * the researcher has to satisfy before any of it.
   */
  const send = (text: string, opts?: { planMode?: boolean }) => {
    if (!recoveryReady || runState.starting) return;
    const planMode = opts?.planMode ?? false;
    if (task && task.studyId === undefined) {
      setFiling({ prompt: text, planMode });
      return;
    }
    startTurn(text, planMode);
  };

  /**
   * File the Task, then run the held-back send. The two cannot happen in one
   * breath: the turn has to start in the Study the Task has just acquired, and
   * this render still has the Study it had a moment ago. So the send is parked
   * and fired by the effect below, once the re-read Task actually reports a
   * Study — the write, not a guess about when it landed, is what releases it.
   */
  const confirmFiling = async (intoStudyId: string) => {
    const held = filing;
    if (!held) return;
    setFiling(null);
    try {
      await api.updateTask(taskId, { studyId: intoStudyId });
    } catch {
      // The Task stays unfiled and the draft stays put: nothing was sent, so
      // there is nothing to undo.
      setFiling(held);
      return;
    }
    setPendingSend({ taskId, ...held });
    setTaskNonce((n) => n + 1);
    refreshTasks();
    invalidate();
    // Keep the address honest about where the Task now lives.
    navigate({ name: "task", studyId: intoStudyId, taskId });
  };

  // Put the message back in the composer while the picker is up. `Composer`
  // clears its text on every send, so a send the picker holds back would
  // otherwise cost the researcher what they wrote — and cancelling is supposed
  // to leave them exactly where they were. Keyed on the held send, so editing
  // the draft with the picker open is never clobbered.
  useEffect(() => {
    if (filing) setDraft(filing.prompt);
  }, [filing]);

  // Release a send that was waiting on the Task being filed. Keyed by task id,
  // and cleared by the reset above when the surface moves to another Task, so
  // a send left behind is abandoned rather than replayed on the way back.
  useEffect(() => {
    if (!pendingSend || pendingSend.taskId !== taskId) return;
    if (task?.studyId === undefined) return;
    setPendingSend(null);
    startTurn(pendingSend.prompt, pendingSend.planMode);
  }, [pendingSend, taskId, task?.studyId, startTurn]);

  /**
   * Where a Task opens FROM THIS SURFACE. `taskRoute` answers the same
   * question from a Task record; here the answer is simply the address this
   * surface is already at, which is what lets a tab open before its record has
   * been read.
   */
  const routeToTask = (id: string): Route =>
    studyId === undefined
      ? { name: "unfiled-task", taskId: id }
      : { name: "task", studyId, taskId: id };

  /** Where the surface goes when the last tab closes: back up to the Study, or
   *  — for an unfiled Task, which has none — to the Lab's Task list. */
  const routeUp = (): Route =>
    studyId === undefined ? { name: "tasks" } : { name: "study", studyId };

  // Start another chat in this Study: a Task is a chat, so "New" mints one.
  // Only offered where there is a Study to mint into — the sidebar that
  // carries it is not rendered for an unfiled Task.
  const newTask = async () => {
    if (studyId === undefined) return;
    const created = await api.createTask({
      studyId,
      stage: "background",
      title: NEW_TASK_TITLE,
    });
    refreshTasks();
    invalidate();
    navigate({ name: "task", studyId, taskId: created.id });
  };

  const openTask = (id: string) => {
    if (id !== taskId) navigate(routeToTask(id));
  };

  const closeTab = (id: string) => {
    const remaining = taskTabsFor(studyId).filter((t) => t.taskId !== id);
    closeTaskTab(id);
    if (id === taskId) {
      if (remaining.length > 0)
        navigate(routeToTask(remaining[remaining.length - 1].taskId));
      else navigate(routeUp());
    }
  };

  /**
   * Take a Task's notebook off the inspector's strip, for a Task that has gone
   * — deleted, or moved to another Study. Distinct from closing a conversation
   * tab, which leaves the notebook alone: a chat you are finished reading is
   * not a ledger you are finished consulting, and keeping the two strips
   * independent is the point of the notebook one.
   */
  const dropNotebookTab = (id: string) => closeNotebookTab(id);

  // Delete a Task: it and its transcript go together, its tab is dropped, and
  // — if it was the one on screen — the surface moves to another open Task (or
  // back to the Study).
  //
  // A refusal is left to reject. This used to be swallowed and the tab closed
  // regardless, which made a delete the core had refused indistinguishable
  // from one it had done: the Task vanished from the screen and came back on
  // the next read. The confirming dialog is a place to say so, and it stays
  // open and reports it rather than reconciling around it.
  const deleteTask = async (id: string) => {
    const remaining = taskTabsFor(studyId).filter((t) => t.taskId !== id);
    await api.deleteTask(id);
    closeTaskTab(id);
    dropNotebookTab(id);
    refreshTasks();
    invalidate();
    if (id === taskId) {
      if (remaining.length > 0)
        navigate(routeToTask(remaining[remaining.length - 1].taskId));
      else navigate(routeUp());
    }
  };

  // Rename and pin are presentation-only in the core — the turns are never
  // touched — so both are optimism-free: write, then re-read the list. A
  // failure simply leaves the sidebar showing the core's unchanged truth.
  const renameTask = async (id: string, title: string) => {
    try {
      await api.updateTask(id, { title });
      renameTaskTab(id, title);
    } catch {
      // Best-effort: the refresh below reconciles with the core either way.
    }
    refreshTasks();
    if (id === taskId) setTaskNonce((n) => n + 1);
    invalidate();
  };

  const pinTask = async (id: string, pinned: boolean) => {
    try {
      await api.updateTask(id, { pinned });
    } catch {
      // Best-effort: the refresh below reconciles with the core either way.
    }
    refreshTasks();
  };

  /**
   * Move a Task along its lifecycle. Unlike rename and pin, a refusal here is
   * reported rather than reconciled away: the Done-gate exists to be heard,
   * and a Task that silently stayed In Review would leave a researcher
   * clicking the same item again.
   *
   * The menu that asks can sit on any row in the sidebar, but the strip that
   * answers heads the open Task — so a message about another Task names it.
   */
  const setTaskStatus = async (id: string, status: TaskStatus) => {
    setStatusError(null);
    try {
      await api.updateTask(id, { status });
      if (id === taskId) {
        setLocalStatus(status);
        setTaskNonce((n) => n + 1);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const other = id === taskId ? undefined : tasks.find((t) => t.id === id);
      setStatusError(other ? `${other.title}: ${message}` : message);
    }
    refreshTasks();
  };

  // Filing a Task under another Study takes it out of this sidebar, so it is
  // reconciled the way a delete is: drop the tab that pointed at it here, and
  // move off it if it was the Task on screen. The Task itself is untouched —
  // it opens under its new Study.
  const moveTask = async (id: string, destination: string) => {
    const remaining = taskTabsFor(studyId).filter((t) => t.taskId !== id);
    try {
      await api.updateTask(id, { studyId: destination });
    } catch {
      // Best-effort: the refresh below reconciles with the core either way.
    }
    closeTaskTab(id);
    dropNotebookTab(id);
    refreshTasks();
    invalidate();
    if (id === taskId) {
      if (remaining.length > 0)
        navigate(routeToTask(remaining[remaining.length - 1].taskId));
      else navigate(routeUp());
    }
  };

  // Move destinations for the sidebar's row menus, newest-worked-on first.
  const studies = useMemo(
    () => [...(allStudies.data ?? [])].sort((a, b) => b.updatedTs - a.updatedTs),
    [allStudies.data],
  );

  // Read order: pinned first (the sidebar draws them as their own group), then
  // most recently worked on.
  const sidebarTasks = useMemo(
    () =>
      [...tasks].sort(
        (a, b) =>
          Number(b.pinned ?? false) - Number(a.pinned ?? false) ||
          b.updatedTs - a.updatedTs,
      ),
    [tasks],
  );

  const tabs: TaskTab[] = openTabs.map((t) => ({
    id: t.taskId,
    label: t.title,
    closable: openTabs.length > 1,
  }));

  /**
   * What to call a Task whose notebook is on the inspector's strip.
   *
   * Read from the Study's own list rather than stored on the tab, so a rename
   * lands on the notebook strip without a second store to keep in step. The
   * open conversation tabs are the fallback for the moment before that list has
   * loaded, since they already carry a title for every Task the researcher has
   * opened.
   */
  const notebookTitle = (id: string): string =>
    tasks.find((t) => t.id === id)?.title ??
    openTabs.find((t) => t.taskId === id)?.title ??
    NEW_TASK_TITLE;

  /**
   * The inspector's tabs. `Files` is this Task's, and there while it is open; an
   * artifact is this Task's, and there while one is open; the notebooks are the
   * Study's, and accumulate.
   *
   * EVERY notebook is called `Notebook`. What the tab names is the kind of
   * surface it opens, and they are all the same kind — a Task's title in that
   * row named the notebook after something that is not on the strip at all, and
   * read as a second copy of the conversation tabs sitting in the pane.
   *
   * They are the notebooks that were OPENED, in the order they were opened, and
   * this Task's is on the strip only once it is among them. It used to be drawn
   * unconditionally and first, which cost more than it gave: arriving anywhere
   * put a notebook nobody had opened at the head of the row and moved the one
   * being read down a place, so a strip of identically-labelled tabs reordered
   * itself under the reader — indistinguishable, from the outside, from having
   * lost the tab. The composer's button and a run strip's pill are the way in,
   * and they were always the way in; the tab was never it.
   *
   * So every one of them closes, with no exceptions at all — a tab is something
   * opened, and what is opened can be put away (see `closeRightPaneTab` for the
   * cases that also move the panel). `Files` used to be the exception, on the
   * grounds that it WAS the pane rather than something opened into it; it is a
   * surface among the others now, reached from the sidebar's Files row or from
   * the breadcrumb's toggle, and it holds the head of the strip so that
   * reopening it never shuffles the row the reader is working in.
   *
   * Selecting another Task's notebook GOES there — a notebook is the record of
   * what one conversation ran, so it is read beside that conversation and never
   * pulled over on top of another. Each names its Task in `title` and in the
   * accessible name of its close, which is the only thing telling two of them
   * apart.
   */
  const rightPaneTabs: RightPaneTab[] = [
    ...(filesOpen ? [{ id: "files", label: "Files", closable: true }] : []),
    ...(openArtifactPath
      ? [
          {
            id: "artifact",
            label: openArtifactPath.split("/").pop() ?? openArtifactPath,
            title: openArtifactPath,
            closable: true,
          },
        ]
      : []),
    ...openNotebooks.map((n) => ({
      id: `notebook:${n.taskId}`,
      label: "Notebook",
      title: `Notebook — ${notebookTitle(n.taskId)}`,
      closable: true,
      // Says which notebook, because the label no longer can — and says
      // "notebook", because the conversation's strip carries a close for the
      // same Task by the same name and the two do different things.
      closeLabel: `Close notebook ${notebookTitle(n.taskId)}`,
    })),
  ];

  const activeRightPaneTab =
    rightPaneTab === "notebook" ? `notebook:${taskId}` : rightPaneTab;

  // The tabs this screen can show without going anywhere — which is every tab
  // but another Task's notebook, since reaching one of those means arriving at
  // that Task. They are where a closed tab may hand the pane; see
  // `closeRightPaneTab`.
  const showableRightPaneTabs = rightPaneTabs.filter(
    (t) => !t.id.startsWith("notebook:") || t.id === `notebook:${taskId}`,
  );

  /**
   * Open a notebook, and put it on the strip.
   *
   * The one place a notebook is ever opened — the composer's button and a run
   * strip's pill both arrive here — which is why it is also the one place that
   * registers a tab. Registering from an effect watching the pane instead looked
   * tidier and was wrong: on a Task-to-Task move there is a render where the new
   * Task is in place and the tab has not been reset yet, so a Task merely walked
   * past collected a notebook tab it had never shown.
   *
   * Another Task's means going to that Task, so the conversation and the ledger
   * arrive together and the screen never pairs one Task's record with another's
   * transcript. `notebookOnArrival` marks that move as a request FOR the
   * notebook — the reset on arrival sends the pane back to Files for every other
   * way of getting there.
   */
  const showNotebookFor = (id: string) => {
    if (studyId !== undefined) openNotebookTab({ studyId, taskId: id });
    showInPane("notebook");
    if (id === taskId) return;
    notebookOnArrival.current = id;
    navigate(routeToTask(id));
  };

  const selectRightPaneTab = (id: string) => {
    if (id === "files") openFiles();
    else if (id === "artifact") setRightPaneTab("artifact");
    else if (id.startsWith("notebook:"))
      showNotebookFor(id.slice("notebook:".length));
  };

  /**
   * Take a tab off the strip.
   *
   * Closing one the pane is not showing costs the screen nothing — another
   * Task's notebook is a way back the reader is finished with, not a surface
   * they are reading.
   *
   * Closing the one the pane IS showing has to take the panel with it, or the
   * pane goes on drawing something nothing in the strip still names. It hands
   * the panel to the neighbour (`tabAfterClose`), and when the strip is left
   * empty it closes the inspector: the pane is its tabs, and there is no home
   * tab to fall back to any more.
   *
   * What it never does is navigate. Another Task's notebook is on the strip but
   * is not a place the pane may fall to — arriving at that Task is a thing the
   * reader ASKS for by selecting it, never something a close does to them.
   */
  const closeRightPaneTab = (id: string) => {
    if (id === "files") setFilesOpen(false);
    else if (id === "artifact") setOpenArtifactPath(null);
    else if (id.startsWith("notebook:"))
      closeNotebookTab(id.slice("notebook:".length));
    else return;
    if (id !== activeRightPaneTab) return;
    const next = tabAfterClose(showableRightPaneTabs, id);
    if (next === null) setPaneMode("closed");
    else setRightPaneTab(next === "files" || next === "artifact" ? next : "notebook");
  };

  // The composer's `@`/`#`/`/` sources, built from what REALLY exists here: the
  // artifacts this chat has produced (deduped, newest turn first), the Study's
  // other Tasks, and the configured skills. A source with nothing in it is
  // dropped by `Composer`, so a trigger never opens an empty list.
  const mentionSources = useMemo(() => {
    const artifacts = new Map<string, string | undefined>();
    for (const turn of history) {
      for (const out of turn.outputs ?? []) {
        if (!artifacts.has(out.path)) {
          artifacts.set(
            out.path,
            out.size !== undefined ? `${out.size} bytes` : undefined,
          );
        }
      }
    }
    return [
      {
        trigger: "@" as const,
        label: "Artifacts",
        items: [...artifacts].map(([path, description]) => ({
          label: path,
          description,
        })),
      },
      {
        trigger: "#" as const,
        label: "Tasks",
        items: tasks
          .filter((t) => t.id !== taskId)
          .map((t) => ({ label: t.title })),
      },
      {
        trigger: "/" as const,
        label: "Skills",
        items: (skills.data ?? [])
          .filter((s) => s.enabled)
          .map((s) => ({ label: s.name, description: s.description })),
      },
    ];
  }, [history, tasks, taskId, skills.data]);

  // This chat's artifacts — live/terminal blocks first, then persisted turns,
  // newest first, deduped by path. The live run is listed separately because
  // the hook holds the turn still on screen OUT of the persisted transcript,
  // so a run that just produced a file would otherwise not show it until the
  // next send graduated the turn.
  const artifactGroups: ArtifactGroup[] = useMemo(() => {
    const code = new Map<string, ReturnType<typeof toFileItem>>();
    const outputs = new Map<string, ReturnType<typeof toFileItem>>();
    const add = (
      into: Map<string, ReturnType<typeof toFileItem>>,
      list: { path: string; size: number; hash?: string }[] | undefined,
    ) => {
      for (const a of list ?? []) if (!into.has(a.path)) into.set(a.path, toFileItem(a));
    };
    for (const run of [...runState.runs].reverse()) {
      add(code, run.run?.code);
      add(outputs, run.run?.outputs);
    }
    for (const turn of [...history].reverse()) {
      add(code, turn.code);
      add(outputs, turn.outputs);
    }
    const groups: ArtifactGroup[] = [];
    if (code.size) groups.push({ title: "Code", items: [...code.values()] });
    if (outputs.size)
      groups.push({ title: "Outputs", items: [...outputs.values()] });
    return groups;
  }, [history, runState.runs]);

  const loadError = taskQuery.error ?? studyQuery.error;
  if (loadError) {
    return (
      <div className="screen">
        <p className="screen-error">{loadError}</p>
      </div>
    );
  }

  // The Task is the whole gate: it names the conversation and everything on
  // this page hangs off it. The Study is NOT — an unfiled Task has none, and
  // waiting for one would blank the chat rather than draw it without the
  // Study-scoped chrome it cannot have anyway.
  if (!task) return <div className="screen" aria-busy="true" />;

  // Once a run lands, the Task is In Review (optimistic; the store agrees).
  // A status this surface wrote itself wins over both: an explicit write is
  // newer authority than anything derived from the runs it followed.
  const liveStatus: TaskStatus =
    localStatus ??
    (runState.runs.some(
      (run) => run.run !== null || run.state.state === "completed",
    )
      ? "in-review"
      : task.status);
  const anyRunning = runState.runs.some((run) => run.running);
  const activeRun = runState.runs.find((run) => run.running);

  // Discards the newest turn and puts the Task's files back. Undefined
  // while a run is live: a turn cannot be pulled out from under one that is
  // still working, and the control the researcher wants there is Stop.
  const revertTurn = anyRunning
    ? undefined
    : async (runId: string) => {
        await api.revertTurn(runId);
        setTaskNonce((n) => n + 1);
      };
  // Edit is Revert followed by an ordinary send of the corrected text. It is
  // not a second operation, which keeps the destructive path down to one.
  const editTurn = anyRunning
    ? undefined
    : async (runId: string, prompt: string) => {
        await api.revertTurn(runId);
        setTaskNonce((n) => n + 1);
        send(prompt);
      };

  const switcher = (
    <ModelSwitcher
      {...(modelOption ? { option: modelOption } : {})}
      reason={noChoiceReason(effectiveCli)}
      selectedModel={effectiveModel}
      onSelect={setSelectedModel}
    />
  );

  // The inspector reads the Study's workspace — its files and its kernel — so
  // an unfiled Task has nothing to open it on. Left undefined rather than
  // shown against an empty workspace, which drops the composer's Notebook
  // button, the run strip's pill and the breadcrumb's toggle together.
  //
  // Both callers — the composer's button and a run strip's pill — mean THIS
  // Task's notebook, so this unpins whatever was being read from another one.
  const openNotebook =
    study === undefined ? undefined : () => showNotebookFor(task.id);

  const liveTurns = runState.runs.map((run) => ({
    runId: run.runId,
    sequence: run.sequence,
    content: (
      <LiveRunBlock run={run} onOpenNotebook={openNotebook} />
    ),
  }));

  const composer = (
    <>
      {filing && (
        <StudyPicker
          onConfirm={(id) => void confirmFiling(id)}
          onCancel={() => setFiling(null)}
        />
      )}
      {runState.startError && (
        <div className="composer-start-error" role="alert">
          Could not start the run — {runState.startError.message}
        </div>
      )}
      {recoveryError && (
        <div className="composer-start-error" role="alert">
          Could not recover active runs — {recoveryError}{" "}
          <button
            type="button"
            onClick={retryRecovery}
            disabled={runState.recovering}
          >
            {runState.recovering ? "Retrying recovery" : "Retry recovery"}
          </button>
        </div>
      )}
      {/* No `placeholder`: `Composer`'s own default is already the docked
          string, and every trigger it names is live here. */}
      <Composer
        variant="docked"
        onSend={send}
        // `starting` is deliberately not here. It is true for as long as a
        // send is crossing to the lab, and disabling on it is what stopped a
        // researcher typing the next thing while the agent was still on the
        // last one. A turn taken during another simply waits its place.
        disabled={!recoveryReady}
        blocker={blocker}
        running={activeRun !== undefined}
        onStop={activeRun?.cancel}
        switcher={switcher}
        draft={draft}
        onDraftChange={setDraft}
        inputRef={inputRef}
        mentions={mentionSources}
        onOpenNotebook={openNotebook}
      />
    </>
  );

  const orderedFindings = [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );

  // The open Task's row reads the status this surface knows rather than the
  // one the list was read with: a turn that has just landed has already moved
  // the Task on, and the row menu offers Done off the back of it.
  const sidebarRows = sidebarTasks.map((t) =>
    t.id === taskId ? { ...t, status: liveStatus } : t,
  );

  // The left pane lists the Study's Tasks, so it exists only where there is a
  // Study. An unfiled Task leaves the slot to the app Rail (see `ownsRail`).
  const sidebar = study && (
    <TaskSidebar
      study={study}
      filesActive={rightPaneOpen && rightPaneTab === "files"}
      onNew={() => void newTask()}
      onOpenFiles={openFiles}
      tasks={sidebarRows}
      activeTaskId={taskId}
      onOpenTask={openTask}
      // The row only says who was asked for. Confirming is the screen's,
      // because the menu unmounts the moment an item is chosen.
      onDeleteTask={(id) =>
        setPendingDelete(sidebarTasks.find((t) => t.id === id) ?? null)
      }
      onRenameTask={(id, title) => void renameTask(id, title)}
      onPinTask={(id, pinned) => void pinTask(id, pinned)}
      onMoveTask={(id, destination) => void moveTask(id, destination)}
      // Offered while a run is live too: the stores keep an explicit status
      // written mid-run as the newer authority, so a Done chosen here is not
      // a write about to be overtaken by the turn that is still going.
      onSetTaskStatus={(id, status) => void setTaskStatus(id, status)}
      studies={studies}
    />
  );

  return (
    <div className="task-screen" data-testid="task-surface">
      <div
        className="task-columns"
        data-pane-mode={paneMode}
        style={{
          // Split, the inspector and the conversation are equal halves — all of
          // the width when focused, and none at all when closed.
          gridTemplateColumns:
            paneMode === "focus"
              ? "minmax(0, 1fr)"
              : `minmax(0, 1fr)${rightPaneOpen ? " minmax(400px, 1fr)" : ""}`,
        }}
      >
        {railView === "context" &&
          railSlot &&
          sidebar &&
          createPortal(sidebar, railSlot)}
        {/* Focused, the inspector owns the screen and the conversation is not
            drawn behind it — one surface, so one header. */}
        <div className="task-main" hidden={paneMode === "focus"}>
          <TaskTabs
            // An unfiled Task's breadcrumb names the Lab's Task list, which is
            // the surface it belongs to until it is filed. Either way the name
            // is the way back to it — the same place closing the last tab goes.
            crumb={study?.title ?? "Tasks"}
            crumbTo={routeUp()}
            tabs={tabs}
            activeId={taskId}
            onSelect={openTask}
            onClose={closeTab}
            // The agent the Task ran on, or — before it has run at all — the
            // one its first turn is about to go to. See `taskAgent`: history
            // outranks the prospect, so this names a past run correctly or
            // names no past run at all. Absent when the lab has no CLI to
            // dispatch to, which is a Task on its way nowhere yet.
            {...(taskAgent ? { agent: taskAgent } : {})}
            {...(agentName === undefined ? {} : { agentName })}
            statusError={statusError}
            rightPaneOpen={rightPaneOpen}
            // The toggle belongs to whichever header reaches the screen's right
            // edge. That is this bar only while the conversation is alone; the
            // moment the inspector is on screen it owns that edge and carries
            // the control itself, beside the tabs it acts on.
            // Opening the inspector means opening something INTO it, now that
            // it has no home surface of its own to land on: this is the Files
            // tab's other way in, beside the sidebar's row.
            onToggleRightPane={
              study === undefined || rightPaneOpen ? undefined : openFiles
            }
            divider={false}
          />
          <div className="task-main-body">
            <section className="conversation" data-testid="conversation">
              <div
                className="conv-stream"
                ref={stick.ref}
                data-testid="conv-stream"
              >
                <div className="conv-column">
                  <TaskTranscript
                    history={history}
                    viewTurns={viewTurns}
                    liveTurns={liveTurns}
                    terminalStatusByRunId={terminalStatusByRunId}
                    {...(revertTurn ? { onRevertTurn: revertTurn } : {})}
                    {...(editTurn ? { onEditTurn: editTurn } : {})}
                  />

                  {findings.length > 0 && (
                    <div className="conv-review">
                      <div className="card-eyebrow">Reviewer findings</div>
                      {orderedFindings.map((finding) => (
                        <FindingCard
                          key={finding.id}
                          finding={finding}
                          onResolve={resolveFinding}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="composer-dock">
                {!stick.pinned && (
                  <button
                    type="button"
                    className="jump-to-latest"
                    onClick={stick.jumpToLatest}
                    aria-label="Jump to latest"
                  >
                    <span aria-hidden="true">↓</span> Jump to latest
                  </button>
                )}
                <div className="composer-column">{composer}</div>
              </div>
            </section>
          </div>
        </div>

        {/* The inspector: this Task's files, an opened artifact, and the
            Notebook — every surface that is not the conversation, in one
            column, reached by one tab strip. Exists only for filed Tasks,
            which are the only ones with a Study workspace to inspect. */}
        {rightPaneOpen && study !== undefined && (
          <div className="task-rightpane">
            <RightPaneTabs
              tabs={rightPaneTabs}
              activeId={activeRightPaneTab}
              onSelect={selectRightPaneTab}
              onCloseTab={closeRightPaneTab}
              paneMode={paneMode === "focus" ? "focus" : "split"}
              onToggleFocus={() =>
                setPaneMode((mode) => (mode === "focus" ? "split" : "focus"))
              }
              onClosePane={() => setPaneMode("closed")}
            />
            {rightPaneTab === "files" ? (
              <ArtifactsPanel
                groups={artifactGroups}
                onOpenArtifact={openArtifact}
              />
            ) : rightPaneTab === "artifact" && openArtifactPath ? (
              // Its own close is the tab's close by another name — the same
              // path, so the panel lands where the strip says it should rather
              // than on a Files tab that may not be open.
              <ArtifactPane
                studyId={study.id}
                path={openArtifactPath}
                onClose={() => closeRightPaneTab("artifact")}
              />
            ) : rightPaneTab === "notebook" ? (
              // Keyed on the Task inside `NotebookPanel`, so arriving at
              // another Task resets the panel outright rather than rendering
              // one Task's cells while the next one's reads are still landing.
              <NotebookPanel
                taskId={task.id}
                sessionLabel={task.title}
                embedded
              />
            ) : null}
          </div>
        )}
        </div>

      {pendingDelete && (
        <DeleteTaskModal
          onClose={() => setPendingDelete(null)}
          onConfirm={async () => {
            await deleteTask(pendingDelete.id);
            setPendingDelete(null);
          }}
        />
      )}
      </div>
  );
}

/**
 * The inline Study picker a send raises on an unfiled Task. One question, one
 * select, one confirm — a step inside the send rather than a modal over it,
 * because the researcher has already started the work and is only being asked
 * where it belongs. Cancel abandons the send; the draft is untouched, so the
 * message they wrote is still there to send again.
 *
 * Defaults to the most recently updated Study, which is where the next piece
 * of work most often belongs.
 */
function StudyPicker({
  onConfirm,
  onCancel,
}: {
  onConfirm: (studyId: string) => void;
  onCancel: () => void;
}) {
  const api = useApi();
  const studiesQuery = usePromise(() => api.listStudies(), [api]);
  const studies = useMemo(
    () => [...(studiesQuery.data ?? [])].sort((a, b) => b.updatedTs - a.updatedTs),
    [studiesQuery.data],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const selected = chosen ?? studies[0]?.id ?? "";

  return (
    <div className="composer-filing" role="group" aria-label="File this task">
      <label className="composer-filing-label" htmlFor="composer-filing-study">
        This task has no Study yet. File it to run it.
      </label>
      <div className="composer-filing-row">
        <select
          id="composer-filing-study"
          className="composer-filing-select"
          value={selected}
          onChange={(e) => setChosen(e.target.value)}
        >
          {studies.map((s: Study) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--primary btn--tiny"
          disabled={!selected}
          onClick={() => onConfirm(selected)}
        >
          File and send
        </button>
        <button
          type="button"
          className="btn btn--neutral btn--tiny"
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The severity chip modifier for a finding's severity. */
const SEVERITY_TONE: Record<Severity, string> = {
  high: "severity-chip--high",
  medium: "severity-chip--medium",
  low: "severity-chip--low",
};

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

function FindingCard({
  finding,
  onResolve,
}: {
  finding: Finding;
  onResolve: (findingId: string) => void;
}) {
  return (
    <div className={`finding-card${finding.resolved ? " is-resolved" : ""}`}>
      <div className="finding-head">
        <span className={`severity-chip ${SEVERITY_TONE[finding.severity]}`}>
          {SEVERITY_LABELS[finding.severity]}
        </span>
        <span className="finding-title">
          {FINDING_CLASS_LABELS[finding.class]}
        </span>
      </div>
      <p className="finding-claim">“{finding.claim}”</p>
      <p className="finding-evidence">
        <span className="finding-evidence-label">Evidence</span>
        {finding.evidence}
      </p>
      {finding.location && (
        <span className="finding-location">{finding.location}</span>
      )}
      <div className="finding-actions">
        {finding.resolved ? (
          <span className="finding-resolved">
            <StatusIcon status="done" />
            Resolved
          </span>
        ) : (
          <button
            type="button"
            className="btn btn--neutral btn--tiny"
            onClick={() => onResolve(finding.id)}
          >
            Resolve
          </button>
        )}
      </div>
    </div>
  );
}

export default TaskScreen;
