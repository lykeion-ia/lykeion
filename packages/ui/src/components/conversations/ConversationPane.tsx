import { useEffect, useRef, useState } from "react";
import type { ConversationDetail, Message, Study } from "@lykeion/api";
import { taskCode } from "@lykeion/api";
import { useApi } from "../../api/ApiContext";
import { usePromise } from "../../hooks/usePromise";
import { useDirectory } from "../../hooks/useDirectory";
import { AssigneeStack } from "../AssigneeStack";
import { RowLink } from "../RowLink";
import { assigneeAvatar, displayName } from "../../lib/assignee";
import { formatAgo } from "../../lib/task-meta";
import { cn } from "../../lib/utils";

/**
 * The open thread: who is in it, what has been said, and the box to say the
 * next thing.
 *
 * The pane takes the whole right-hand side rather than a centred measure of
 * its own — the list beside it already sets the reading edge, and a column
 * floating in the middle of the space left over reads as a second, unexplained
 * margin.
 */
export function ConversationPane({
  detail,
  onPost,
  posting,
  error,
}: {
  detail: ConversationDetail;
  onPost: (body: string) => void;
  posting: boolean;
  /** Why the last send did not land. Cleared by the next attempt. */
  error: string | null;
}) {
  const api = useApi();
  const dir = useDirectory();
  const { conversation, messages } = detail;

  // The Task's code — "CMP-3" — is how a researcher refers to the work, so the
  // thread names it rather than only its own title. Read here because the
  // conversation carries ids, not the Study's key or the Task's number.
  const contextQuery = usePromise(
    () => api.getStudy(conversation.studyId),
    [api, conversation.studyId],
  );
  const study: Study | undefined = contextQuery.data?.study;
  const task = contextQuery.data?.tasks.find((t) => t.id === conversation.taskId);
  const code = study && task ? taskCode(study, task) : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3">
        <AssigneeStack
          assignees={conversation.participants}
          size={24}
          ringClass="ring-canvas"
        />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-read font-semibold text-fg">
            {conversation.title}
          </h2>
          <p className="truncate text-meta text-fg-subtle">
            {conversation.participants
              .map((p) => displayName(p, dir))
              .join(", ")}
          </p>
        </div>
        {/* The way from the talk to the work. A thread is about a Task, and a
            reader who has just agreed what to do needs one click to get
            there. */}
        {code && task && (
          <RowLink
            to={{
              name: "task",
              studyId: conversation.studyId,
              taskId: conversation.taskId,
            }}
            className="shrink-0 font-mono text-meta text-accent hover:underline"
          >
            {code} →
          </RowLink>
        )}
      </header>

      <MessageThread messages={messages} />

      <MessageComposer onPost={onPost} posting={posting} error={error} />
    </div>
  );
}

/** The messages, oldest at the top, pinned to the bottom as they arrive. */
function MessageThread({ messages }: { messages: Message[] }) {
  const api = useApi();
  const dir = useDirectory();
  const endRef = useRef<HTMLDivElement>(null);

  // Who the reader is, so their own turns can take the trailing edge. Until it
  // lands nothing is "mine" and the thread reads as one column — the same
  // holding pattern the directory's names sit in a row above.
  const me = usePromise(() => api.currentUser(), [api]);

  // A new message arrives at the BOTTOM, which is off-screen in a thread long
  // enough to scroll. Without this the reader would have to chase it.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  if (messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-ui text-fg-subtle">
        Nothing said yet.
      </div>
    );
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
      data-testid="conversation-thread"
    >
      <ol className="flex flex-col gap-4">
        {messages.map((message) => {
          const avatar = assigneeAvatar(message.author, dir);
          const isAgent = message.author.kind === "agent";
          // The reader's own turn. Mirrored to the trailing edge — avatar,
          // byline and text together — which is how every messaging surface
          // says "this one is yours" without a word, and matches the Task
          // transcript's own `.msg--user`. An agent is never the reader,
          // whatever it is named.
          const mine =
            message.author.kind === "user" &&
            message.author.userId === me.data?.id;
          return (
            <li
              key={message.id}
              data-own={mine || undefined}
              className={cn("flex gap-2.5", mine && "flex-row-reverse")}
            >
              <span
                aria-hidden="true"
                className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[6px] text-meta font-semibold text-white"
                style={{
                  backgroundImage: `linear-gradient(135deg, ${avatar.gradient[0]}, ${avatar.gradient[1]})`,
                }}
              >
                {avatar.initial}
              </span>
              <div
                className={cn(
                  "flex min-w-0 flex-1 flex-col",
                  // Own messages shrink to their text and hug the edge; every
                  // other row keeps the full column it has always had.
                  mine && "items-end",
                )}
              >
                <div
                  className={cn(
                    "flex items-baseline gap-2",
                    // Name nearest its avatar on either side, so the byline
                    // reads outward from the face rather than away from it.
                    mine && "flex-row-reverse",
                  )}
                >
                  <span className="text-sub font-medium text-fg">
                    {displayName(message.author, dir)}
                  </span>
                  {/* An agent in a thread of people is worth marking. Which
                      one it is, is already in the name beside it. */}
                  {isAgent && (
                    <span className="rounded border border-line px-1 text-micro font-medium uppercase tracking-[0.4px] text-fg-tertiary">
                      Agent
                    </span>
                  )}
                  <span className="text-meta text-fg-tertiary">
                    {formatAgo(message.ts)}
                  </span>
                </div>
                <p
                  className={cn(
                    "whitespace-pre-wrap break-words text-ui leading-relaxed text-fg-muted",
                    // The measure the Task transcript already caps a reader's
                    // own turn at. Without it a long message spans the pane
                    // and lands back where a left-aligned one would.
                    mine && "max-w-[52ch] text-left",
                  )}
                >
                  {message.body}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      <div ref={endRef} />
    </div>
  );
}

/**
 * The box at the bottom of an open thread.
 *
 * Enter sends and Shift+Enter inserts a newline — the convention every chat
 * uses, and the one [`Composer`] already follows on the Task surface, so the
 * two boxes in this app do not disagree about what Enter does.
 */
function MessageComposer({
  onPost,
  posting,
  error,
}: {
  onPost: (body: string) => void;
  posting: boolean;
  error: string | null;
}) {
  const [text, setText] = useState("");
  const canSend = text.trim() !== "" && !posting;

  const send = () => {
    if (!canSend) return;
    onPost(text.trim());
    setText("");
  };

  return (
    <div className="shrink-0 border-t border-line px-5 py-3">
      {error && <p className="pb-2 text-sub text-danger">{error}</p>}
      <div className="flex items-end gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-2 transition-colors duration-[120ms] focus-within:border-accent-focus">
        <textarea
          rows={1}
          value={text}
          disabled={posting}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Write a message…"
          aria-label="Write a message"
          className="max-h-[140px] w-full resize-none bg-transparent text-ui leading-relaxed text-fg outline-none focus:outline-none placeholder:text-fg-subtle"
        />
        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          aria-label="Send message"
          className={cn(
            "grid h-7 w-7 shrink-0 place-items-center rounded-md bg-fg text-canvas transition-opacity",
            canSend ? "hover:opacity-90" : "cursor-not-allowed opacity-40",
          )}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <path
              d="M8 13V3.5M8 3.5 4.5 7M8 3.5 11.5 7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default ConversationPane;
