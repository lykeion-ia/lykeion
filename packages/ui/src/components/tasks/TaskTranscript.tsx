import { Fragment } from "react";
import type { TaskTurn, TurnItem } from "@lykeion/api";
import { PencilIcon } from "../icons";
import { blocksOf, ToolStepGroup } from "./ToolStep";
import { AssistantMessage } from "./AssistantMessage";
import { SubagentThread } from "./SubagentThread";

/** A turn completed in the current view (before the persisted transcript refresh). */
export interface ViewTurn {
  prompt: string;
  messages: string[];
  /**
   * The finished run's ordered stream (prose + tool steps), carried over when
   * the turn graduates out of the live surface. Without it the cards the turn
   * just drew would vanish the moment the researcher sends the next message —
   * `messages` alone has no steps in it. Absent when the run produced no
   * stream (a failed turn, or a turn recorded before live streaming existed).
   */
  stream?: TurnItem[];
  status: "ok" | "failed";
  /**
   * The landed run this turn came from, when it landed one. Lets the persisted
   * transcript REPLACE this copy once it carries the same turn (matched by id)
   * instead of rendering both. Absent for a turn that recorded no run — a
   * stopped turn — which is exactly the turn that must survive that pruning,
   * since the transcript will never contain it.
   */
  runId?: string;
}

/**
 * Group persisted turns for render: each `subagent` turn nests under the
 * last plain (non-subagent) turn that preceded it, so a delegated turn draws
 * as a `SubagentThread` under its parent instead of its own top-level bubble.
 * An orphaned subagent turn (no preceding plain turn — shouldn't happen in
 * practice) falls back to rendering standalone so nothing is silently
 * dropped from the transcript.
 */
export function groupTaskTurns(
  turns: TaskTurn[],
): { turn: TaskTurn; subagents: TaskTurn[] }[] {
  const groups: { turn: TaskTurn; subagents: TaskTurn[] }[] = [];
  for (const t of turns) {
    if (t.subagent) {
      const last = groups[groups.length - 1];
      if (last) {
        last.subagents.push(t);
        continue;
      }
    }
    groups.push({ turn: t, subagents: [] });
  }
  return groups;
}

/**
 * One turn's ordered stream: prose paragraphs and tool-step cards, drawn in
 * the order they actually arrived. `blocksOf` does the whole fold (grouping
 * consecutive steps, resolving every card's label once) — the only decision
 * left here is the markup, and a prose block deliberately renders as the same
 * `.msg--assistant` bubble a stream-less turn does, so the two paths look
 * identical wherever no tool ran.
 *
 * The LIVE turn renders through this same component, with `stdoutFor` wired
 * up: one renderer for the turn in flight and the turn reopened months later,
 * so the two can never drift. A persisted turn passes no `stdoutFor` — live
 * output is never recorded.
 */
export function StreamView({
  stream,
  stdoutFor,
}: {
  stream: TurnItem[];
  stdoutFor?: (toolUseId?: string) => string | undefined;
}) {
  return (
    <>
      {blocksOf(stream).map((block, i) =>
        block.kind === "text" ? (
          <AssistantMessage text={block.text} key={i} />
        ) : (
          <ToolStepGroup key={i} steps={block.steps} stdoutFor={stdoutFor} />
        ),
      )}
    </>
  );
}

/**
 * One researcher prompt bubble. Shared by `TurnView` (a historic/graduated
 * turn) and the live region (the turn currently running or just finished) so
 * the two never draw different markup for the same kind of bubble.
 *
 * `onEdit`, when supplied, draws a hover **Edit** button on the bubble.
 * Clicking it hands `prompt` back to the caller — the Task surface refills
 * the composer draft and focuses it. Edit does **NOT** delete, rewrite, or
 * otherwise touch the recorded turn: the bubble and every message below it
 * are untouched, and nothing here (or in `useRun`) mutates persisted history.
 * It is purely a shortcut for starting a new message from an old prompt's
 * text — never assume the opposite because of the name.
 */
export function UserBubble({
  prompt,
  onEdit,
}: {
  prompt: string;
  onEdit?: (text: string) => void;
}) {
  if (!prompt) return null;
  return (
    <div className="msg msg--user">
      {prompt}
      {onEdit && (
        <button
          type="button"
          className="msg-edit-btn"
          aria-label="Edit prompt"
          onClick={() => onEdit(prompt)}
        >
          <PencilIcon width={14} height={14} />
        </button>
      )}
    </div>
  );
}

/**
 * One persisted turn: the researcher's prompt then the assistant's replies —
 * as an interleaved stream when the turn carries one, otherwise as the plain
 * prose bubbles. The fallback is not vestigial: `stream` is absent from every
 * older turn recorded before live streaming existed, and those transcripts
 * must keep rendering exactly as they did.
 *
 * `onEditPrompt` is passed straight through to `UserBubble`'s `onEdit` — see
 * its doc comment for what Edit does and does not do.
 */
function TurnView({
  prompt,
  messages,
  stream,
  onEditPrompt,
}: {
  prompt: string;
  messages: string[];
  stream?: TurnItem[];
  onEditPrompt?: (text: string) => void;
}) {
  return (
    <>
      <UserBubble prompt={prompt} onEdit={onEditPrompt} />
      {stream && stream.length > 0 ? (
        <StreamView stream={stream} />
      ) : (
        messages.map((text, i) => <AssistantMessage text={text} key={i} />)
      )}
    </>
  );
}

/**
 * A Task's transcript above the live block. Renders turns and nothing else:
 * it does not know how they were loaded, whether a run is in flight, or what
 * the composer beneath it is doing. The in-flight turn stays the screen's
 * business — it needs the run's live state — which is why `StreamView` and
 * `UserBubble` are exported alongside.
 *
 * Two lists, because they are two different things. Persisted turns carry a
 * `runId` and can hold delegated subagent turns, so they are grouped and keyed
 * by it. A turn finished in this view has no record yet — no id to key on and
 * nothing nested under it — so it renders flat, keyed by position.
 */
export function TaskTranscript({
  history,
  viewTurns,
  onEditPrompt,
}: {
  /** Persisted turns: grouped, with subagent turns nested under their parent. */
  history: TaskTurn[];
  /** Turns finished in this view: rendered flat, no grouping, no run ids. */
  viewTurns: ViewTurn[];
  onEditPrompt?: (prompt: string) => void;
}) {
  return (
    <>
      {groupTaskTurns(history).map(({ turn, subagents }) => (
        <Fragment key={turn.runId}>
          <TurnView
            prompt={turn.prompt}
            messages={turn.messages}
            stream={turn.stream}
            onEditPrompt={onEditPrompt}
          />
          {subagents.map((s) => (
            <SubagentThread
              key={s.runId}
              persona={s.subagent ?? "Subagent"}
              task={s.prompt}
              messages={s.messages}
              outputs={s.outputs}
            />
          ))}
        </Fragment>
      ))}
      {viewTurns.map((t, i) => (
        <TurnView
          key={`view-${i}`}
          prompt={t.prompt}
          messages={t.messages}
          stream={t.stream}
          onEditPrompt={onEditPrompt}
        />
      ))}
    </>
  );
}
