/**
 * Conversations — the Inbox's messaging model.
 *
 * A Conversation is a thread ABOUT a Task: researchers and agents talking to
 * each other over the work. It is deliberately NOT the Task's transcript. A
 * Task is already a chat in this workbench — its transcript is the agent's run
 * — and the two must stay tellable apart, so the vocabulary is fixed:
 *
 * - a Task's TRANSCRIPT is the agent run, read with `getTask`;
 * - a Task's CONVERSATIONS are people (and agents) discussing it, read here.
 *
 * A Task can carry several Conversations. One thread per Task would make "new
 * chat" mean "open the existing one", and there would be no way to hold a
 * second, separate discussion about the same work.
 */

import type { Assignee } from "./types";

/**
 * One thing said in a Conversation.
 *
 * `author` is an [`Assignee`] rather than a bare user id because an agent
 * speaks here too, and "a person or an agent" is a distinction this contract
 * already carries. A second vocabulary for the same idea would drift from it.
 */
export interface Message {
  id: string;
  conversationId: string;
  author: Assignee;
  body: string;
  ts: number;
}

/** A thread about one Task. */
export interface Conversation {
  id: string;
  researchId: string;
  taskId: string;
  /** Taken from the Task's title when the opener does not supply one. */
  title: string;
  /**
   * Who is in it. Fixed at creation in this slice — there is no contract
   * method to add or remove somebody afterwards.
   */
  participants: Assignee[];
  /** The `User.id` of whoever opened it. Always a person: an agent does not
   *  open threads in this slice. */
  createdBy: string;
  createdTs: number;
  /** Last activity. What the list sorts on, and what a row dates itself by. */
  updatedTs: number;
}

/**
 * A Conversation as the LIST needs it: the thread, the one line a row draws,
 * and the count that decides whether the row shouts. Deliberately not the
 * whole message history — a list of twenty threads would otherwise carry every
 * word ever said in any of them.
 */
export interface ConversationSummary {
  conversation: Conversation;
  /** Absent only for a thread whose messages have all been removed; a thread
   *  is opened WITH its first message, so a fresh one always has this. */
  lastMessage?: Message;
  /** Messages the current member has not read. Drives the row's pill and the
   *  Rail's badge. */
  unread: number;
}

/** A Conversation as the PANE needs it: the thread, in full. */
export interface ConversationDetail {
  conversation: Conversation;
  /** Ascending by ts — reading order, oldest first. */
  messages: Message[];
}

/** What opening a Conversation takes. */
export interface NewConversation {
  researchId: string;
  taskId: string;
  /** Omitted takes the Task's own title. */
  title?: string;
  /**
   * Who to start it with. The opener is added by the core whether or not they
   * are named here — nobody opens a thread they are not in.
   */
  participants: Assignee[];
  /**
   * The opening message. Required: a thread nobody has said anything in is not
   * a thread, it is an empty row that reads as a bug.
   */
  body: string;
}
