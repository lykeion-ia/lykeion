import { expect, it } from "vitest";
import type { Conversation, ConversationSummary, Message } from "@lykeion/api";
import {
  filterConversations,
  matchesChip,
  matchesQuery,
} from "./conversation-filters";

function thread(
  id: string,
  title: string,
  body: string,
  unread: number,
): ConversationSummary {
  const conversation: Conversation = {
    id,
    researchId: "s_1",
    taskId: "t_1",
    title,
    participants: [
      { kind: "user", userId: "u_you" },
      { kind: "user", userId: "u_amara" },
    ],
    createdBy: "u_you",
    createdTs: 0,
    updatedTs: 0,
  };
  const lastMessage: Message = {
    id: `m_${id}`,
    conversationId: id,
    author: { kind: "user", userId: "u_amara" },
    body,
    ts: 0,
  };
  return { conversation, lastMessage, unread };
}

const traces = thread("c_1", "Preprocess calcium traces", "512 is pre-filter", 2);
const drift = thread("c_2", "Quantify tuning drift", "Taking it", 0);
const lanes = thread("c_3", "Integrate 10x lanes", "Batch correction running", 1);
const all = [traces, drift, lanes];

const NAMES: Record<string, string[]> = {
  c_1: ["You", "Amara", "Reviewer"],
  c_2: ["You", "Amara"],
  c_3: ["You", "Bohan"],
};
const namesOf = (s: ConversationSummary) => NAMES[s.conversation.id];

it("All lets every thread through", () => {
  for (const s of all) expect(matchesChip(s, "all")).toBe(true);
});

it("Unread reads the same count the Rail badge and the row pill do", () => {
  expect(matchesChip(traces, "unread")).toBe(true);
  expect(matchesChip(drift, "unread")).toBe(false);
});

it("an empty or all-whitespace query matches everything", () => {
  expect(matchesQuery(traces, NAMES.c_1, "")).toBe(true);
  expect(matchesQuery(traces, NAMES.c_1, "   ")).toBe(true);
});

it("a query matches the title, case-insensitively", () => {
  expect(matchesQuery(traces, [], "CALCIUM")).toBe(true);
  expect(matchesQuery(traces, [], "preprocess")).toBe(true);
  expect(matchesQuery(traces, [], "genomics")).toBe(false);
});

it("a query matches the last message the row previews", () => {
  // The preview is the row's second visible line, so it has to be searchable
  // — otherwise a row that clearly contains the word would be hidden by it.
  expect(matchesQuery(traces, [], "pre-filter")).toBe(true);
  expect(matchesQuery(drift, [], "taking")).toBe(true);
});

it("a query matches the people the row draws avatars for", () => {
  expect(matchesQuery(lanes, NAMES.c_3, "bohan")).toBe(true);
  expect(matchesQuery(drift, NAMES.c_2, "bohan")).toBe(false);
});

it("filterConversations applies the chip and the query together", () => {
  expect(
    filterConversations(all, namesOf, { query: "", chip: "all" }).map(
      (s) => s.conversation.id,
    ),
  ).toEqual(["c_1", "c_2", "c_3"]);

  expect(
    filterConversations(all, namesOf, { query: "", chip: "unread" }).map(
      (s) => s.conversation.id,
    ),
  ).toEqual(["c_1", "c_3"]);

  // Both narrow at once: unread AND matching the query, not either.
  expect(
    filterConversations(all, namesOf, { query: "amara", chip: "unread" }).map(
      (s) => s.conversation.id,
    ),
  ).toEqual(["c_1"]);
});

it("keeps the list's order — the caller already sorted it", () => {
  const got = filterConversations(all, namesOf, { query: "", chip: "all" });
  expect(got.map((s) => s.conversation.id)).toEqual(
    all.map((s) => s.conversation.id),
  );
});

it("a query that matches nothing yields an empty list, not everything", () => {
  expect(filterConversations(all, namesOf, { query: "zzz", chip: "all" })).toEqual(
    [],
  );
});

it("a thread whose messages are all gone still filters on its title", () => {
  const bare: ConversationSummary = { ...traces, lastMessage: undefined };
  expect(matchesQuery(bare, [], "calcium")).toBe(true);
  expect(matchesQuery(bare, [], "pre-filter")).toBe(false);
});
