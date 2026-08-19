import type { Group } from "@lykeion/api";
import { UsersIcon } from "../icons";
import { UserAvatar } from "../UserAvatar";
import { agentAvatar } from "../../lib/assignee";
import { useDirectory } from "../../hooks/useDirectory";
import { formatAgo } from "../../lib/task-meta";
import { cn } from "../../lib/utils";

export interface GroupsViewProps {
  groups: Group[];
  loading?: boolean;
}

/** The Groups surface: a faithful empty state until groups exist,
 *  then a simple list. Lead avatars are derived from the real agent name. */
export function GroupsView({ groups, loading }: GroupsViewProps) {
  const dir = useDirectory();

  if (!loading && groups.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <UsersIcon width={40} height={40} className="text-fg-tertiary" />
        <p className="text-ui text-fg-subtle">
          No groups yet. Create one to get started.
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
              <span className="truncate text-ui font-medium text-fg">
                {group.name}
              </span>
              <span className="truncate text-sub text-fg-subtle">
                {group.description}
              </span>
            </span>
            {/* The colleagues in this group, ahead of the lead so the row
                reads left-to-right as "the group, then who runs it". An id
                the directory cannot resolve is skipped rather than drawn as
                a blank circle: a removed colleague still resolves, so a miss
                once `dir.loaded` is a genuinely unknown id, and a face for it
                would assert a person who is not there. */}
            {group.memberUsers.length > 0 && (
              <span className="ml-auto flex items-center -space-x-1.5">
                {group.memberUsers.map((userId) => {
                  const user = dir.user(userId);
                  if (!user) return null;
                  // Titled on a wrapper rather than on `UserAvatar` itself:
                  // that component draws an uploaded picture with the name as
                  // its `alt` and the initials fallback with no accessible
                  // name at all, and it is shared by every surface that draws
                  // a face — so the name belongs here, where this row needs
                  // it, not in a change everyone inherits.
                  return (
                    <span
                      key={userId}
                      title={user.displayName}
                      className="inline-flex"
                    >
                      <UserAvatar
                        user={user}
                        size={20}
                        className="ring-1 ring-canvas"
                      />
                    </span>
                  );
                })}
              </span>
            )}
            <span
              className={cn(
                "flex items-center gap-1.5 text-sub text-fg-muted",
                group.memberUsers.length === 0 && "ml-auto",
              )}
            >
              {lead && (
                <>
                  <span
                    className="grid h-4 w-4 shrink-0 place-items-center rounded-[5px] text-micro font-semibold text-white"
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
            <span className="w-16 shrink-0 text-right text-sub text-fg-tertiary">
              {formatAgo(group.updatedTs)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default GroupsView;
