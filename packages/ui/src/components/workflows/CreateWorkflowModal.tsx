import { useEffect, useState } from "react";
import {
  CORE_PHASES,
  DISCIPLINES,
  DISCIPLINE_LABELS,
  METHOD_PHASES,
  METHOD_PHASE_LABELS,
  type Discipline,
  type MethodPhase,
  type Placeholder,
  type Workflow,
} from "@lykeion/api";
import { CloseIcon } from "../icons";
import { DISCIPLINE_COLOR } from "../../lib/workflow-meta";
import { cn } from "../../lib/utils";

const LABEL = "text-[12.5px] font-medium text-fg-muted";
const FIELD =
  "w-full rounded-md border border-line bg-surface-2 px-2.5 py-2 text-[13px] text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong";

/** Turn a name into a stable id token. */
export function slugId(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workflow"
  );
}

/** The unique `{token}` placeholders in a prompt, in first-seen order. */
export function parsePlaceholders(prompt: string): Placeholder[] {
  const seen = new Set<string>();
  const out: Placeholder[] = [];
  for (const m of prompt.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      required: true,
    });
  }
  return out;
}

export function CreateWorkflowModal({
  onCreate,
  onClose,
}: {
  onCreate: (workflow: Workflow) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [discipline, setDiscipline] = useState<Discipline>("general");
  const [prompt, setPrompt] = useState("");
  const [phases, setPhases] = useState<MethodPhase[]>(CORE_PHASES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const placeholders = parsePlaceholders(prompt);
  const canCreate = Boolean(name.trim()) && Boolean(prompt.trim()) && !busy;

  // Selection is held as a set and read back through the spine's order, so a
  // procedure's phases are a subsequence however they were clicked.
  const togglePhase = (phase: MethodPhase) =>
    setPhases((current) => {
      const next = new Set(current);
      if (next.has(phase)) next.delete(phase);
      else next.add(phase);
      return METHOD_PHASES.filter((p) => next.has(p));
    });

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({
        id: slugId(name),
        name: name.trim(),
        description: description.trim(),
        discipline,
        icon: "flow",
        prompt: prompt.trim(),
        placeholders,
        phases,
        suggestedSkills: [],
        requiresFiles: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Create workflow"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-[600px] flex-col rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 className="text-[15px] font-semibold text-fg">Create Workflow</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
          >
            <CloseIcon width={15} height={15} />
          </button>
        </div>
        <p className="px-5 text-[13px] text-fg-subtle">
          A research procedure, and the phases of the method it runs.
        </p>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Name</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Differential expression"
              className={FIELD}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className={LABEL}>Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this workflow produces"
              className={FIELD}
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>Discipline</span>
            <div className="grid grid-cols-4 gap-2">
              {DISCIPLINES.map((option) => {
                const selected = discipline === option;
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setDiscipline(option)}
                    aria-pressed={selected}
                    className={cn(
                      "flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left text-[12px] transition-colors",
                      selected
                        ? "border-line-strong bg-surface-2 text-fg"
                        : "border-line text-fg-muted hover:bg-surface-2",
                    )}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: DISCIPLINE_COLOR[option] }}
                    />
                    <span className="truncate">
                      {DISCIPLINE_LABELS[option]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <span className={LABEL}>Prompt template</span>
            <textarea
              value={prompt}
              rows={4}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Load {counts_file} and compare {group_a} vs {group_b}…"
              className={cn(FIELD, "resize-y")}
            />
            <span className="text-[11px] text-fg-tertiary">
              Wrap fillable slots in braces, e.g. {"{group_a}"}.
              {placeholders.length > 0 &&
                ` Detected: ${placeholders.map((p) => p.key).join(", ")}.`}
            </span>
          </label>

          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>Phases</span>
            <div className="grid grid-cols-2 gap-2">
              {METHOD_PHASES.map((phase) => {
                const selected = phases.includes(phase);
                return (
                  <button
                    key={phase}
                    type="button"
                    onClick={() => togglePhase(phase)}
                    aria-pressed={selected}
                    className={cn(
                      "rounded-lg border px-2.5 py-1.5 text-left text-[12px] transition-colors",
                      selected
                        ? "border-line-strong bg-surface-2 text-fg"
                        : "border-line text-fg-muted hover:bg-surface-2",
                    )}
                  >
                    {METHOD_PHASE_LABELS[phase]}
                  </button>
                );
              })}
            </div>
            <span className="text-[11px] text-fg-tertiary">
              Leave out the phases this procedure has nothing to do in.
            </span>
          </div>

          {error && (
            <p className="text-[12px] text-danger" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-fg-muted hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canCreate}
            onClick={submit}
            className={cn(
              "rounded-md bg-fg px-3.5 py-1.5 text-[13px] font-medium text-canvas transition-opacity",
              canCreate ? "hover:opacity-90" : "cursor-not-allowed opacity-50",
            )}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

export default CreateWorkflowModal;
