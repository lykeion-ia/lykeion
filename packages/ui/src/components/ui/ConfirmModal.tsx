import { useEffect, useState, type ReactNode } from "react";
import { CloseIcon } from "../icons";

export interface ConfirmModalProps {
  /** What this dialog is, for anyone not reading it with their eyes. */
  label: string;
  heading: string;
  /** The thing being acted on, named the way its own surface names it. */
  subject: ReactNode;
  /**
   * What is lost, in the caller's own words and its own elements — rendered
   * as given rather than wrapped, because one action needs a sentence and
   * another needs to itemise before it.
   */
  body: ReactNode;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

/**
 * One step before an action nothing inside the workbench can take back.
 *
 * The mechanism lives here because three surfaces were already drawing this
 * same dialog — deleting a Study, removing a machine, and now deleting a Task
 * — and two of them had drifted into being the same component twice over,
 * closely enough that one said so in its own docstring. A behavioural fix to
 * either (a focus trap, restoring focus on close) would have been made once
 * and silently missed the other.
 *
 * What does NOT live here is the wording. Each caller keeps its own small
 * component saying what its own action costs, because that sentence is the
 * only part of a confirmation anyone reads, and a generic one would be worth
 * less than no dialog at all.
 *
 * A rejected confirmation leaves the dialog open and puts the reason in it.
 * Closing on failure would report the action as done.
 */
export function ConfirmModal({
  label,
  heading,
  subject,
  body,
  confirmLabel,
  onClose,
  onConfirm,
}: ConfirmModalProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
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
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[460px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pb-3 pt-4">
          <h2 className="text-read font-semibold text-fg">{heading}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
          >
            <CloseIcon width={15} height={15} />
          </button>
        </div>

        <div className="space-y-3 px-5 pb-1">
          {subject}
          {body}
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
            autoFocus
            disabled={busy}
            onClick={submit}
            className="rounded-md bg-danger px-3.5 py-1.5 text-ui font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ConfirmModal;
