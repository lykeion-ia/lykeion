import { useEffect, useRef, useState } from "react";
import {
  STAGES,
  STAGE_LABELS,
  PRIORITY_LABELS,
  type Assignee,
  type Priority,
  type Stage,
  type Task,
} from "@lykeion/api";
import {
  useApi,
  useDataVersion,
  useInvalidateData,
} from "../../api/ApiContext";
import { usePromise } from "../../hooks/usePromise";
import { useDirectory } from "../../hooks/useDirectory";
import { CloseIcon, ComposeIcon } from "../icons";
import { AssigneeStack } from "../AssigneeStack";
import { AssigneePicker } from "./AssigneePicker";
import { assigneeKey, displayName } from "../../lib/assignee";
import { PRIORITY_ORDER } from "../../lib/task-meta";
import { cn } from "../../lib/utils";

/**
 * Create a real Task, wired to `api.createTask`: pick a Research + stage, set
 * title/description/priority, and assign people (multi). Extra fields
 * (labels, links, subtasks, target date) are edited on the task's Details
 * editor after it exists. No mock data.
 */
export function NewTaskModal({
  onClose,
  onCreated,
  defaultResearchId,
  defaultTitle,
}: {
  onClose: () => void;
  onCreated?: (task: Task) => void;
  defaultResearchId?: string;
  /** Seeds the title field. The researcher edits it before creating. */
  defaultTitle?: string;
}) {
  const api = useApi();
  const dir = useDirectory();
  const invalidate = useInvalidateData();
  const version = useDataVersion();
  const studiesQuery = usePromise(() => api.listResearches(), [api, version]);
  const researches = studiesQuery.data ?? [];
  const meQuery = usePromise(() => api.currentUser(), [api]);
  const me = meQuery.data;

  const [researchId, setResearchId] = useState(defaultResearchId ?? "");
  const [title, setTitle] = useState(defaultTitle ?? "");
  const [description, setDescription] = useState("");
  const [stage, setStage] = useState<Stage>("background");
  const [priority, setPriority] = useState<Priority>("none");
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seededMineRef = useRef(false);

  // No Research is defaulted in. A caller that knows where the Task belongs pins
  // it with `defaultResearchId`; a quick capture from the Rail deliberately
  // creates an unfiled Task rather than silently filing it into whichever
  // Research happens to sort first.

  // Default to assigning the creating member, exactly once, as soon as their
  // identity loads. A ref (not `assignees.length`) gates this: `assignees`
  // reads empty again after the researcher removes the default, and that
  // removal must stick rather than be undone by this effect re-firing.
  useEffect(() => {
    if (!seededMineRef.current && me) {
      seededMineRef.current = true;
      setAssignees([{ kind: "user", userId: me.id }]);
    }
  }, [me]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const removeAssignee = (target: Assignee) =>
    setAssignees((a) =>
      a.filter((x) => assigneeKey(x) !== assigneeKey(target)),
    );

  // `!!me` gates submit until the creating member's identity resolves: the
  // in-memory implementation settles it same-tick, but an IPC-backed one
  // resolves async, and submitting early would silently create an
  // unassigned Task.
  const canSubmit = title.trim().length > 0 && !!me && !busy;

  const submit = () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    api
      .createTask({
        // Empty means unfiled; the contract takes an absent `researchId`, not "".
        researchId: researchId || undefined,
        stage,
        title: title.trim(),
        description: description.trim() || undefined,
        priority,
        assignees,
      })
      .then(
        (task) => {
          // Every caller creates a Task through this modal, so this is the one
          // place that can tell every surface, not just the caller's own
          // `onCreated`, that the data it reads may have changed.
          invalidate();
          onCreated?.(task);
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
        aria-label="Create task"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[620px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 px-4 pb-1 pt-3">
          <ComposeIcon width={15} height={15} className="text-fg-subtle" />
          <span className="text-ui font-medium text-fg">New task</span>
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

        <div className="px-4 pb-2 pt-1">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            className="w-full bg-transparent text-title font-semibold tracking-[-0.2px] text-fg outline-none focus-visible:outline-none! placeholder:text-fg-subtle"
          />
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add a description…"
            className="mt-2 w-full resize-none bg-transparent text-read leading-relaxed text-fg-muted outline-none focus-visible:outline-none! placeholder:text-fg-subtle"
          />
        </div>

        {/* properties */}
        <div className="grid grid-cols-2 gap-2 px-4 pb-3 sm:grid-cols-3">
          <Field label="Research">
            <select
              value={researchId}
              onChange={(e) => setResearchId(e.target.value)}
              className="w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 text-sub text-fg outline-none focus-visible:outline-none! focus:border-line-strong"
            >
              <option value="">
                {researches.length === 0
                  ? "No researches yet — unfiled"
                  : "— No research —"}
              </option>
              {researches.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.key} · {s.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Stage">
            <select
              value={stage}
              onChange={(e) => setStage(e.target.value as Stage)}
              className="w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 text-sub text-fg outline-none focus-visible:outline-none! focus:border-line-strong"
            >
              {STAGES.map((s) => (
                <option key={s} value={s}>
                  {STAGE_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority">
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as Priority)}
              className="w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 text-sub text-fg outline-none focus-visible:outline-none! focus:border-line-strong"
            >
              {PRIORITY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {/* assignees */}
        <div className="px-4 pb-3">
          <div className="mb-1.5 text-meta font-medium uppercase tracking-[0.4px] text-fg-tertiary">
            Assignees
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {assignees.length > 0 && (
              <AssigneeStack
                assignees={assignees}
                size={20}
                ringClass="ring-surface"
              />
            )}
            {assignees.map((a) => (
              <span
                key={assigneeKey(a)}
                className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-sub text-fg-muted"
              >
                {displayName(a, dir)}
                {/* The padding is the pointer target: an 11px glyph is far
                    under the ~24px a click can be aimed at, and every miss
                    lands on inert chip markup. The matching negative margin
                    lets the target spill over the chip's own padding without
                    changing the size the chip draws at. */}
                <button
                  type="button"
                  aria-label={`Remove ${displayName(a, dir)}`}
                  onClick={() => removeAssignee(a)}
                  className="-m-2.5 p-2.5 text-fg-tertiary hover:text-fg"
                >
                  <CloseIcon width={11} height={11} />
                </button>
              </span>
            ))}
            <AssigneePicker value={assignees} onChange={setAssignees} />
          </div>
        </div>

        {error && (
          <p className="px-4 pb-2 text-sub text-danger">{error}</p>
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
            disabled={!canSubmit}
            onClick={submit}
            className={cn(
              "rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity",
              canSubmit ? "hover:opacity-90" : "cursor-not-allowed opacity-40",
            )}
          >
            {busy ? "Creating…" : "Create task"}
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

export default NewTaskModal;
