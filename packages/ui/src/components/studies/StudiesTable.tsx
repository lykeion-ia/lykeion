import type { MouseEvent } from "react";
import type { Study, Task } from "@lykeion/api";
import { RowLink } from "../RowLink";
import { ArchiveIcon, PencilIcon, TrashIcon } from "../icons";
import { InlineRename } from "../ui/InlineRename";
import { deriveStudyMeta } from "../../lib/study-meta";
import { formatAgo } from "../../lib/task-meta";
import { cn } from "../../lib/utils";
import { useDirectory } from "../../hooks/useDirectory";

export interface StudiesTableProps {
  studies: Study[];
  tasksByStudy: Record<string, Task[]>;
  /** Which row is being renamed in place, if any (owned by the screen). */
  renamingId?: string | null;
  /** Start renaming a row. Omit to hide the rename action. */
  onStartRename?: (studyId: string) => void;
  /** Commit a rename; `title` is already trimmed and non-blank. */
  onRename?: (studyId: string, title: string) => void;
  onCancelRename?: () => void;
  /** Ask to delete a Study (the screen owns the confirm). Omit to hide it. */
  onDelete?: (study: Study) => void;
  /** Archive a Study out of the list. Omit to hide the action. */
  onArchive?: (study: Study) => void;
  /** Bring an archived Study back. Omit to hide the action. */
  onRestore?: (study: Study) => void;
}

// Column template shared by the header and every row so widths line up. The
// trailing column holds the row actions (and an empty header cell).
const GRID_COLS = "grid-cols-[minmax(0,1fr)_100px_130px_150px_110px_90px_58px]";

// Row padding/typography, shared by the link row and its renaming twin.
const ROW_CLASS = "grid items-center gap-3 px-3 py-2.5 text-ui";

// The small muted tag styling shared by the key badge and the Archived marker.
const BADGE_CLASS =
  "shrink-0 rounded border border-line bg-surface-3 px-1.5 py-0.5 text-micro text-fg-subtle";

// The eyebrow over a group of rows. It reuses the column header's typography
// so the two read as one system rather than two competing labels.
const GROUP_LABEL_CLASS =
  "px-3 pb-1.5 pt-4 text-meta font-medium uppercase tracking-[0.4px] text-fg-tertiary";

