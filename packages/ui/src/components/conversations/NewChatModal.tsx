import { useEffect, useState } from "react";
import {
  taskCode,
  type Assignee,
  type Conversation,
  type Task,
} from "@lykeion/api";
import { useApi, useDataVersion, useInvalidateData } from "../../api/ApiContext";
import { usePromise } from "../../hooks/usePromise";
import { useDirectory } from "../../hooks/useDirectory";
import { CloseIcon, ComposeIcon } from "../icons";
import { AssigneeStack } from "../AssigneeStack";
import { AssigneePicker } from "../tasks/AssigneePicker";
import { assigneeKey, displayName } from "../../lib/assignee";
import { cn } from "../../lib/utils";

/**
 * Start a conversation — a thread about one Task, held with colleagues and
 * agents.
 *
 * This is NOT the Task's chat. A Task is already a chat in this workbench: its
 * transcript is the agent's run, and it opens on the Task surface. What this
 * mints is a thread ABOUT that work, which is what the Inbox lists.
 *
 * Deliberately not built on [`Composer`]. That control's affordances — "Plan
 * first", the `@`/`#`/`/` triggers, the machine blocker, the CLI switcher —
 * exist to start agent runs, and every one of them would be a lie over a box
 * that posts a message to a colleague. A plain textarea is the honest control.
 */
