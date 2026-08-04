import type { Assignee } from "@lykeion/api";
import { assigneeAvatar, assigneeKey } from "../lib/assignee";
import { useDirectory } from "../hooks/useDirectory";
import { cn } from "../lib/utils";

export interface AssigneeStackProps {
  /** A Task's real assignees; empty renders nothing. */
  assignees: Assignee[];
  /** Square edge in px for each avatar. */
  size?: number;
  /** Max avatars before a "+N" overflow chip. */
  max?: number;
  /** Tailwind ring color of the cut-out gap — match the surface behind. */
  ringClass?: string;
  className?: string;
}

/**
 * Overlapping stack of gradient avatars for a Task's assignees. Uses Lykeion's
 * squircle avatar shape (see `assigneeAvatar`) in a `-space-x` overlapping row.
 */
export function AssigneeStack({
  assignees,
  size = 18,
  max = 3,
  ringClass = "ring-surface-2",
  className,
}: AssigneeStackProps) {
  const dir = useDirectory();
  if (assignees.length === 0) return null;
  const shown = assignees.slice(0, max);
  const extra = assignees.length - shown.length;
  const fontSize = Math.max(8, Math.round(size * 0.5));

  return (
    <div className={cn("flex -space-x-1.5", className)}>
      {shown.map((assignee) => {
        const a = assigneeAvatar(assignee, dir);
        return (
          <span
            key={assigneeKey(assignee)}
            title={a.label}
            className={cn(
              "grid shrink-0 place-items-center rounded-[5px] font-semibold text-white ring-2",
              ringClass,
            )}
            style={{
              width: size,
              height: size,
              fontSize,
              backgroundImage: `linear-gradient(135deg, ${a.gradient[0]}, ${a.gradient[1]})`,
            }}
          >
            {a.initial}
          </span>
        );
      })}
      {extra > 0 && (
        <span
          title={`+${extra} more`}
          className={cn(
            "grid shrink-0 place-items-center rounded-[5px] bg-surface-3 font-semibold text-fg-subtle ring-2",
            ringClass,
          )}
          style={{ width: size, height: size, fontSize }}
        >
          +{extra}
        </span>
      )}
    </div>
  );
}

export default AssigneeStack;
