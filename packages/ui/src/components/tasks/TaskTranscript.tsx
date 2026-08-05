import { Fragment, type ReactNode } from "react";
import type { TaskTurn, TurnItem, TurnState } from "@lykeion/api";
import { PencilIcon } from "../icons";
import { blocksOf, ToolStepGroup } from "./ToolStep";
import { AssistantMessage } from "./AssistantMessage";
import { SubagentThread } from "./SubagentThread";

type CancelledTurnState = Extract<TurnState, { state: "cancelled" }>;

/** A turn completed in the current view (before the persisted transcript refresh). */
export interface ViewTurn {
  /** Durable position when known; legacy ephemeral turns fall back to arrival order. */
  sequence?: number;
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

/** One keyed live block supplied by the Task surface for chronological merge. */
export interface LiveTranscriptTurn {
  runId: string;
  sequence: number;
  content: ReactNode;
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
          block.block === "thought" ? (
            <details
              key={i}
              className="turn-block turn-block--thought"
              data-testid="turn-block-thought"
              data-block-kind="thought"
            >
              <summary>Thought</summary>
              <AssistantMessage text={block.text} />
            </details>
          ) : (
            <div
              key={i}
              className={`turn-block turn-block--${block.block ?? "interim"}`}
              data-testid={`turn-block-${block.block ?? "interim"}`}
              data-block-kind={block.block ?? "interim"}
              role={block.block === "error" ? "alert" : undefined}
            >
              <AssistantMessage text={block.text} />
            </div>
          )
        ) : (
          <div key={i} data-testid="turn-block-tool" data-block-kind="tool">
            <ToolStepGroup steps={block.steps} stdoutFor={stdoutFor} />
          </div>
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
  status,
  cancelled,
  onEditPrompt,
}: {
  prompt: string;
  messages: string[];
  stream?: TurnItem[];
  status?: "ok" | "failed";
  cancelled?: CancelledTurnState;
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
      {status === "failed" && !cancelled && (
        <div className="run-line run-line--failed">Run failed</div>
      )}
      {cancelled && (
        <div
          className={
            cancelled.unacknowledged
              ? "run-line run-line--unacknowledged"
              : "run-line run-line--cancelled"
          }
        >
          {cancelled.unacknowledged
            ? "The agent has not confirmed it stopped — it may still be running."
            : "Run stopped"}
        </div>
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
  liveTurns = [],
  terminalStatusByRunId = {},
  onEditPrompt,
}: {
  /** Persisted turns: grouped, with subagent turns nested under their parent. */
  history: TaskTurn[];
  /** Turns finished in this view: rendered flat, no grouping, no run ids. */
  viewTurns: ViewTurn[];
  /** Active/terminal blocks awaiting settled-history reconciliation. */
  liveTurns?: LiveTranscriptTurn[];
  /** Terminal distinctions preserved across live-to-history replacement. */
  terminalStatusByRunId?: Readonly<Record<string, CancelledTurnState>>;
  onEditPrompt?: (prompt: string) => void;
}) {
  const entries: Array<{
    key: string;
    sequence: number;
    order: number;
    content: ReactNode;
  }> = [];
  let order = 0;
  const chronologicalHistory = [...history].sort(
    (a, b) => a.sequence - b.sequence,
  );
  for (const { turn, subagents } of groupTaskTurns(chronologicalHistory)) {
    entries.push({
      key: `history-${turn.runId}`,
      sequence: turn.sequence,
      order: order++,
      content: (
        <>
          <TurnView
            prompt={turn.prompt}
            messages={turn.messages}
            stream={turn.stream}
            status={turn.status}
            cancelled={terminalStatusByRunId[turn.runId]}
            onEditPrompt={onEditPrompt}
          />
        </>
      ),
    });
    for (const subagent of subagents) {
      entries.push({
        key: `history-${subagent.runId}`,
        sequence: subagent.sequence,
        order: order++,
        content: (
          <SubagentThread
            persona={subagent.subagent ?? "Subagent"}
            task={subagent.prompt}
            messages={subagent.messages}
            outputs={subagent.outputs}
          />
        ),
      });
    }
  }
  const historyFloor = Math.max(0, ...history.map((turn) => turn.sequence));
  viewTurns.forEach((turn, index) => {
    entries.push({
      key: `view-${index}`,
      sequence: turn.sequence ?? historyFloor + index + 1,
      order: order++,
      content: (
        <TurnView
          prompt={turn.prompt}
          messages={turn.messages}
          stream={turn.stream}
          status={turn.status}
          onEditPrompt={onEditPrompt}
        />
      ),
    });
  });
  for (const turn of liveTurns) {
    entries.push({
      key: `live-${turn.runId}`,
      sequence: turn.sequence,
      order: order++,
      content: turn.content,
    });
  }
  entries.sort((a, b) => a.sequence - b.sequence || a.order - b.order);

  return (
    <>
      {entries.map((entry) => (
        <Fragment key={entry.key}>{entry.content}</Fragment>
      ))}
    </>
  );
}
