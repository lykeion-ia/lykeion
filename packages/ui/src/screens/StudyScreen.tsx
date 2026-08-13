import { useMemo, useState, type ReactNode } from "react";
import {
  STAGES,
  STAGE_LABELS,
  titleFromPrompt,
  type Stage,
  type StudyPatch,
  type Task,
  type TaskPatch,
} from "@lykeion/api";
import { useApi, useDataVersion, useInvalidateData } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { useRuntimeBlocker } from "../hooks/useRuntimeBlocker";
import { useListNav } from "../hooks/useListNav";
import { useRouter } from "../router";
import { Composer } from "../components/tasks/Composer";
import { CliDock, cliIdentity } from "../components/tasks/CliDock";
import { ModelSwitcher } from "../components/tasks/ModelSwitcher";
import { CrumbStrip } from "../components/ScreenCrumb";
import { RowLink } from "../components/RowLink";
import { Icon } from "../components/Icon";
import { StudyFormModal } from "../components/studies/StudyFormModal";
import { DeleteStudyModal } from "../components/studies/DeleteStudyModal";
import { DeleteTaskModal } from "../components/tasks/DeleteTaskModal";
import { ActionMenu } from "../components/ui/ActionMenu";
import { InlineRename } from "../components/ui/InlineRename";
import { TaskRowMenu } from "../components/tasks/TaskRowMenu";
import {
  ArchiveIcon,
  KebabIcon,
  PencilIcon,
  PinIcon,
  TrashIcon,
} from "../components/icons";
import { modelOptionOf, noChoiceReason } from "../lib/agent-options";
import { cliIcon } from "../lib/cli-icons";
import { cliInk } from "../lib/cli-brand";
import { stashRun } from "../lib/pending-run";
import { nameChatAfterFirstMessage } from "../lib/task-naming";
import {
  closeTaskTab,
  closeTaskTabsForStudy,
  renameTaskTab,
} from "../lib/task-tabs";
import {
  closeNotebookTab,
  closeNotebookTabsForStudy,
} from "../lib/notebook-tabs";
import { formatAgo } from "../lib/task-meta";
import "./screens.css";
import "./task.css";

/**
 * A research line, opened. The main column names the Study, offers the
 * composer, and then lists every Task the Study holds — assigned to anyone or
 * to no one, open or finished. The list is unfiltered on purpose: a surface
 * that showed only your own work would leave the rest of the Study's Tasks
 * with no click-path from here. The rail carries the standing context a
 * research line accumulates.
 *
 * Sending from the composer mints a Task and hands the prompt off to it: a
 * Task is a chat, so starting a conversation and opening a piece of work are
 * one act. Every chat in the Study is therefore tracked work, and shows up
 * wherever work does.
 */
