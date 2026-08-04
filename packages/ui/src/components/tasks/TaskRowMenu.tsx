import type { Study } from "@lykeion/api";
import { ActionMenu, type ActionMenuItem } from "../ui/ActionMenu";
import { FlaskIcon, KebabIcon, PencilIcon, PinIcon, TrashIcon } from "../icons";
import { cn } from "../../lib/utils";

export interface TaskRowMenuProps {
  /** Names the Task in the trigger's accessible label. */
  title: string;
  pinned: boolean;
  /** Classes for the menu root — the surface's own positioning slot. */
  className?: string;
  /** Classes for the kebab button, which each surface sizes for itself. */
  triggerClassName?: string;
  /** Which edge the panel hangs from. Rows sit at the right, so "end". */
  align?: "start" | "end";
  /** Candidate destinations for a move. The Task's own Study is dropped. */
  studies?: Study[];
  /** The Study the Task is in now, so it never offers a move to itself. */
  currentStudyId?: string;
  onPin?: () => void;
  onRename?: () => void;
  onMove?: (studyId: string) => void;
  onDelete?: () => void;
}

/**
 * The per-Task kebab menu — Pin · Rename · Move to study · Delete — shared by
 * every surface that lists Tasks, so the same row offers the same four things
 * wherever a reader meets it.
 *
 * Every action is optional and an omitted handler drops its item: a caller
 * that can only offer some of them still gets a coherent menu, and one that
 * can offer none renders nothing at all rather than an empty popover.
 */
export function TaskRowMenu({
  title,
  pinned,
  className,
  triggerClassName,
  align = "end",
  studies,
  currentStudyId,
  onPin,
  onRename,
  onMove,
  onDelete,
}: TaskRowMenuProps) {
  const items: ActionMenuItem[] = [];

  if (onPin)
    items.push({
      id: "pin",
      icon: PinIcon,
      label: pinned ? "Unpin" : "Pin",
      onSelect: onPin,
    });

  if (onRename)
    items.push({
      id: "rename",
      icon: PencilIcon,
      label: "Rename",
      onSelect: onRename,
    });

  // A lab with one Study has nowhere to move a Task to, and a menu row that
  // opens an empty flyout is worse than no row.
  const destinations = (studies ?? []).filter((s) => s.id !== currentStudyId);
  if (onMove && destinations.length > 0)
    items.push({
      id: "move",
      icon: FlaskIcon,
      label: "Move to study",
      submenu: destinations.map((study) => ({
        id: study.id,
        icon: FlaskIcon,
        label: study.title,
        detail: study.key,
        onSelect: () => onMove(study.id),
      })),
    });

  if (onDelete)
    items.push({
      id: "delete",
      icon: TrashIcon,
      label: "Delete",
      danger: true,
      // Only rule off the destructive row when something sits above it.
      separatorBefore: items.length > 0,
      onSelect: onDelete,
    });

  if (items.length === 0) return null;

  return (
    <ActionMenu items={items} align={align} width="w-56" className={className}>
      {({ open, toggle }) => (
        <button
          type="button"
          className={cn(triggerClassName)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Task actions for ${title}`}
          onClick={(e) => {
            // The trigger sits on top of the row's own link on some surfaces,
            // and opening a menu is never a navigation.
            e.preventDefault();
            e.stopPropagation();
            toggle();
          }}
        >
          <KebabIcon width={14} height={14} />
        </button>
      )}
    </ActionMenu>
  );
}

export default TaskRowMenu;
