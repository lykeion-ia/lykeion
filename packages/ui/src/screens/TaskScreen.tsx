import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FINDING_CLASS_LABELS,
  SEVERITY_LABELS,
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
import { StatusIcon } from "../components/StatusIcon";
import { CloseIcon } from "../components/icons";
import { Composer } from "../components/tasks/Composer";
import { PermissionCard } from "../components/tasks/PermissionCard";
import { QuestionCard } from "../components/tasks/QuestionCard";
import { PlanCard } from "../components/tasks/PlanCard";
import { TaskSidebar } from "../components/tasks/TaskSidebar";
import { TaskTabs, type TaskTab } from "../components/tasks/TaskTabs";
import { RunStrip } from "../components/tasks/RunStrip";
import {
  ArtifactsPanel,
  toFileItem,
  type ArtifactGroup,
} from "../components/tasks/ArtifactsPanel";
import { NotebookPanel } from "../components/tasks/NotebookPanel";
import { ArtifactPane } from "../components/tasks/ArtifactPane";
import { AssistantMessage } from "../components/tasks/AssistantMessage";
import { ModelSwitcher } from "../components/tasks/ModelSwitcher";
import {
  TaskTranscript,
  StreamView,
  UserBubble,
} from "../components/tasks/TaskTranscript";
import { modelsForCli } from "../lib/cli-models";
import { useRouter, type Route } from "../router";
import {
  closeTaskTab,
  openTaskTab,
  renameTaskTab,
  taskTabsFor,
  useTaskTabs,
} from "../lib/task-tabs";
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
  const taskQuery = usePromise(
    () => api.getTask(taskId),
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
  useEffect(() => {
    const read = taskQuery.data?.task;
    if (read) setHeldTask(read);
  }, [taskQuery.data]);
  useEffect(() => {
    const read = studyQuery.data?.study;
    if (read) setHeldStudy(read);
  }, [studyQuery.data]);
  const task =
    taskQuery.data?.task ?? (heldTask?.id === taskId ? heldTask : undefined);
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
    viewTurns,
    addViewTurn,
    run: runState,
    pendingPrompt,
  } = useTaskRun(runStudyId, taskId, refreshTasks);

  // Follow the live reply to the bottom while pinned. The signature must grow
  // on every token so streaming prose (and thinking, and tool stdout) keeps
  // the transcript pinned to the tail — see `useStickToBottom`'s jsdoc for
  // the pin rule. Never fights a researcher who has scrolled up to read
  // something older.
  const landedLen = runState.run?.stream?.length ?? 0;
  const turnStreamLen = landedLen > 0 ? landedLen : runState.liveStream.length;
  const liveStdoutLen = (runState.live.toolStdout ?? []).reduce(
    (n, s) => n + s.text.length,
    0,
  );
  const stickDep = [
    history.length,
    viewTurns.length,
    turnStreamLen,
    runState.live.text?.length ?? 0,
    runState.live.thinking?.length ?? 0,
    liveStdoutLen,
  ].join("|");
  const stick = useStickToBottom<HTMLDivElement>(stickDep);

  // The composer's draft text, owned here (not by `Composer`'s internal
  // state) so Edit can refill it from a past prompt — and so a send held back
  // by the Study picker leaves the text exactly where the researcher left it.
  // `inputRef` lets Edit focus the textarea after refilling it.
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // The right-hand inspector: the Study's live Notebook, this Task's
  // artifacts, and one opened artifact. Manual toggle — it never steals the
  // column mid-run.
  const [rightPaneOpen, setRightPaneOpen] = useState(false);
  const [rightPaneTab, setRightPaneTab] = useState<
    "files" | "notebook" | "artifact"
  >("files");
  const [openArtifactPath, setOpenArtifactPath] = useState<string | null>(null);
  const openArtifact = useCallback((path: string) => {
    setOpenArtifactPath(path);
    setRightPaneTab("artifact");
    setRightPaneOpen(true);
  }, []);
  const openFiles = useCallback(() => {
    setRightPaneTab("files");
    setRightPaneOpen(true);
  }, []);

  // The model the next turn runs on. The CLI is NOT chosen here: this surface
  // carries no agent dock, so a turn started from it goes to the first
  // available CLI — the choice belongs to the Study's composer, which is where
  // the work is started from. What that CLI offers is what the switcher lists.
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const effectiveCliId = (clis.find((c) => c.available) ?? clis[0])?.id ?? null;
  const effectiveModel =
    selectedModel ?? modelsForCli(effectiveCliId)[0]?.value ?? null;

  // Reviewer findings for this Task (loaded on open and after a run completes).
  const [findings, setFindings] = useState<Finding[]>([]);
  // Local Done-gate state: the marked-done optimism + any block message.
  const [markedDone, setMarkedDone] = useState(false);
  const [doneError, setDoneError] = useState<string | null>(null);
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

  const runRecord = runState.run;
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
  }, [api, studyId, taskId, runRecord]);

  // Reset per-Task view state whenever the Task changes. Keyed on the Task
  // alone, deliberately not on the Study: the one time a Task's Study changes
  // under a mounted surface is the moment a send files it, and everything
  // reset here — the parked send above all — is exactly what that send is
  // waiting on.
  useEffect(() => {
    setMarkedDone(false);
    setDoneError(null);
    setRightPaneOpen(false);
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
    runState.prompt ??
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

  const markDone = useCallback(() => {
    setDoneError(null);
    api.updateTask(taskId, { status: "done" }).then(
      () => {
        setMarkedDone(true);
        setTaskNonce((n) => n + 1);
        refreshTasks();
      },
      (err: unknown) =>
        setDoneError(err instanceof Error ? err.message : String(err)),
    );
  }, [api, taskId, refreshTasks]);

  // Graduate the current finished turn (if any) into `viewTurns`, so it stays
  // on screen once the live surface moves on to the next `send`.
  const graduateFinishedTurn = useCallback(() => {
    if (!runState.state) return;
    addViewTurn({
      prompt: runState.prompt ?? "",
      messages: [...runState.messages],
      // The landed record where there is one; otherwise what the turn
      // accumulated live. A turn the researcher STOPPED lands no record
      // here, and its cards are as much a part of the transcript as any
      // other — dropping them would undo, one send later, exactly what
      // keeping `liveStream` out of `teardown()` protects.
      stream:
        runState.run?.stream ??
        (runState.liveStream.length > 0 ? runState.liveStream : undefined),
      status: runState.state?.state === "failed" ? "failed" : "ok",
      runId: runState.run?.runId,
    });
  }, [
    addViewTurn,
    runState.state,
    runState.prompt,
    runState.messages,
    runState.run,
    runState.liveStream,
  ]);

  /**
   * Name a chat after the message that started it.
   *
   * A Task minted from a composer takes the truncated prompt as its title, but
   * one started from the sidebar's New is minted before there is any prompt to
   * take — so it lands under a placeholder, and the first send is where the
   * real title is WRITTEN. The title stays an authored field: nothing derives
   * it at render time, a rename replaces it for good, and a second turn leaves
   * it alone.
   *
   * Guarded on both halves of "this chat has never been spoken in": no run has
   * landed, and the title is still the one `newTask` minted. A Task the
   * researcher named themselves — through the New Task form, or a rename that
   * happened to land on the placeholder — keeps the name they gave it.
   */
  const titleFromFirstSend = useCallback(
    (text: string) => {
      if (!task || task.runCount !== 0 || task.title !== NEW_TASK_TITLE) return;
      const title = text.trim().slice(0, 80);
      if (!title) return;
      api.updateTask(taskId, { title }).then(
        () => {
          renameTaskTab(taskId, title);
          refreshTasks();
          setTaskNonce((n) => n + 1);
          invalidate();
        },
        () => {
          // Best-effort: the chat runs either way, and it keeps the
          // placeholder rather than losing the send over a naming write.
        },
      );
    },
    [api, task, taskId, refreshTasks, invalidate],
  );

  const start = runState.start;
  const startTurn = useCallback(
    (text: string, planMode: boolean) => {
      graduateFinishedTurn();
      // The composer's draft is owned here — clear it on send the same way
      // `Composer`'s own internal state would.
      setDraft("");
      titleFromFirstSend(text);
      start(text, { planMode, agent: effectiveCliId, model: effectiveModel });
    },
    [
      graduateFinishedTurn,
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
    if (runState.running) return;
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

  // Delete a Task: it and its transcript go together, its tab is dropped, and
  // — if it was the one on screen — the surface moves to another open Task (or
  // back to the Study).
  const deleteTask = async (id: string) => {
    const remaining = taskTabsFor(studyId).filter((t) => t.taskId !== id);
    try {
      await api.deleteTask(id);
    } catch {
      // Best-effort: still reconcile the UI with the core below.
    }
    closeTaskTab(id);
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

  // This chat's artifacts — the live run's first, then every persisted turn's,
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
    add(code, runRecord?.code);
    add(outputs, runRecord?.outputs);
    for (const turn of [...history].reverse()) {
      add(code, turn.code);
      add(outputs, turn.outputs);
    }
    const groups: ArtifactGroup[] = [];
    if (code.size) groups.push({ title: "Code", items: [...code.values()] });
    if (outputs.size)
      groups.push({ title: "Outputs", items: [...outputs.values()] });
    return groups;
  }, [history, runRecord]);

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
  // A successful Mark Done wins over both.
  const liveStatus: TaskStatus = markedDone
    ? "done"
    : runState.run
      ? "in-review"
      : task.status;
  const showMarkDone = liveStatus === "in-review";

  const state = runState.state;
  const card = runState.pendingCard;
  const question = runState.pendingQuestion;
  // Once the live turn lands, its recorded stream replaces the one accumulated
  // live. Both are `TurnItem[]` and both render through `blocksOf`, so the
  // switch changes nothing on screen except that the landed one is the record:
  // it carries each step's merged result, and it is what a reopen will replay.
  //
  // The presence of the landed stream is the ONLY gate: the run's final state
  // must not change the presentation. The run is recorded unconditionally, so
  // a soft failure (a denied permission, a rejected plan) lands as `Failed`
  // WITH a stream; gating on `completed` too made such a turn render prose live
  // and then flip to cards the moment it graduated on the next send — and again
  // on reopen from the persisted transcript.
  const landedStream = runState.run?.stream;
  const turnStream =
    landedStream && landedStream.length > 0
      ? landedStream
      : runState.liveStream;
  // The in-flight tail beneath the blocks: whatever has NOT yet become a whole
  // message or a merged result. `{}` (the turn's last snapshot, and the whole
  // of it for an adapter that streams no deltas) draws nothing at all.
  const live = runState.live;
  /**
   * One running step's live output, matched to its own card by `toolUseId`.
   *
   * The id match is load-bearing, not decoration: tools run concurrently, so
   * `toolStdout` is a keyed list and taking "the" buffer would print one
   * tool's output under another tool's label.
   */
  const stdoutFor = (toolUseId?: string) =>
    toolUseId
      ? live.toolStdout?.find((s) => s.toolUseId === toolUseId)?.text
      : undefined;

  const planPending =
    state !== null && state.state === "awaiting-plan-approval";

  // Refill the composer with a past prompt and hand focus back to it — see
  // `UserBubble`'s `onEdit` doc comment for what Edit does and does NOT do.
  // Undefined while a run is live: `undefined` renders no Edit button at all,
  // rather than a button that would fight the (disabled) composer for the
  // researcher's next move.
  const editPrompt = runState.running
    ? undefined
    : (text: string) => {
        setDraft(text);
        inputRef.current?.focus();
      };

  const switcher = (
    <ModelSwitcher
      cliId={effectiveCliId}
      selectedModel={effectiveModel}
      onSelect={setSelectedModel}
    />
  );

  // The inspector reads the Study's workspace — its files and its kernel — so
  // an unfiled Task has nothing to open it on. Left undefined rather than
  // shown against an empty workspace, which drops the composer's Notebook
  // button, the run strip's pill and the breadcrumb's toggle together.
  const openNotebook =
    study === undefined
      ? undefined
      : () => {
          setRightPaneTab("notebook");
          setRightPaneOpen(true);
        };

  const composer = (
    <>
      {filing && (
        <StudyPicker
          onConfirm={(id) => void confirmFiling(id)}
          onCancel={() => setFiling(null)}
        />
      )}
      {/* No `placeholder`: `Composer`'s own default is already the docked
          string, and every trigger it names is live here. */}
      <Composer
        variant="docked"
        onSend={send}
        disabled={runState.running}
        blocker={blocker}
        running={runState.running}
        onStop={runState.cancel}
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

  // The left pane lists the Study's Tasks, so it exists only where there is a
  // Study. An unfiled Task leaves the slot to the app Rail (see `ownsRail`).
  const sidebar = study && (
    <TaskSidebar
      study={study}
      filesActive={rightPaneOpen && rightPaneTab === "files"}
      onNew={() => void newTask()}
      onOpenFiles={openFiles}
      tasks={sidebarTasks}
      activeTaskId={taskId}
      onOpenTask={openTask}
      onDeleteTask={(id) => void deleteTask(id)}
      onRenameTask={(id, title) => void renameTask(id, title)}
      onPinTask={(id, pinned) => void pinTask(id, pinned)}
      onMoveTask={(id, destination) => void moveTask(id, destination)}
      studies={studies}
    />
  );

  return (
    <div className="task-screen" data-testid="task-surface">
      <div
        className="task-columns"
        style={{
          // The inspector takes a real share of the width when open, and none
          // at all when closed.
          gridTemplateColumns: `minmax(0, 1fr)${
            rightPaneOpen ? " minmax(400px, 0.82fr)" : ""
          }`,
        }}
      >
        {railView === "context" &&
          railSlot &&
          sidebar &&
          createPortal(sidebar, railSlot)}
        <div className="task-main">
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
            showMarkDone={showMarkDone}
            onMarkDone={markDone}
            doneError={doneError}
            rightPaneOpen={rightPaneOpen}
            onToggleRightPane={
              study === undefined
                ? undefined
                : () => setRightPaneOpen((o) => !o)
            }
            divider={false}
          />
          <div className="task-main-body">
            {/* Every Task opens here — the conversation, whether or not
                anything has been said in it yet. A Task with no turns draws an
                empty transcript over its composer rather than a surface of its
                own: the chat is the Task, so there is nothing to enter first. */}
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
                    onEditPrompt={editPrompt}
                  />

                  {/* Scoped to ONLY the in-flight turn — never `.conv-stream`
                      itself, which would re-announce the whole transcript
                      every time the Task is reopened. */}
                  <div
                    className="conv-live"
                    aria-live="polite"
                    aria-atomic="false"
                    role="log"
                    data-testid="live-region"
                  >
                    {state !== null && (
                      <>
                        <UserBubble
                          prompt={runState.prompt ?? ""}
                          onEdit={runState.running ? undefined : editPrompt}
                        />
                        <StreamView
                          stream={turnStream}
                          stdoutFor={landedStream ? undefined : stdoutFor}
                        />

                        {/* The in-flight tail, under the blocks it will
                        become. Thinking is its OWN channel — never merged
                        into prose, never persisted; the two stay apart
                        because reasoning is not the answer. */}
                        {live.thinking ? (
                          <div
                            className="live-thinking"
                            data-testid="live-thinking"
                          >
                            {live.thinking}
                          </div>
                        ) : null}
                        {live.text ? (
                          <div className="live-text" data-testid="live-text">
                            <AssistantMessage text={live.text} live />
                          </div>
                        ) : null}

                        {runState.plan && (
                          <PlanCard
                            plan={runState.plan}
                            pending={planPending}
                            onApprove={runState.approvePlan}
                            onReject={() => runState.rejectPlan()}
                          />
                        )}

                        {state.state === "awaiting-permission" && card && (
                          <PermissionCard
                            request={card}
                            onAllow={(scope) =>
                              runState.decide(card.id, {
                                decision: "allow",
                                scope,
                              })
                            }
                            onDeny={() =>
                              runState.decide(card.id, { decision: "deny" })
                            }
                          />
                        )}

                        {state.state === "awaiting-question" && question && (
                          <QuestionCard
                            request={question}
                            onAnswer={(selected) =>
                              runState.answerQuestion(
                                question.requestId,
                                selected,
                              )
                            }
                          />
                        )}

                        {state.state in RUN_LINE_LABEL && (
                          <div
                            className="run-line"
                            role="status"
                            data-testid="run-line"
                          >
                            <span className="run-dot" aria-hidden="true" />
                            {RUN_LINE_LABEL[state.state as LiveRunState]}
                          </div>
                        )}

                        {state.state === "completed" && (
                          <div className="run-line run-line--done">
                            <StatusIcon status="done" />
                            Run complete
                          </div>
                        )}

                        {state.state === "failed" && (
                          <div className="run-line run-line--failed">
                            Run failed — {state.reason}
                          </div>
                        )}

                        {state.state === "cancelled" && (
                          <div
                            className={
                              state.unacknowledged
                                ? "run-line run-line--unacknowledged"
                                : "run-line run-line--cancelled"
                            }
                          >
                            {state.unacknowledged
                              ? "The agent has not confirmed it stopped — it may still be running."
                              : "Run stopped"}
                          </div>
                        )}
                      </>
                    )}
                  </div>

                  {findings.length > 0 && (
                    <div className="conv-review">
                      <div className="card-eyebrow">Reviewer findings</div>
                      {orderedFindings.map((f) => (
                        <FindingCard
                          key={f.id}
                          finding={f}
                          onResolve={resolveFinding}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Live plan progress — `Step N of M`, the Reviewing pill, and
                  the Notebook pill that opens the inspector on the live
                  kernel. */}
              <RunStrip
                plan={runState.plan}
                reviewing={runState.reviewing}
                onOpenNotebook={openNotebook}
              />

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

          {/* The inspector is the Study's workspace — artifacts on disk and a
              live kernel — so it exists only where there is one. Every way of
              opening it is already off without a Study; this is the last of
              them, and the one that keeps `ArtifactPane`/`NotebookPanel` from
              ever being handed a Study id there is none of. */}
          {rightPaneOpen && study !== undefined && (
            <div className="task-rightpane">
              <div
                className="rightpane-tabs"
                role="tablist"
                aria-label="Right pane"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightPaneTab === "files"}
                  className={`rightpane-tab${rightPaneTab === "files" ? " is-active" : ""}`}
                  onClick={() => setRightPaneTab("files")}
                >
                  Files
                </button>
                {openArtifactPath && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={rightPaneTab === "artifact"}
                    className={`rightpane-tab${rightPaneTab === "artifact" ? " is-active" : ""}`}
                    onClick={() => setRightPaneTab("artifact")}
                    title={openArtifactPath}
                  >
                    {openArtifactPath.split("/").pop()}
                  </button>
                )}
                <button
                  type="button"
                  role="tab"
                  aria-selected={rightPaneTab === "notebook"}
                  className={`rightpane-tab${rightPaneTab === "notebook" ? " is-active" : ""}`}
                  onClick={() => setRightPaneTab("notebook")}
                >
                  Notebook
                </button>
                <button
                  type="button"
                  className="art-icon-btn rightpane-close"
                  title="Close panel"
                  aria-label="Close panel"
                  onClick={() => setRightPaneOpen(false)}
                >
                  <CloseIcon />
                </button>
              </div>
              {rightPaneTab === "files" ? (
                <ArtifactsPanel
                  groups={artifactGroups}
                  onOpenArtifact={openArtifact}
                />
              ) : rightPaneTab === "artifact" && openArtifactPath ? (
                <ArtifactPane
                  studyId={study.id}
                  path={openArtifactPath}
                  onClose={() => {
                    setOpenArtifactPath(null);
                    setRightPaneTab("files");
                  }}
                />
              ) : (
                <NotebookPanel studyId={study.id} />
              )}
            </div>
          )}
        </div>
      </div>
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
