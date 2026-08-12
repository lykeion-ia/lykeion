import type { Study } from "@lykeion/api";
import { ConfirmModal } from "../ui/ConfirmModal";

export interface DeleteStudyModalProps {
  study: Study;
  /** Tasks the Study holds — shown so the researcher sees what goes with it. */
  taskCount: number;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

/**
 * Confirm deleting a Study, one step before an action that cannot be taken
 * back. Deleting drops the Study outright; nothing about it is recoverable
 * from inside the workbench, so this confirmation is the only guard against
 * a mis-click. Archive is the reversible operation.
 *
 * The dialog itself is {@link ../ui/ConfirmModal}. What stays here is the
 * count: a Study is deleted from a list where its tasks are not on screen,
 * and how many go with it is the fact that changes the answer.
 */
export function DeleteStudyModal({
  study,
  taskCount,
  onClose,
  onConfirm,
}: DeleteStudyModalProps) {
  return (
    <ConfirmModal
      label="Delete study"
      heading="Delete study?"
      confirmLabel="Delete"
      onClose={onClose}
      onConfirm={onConfirm}
      subject={
        <p className="flex min-w-0 items-center gap-2 text-ui">
          <span className="truncate font-medium text-fg">{study.title}</span>
          <span className="shrink-0 rounded border border-line bg-surface-3 px-1.5 py-0.5 text-micro text-fg-subtle">
            {study.key}
          </span>
        </p>
      }
      body={
        <>
          <p className="text-sub leading-snug text-fg-muted">
            {taskCount === 1 ? "1 task" : `${taskCount} tasks`}, every
            transcript, and the Study's files leave the workspace with it.
          </p>
          <p className="text-sub leading-snug text-fg-subtle">
            This removes the Study and everything it holds. It
            cannot be undone.
          </p>
        </>
      }
    />
  );
}

export default DeleteStudyModal;
