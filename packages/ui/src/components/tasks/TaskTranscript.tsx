import { Fragment, useState, type ReactNode } from "react";
import type { TaskTurn, TurnItem, TurnState } from "@lykeion/api";
import { PencilIcon } from "../icons";
import { blocksOf, ToolStepGroup } from "./ToolStep";
import { RailRow, TurnRail } from "./TurnRail";
import { AssistantMessage } from "./AssistantMessage";
import { AssistantReply, replyText } from "./AssistantReply";
import { CopyButton } from "./CopyButton";
import { SubagentThread } from "./SubagentThread";
// Edit and Revert below wear `.quiet-action`, which is defined here rather
// than in task.css now that the Machines screen wears it too.
import "../components.css";

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

/** The same neutral provenance row for a system continuation whether it is
 * live, recovered, or already settled in history. */
export function EnvironmentContinuationStatus({
  continuation,
}: {
  continuation?: TaskTurn["continuation"];
}) {
  return (
    <div
      className="run-line run-line--system"
      data-testid="environment-continuation-status"
    >
      {continuation?.kind === "environment-setup"
        ? `${continuation.environmentName} is ready. Continuing the work blocked above.`
        : "Continuing earlier work."}
    </div>
  );
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
 * One turn's ordered stream: prose paragraphs, thinking and tool steps, drawn
 * in the order they actually arrived — each one a node on the turn's rail (see
 * `TurnRail`). `blocksOf` does the whole fold (grouping consecutive steps,
 * resolving every row's label once) — the only decision left here is the
 * markup, and a prose block deliberately renders as the same `.msg--assistant`
 * bubble a stream-less turn does, so the two paths look identical wherever no
 * tool ran.
 *
 * Everything after the prompt goes on the rail, prose included. The rail is the
 * record of what the agent did AND said, in one order; giving the prose its own
 * ungoverned lane would put the two back in separate columns, which is the
 * shape this replaced.
 *
 * The rows are emitted bare, not inside a `TurnRail` of their own: the caller
 * owns the rail, because the live surface has to put its in-flight tail on the
 * SAME one (see `TaskScreen`'s live block) rather than under a second.
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
          block.block === "thinking" ? (
            <RailRow key={i} marker="thinking">
              <details
                className="turn-block turn-block--thinking"
                data-testid="turn-block-thinking"
                data-block-kind="thinking"
              >
                <summary>Thought</summary>
                <AssistantMessage text={block.text} />
              </details>
            </RailRow>
          ) : (
            <RailRow key={i} marker="prose">
              <div
                className={`turn-block turn-block--${block.block ?? "interim"}`}
                data-testid={`turn-block-${block.block ?? "interim"}`}
                data-block-kind={block.block ?? "interim"}
                role={block.block === "error" ? "alert" : undefined}
              >
                <AssistantMessage text={block.text} />
              </div>
            </RailRow>
          )
        ) : (
          // A steps block draws its OWN rows (one per step, or a header plus a
          // nested rail), so this wrapper must not come between them and the
          // rail's grid — `display: contents` keeps the block's identity for
          // anything reading the transcript's shape while letting the rows
          // through as the rail's own children.
          <div
            key={i}
            className="turn-block-tool"
            data-testid="turn-block-tool"
            data-block-kind="tool"
          >
            <ToolStepGroup steps={block.steps} stdoutFor={stdoutFor} />
          </div>
        ),
      )}
    </>
  );
}

/** What a turn's newest-turn controls do, and whether they can. Absent on
 *  every turn but the newest: an older turn keeps Copy, which is most of
 *  what it was wanted for. */
export interface TurnRevert {
  /** False when no snapshot of the Task's files was taken before this turn
   *  ran. A control that cannot restore anything is worse than an absent
   *  one, so it is drawn disabled, naming why. */
  available: boolean;
  reason?: string;
  onRevert?: () => Promise<void>;
  onEdit?: (prompt: string) => Promise<void>;
}

/**
 * What discarding a turn costs, named before it happens rather than
 * afterwards. Every clause is a separate fact and none of them is a
 * footnote: the turn goes, the Task's own files go back, the agent starts a
 * fresh conversation with no memory of the earlier turns either, and a
 * folder the researcher granted is left exactly as the turn left it.
 */
const REVERT_CONSEQUENCES = [
  "This turn and its steps are discarded.",
  "The Task's files go back to what they were before it ran.",
  "The agent starts a fresh conversation, with no memory of the earlier turns either. The transcript keeps them; its context is not kept.",
  "Files written into a folder you granted are your own, and are not rolled back.",
];

/**
 * One researcher prompt bubble. Shared by `TurnView` (a historic/graduated
 * turn) and the live region (the turn currently running or just finished) so
 * the two never draw different markup for the same kind of bubble.
 *
 * Copy is drawn on every bubble. Edit and Revert are drawn on the newest
 * turn alone — there is one snapshot per Task, and a turn that has already
 * been built on cannot be pulled out from under the work that followed it —
 * and each confirms first, naming what is lost.
 *
 * Edit is Revert followed by an ordinary send of the corrected text. It is
 * not a second operation, and it is not the shortcut that only refilled the
 * composer: two controls called Edit on one surface, meaning different
 * things, is worse than either.
 */
