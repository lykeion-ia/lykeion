import type { ResearchGroup } from "@lykeion/api";
import { UsersIcon } from "../icons";
import { agentAvatar } from "../../lib/assignee";
import { formatAgo } from "../../lib/task-meta";

export interface ResearchGroupsViewProps {
  groups: ResearchGroup[];
  loading?: boolean;
}

/** The Research Groups surface: a faithful empty state until groups exist,
 *  then a simple list. Lead avatars are derived from the real agent name. */
export function ResearchGroupsView({
  groups,
  loading,
}: ResearchGroupsViewProps) {
  if (!loading && groups.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <UsersIcon width={40} height={40} className="text-fg-tertiary" />
        <p className="text-[13px] text-fg-subtle">
          No research groups yet. Create one to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto px-5 pb-5">
      {groups.map((group) => {
        const lead = group.leadAgent ? agentAvatar(group.leadAgent) : null;
        return (
          <div
            key={group.id}
            className="flex items-center gap-3 border-b border-line-soft px-3 py-3"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-surface-2 text-fg-subtle">
              <UsersIcon width={16} height={16} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium text-fg">
                {group.name}
              </span>
              <span className="truncate text-[12px] text-fg-subtle">
                {group.description}
              </span>
            </span>
            <span className="ml-auto flex items-center gap-1.5 text-[12.5px] text-fg-muted">
              {lead && (
                <>
                  <span
                    className="grid h-4 w-4 shrink-0 place-items-center rounded-[5px] text-[9px] font-semibold text-white"
                    style={{
                      backgroundImage: `linear-gradient(135deg, ${lead.gradient[0]}, ${lead.gradient[1]})`,
                    }}
                  >
                    {lead.initial}
                  </span>
                  {lead.label}
                </>
              )}
            </span>
            <span className="w-16 shrink-0 text-right text-[12px] text-fg-tertiary">
              {formatAgo(group.updatedTs)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default ResearchGroupsView;
