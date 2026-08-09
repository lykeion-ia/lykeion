import { useEffect, useState } from "react";
import type { Study } from "@lykeion/api";
import { CloseIcon } from "../icons";

export interface DeleteStudyModalProps {
  study: Study;
  /** Tasks the Study holds — shown so the researcher sees what goes with it. */
  taskCount: number;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

/**
 * Confirm deleting a Study — the same centered modal as
 * {@link ./CreateStudyModal}, one step before an action that cannot be taken
 * back. Deleting drops the Study outright; nothing about it is recoverable
 * from inside the workbench, so this confirmation is the only guard against
 * a mis-click. Archive is the reversible operation.
 */
export function DeleteStudyModal({
  study,
  taskCount,
  onClose,
  onConfirm,
}: DeleteStudyModalProps) {
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
        aria-label="Delete study"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[460px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pb-3 pt-4">
          <h2 className="text-read font-semibold text-fg">Delete study?</h2>
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
          <p className="flex min-w-0 items-center gap-2 text-ui">
            <span className="truncate font-medium text-fg">{study.title}</span>
            <span className="shrink-0 rounded border border-line bg-surface-3 px-1.5 py-0.5 text-micro text-fg-subtle">
              {study.key}
            </span>
          </p>
          <p className="text-sub leading-snug text-fg-muted">
            {taskCount === 1 ? "1 task" : `${taskCount} tasks`}, every
            transcript, and the Study's files leave the workspace with it.
          </p>
          <p className="text-sub leading-snug text-fg-subtle">
            This removes the Study and everything it holds. In this session it
            cannot be undone.
          </p>
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
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export default DeleteStudyModal;
