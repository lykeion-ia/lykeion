import { useCallback, useMemo, useState } from "react";
import type { ConversationDetail } from "@lykeion/api";
import { useApi, useDataVersion, useInvalidateData } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { useDirectory } from "../hooks/useDirectory";
import { ComposeIcon } from "../components/icons";
import { ScreenHeader } from "../components/ui/ScreenHeader";
import { ConversationFilters } from "../components/conversations/ConversationFilters";
import { ConversationList } from "../components/conversations/ConversationList";
import { ConversationPane } from "../components/conversations/ConversationPane";
import { NewChatModal } from "../components/conversations/NewChatModal";
import { displayName } from "../lib/assignee";
import {
  filterConversations,
  type ConversationChip,
} from "../lib/conversation-filters";
import { cn } from "../lib/utils";

/**
 * The Inbox — conversations about the lab's work: a list of threads, and the
 * open one beside it.
 *
 * A thread is held with colleagues and agents ABOUT a Task. It is not the
 * Task's own chat, which is the agent's transcript and lives on the Task
 * surface; the link in the open thread's header is the way across.
 */
export function InboxScreen() {
  const api = useApi();
  const version = useDataVersion();
  const invalidate = useInvalidateData();
  const dir = useDirectory();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<ConversationChip>("all");
  const [newChatOpen, setNewChatOpen] = useState(false);
  // Bumped when a message lands, to re-read the open thread. Separate from the
  // app-wide version so posting refreshes THIS pane without every other
  // surface's query refiring on each keystroke of a conversation.
  const [threadNonce, setThreadNonce] = useState(0);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  const listQuery = usePromise(() => api.listConversations(), [api, version]);
  const summaries = useMemo(() => listQuery.data ?? [], [listQuery.data]);

  const detailQuery = usePromise<ConversationDetail | null>(
    () => (selectedId ? api.getConversation(selectedId) : Promise.resolve(null)),
    [api, selectedId, threadNonce, version],
  );

  const visible = useMemo(
    () =>
      filterConversations(
        summaries,
        (s) => s.conversation.participants.map((p) => displayName(p, dir)),
        { query, chip },
      ),
    [summaries, dir, query, chip],
  );

  // Resolved against the WHOLE list, not the narrowed one: a thread stays open
  // while it is being read even if the chip or a keystroke has just taken it
  // out of the list beside it. Resolving against `visible` would instead blank
  // the pane on the first character typed, which is the opposite of a search.
  const selected = summaries.find((s) => s.conversation.id === selectedId);

  const open = useCallback(
    (conversationId: string) => {
      setSelectedId(conversationId);
      setPostError(null);
      // Opening IS reading. The mark is written before the pane draws, and the
      // list — with the Rail's badge behind it — is re-read once it lands.
      api.markConversationRead(conversationId).then(
        () => invalidate(),
        () => {
          // The thread still opens. Failing to record that it was read is not
          // a reason to refuse to show it.
        },
      );
    },
    [api, invalidate],
  );

  const post = (body: string) => {
    if (!selectedId) return;
    setPosting(true);
    setPostError(null);
    api.postMessage(selectedId, body).then(
      () => {
        setPosting(false);
        // The thread first, so the message appears where it was typed; then
        // the list, which has to re-sort and re-preview around it.
        setThreadNonce((n) => n + 1);
        invalidate();
      },
      (err: unknown) => {
        setPosting(false);
        setPostError(err instanceof Error ? err.message : String(err));
      },
    );
  };

  const listMessage = listQuery.error
    ? { text: listQuery.error, tone: "text-danger" }
    : summaries.length === 0
      ? // Only ever said of a genuinely empty Inbox. Said of a list that a chip
        // or a query has emptied, it would be a lie — there are threads, just
        // not under this narrowing.
        listQuery.loading
        ? null
        : { text: "No conversations yet — start one.", tone: "text-fg-subtle" }
      : visible.length === 0
        ? { text: "No conversations match", tone: "text-fg-subtle" }
        : null;

  return (
    <div className="flex min-h-0 flex-1">
      {/* The list's column, title row and filters included. Because the title
          sits inside it, this column's right border is the rule between the
          two panes and runs the screen's whole height — the list reads as a
          column of the screen rather than a box parked under a full-width
          title, and the thread beside it starts at the screen's own top. */}
      <div className="flex w-[380px] shrink-0 flex-col border-r border-line">
        {/* The same title row every other section uses, so Inbox names itself
            in the one place the eye already looks. No count beside the title:
            the Rail already badges this same Inbox, and repeating it here only
            invites the two numbers to disagree.

            The action rides the title line, which since the header moved into
            this column means it lands at the column's own right edge, against
            the rule — the compose control sits over the list it starts a
            thread for.

            It shares the Rail's `ComposeIcon` but deliberately NOT the Rail's
            modal. The two make different things: the Rail's "New Task" mints
            WORK, and this starts a CONVERSATION about work that already
            exists. One glyph for "begin something", two different somethings —
            which is why the labels have to differ, and do.

            It stays on an empty Inbox: nothing to read is exactly when
            starting something is worth offering. */}
        <ScreenHeader
          title="Inbox"
          action={
            <button
              type="button"
              onClick={() => setNewChatOpen(true)}
              // Icon-only, so the name is carried rather than drawn.
              aria-label="New chat"
              title="New chat"
              // The 32px box is the header's own CTA height — the row is
              // pinned to it, so growing the box would push this title row
              // taller than every other section's. The glyph grows inside it.
              className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg"
            >
              <ComposeIcon width={19} height={19} />
            </button>
          }
        />
        {/* Nothing to narrow on an empty or errored Inbox, and a search field
            over no list is furniture that does nothing. */}
        {summaries.length > 0 && (
          <ConversationFilters
            query={query}
            onQuery={setQuery}
            chip={chip}
            onChip={setChip}
          />
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {listMessage ? (
            <p
              className={cn(
                "px-3 py-6 text-center text-[13px]",
                listMessage.tone,
              )}
            >
              {listMessage.text}
            </p>
          ) : (
            <ConversationList
              summaries={visible}
              selectedId={selectedId}
              onSelect={open}
            />
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {selected && detailQuery.data ? (
          <ConversationPane
            detail={detailQuery.data}
            onPost={post}
            posting={posting}
            error={postError}
          />
        ) : (
          // Nothing to invite a click on when there is nothing in the list.
          summaries.length > 0 && (
            <div className="flex flex-1 items-center justify-center text-[13px] text-fg-subtle">
              Select a conversation to read it
            </div>
          )
        )}
      </div>

      {newChatOpen && (
        <NewChatModal
          onClose={() => setNewChatOpen(false)}
          // Land in what was just started: a thread opened and then left
          // unselected reads as a create that did nothing.
          onCreated={(conversation) => open(conversation.id)}
        />
      )}
    </div>
  );
}

export default InboxScreen;
