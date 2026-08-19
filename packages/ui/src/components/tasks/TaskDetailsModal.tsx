import { useEffect, useState } from "react";
import {
  taskCode,
  type Assignee,
  type Research,
  type Subtask,
  type Task,
} from "@lykeion/api";
import { useApi } from "../../api/ApiContext";
import {
  CalendarIcon,
  CheckIcon,
  CloseIcon,
  LinkIcon,
  PlusIcon,
} from "../icons";
import { AssigneeStack } from "../AssigneeStack";
import { AssigneePicker } from "./AssigneePicker";
import { ProgressRing } from "../ProgressRing";
import { Popover } from "../ui/Popover";
import { Calendar } from "../filters/CalendarPopover";
import { assigneeKey, displayName } from "../../lib/assignee";
import { useDirectory } from "../../hooks/useDirectory";
import { LABELS, formatTargetDate } from "../../lib/task-meta";
import { cn } from "../../lib/utils";

/**
 * Edit the "core" real fields of an existing Task — assignees, labels, links,
 * target date, and a subtask checklist — then persist them in one
 * `api.updateTask` patch. Opened from a board card; leaves the chat surface
 * (TaskScreen) untouched.
 */
export function TaskDetailsModal({
  task,
  research,
  researches,
  onClose,
  onSaved,
}: {
  task: Task;
  /** The Task's Research, or undefined when it is unfiled. */
  research?: Research;
  /**
   * The Researches an unfiled Task can be filed into. Omit for a Task that
   * already has one — filing is the only reason this modal needs the list.
   */
  researches?: Research[];
  onClose: () => void;
  onSaved?: (task: Task) => void;
}) {
  const api = useApi();
  const dir = useDirectory();
  // Filing is the one edit here that is not just a field: it gives an unfiled
  // Task a home, a code, and a workspace to run in. Empty means "leave it
  // unfiled".
  const [fileInto, setFileInto] = useState("");
  const [assignees, setAssignees] = useState<Assignee[]>(
    task.assignees ?? [],
  );
  const [labelIds, setLabelIds] = useState<string[]>(task.labels ?? []);
  const [links, setLinks] = useState<string[]>(task.links ?? []);
  const [targetDate, setTargetDate] = useState<string | undefined>(
    task.targetDate,
  );
  const [subtasks, setSubtasks] = useState<Subtask[]>(task.subtasks ?? []);
  const [link, setLink] = useState("");
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const addLink = () => {
    const l = link.trim();
    if (l && !links.includes(l)) setLinks((ls) => [...ls, l]);
    setLink("");
  };
  const addSubtask = () => {
    const t = subtaskTitle.trim();
    if (t) setSubtasks((s) => [...s, { title: t, done: false }]);
    setSubtaskTitle("");
  };
  const toggleLabel = (id: string) =>
    setLabelIds((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id],
    );
  const toggleSubtask = (i: number) =>
    setSubtasks((s) =>
      s.map((st, j) => (j === i ? { ...st, done: !st.done } : st)),
    );
  const removeSubtask = (i: number) =>
    setSubtasks((s) => s.filter((_, j) => j !== i));

  const doneCount = subtasks.filter((s) => s.done).length;

  const save = () => {
    setBusy(true);
    setError(null);
    api
      .updateTask(task.id, {
        assignees,
        labels: labelIds,
        links,
        targetDate: targetDate ?? null,
        subtasks,
        // Omitted unless the researcher picked one: passing `undefined` leaves
        // the Task where it is, and there is no un-filing.
        ...(fileInto ? { researchId: fileInto } : {}),
      })
      .then(
        (updated) => {
          onSaved?.(updated);
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
        aria-label="Task details"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[86vh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 px-4 pb-2 pt-3">
          <span className="font-mono text-meta text-fg-tertiary">
            {taskCode(research, task)}
          </span>
          <span className="truncate text-ui font-medium text-fg">
            {task.title}
          </span>
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

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-2">
          {/* Research — only for an unfiled Task, which is the only one that can
              be filed. A Task that already has a Research is moved from the
              Research's own surfaces, not from here. */}
          {research === undefined && researches !== undefined && (
            <Section title="Research">
              <select
                aria-label="File into a Research"
                value={fileInto}
                onChange={(e) => setFileInto(e.target.value)}
                className="w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 text-sub text-fg outline-none focus-visible:outline-none! focus:border-line-strong"
              >
                <option value="">Unfiled — belongs to no Research</option>
                {researches.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.key} · {s.title}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-meta text-fg-tertiary">
                Filing gives this task a code and a workspace. An unfiled task
                can be opened and written in, but not run — a run needs a
                Research's workspace.
              </p>
            </Section>
          )}

          {/* Assignees */}
          <Section title="Assignees">
            <div className="flex flex-wrap items-center gap-2">
              {assignees.length > 0 && (
                <AssigneeStack
                  assignees={assignees}
                  size={20}
                  ringClass="ring-surface"
                />
              )}
              {assignees.map((a) => (
                <Pill
                  key={assigneeKey(a)}
                  onRemove={() =>
                    setAssignees((prev) =>
                      prev.filter((x) => assigneeKey(x) !== assigneeKey(a)),
                    )
                  }
                >
                  {displayName(a, dir)}
                </Pill>
              ))}
              <AssigneePicker value={assignees} onChange={setAssignees} />
            </div>
          </Section>

          {/* Labels */}
          <Section title="Labels">
            <div className="flex flex-wrap gap-1.5">
              {LABELS.map((label) => {
                const on = labelIds.includes(label.id);
                return (
                  <button
                    key={label.id}
                    type="button"
                    onClick={() => toggleLabel(label.id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sub transition-colors",
                      on
                        ? "border-line-strong bg-surface-3 text-fg"
                        : "border-line bg-surface-2 text-fg-subtle hover:text-fg",
                    )}
                  >
                    <span
                      className="h-[7px] w-[7px] shrink-0 rounded-full"
                      style={{ backgroundColor: label.color }}
                    />
                    {label.name}
                    {on && (
                      <CheckIcon
                        width={12}
                        height={12}
                        className="text-fg-subtle"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Target date */}
          <Section title="Target date">
            <Popover
              className="w-fit"
              panelClassName="w-auto"
              trigger={({ toggle }) => (
                <button
                  type="button"
                  onClick={toggle}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-sub text-fg-muted hover:bg-surface-3 hover:text-fg"
                >
                  <CalendarIcon
                    width={14}
                    height={14}
                    className="text-fg-subtle"
                  />
                  {targetDate ? formatTargetDate(targetDate) : "Set date"}
                </button>
              )}
            >
              {({ close }) => (
                <Calendar
                  value={targetDate}
                  onSelect={(iso) => {
                    setTargetDate(iso);
                    close();
                  }}
                />
              )}
            </Popover>
          </Section>

          {/* Links */}
          <Section title="Links">
            <div className="space-y-1.5">
              {links.map((l) => (
                <div key={l} className="flex items-center gap-2">
                  <LinkIcon
                    width={13}
                    height={13}
                    className="shrink-0 text-fg-subtle"
                  />
                  <span className="min-w-0 flex-1 truncate text-sub text-fg-muted">
                    {l}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${l}`}
                    onClick={() => setLinks((ls) => ls.filter((x) => x !== l))}
                    className="text-fg-tertiary hover:text-fg"
                  >
                    <CloseIcon width={12} height={12} />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <input
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && (e.preventDefault(), addLink())
                  }
                  placeholder="https://…"
                  className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-sub text-fg outline-none placeholder:text-fg-tertiary focus:border-line-strong"
                />
                <button
                  type="button"
                  onClick={addLink}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line text-fg-subtle hover:bg-surface-2 hover:text-fg"
                  aria-label="Add link"
                >
                  <PlusIcon width={14} height={14} />
                </button>
              </div>
            </div>
          </Section>

          {/* Subtasks */}
          <Section
            title={
              <span className="inline-flex items-center gap-1.5">
                Subtasks
                {subtasks.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-fg-tertiary">
                    <ProgressRing done={doneCount} total={subtasks.length} />
                    <span className="tabular-nums">
                      {doneCount}/{subtasks.length}
                    </span>
                  </span>
                )}
              </span>
            }
          >
            <div className="space-y-1">
              {subtasks.map((s, i) => (
                <div key={i} className="flex items-center gap-2">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={s.done}
                    aria-label={s.title}
                    onClick={() => toggleSubtask(i)}
                    className={cn(
                      "grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors",
                      s.done
                        ? "border-success bg-success/20 text-success"
                        : "border-line-strong text-transparent hover:border-fg-subtle",
                    )}
                  >
                    <CheckIcon width={11} height={11} />
                  </button>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-sub",
                      s.done
                        ? "text-fg-tertiary line-through"
                        : "text-fg-muted",
                    )}
                  >
                    {s.title}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${s.title}`}
                    onClick={() => removeSubtask(i)}
                    className="text-fg-tertiary hover:text-fg"
                  >
                    <CloseIcon width={12} height={12} />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-2 pt-0.5">
                <input
                  value={subtaskTitle}
                  onChange={(e) => setSubtaskTitle(e.target.value)}
                  onKeyDown={(e) =>
                    e.key === "Enter" && (e.preventDefault(), addSubtask())
                  }
                  placeholder="Add a subtask…"
                  className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-sub text-fg outline-none placeholder:text-fg-tertiary focus:border-line-strong"
                />
                <button
                  type="button"
                  onClick={addSubtask}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line text-fg-subtle hover:bg-surface-2 hover:text-fg"
                  aria-label="Add subtask"
                >
                  <PlusIcon width={14} height={14} />
                </button>
              </div>
            </div>
          </Section>
        </div>

        {error && (
          <p className="px-4 pb-1 text-sub text-danger">{error}</p>
        )}

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
            disabled={busy}
            onClick={save}
            className={cn(
              "rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity",
              busy ? "cursor-not-allowed opacity-40" : "hover:opacity-90",
            )}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-meta font-medium uppercase tracking-[0.4px] text-fg-tertiary">
        {title}
      </div>
      {children}
    </div>
  );
}

function Pill({
  children,
  onRemove,
}: {
  children: React.ReactNode;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-sub text-fg-muted">
      {children}
      {/* The padding is the pointer target: an 11px glyph is far under the
          ~24px a click can be aimed at, and every miss lands on inert pill
          markup. The matching negative margin lets the target spill over the
          pill's own padding without changing the size the pill draws at. */}
      <button
        type="button"
        aria-label="Remove"
        onClick={onRemove}
        className="-m-2.5 p-2.5 text-fg-tertiary hover:text-fg"
      >
        <CloseIcon width={11} height={11} />
      </button>
    </span>
  );
}

export default TaskDetailsModal;
