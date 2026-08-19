import type { ColleagueRow } from "./colleague-meta";
import { UserAvatar } from "../UserAvatar";
import { formatAgo } from "../../lib/task-meta";
import { cn } from "../../lib/utils";

const GRID_COLS =
  "grid-cols-[minmax(0,1.4fr)_92px_128px_minmax(0,1fr)_88px_88px_72px]";
const ROW_CLASS = "grid items-center gap-3 px-3 py-2.5 text-ui";
const BADGE_CLASS =
  "shrink-0 rounded border border-line bg-surface-3 px-1.5 py-0.5 text-micro text-fg-subtle";

export interface ColleaguesTableProps {
  rows: ColleagueRow[];
  /** Offer Remove on this row. The screen decides — see `canRemove` there. */
  canRemove?: (row: ColleagueRow) => boolean;
  onRemove?: (row: ColleagueRow) => void;
}

export function ColleaguesTable({
  rows,
  canRemove,
  onRemove,
}: ColleaguesTableProps) {
  return (
    <div className="flex-1 overflow-auto px-5 pb-5">
      <div
        className={cn(
          "grid items-center gap-3 border-b border-line px-3 py-2 text-meta font-medium uppercase tracking-[0.4px] text-fg-tertiary",
          GRID_COLS,
        )}
      >
        <span>Name</span>
        <span>Role</span>
        <span>Open work</span>
        <span>Researches</span>
        <span>Machines</span>
        <span>Joined</span>
        <span />
      </div>

      {rows.map((row) => {
        const gone = row.member.removedTs !== undefined;
        const pct =
          row.totalCount > 0
            ? Math.round((row.doneCount / row.totalCount) * 100)
            : 0;
        return (
          <div
            key={row.member.user.id}
            className={cn(
              "group relative border-b border-line-soft hover:bg-surface-2",
              gone && "opacity-50",
            )}
          >
            <div className={cn(ROW_CLASS, GRID_COLS)}>
              <span className="flex min-w-0 items-center gap-2.5">
                <UserAvatar user={row.member.user} size={28} />
                <span className="flex min-w-0 flex-col">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-medium text-fg">
                      {row.member.user.displayName}
                    </span>
                    {gone && (
                      <span className={BADGE_CLASS}>No longer a member</span>
                    )}
                  </span>
                  <span className="truncate text-sub text-fg-subtle">
                    {row.member.user.email}
                  </span>
                </span>
              </span>

              <span className="truncate capitalize text-fg-muted">
                {row.member.role}
              </span>

              {/* An empty bar asserts work that does not exist, so a colleague
                  with nothing open says so in words instead. */}
              {row.openCount === 0 ? (
                <span className="text-fg-tertiary">Nothing open</span>
              ) : (
                <span className="flex items-center gap-2">
                  <span className="h-1.5 w-14 overflow-hidden rounded border border-line bg-surface-3">
                    <span
                      className="block h-full bg-accent"
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="text-meta tabular-nums text-fg-tertiary">
                    {row.openCount} open
                  </span>
                </span>
              )}

              <span className="flex min-w-0 items-center gap-1">
                {row.researchKeys.slice(0, 2).map((key) => (
                  <span key={key} className={BADGE_CLASS}>
                    {key}
                  </span>
                ))}
                {row.researchKeys.length > 2 && (
                  <span className="text-meta text-fg-tertiary">
                    +{row.researchKeys.length - 2}
                  </span>
                )}
              </span>

              <span className="text-fg-muted">
                {row.machineCount === 0 ? "—" : row.machineCount}
              </span>

              <span className="truncate text-fg-tertiary">
                {formatAgo(row.member.joinedTs)}
              </span>

              <span />
            </div>

            {canRemove?.(row) && onRemove && (
              <span className="absolute inset-y-0 right-3 flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <button
                  type="button"
                  aria-label={`Remove ${row.member.user.displayName}`}
                  onClick={() => onRemove(row)}
                  className="rounded-md border border-line-strong px-2.5 py-1 text-sub text-fg hover:bg-surface"
                >
                  Remove
                </button>
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default ColleaguesTable;