export function NewChatModal({
  onClose,
  onCreated,
  defaultStudyId,
  defaultTaskId,
}: {
  onClose: () => void;
  /** The new thread, so the Inbox can select what was just opened. */
  onCreated?: (conversation: Conversation) => void;
  defaultStudyId?: string;
  /** Only honoured when it names a Task inside `defaultStudyId`. */
  defaultTaskId?: string;
}) {
  const api = useApi();
  const dir = useDirectory();
  const invalidate = useInvalidateData();
  const version = useDataVersion();

  const studiesQuery = usePromise(() => api.listStudies(), [api, version]);
  const studies = studiesQuery.data ?? [];

  const [studyId, setStudyId] = useState(defaultStudyId ?? "");
  const [taskId, setTaskId] = useState(defaultTaskId ?? "");
  const [title, setTitle] = useState("");
  const [participants, setParticipants] = useState<Assignee[]>([]);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The chosen Study's Tasks. A thread is about one Task, so there is nothing
  // to offer until a Study names some.
  const detailQuery = usePromise(
    () => (studyId ? api.getStudy(studyId) : Promise.resolve(null)),
    [api, studyId, version],
  );
  const study = detailQuery.data?.study;
  const tasks: Task[] = detailQuery.data?.tasks ?? [];
  const task = tasks.find((t) => t.id === taskId);

  // Changing Study invalidates the Task under it — a task id from the previous
  // Study would submit a thread about work that lives somewhere else, which
  // the core refuses. Clearing it here means the researcher sees the empty
  // picker rather than that rejection.
  useEffect(() => {
    if (taskId && !tasks.some((t) => t.id === taskId)) setTaskId("");
  }, [tasks, taskId]);

  /**
   * Participants follow the subject: choosing a Task seeds the thread with
   * whoever that Task is on.
   *
   * Deliberately NOT the one-shot latch `NewTaskModal` uses for its own
   * default assignee. There, the default answers "who is doing this?" once and
   * removing it must stick. Here the default answers "who is this about?", and
   * changing the Task changes the answer — a thread seeded from CMP-3 that
   * kept CMP-3's people after the subject moved to GEN-8 would be wrong, not
   * preserved. Edits made after the seed survive until the Task changes again.
   */
  useEffect(() => {
    if (!task) return;
    setParticipants(task.assignees ?? []);
  }, [task?.id, task?.assignees]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const removeParticipant = (target: Assignee) =>
    setParticipants((p) =>
      p.filter((x) => assigneeKey(x) !== assigneeKey(target)),
    );

  // All three are load-bearing: a thread needs a subject to be about and a
  // first message to exist at all. The core refuses each of them, and a button
  // that submits into a refusal teaches nothing.
  const canSubmit =
    studyId !== "" && taskId !== "" && body.trim().length > 0 && !busy;

  const submit = () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    api
      .createConversation({
        studyId,
        taskId,
        // Empty means "name it after the Task"; the contract takes an absent
        // title, not "".
        title: title.trim() || undefined,
        participants,
        body: body.trim(),
      })
      .then(
        (conversation) => {
          // Every surface that lists threads reads through the same version
          // counter, so this is the one place that can tell all of them —
          // the Rail's badge included — that the list has changed.
          invalidate();
          onCreated?.(conversation);
          onClose();
        },
        (err: unknown) => {
          setBusy(false);
          setError(err instanceof Error ? err.message : String(err));
        },
      );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Start a conversation"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[620px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 px-4 pb-1 pt-3">
          <ComposeIcon width={15} height={15} className="text-fg-subtle" />
          <span className="text-ui font-medium text-fg">New chat</span>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
          >
            <CloseIcon width={15} height={15} />
          </button>
        </div>

        {/* What the thread is about, chosen before it is written: the people
            below are seeded from the Task, so the subject has to come first. */}
        <div className="grid grid-cols-2 gap-2 px-4 pb-3 pt-1">
          <Field label="Study">
            <select
              value={studyId}
              onChange={(e) => setStudyId(e.target.value)}
              className="w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 text-sub text-fg outline-none focus-visible:outline-none! focus:border-line-strong"
            >
              <option value="">
                {studies.length === 0 ? "No studies yet" : "— Pick a study —"}
              </option>
              {studies.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.key} · {s.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Task">
            <select
              value={taskId}
              disabled={studyId === ""}
              onChange={(e) => setTaskId(e.target.value)}
              className="w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 text-sub text-fg outline-none focus-visible:outline-none! focus:border-line-strong disabled:opacity-50"
            >
              <option value="">
                {studyId === ""
                  ? "Pick a study first"
                  : tasks.length === 0
                    ? "This study holds no tasks"
                    : "— Pick a task —"}
              </option>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {taskCode(study, t)} · {t.title}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="px-4 pb-3">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            // The Task's own title is what an empty field resolves to, so the
            // placeholder shows it rather than describing it.
            placeholder={task ? task.title : "Chat title (optional)"}
            aria-label="Chat title"
            className="w-full bg-transparent text-title font-semibold tracking-[-0.2px] text-fg outline-none focus-visible:outline-none! placeholder:text-fg-subtle"
          />
        </div>

        <div className="px-4 pb-3">
          <div className="mb-1.5 text-meta font-medium uppercase tracking-[0.4px] text-fg-tertiary">
            With
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {participants.length > 0 && (
              <AssigneeStack
                assignees={participants}
                size={20}
                ringClass="ring-surface"
              />
            )}
            {participants.map((p) => (
              <span
                key={assigneeKey(p)}
                className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-sub text-fg-muted"
              >
                {displayName(p, dir)}
                {/* The padding is the pointer target — an 11px glyph is far
                    under the ~24px a click can be aimed at. The matching
                    negative margin lets the target spill past the chip's own
                    padding without changing the size the chip draws at. */}
                <button
                  type="button"
                  aria-label={`Remove ${displayName(p, dir)}`}
                  onClick={() => removeParticipant(p)}
                  className="-m-2.5 p-2.5 text-fg-tertiary hover:text-fg"
                >
                  <CloseIcon width={11} height={11} />
                </button>
              </span>
            ))}
            <AssigneePicker value={participants} onChange={setParticipants} />
          </div>
        </div>

        <div className="px-4 pb-3">
          <textarea
            autoFocus
            rows={4}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              // ⌘↵ / Ctrl+↵ sends. Plain Enter inserts a newline: this is a
              // message being drafted, not a search box, and a first message
              // worth opening a thread for often runs to a paragraph.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Write the first message…"
            aria-label="First message"
            className="w-full resize-none rounded-md border border-line bg-surface-2 px-2.5 py-2 text-read leading-relaxed text-fg outline-none focus-visible:outline-none! focus:border-line-strong placeholder:text-fg-subtle"
          />
        </div>

        {error && <p className="px-4 pb-2 text-sub text-danger">{error}</p>}

        <div className="flex items-center gap-3 border-t border-line px-4 py-3">
          <span className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-ui text-fg-subtle hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className={cn(
              "rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity",
              canSubmit ? "hover:opacity-90" : "cursor-not-allowed opacity-40",
            )}
          >
            {busy ? "Starting…" : "Start chat"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-meta font-medium uppercase tracking-[0.4px] text-fg-tertiary">
        {label}
      </span>
      {children}
    </label>
  );
}

export default NewChatModal;