export function UserBubble({
  prompt,
  revert,
}: {
  prompt: string;
  revert?: TurnRevert;
}) {
  const [asking, setAsking] = useState<"revert" | "edit" | undefined>(undefined);
  const [draft, setDraft] = useState(prompt);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  if (!prompt) return null;

  const disabled = revert !== undefined && !revert.available;
  const why = disabled
    ? (revert.reason ??
      "there is no snapshot of this Task's files from before this turn")
    : undefined;

  const attempt = (work: () => Promise<void>): void => {
    setBusy(true);
    setFailure(undefined);
    void work().then(
      () => {
        setBusy(false);
        setAsking(undefined);
      },
      (err: unknown) => {
        setBusy(false);
        setFailure(err instanceof Error ? err.message : String(err));
      },
    );
  };

  return (
    <div className="msg msg--user">
      {prompt}
      <div className="msg-actions">
        <CopyButton text={prompt} />
        {revert && (
          <>
            <button
              type="button"
              className="quiet-action"
              disabled={disabled}
              {...(why ? { title: why } : {})}
              onClick={() => {
                setDraft(prompt);
                setAsking("edit");
              }}
            >
              <PencilIcon width={13} height={13} />
              Edit
            </button>
            <button
              type="button"
              className="quiet-action"
              disabled={disabled}
              {...(why ? { title: why } : {})}
              onClick={() => setAsking("revert")}
            >
              Revert
            </button>
          </>
        )}
      </div>
      {asking && (
        <div className="turn-confirm" data-testid="turn-confirm">
          <ul className="turn-confirm-list">
            {REVERT_CONSEQUENCES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {asking === "edit" && (
            <textarea
              className="turn-confirm-draft"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Corrected prompt"
            />
          )}
          {failure && (
            <p className="turn-confirm-failure" role="alert">
              {failure}
            </p>
          )}
          <div className="turn-confirm-buttons">
            <button
              type="button"
              className="turn-confirm-go"
              disabled={busy}
              onClick={() =>
                attempt(async () => {
                  if (asking === "edit") await revert?.onEdit?.(draft);
                  else await revert?.onRevert?.();
                })
              }
            >
              {asking === "edit" ? "Discard and resend" : "Discard the turn"}
            </button>
            <button
              type="button"
              className="turn-confirm-keep"
              disabled={busy}
              onClick={() => {
                setAsking(undefined);
                setFailure(undefined);
              }}
            >
              Keep it
            </button>
          </div>
        </div>
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
 * `revert` is passed straight through to `UserBubble` — see its doc comment
 * for what Edit and Revert do, and which turns carry them.
 */
function TurnView({
  origin,
  continuation,
  prompt,
  messages,
  stream,
  status,
  cancelled,
  revert,
}: {
  origin?: TaskTurn["origin"];
  continuation?: TaskTurn["continuation"];
  prompt: string;
  messages: string[];
  stream?: TurnItem[];
  status?: "ok" | "failed";
  cancelled?: CancelledTurnState;
  revert?: TurnRevert;
}) {
  return (
    <>
      {origin === "system" ? (
        <EnvironmentContinuationStatus continuation={continuation} />
      ) : (
        <UserBubble prompt={prompt} {...(revert ? { revert } : {})} />
      )}
      <AssistantReply text={replyText(messages, stream)}>
        {/* Both paths rail. A turn recorded before live streaming existed has
            only its prose, and it is still the agent's reply to this prompt —
            drawing it off the rail would make an old transcript a different
            KIND of thing from a new one, when all that differs is how much of
            it was recorded. */}
        <TurnRail>
          {stream && stream.length > 0 ? (
            <StreamView stream={stream} />
          ) : (
            messages.map((text, i) => (
              <RailRow key={i} marker="prose">
                <AssistantMessage text={text} />
              </RailRow>
            ))
          )}
        </TurnRail>
      </AssistantReply>
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
  onRevertTurn,
  onEditTurn,
}: {
  /** Persisted turns: grouped, with subagent turns nested under their parent. */
  history: TaskTurn[];
  /** Turns finished in this view: rendered flat, no grouping, no run ids. */
  viewTurns: ViewTurn[];
  /** Active/terminal blocks awaiting settled-history reconciliation. */
  liveTurns?: LiveTranscriptTurn[];
  /** Terminal distinctions preserved across live-to-history replacement. */
  terminalStatusByRunId?: Readonly<Record<string, CancelledTurnState>>;
  /** Discards the newest turn and puts the Task's files back. Offered on
   *  that turn alone; every older one keeps Copy. */
  onRevertTurn?: (runId: string) => Promise<void>;
  /** Discards the newest turn and sends the corrected text in its place. */
  onEditTurn?: (runId: string, prompt: string) => Promise<void>;
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
  // The one turn Edit and Revert are offered on. A turn that has already
  // been built on cannot be pulled out from under the work that followed it,
  // and there is one snapshot per Task rather than one per turn.
  const newest = chronologicalHistory[chronologicalHistory.length - 1];
  for (const { turn, subagents } of groupTaskTurns(chronologicalHistory)) {
    const revert: TurnRevert | undefined =
      turn.origin === "user" && turn.runId === newest?.runId && (onRevertTurn || onEditTurn)
        ? {
            available: turn.revert?.available === true,
            ...(turn.revert?.reason === undefined ? {} : { reason: turn.revert.reason }),
            ...(onRevertTurn ? { onRevert: () => onRevertTurn(turn.runId) } : {}),
            ...(onEditTurn
              ? { onEdit: (prompt: string) => onEditTurn(turn.runId, prompt) }
              : {}),
          }
        : undefined;
    entries.push({
      key: `history-${turn.runId}`,
      sequence: turn.sequence,
      order: order++,
      content: (
        <>
          <TurnView
            origin={turn.origin}
            continuation={turn.continuation}
            prompt={turn.prompt}
            messages={turn.messages}
            stream={turn.stream}
            status={turn.status}
            cancelled={terminalStatusByRunId[turn.runId]}
            {...(revert ? { revert } : {})}
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
