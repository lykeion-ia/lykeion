import type { ReactNode } from "react";
import type { TurnItem } from "@lykeion/api";
import { CopyButton } from "./CopyButton";

/**
 * The prose of one reply, as the agent wrote it — the source that goes on the
 * clipboard.
 *
 * A turn's `messages`, and a stream's text blocks, are the PARAGRAPHS of a
 * single answer: the adapter breaks one reply into blocks on its way through,
 * and rejoining them with a blank line is what turns them back into the thing
 * the agent actually said. Markdown-safe by construction — a blank line is a
 * paragraph break, never a seam guess.
 *
 * Thinking is excluded. It is not the answer, it is never recorded as one, and
 * the transcript keeps it in its own channel precisely so it cannot be taken
 * for one; it must not ride along on the clipboard either.
 */
export function replyText(messages: string[], stream?: TurnItem[]): string {
  const parts =
    stream && stream.length > 0
      ? stream
          .filter(
            (item): item is Extract<TurnItem, { kind: "text" }> =>
              item.kind === "text" && item.block !== "thinking",
          )
          .map((item) => item.text)
      : messages;
  return parts.filter((text) => text.trim() !== "").join("\n\n");
}

/**
 * The agent's whole answer to one prompt, and the one Copy that takes it.
 *
 * The unit is the REPLY, not the bubble. A turn routinely renders several
 * `.msg--assistant` blocks — two paragraphs, or prose split around a tool card
 * — and they are one thing the agent said, so they get one control. A Copy per
 * block would claim otherwise, which is what it used to do.
 *
 * Its own module because both places that render an agent's reply need it —
 * `TurnView` (TaskTranscript.tsx) and `SubagentThread` — and the former
 * already imports the latter.
 *
 * Nothing is drawn when there is no prose to take: a turn that only ran tools,
 * or one still streaming, has no answer to copy yet.
 */
export function AssistantReply({
  text,
  children,
}: {
  text: string;
  children: ReactNode;
}) {
  return (
    <div className="turn-reply">
      {children}
      {text !== "" && (
        <div className="msg-actions">
          <CopyButton text={text} />
        </div>
      )}
    </div>
  );
}

export default AssistantReply;