export function StudyScreen({ studyId }: { studyId: string }) {
  const api = useApi();
  const { navigate } = useRouter();
  const version = useDataVersion();
  const invalidate = useInvalidateData();
  const detail = usePromise(() => api.getStudy(studyId), [api, studyId, version]);
  const clisQuery = usePromise(() => api.listAgentClis(), [api]);
  const clis = clisQuery.data ?? [];
  // `machineNames` rides along on the same `listRuntimes()` read the blocker
  // itself needs — a second, separate read here would fire on every mount
  // and every `invalidate()` for data this hook already has.
  const { blocker, machineNames } = useRuntimeBlocker();
  // Held as a `cliIdentity()` value, not a bare CLI id — a member can pair
  // more than one machine, so `clis` can hold "claude" twice, once per
  // machine, and only the composite says which one this is.
  const [selectedCliId, setSelectedCliId] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Why the last send never left the composer. Cleared on the next attempt.
  const [sendError, setSendError] = useState<string | null>(null);
  // The Study's own two dialogs, and why the last head action failed.
  const [showEdit, setShowEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The Task a researcher has asked to delete from the list, held while they
  // confirm it. Separate from the Study's own delete above: they guard
  // different things and can never be open at once.
  const [pendingTaskDelete, setPendingTaskDelete] = useState<Task | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Which Task row is being renamed in place — at most one at a time.
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const study = detail.data?.study;
  // Pinned Tasks read first. The sort key is the pin and nothing else, and
  // `sort` is stable, so number order survives inside both groups — this list
  // reads by number on purpose (see `listTasks`), and re-sorting it by
  // recency here would quietly break the one ordering the page promises.
  // This flat order is what the keyboard walks; the groups below only decide
  // where the eyebrows fall in it.
  const tasks = useMemo(
    () =>
      [...(detail.data?.tasks ?? [])].sort(
        (a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false),
      ),
    [detail.data?.tasks],
  );
  const pinnedTasks = tasks.filter((t) => t.pinned);
  const restTasks = tasks.filter((t) => !t.pinned);
  // With nothing pinned there is one ungrouped list, and it is all of them.
  // Once a group splits off, what is left is no longer "all".
  const restLabel = pinnedTasks.length > 0 ? "Tasks" : "All tasks";
  // Destinations for a row's "Move to study", newest-worked-on first — the
  // order `StudyPicker` files an unfiled Task by.
  const studiesQuery = usePromise(() => api.listStudies(), [api, version]);
  const studies = useMemo(
    () => [...(studiesQuery.data ?? [])].sort((a, b) => b.updatedTs - a.updatedTs),
    [studiesQuery.data],
  );

  const { index, select, setRef } = useListNav(tasks.length, (i) => {
    const task = tasks[i];
    if (task) navigate({ name: "task", studyId, taskId: task.id });
  });

  // The effective CLI (matches the dock's resolution) drives the model
  // catalogue and is what a send actually names — never the raw dock
  // selection, which is a machine-scoped composite, not a CLI id a run
  // knows how to launch.
  const effectiveCli =
    clis.find((c) => cliIdentity(c) === selectedCliId) ??
    clis.find((c) => c.available) ??
    clis[0];
  const effectiveCliId = effectiveCli?.id ?? null;

  // What this agent itself advertised, which is the only authority on what
  // it offers. Absent when it offered nothing, or when no session could be
  // opened to ask — the pill says which.
  const modelOption = modelOptionOf(effectiveCli);
  const effectiveModel = selectedModel ?? modelOption?.currentValue ?? null;

  // Switching agent drops a value the new one does not offer.
  const selectCli = (identity: string) => {
    setSelectedCliId(identity);
    const cli = clis.find((c) => cliIdentity(c) === identity);
    setSelectedModel((m) =>
      modelOptionOf(cli)?.choices.some((x) => x.value === m) ? m : null,
    );
  };

  const send = async (text: string, opts?: { planMode?: boolean }) => {
    if (busy || !study) return;
    setBusy(true);
    setSendError(null);
    let task: Task;
    try {
      task = await api.createTask({
        studyId,
        stage: "background",
        title: titleFromPrompt(text),
      });
    } catch (err) {
      // Minting the Task IS the send — there is nothing to hand off to without
      // one. Release the composer and say so, rather than leaving it disabled
      // for the rest of the page's life with no explanation.
      setBusy(false);
      setSendError(err instanceof Error ? err.message : String(err));
      return;
    }
    stashRun(task.id, {
      prompt: text,
      // Per-message: a plain send is a normal run; "Plan first" opts in.
      planMode: opts?.planMode ?? false,
      agent: effectiveCliId,
      model: effectiveModel,
    });
    // Fired before the navigation, not after: it is about the Task, not about
    // this screen, and it outlives the screen either way.
    nameChatAfterFirstMessage(api, task.id, text, effectiveCliId, () => invalidate());
    invalidate();
    navigate({ name: "task", studyId, taskId: task.id });
  };

  // Every head action writes, then re-reads. A rejected one says why beside
  // the name rather than leaving the page looking as though nothing happened.
  const patchStudy = async (patch: StudyPatch) => {
    setActionError(null);
    try {
      await api.updateStudy(studyId, patch);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    invalidate();
  };

  // Archive and restore need no confirm: both are reversible and lose
  // nothing, which is exactly what tells them apart from delete. Neither
  // moves you off the page — `getStudy` still resolves for an archived
  // Study, so it only leaves the list.
  const setArchived = async (archived: boolean) => {
    setActionError(null);
    try {
      if (archived) await api.archiveStudy(studyId);
      else await api.restoreStudy(studyId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    invalidate();
  };

  // Delete: the Study leaves the Lab for good. Drop any breadcrumb tabs it
  // owned — they would point at a Study that no longer opens — and leave for
  // the list, because this page has nothing left to show.
  const deleteStudy = async () => {
    await api.deleteStudy(studyId);
    closeTaskTabsForStudy(studyId);
    closeNotebookTabsForStudy(studyId);
    setConfirmDelete(false);
    invalidate();
    navigate({ name: "studies" });
  };

  // The row menu's four actions. Like the head's, each writes and then
  // re-reads rather than guessing at the result: pin, rename and move are
  // presentation in the core, so there is nothing to be optimistic about, and
  // a rejected write leaves the list showing the core's unchanged truth with
  // the reason beside the Study's name.
  const patchTask = async (taskId: string, patch: TaskPatch) => {
    setActionError(null);
    try {
      await api.updateTask(taskId, patch);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    invalidate();
  };

  const renameTask = async (taskId: string, title: string) => {
    // A breadcrumb tab carries the old title until it is told otherwise.
    renameTaskTab(taskId, title);
    await patchTask(taskId, { title });
  };

  // Moving a Task files it elsewhere: it leaves this list, and the tab that
  // pointed at it under this Study would open a route the Task no longer has.
  const moveTask = async (taskId: string, destination: string) => {
    await patchTask(taskId, { studyId: destination });
    closeTaskTab(taskId);
    closeNotebookTab(taskId);
  };

  // Deleting a Task is final — the core tombstones it — and nothing here can
  // restore it, so it is asked about first, the same way it is asked about
  // from the Task's own sidebar. A refusal is left to reject: the dialog is
  // where it can be reported, and closing over one would say the Task was
  // gone when the next read will bring it back.
  const removeTask = async (taskId: string) => {
    setActionError(null);
    await api.deleteTask(taskId);
    closeTaskTab(taskId);
    closeNotebookTab(taskId);
    invalidate();
  };

  // What a detected CLI calls itself, for the row glyph's tooltip. Falls back
  // to the id the turn recorded: a Task keeps naming the agent it ran on even
  // once no machine here reports that CLI any more.
  const agentName = (id: string) => clis.find((c) => c.id === id)?.name ?? id;

  /**
   * One Task line. `i` is its place in the flat, top-to-bottom reading order
   * the list navigates by — which runs across both groups, so an arrow key
   * walks from the last pinned Task into the first unpinned one rather than
   * stopping at the seam.
   */
  const renderTaskRow = (task: Task, i: number) => (
    <div className="study-task-row" key={task.id}>
      {renamingId === task.id ? (
        <InlineRename
          title={task.title}
          label={`Rename ${task.title}`}
          className="study-task-rename"
          onCommit={(next) => {
            setRenamingId(null);
            if (next !== task.title) void renameTask(task.id, next);
          }}
          onCancel={() => setRenamingId(null)}
        />
      ) : (
        <>
          <RowLink
            to={{ name: "task", studyId, taskId: task.id }}
            className={`study-task${i === index ? " is-active" : ""}`}
            rowRef={setRef(i)}
            onFocus={() => select(i)}
          >
            <TaskGlyph
              agent={task.agent}
              name={task.agent ? agentName(task.agent) : undefined}
            />
            <span className="study-task-title">{task.title}</span>
            <span className="study-task-when">{formatAgo(task.updatedTs)}</span>
          </RowLink>
          {/* Shares the row's right slot with the timestamp: the time reads
              at rest, the kebab takes its place on hover or focus, and
              neither moves the row. */}
          <span className="study-task-actions">
            <TaskRowMenu
              title={task.title}
              pinned={!!task.pinned}
              status={task.status}
              triggerClassName="study-task-kebab"
              studies={studies}
              currentStudyId={studyId}
              onPin={() => void patchTask(task.id, { pinned: !task.pinned })}
              onRename={() => setRenamingId(task.id)}
              onMove={(destination) => void moveTask(task.id, destination)}
              onDelete={() => setPendingTaskDelete(task)}
              onSetStatus={(status) => void patchTask(task.id, { status })}
            />
          </span>
        </>
      )}
    </div>
  );

  if (detail.error) {
    return (
      <div className="screen">
        <p className="screen-error">{detail.error}</p>
      </div>
    );
  }
  if (!study) return <div className="screen" aria-busy="true" />;

  const archived = study.archivedTs !== undefined;
  const pinned = study.pinned === true;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="study-page">
      {/* The same strip the Task surface heads with, so the trail does not move
          across the click that opens a run. It sits above the scroller and is
          flush to the panel's edge rather than to the page's centred measure —
          the way out of the page does not travel with the page's contents. */}
      <div className="shrink-0">
        <CrumbStrip page={study.title} />
      </div>

      <div className="study-screen">
        <div className="study-page">
          {/* The name heads the whole page rather than the main column: it
              belongs to the Study, not to the column of work, so it runs the
              page's full measure and the columns begin beneath it. */}
          {/* The head keeps the name alone, so the description can begin the
              main column and start on the rail panel's first line. */}
          <header className="study-head">
            <h1 className="study-title">{study.title}</h1>
            {archived && <span className="study-archived">Archived</span>}
            <span className="study-head-actions">
              <button
                type="button"
                aria-label={pinned ? "Unpin study" : "Pin study"}
                title={pinned ? "Unpin study" : "Pin study"}
                aria-pressed={pinned}
                className={`study-head-action${pinned ? " is-on" : ""}`}
                onClick={() => void patchStudy({ pinned: !pinned })}
              >
                <PinIcon width={15} height={15} />
              </button>
              <ActionMenu
                align="end"
                width="w-52"
                items={[
                  {
                    id: "edit",
                    icon: PencilIcon,
                    label: "Edit",
                    onSelect: () => setShowEdit(true),
                  },
                  archived
                    ? {
                        id: "restore",
                        icon: ArchiveIcon,
                        label: "Restore",
                        onSelect: () => void setArchived(false),
                      }
                    : {
                        id: "archive",
                        icon: ArchiveIcon,
                        label: "Archive",
                        onSelect: () => void setArchived(true),
                      },
                  {
                    id: "delete",
                    icon: TrashIcon,
                    label: "Delete",
                    danger: true,
                    separatorBefore: true,
                    onSelect: () => setConfirmDelete(true),
                  },
                ]}
              >
                {({ open, toggle }) => (
                  <button
                    type="button"
                    aria-label="Study actions"
                    title="Study actions"
                    aria-haspopup="menu"
                    aria-expanded={open}
                    className="study-head-action"
                    onClick={toggle}
                  >
                    <KebabIcon width={15} height={15} />
                  </button>
                )}
              </ActionMenu>
            </span>
          </header>

          <div className="study-columns">
            <div className="study-main">
              {study.description && (
                <p className="study-description">{study.description}</p>
              )}
              {actionError && <p className="study-card-note">{actionError}</p>}

              {/* The composer opens the page's work: no hero question above it
                  — the header already names the Study, so the box is the ask. */}
              <section className="study-composer" aria-label="Start a task">
                <CliDock
                  clis={clis}
                  selectedId={selectedCliId}
                  onSelect={selectCli}
                  machineNames={machineNames}
                />
                <Composer
                  variant="hero"
                  onSend={(text, opts) => void send(text, opts)}
                  disabled={busy}
                  blocker={blocker}
                  placeholder="Describe a task, or run a command — ⌘K to search…"
                  switcher={
                    <ModelSwitcher
                      {...(modelOption ? { option: modelOption } : {})}
                      reason={noChoiceReason(effectiveCli)}
                      selectedModel={effectiveModel}
                      onSelect={setSelectedModel}
                    />
                  }
                />
                {sendError && <p className="study-card-note">{sendError}</p>}
              </section>

              {/* A pinned Task reads first, in a group of its own, directly
                  under the composer — the same shape a pinned Study takes on
                  the Studies list. The group only exists while something is
                  pinned: an eyebrow over a list nobody has pinned anything in
                  is noise. */}
              {pinnedTasks.length > 0 && (
                <section className="study-tasks" aria-label="Pinned">
                  <h2 className="study-tasks-label">Pinned</h2>
                  {pinnedTasks.map((task, i) => renderTaskRow(task, i))}
                </section>
              )}

              {(restTasks.length > 0 || tasks.length === 0) && (
                <section className="study-tasks" aria-label={restLabel}>
                  <h2 className="study-tasks-label">{restLabel}</h2>
                  {tasks.length === 0 ? (
                    <p className="study-tasks-empty">
                      No tasks yet — this Study holds no work of its own.
                    </p>
                  ) : (
                    restTasks.map((task, j) =>
                      renderTaskRow(task, pinnedTasks.length + j),
                    )
                  )}
                </section>
              )}
            </div>

            <aside className="study-rail">
              <div className="study-rail-panel">
                <InstructionsCard
                  value={study.agentContext ?? ""}
                  onSave={async (agentContext) => {
                    await api.updateStudy(studyId, { agentContext });
                    invalidate();
                  }}
                />

                <RailCard title="Memory">
                  {/* Nothing in the contract holds a Study's accumulated
                      memory, so the card says it is empty and offers no
                      control. */}
                  <p className="study-card-empty">
                    Nothing remembered — this Study has kept no notes of its
                    own.
                  </p>
                </RailCard>

                <RailCard title="Scientific stages">
                  <ul className="study-stage-list">
                    {STAGES.map((stage) => (
                      <li key={stage} className="study-stage">
                        <span className="study-stage-label">
                          {STAGE_LABELS[stage]}
                        </span>
                        <span className="study-stage-count">
                          {countAt(tasks, stage)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </RailCard>

                <RailCard title="Files">
                  {/* Nothing here reads a Study's artifact bytes, so the card
                      says it is empty and offers no control. */}
                  <p className="study-card-empty">
                    No files — nothing has been written into this Study.
                  </p>
                </RailCard>
              </div>
            </aside>
          </div>
        </div>
      </div>

      {showEdit && (
        <StudyFormModal
          study={study}
          onClose={() => setShowEdit(false)}
          onSubmit={async (input) => {
            await api.updateStudy(studyId, input);
            setShowEdit(false);
            invalidate();
          }}
        />
      )}

      {confirmDelete && (
        <DeleteStudyModal
          study={study}
          taskCount={tasks.length}
          onClose={() => setConfirmDelete(false)}
          onConfirm={deleteStudy}
        />
      )}

      {pendingTaskDelete && (
        <DeleteTaskModal
          onClose={() => setPendingTaskDelete(null)}
          onConfirm={async () => {
            await removeTask(pendingTaskDelete.id);
            setPendingTaskDelete(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * What a Task row leads with: the mark of the coding agent it is talking to,
 * drawn from the same brand set the composer's CLI dock wears, so one drawing
 * means one agent everywhere on this page. Which agent is on a piece of work
 * is the fact that separates two rows of this list, and reading it off the
 * row is what saves opening the Task to find out.
 *
 * A Task nobody has run is on no agent, and an agent with no bundled mark has
 * nothing to draw — both keep the chat glyph, which is what a Task is before
 * it is anything else, and the same one the rail's conversation control
 * carries.
 *
 * The mark wears its brand's own colour. Which agent is on a piece of work is
 * what this column is FOR, and a column of identical grey silhouettes made a
 * reader tell Claude from Codex by their outlines at 14px — colour is the
 * fastest thing on a row to read, and it is the one fact these drawings carry
 * that a shape does not. The chat glyph keeps the row's ink: it stands for no
 * brand, so it has no colour to be in. Brands whose mark is black or white
 * keep the row's ink too; see `cliInk`.
 */
function TaskGlyph({ agent, name }: { agent?: string; name?: string }) {
  const Mark = agent ? cliIcon(agent) : null;
  const ink = Mark && agent ? cliInk(agent) : null;
  return (
    <span
      className="study-task-glyph"
      // Out of the accessibility tree rather than named: this sits inside the
      // row's link, and a titled child with no readable content of its own
      // would be folded into the link's name — so the row would announce its
      // agent before its title.
      aria-hidden="true"
      {...(ink ? { style: { color: ink } } : {})}
      {...(Mark ? { "data-agent": agent, title: name } : {})}
    >
      {Mark ? (
        <Mark className="study-task-mark" />
      ) : (
        <Icon name="chat" size={14} />
      )}
    </span>
  );
}

/** How many of a Study's Tasks sit at one stage of the scientific arc. */
function countAt(tasks: Task[], stage: Stage): number {
  return tasks.filter((t) => t.stage === stage).length;
}

/**
 * One rail card: a title, an optional action beside it, and a body. The action
 * is optional because a card whose feature has nothing behind it must not
 * offer a control — an empty state says more than a button that does nothing.
 */
function RailCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="study-card" aria-label={title}>
      <div className="study-card-head">
        <h2 className="study-card-title">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * What every agent started in this Study is told. Editable in place — a card
 * that shows a value it cannot change is worse than no card.
 */
function InstructionsCard({
  value,
  onSave,
}: {
  value: string;
  onSave: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = () => {
    setDraft(value);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft.trim());
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  };

  return (
    <RailCard
      title="Instructions"
      action={
        editing ? undefined : (
          <button
            type="button"
            aria-label="Edit instructions"
            className="study-card-action"
            onClick={open}
          >
            Edit
          </button>
        )
      }
    >
      {editing ? (
        <>
          <textarea
            aria-label="Instructions"
            className="study-card-textarea"
            rows={7}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="study-card-actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={saving}
              onClick={() => void save()}
            >
              Save
            </button>
            <button
              type="button"
              className="btn btn--neutral"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
          {error && <p className="study-card-note">{error}</p>}
        </>
      ) : value ? (
        <p className="study-card-prose">{value}</p>
      ) : (
        <p className="study-card-empty">
          Nothing yet — agents here start with no standing context.
        </p>
      )}
    </RailCard>
  );
}

export default StudyScreen;