export function StudiesTable({
  studies,
  tasksByStudy,
  renamingId = null,
  onStartRename,
  onRename,
  onCancelRename,
  onDelete,
  onArchive,
  onRestore,
}: StudiesTableProps) {
  const dir = useDirectory();

  // Pinned Studies read first, in a group of their own. Within each group the
  // order is the one the screen handed over — filtering and sorting happened
  // before this component saw the list, and pinning must not disturb them.
  const pinned = studies.filter((s) => s.pinned);
  const rest = studies.filter((s) => !s.pinned);

  const renderRow = (study: Study) => {
    const tasks = tasksByStudy[study.id] ?? [];
    const meta = deriveStudyMeta(study, tasks, dir);
    const progressPct =
      meta.totalCount > 0
        ? Math.round((meta.doneCount / meta.totalCount) * 100)
        : 0;

    const renaming = renamingId === study.id && !!onRename;
    const cells = (
      <>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-fg">{study.title}</span>
          <span className={BADGE_CLASS}>{study.key}</span>
          {study.archivedTs !== undefined && (
            <span className={BADGE_CLASS}>Archived</span>
          )}
        </span>

        <span className="truncate text-fg-muted">{meta.priorityLabel}</span>

        <span className="inline-flex items-center gap-1.5 text-fg-muted">
          <span
            className={cn("h-2 w-2 shrink-0 rounded-full", meta.statusDotClass)}
          />
          {meta.statusLabel}
        </span>

        <span className="flex items-center gap-2">
          <span className="h-1.5 w-16 overflow-hidden rounded border border-line bg-surface-3">
            <span
              className="block h-full bg-accent"
              style={{ width: `${progressPct}%` }}
            />
          </span>
          <span className="text-meta tabular-nums text-fg-tertiary">
            {meta.doneCount}/{meta.totalCount}
          </span>
        </span>

        <span className="flex items-center gap-1.5 text-fg-muted">
          {meta.lead ? (
            <>
              <span
                className="grid h-4 w-4 shrink-0 place-items-center rounded-[5px] text-micro font-semibold text-white"
                style={{
                  backgroundImage: `linear-gradient(135deg, ${meta.lead.gradient[0]}, ${meta.lead.gradient[1]})`,
                }}
              >
                {meta.lead.initial}
              </span>
              <span className="truncate">{meta.lead.label}</span>
            </>
          ) : (
            <span className="text-fg-tertiary">—</span>
          )}
        </span>

        <span className="truncate text-fg-tertiary">
          {formatAgo(study.createdTs)}
        </span>

        {/* Reserved for the actions, which overlay this column as a
            sibling of the link (an anchor may not contain buttons). */}
        <span />
      </>
    );

    return (
      <div
        key={study.id}
        className="group relative border-b border-line-soft hover:bg-surface-2"
      >
        {renaming ? (
          // While renaming, the row is NOT a link: Enter and every
          // keystroke belong to the input, never to navigation.
          <div className={cn(ROW_CLASS, GRID_COLS)}>
            <span className="flex min-w-0 items-center gap-2">
              <InlineRename
                title={study.title}
                label={`Rename ${study.title}`}
                className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface-2 px-1.5 py-0.5 text-ui font-medium text-fg outline-none"
                onCommit={(next) => onRename?.(study.id, next)}
                onCancel={() => onCancelRename?.()}
              />
              <span className={BADGE_CLASS}>{study.key}</span>
            </span>
            <span className="col-span-5" />
          </div>
        ) : (
          <RowLink
            to={{ name: "study", studyId: study.id }}
            className={cn(ROW_CLASS, GRID_COLS)}
          >
            {cells}
          </RowLink>
        )}

        {!renaming && (onStartRename || onArchive || onRestore || onDelete) && (
          <span className="absolute inset-y-0 right-3 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            {onStartRename && (
              <RowAction
                label={`Rename ${study.title}`}
                onClick={() => onStartRename(study.id)}
              >
                <PencilIcon width={14} height={14} />
              </RowAction>
            )}
            {study.archivedTs === undefined
              ? onArchive && (
                  <RowAction
                    label={`Archive ${study.title}`}
                    onClick={() => onArchive(study)}
                  >
                    <ArchiveIcon width={14} height={14} />
                  </RowAction>
                )
              : onRestore && (
                  <RowAction
                    label={`Restore ${study.title}`}
                    onClick={() => onRestore(study)}
                  >
                    <ArchiveIcon width={14} height={14} />
                  </RowAction>
                )}
            {onDelete && (
              <RowAction
                label={`Delete ${study.title}`}
                danger
                onClick={() => onDelete(study)}
              >
                <TrashIcon width={14} height={14} />
              </RowAction>
            )}
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="flex-1 overflow-auto px-5 pb-5">
      <div
        className={cn(
          "grid items-center gap-3 border-b border-line px-3 py-2 text-meta font-medium uppercase tracking-[0.4px] text-fg-tertiary",
          GRID_COLS,
        )}
      >
        <span>Name</span>
        <span>Priority</span>
        <span>Status</span>
        <span>Progress</span>
        <span>Lead</span>
        <span>Created</span>
        <span />
      </div>

      {/* The groups only exist while something is pinned — an eyebrow over a
          single ungrouped run of rows would be noise on a list nobody has
          pinned anything in. */}
      {pinned.length > 0 ? (
        <>
          <div className={GROUP_LABEL_CLASS}>Pinned</div>
          {pinned.map(renderRow)}
          {rest.length > 0 && (
            <>
              <div className={GROUP_LABEL_CLASS}>Studies</div>
              {rest.map(renderRow)}
            </>
          )}
        </>
      ) : (
        rest.map(renderRow)
      )}
    </div>
  );
}

/** One hover-revealed row action — icon-only, named for screen readers. */
function RowAction({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: (e: MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid h-6 w-6 place-items-center rounded-md text-fg-subtle hover:bg-surface-3",
        danger ? "hover:text-danger" : "hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

export default StudiesTable;
