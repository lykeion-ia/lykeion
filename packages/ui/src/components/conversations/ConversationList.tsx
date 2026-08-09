import type { ConversationSummary } from "@lykeion/api";
import { AssigneeStack } from "../AssigneeStack";
import { useDirectory } from "../../hooks/useDirectory";
import { displayName } from "../../lib/assignee";
import { formatAgo } from "../../lib/task-meta";
import { cn } from "../../lib/utils";

/**
 * The Inbox's left column: one row per thread, newest activity at the top.
 *
 * Each row is the whole thread in three lines' worth of space — who is in it,
 * what it is called, what was last said, and how much of that the reader has
 * not seen. Nothing here opens anything but the thread itself: the row IS the
 * click target, so there is no second affordance to aim at inside it.
 */
export function ConversationList({
  summaries,
  selectedId,
  onSelect,
}: {
  summaries: ConversationSummary[];
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
}) {
  const dir = useDirectory();

  return (
    <>
      {summaries.map(({ conversation, lastMessage, unread }) => {
        const isSelected = conversation.id === selectedId;
        return (
          <button
            key={conversation.id}
            type="button"
            onClick={() => onSelect(conversation.id)}
            aria-pressed={isSelected}
            className={cn(
              "flex w-full items-start gap-2.5 border-b border-line-soft px-3 py-2.5 text-left transition-colors duration-[120ms]",
              isSelected ? "bg-surface-2" : "hover:bg-surface",
            )}
          >
            <AssigneeStack
              assignees={conversation.participants}
              size={26}
              max={2}
              ringClass={isSelected ? "ring-surface-2" : "ring-sidebar"}
              className="mt-0.5 shrink-0"
            />

            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex items-baseline gap-2">
                {/* Unread carries the weight, read recedes. Without this the
                    Unread chip would sort the list by something the list never
                    shows, and its result would look arbitrary. */}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-ui",
                    unread > 0
                      ? "font-medium text-fg"
                      : "font-normal text-fg-muted",
                  )}
                >
                  {conversation.title}
                </span>
                <span className="shrink-0 text-meta text-fg-tertiary">
                  {formatAgo(conversation.updatedTs)}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-sub",
                    unread > 0 ? "text-fg-muted" : "text-fg-subtle",
                  )}
                >
                  {lastMessage
                    ? // Named, not just quoted: in a thread of four people the
                      // preview is unreadable without knowing who is speaking.
                      `${displayName(lastMessage.author, dir)}: ${lastMessage.body}`
                    : "No messages yet"}
                </span>
                {unread > 0 && (
                  // Visually a bare numeral — the right shape for a count on a
                  // row — but named for what it counts, so a screen reader is
                  // not handed an unlabelled number.
                  <span
                    aria-label={`${unread} unread`}
                    className="shrink-0 rounded-full bg-accent/20 px-1.5 text-micro font-semibold text-accent"
                  >
                    {unread}
                  </span>
                )}
              </div>
            </div>
          </button>
        );
      })}
    </>
  );
}

export default ConversationList;
