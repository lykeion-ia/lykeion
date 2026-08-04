import type { ConversationSummary } from "@lykeion/api";

/**
 * The chips over the Inbox list. Exactly one is active at a time — this is a
 * narrowing of one list, not a set of independent switches, so "All" is a real
 * member rather than the absence of a selection.
 *
 * Two, not four. The Inbox used to carry a chip per notification kind, because
 * a reviewer flag and a status change were different things worth hunting for
 * separately. A list of threads has no kinds: every row is the same sort of
 * object, and the only question a reader arrives with is whether anybody is
 * waiting on them.
 */
export type ConversationChip = "all" | "unread";

export const CONVERSATION_CHIPS: { id: ConversationChip; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
];

export interface ConversationQuery {
  query: string;
  chip: ConversationChip;
}

export const EMPTY_CONVERSATION_QUERY: ConversationQuery = {
  query: "",
  chip: "all",
};

/** Whether the chip lets this thread through. */
export function matchesChip(
  summary: ConversationSummary,
  chip: ConversationChip,
): boolean {
  if (chip === "all") return true;
  // Read off the same `unread` the row's pill and the Rail's badge count, so
  // the three can never disagree about what is outstanding.
  return summary.unread > 0;
}

/**
 * Whether the typed query matches this thread.
 *
 * Matched against what the row actually shows — its title, the last message,
 * and the people in it, whose avatars the row draws — so a search that hides a
 * row can always be explained by looking at the row. An all-whitespace query
 * matches everything rather than nothing.
 *
 * `names` is passed in rather than a `Directory`: turning an `Assignee` into a
 * readable name needs the member roster, which is the screen's to hold, not
 * this module's to fetch.
 */
export function matchesQuery(
  summary: ConversationSummary,
  names: string[],
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (summary.conversation.title.toLowerCase().includes(q)) return true;
  if ((summary.lastMessage?.body ?? "").toLowerCase().includes(q)) return true;
  return names.some((n) => n.toLowerCase().includes(q));
}

/** The Inbox list, narrowed by the chip and the query. */
export function filterConversations(
  summaries: ConversationSummary[],
  namesOf: (summary: ConversationSummary) => string[],
  { query, chip }: ConversationQuery,
): ConversationSummary[] {
  return summaries.filter(
    (s) => matchesChip(s, chip) && matchesQuery(s, namesOf(s), query),
  );
}
