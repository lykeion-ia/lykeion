import { ConfirmModal } from "../ui/ConfirmModal";

export interface DeleteTaskModalProps {
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

/**
 * Confirm deleting a Task, one step before the only Task row action that
 * cannot be taken back.
 *
 * A Task *is* its chat here, so deleting one is not filing it away — it takes
 * the whole conversation, every turn in it, and whatever those turns wrote.
 * There is no archive for a Task to soften that, which is why this is the one
 * item in the row menu that asks: the reversible actions around it, pinning
 * and renaming, are precisely the ones that should not.
 *
 * It is deliberately not owned by the menu. `ActionMenu` closes on select, so
 * a dialog raised from inside it would unmount with the menu that raised it —
 * the screen owns this, and the menu only says the researcher asked.
 *
 * It does not name the Task. The researcher pointed at the row to open the
 * menu this was raised from, so the title would be the second answer to a
 * question already asked — and it takes no `Task` at all rather than
 * accepting one it does not read.
 */
export function DeleteTaskModal({ onClose, onConfirm }: DeleteTaskModalProps) {
  return (
    <ConfirmModal
      label="Delete task"
      heading="Delete task?"
      confirmLabel="Delete"
      onClose={onClose}
      onConfirm={onConfirm}
      body={
        <p className="text-sub leading-snug text-fg-subtle">
          The chat and every turn in it go with the Task. It
          cannot be undone.
        </p>
      }
    />
  );
}

export default DeleteTaskModal;
