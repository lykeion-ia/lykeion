import { useEffect, useState } from "react";
import type { Research } from "@lykeion/api";
import { CloseIcon } from "../icons";
import type { NewResearchInput } from "../../lib/research-meta";

export interface ResearchFormModalProps {
  /**
   * The Research being edited. Absent means the form opens empty and mints a new
   * one — the same three fields either way, because what a Research is does not
   * change between opening one and correcting one.
   */
  research?: Research;
  onClose: () => void;
  /**
   * Hand back what was typed. The caller decides whether that means
   * `createResearch` or `updateResearch`; every field is always present, so an
   * emptied Description clears the Research's rather than leaving it unpatched.
   */
  onSubmit: (input: NewResearchInput) => Promise<void>;
}

/** New/Edit Research — a centered modal, the same shape as
 *  {@link ./DeleteResearchModal}. Name → title, plus a reference Description and
 *  an Agent Context injected into agent prompts. */
export function ResearchFormModal({
  research,
  onClose,
  onSubmit,
}: ResearchFormModalProps) {
  const editing = research !== undefined;
  const [title, setTitle] = useState(research?.title ?? "");
  const [description, setDescription] = useState(research?.description ?? "");
  const [agentContext, setAgentContext] = useState(research?.agentContext ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canSubmit = title.trim().length > 0 && !busy;
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim(),
        agentContext: agentContext.trim(),
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
        aria-label={editing ? "Edit research" : "Create research"}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pb-3 pt-4">
          <h2 className="text-read font-semibold text-fg">
            {editing ? "Edit Research" : "New Research"}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
          >
            <CloseIcon width={15} height={15} />
          </button>
        </div>

        <div className="space-y-4 px-5 pb-1">
          <label className="flex flex-col gap-1.5">
            <span className="text-sub font-medium text-fg-muted">
              Name
            </span>
            {/* Named explicitly rather than by the wrapping label: the two
                fields below carry help text inside theirs, which would
                otherwise become part of the control's name. */}
            <input
              autoFocus
              aria-label="Name"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="Research name"
              autoComplete="off"
              className="w-full rounded-md border border-line bg-surface-2 px-2.5 py-2 text-ui text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sub font-medium text-fg-muted">
              Description
            </span>
            <span className="text-sub leading-snug text-fg-subtle">
              Shown in the research list for your reference — not included in the
              agent's prompt.
            </span>
            <textarea
              aria-label="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what this research is about…"
              rows={3}
              className="w-full resize-none rounded-md border border-line bg-surface-2 px-2.5 py-2 text-ui text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sub font-medium text-fg-muted">
              Agent Context
            </span>
            <span className="text-sub leading-snug text-fg-subtle">
              This context will be included in every agent's system prompt for
              this research. Use it to provide background information, conventions,
              or instructions that all agents should follow.
            </span>
            <textarea
              aria-label="Agent Context"
              value={agentContext}
              onChange={(e) => setAgentContext(e.target.value)}
              placeholder="e.g., This research examines the effects of compound X on gene Y in cell line Z. Always use GRCh38 for genome references…"
              rows={4}
              className="w-full resize-none rounded-md border border-line bg-surface-2 px-2.5 py-2 text-ui text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong"
            />
          </label>

          {error && <p className="text-sub text-danger">{error}</p>}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-ui text-fg-muted hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {editing ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ResearchFormModal;
