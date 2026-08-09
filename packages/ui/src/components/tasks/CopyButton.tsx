import { useState } from "react";
import { CopyIcon } from "../icons";

/**
 * Copies text and says so briefly. Nothing is lost, so nothing is confirmed.
 *
 * Its own module because both halves of the conversation copy: `UserBubble`
 * (TaskTranscript.tsx) and `AssistantMessage`, and the latter is imported BY
 * the former — leaving this in TaskTranscript would have the two importing
 * each other.
 */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="msg-action"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <CopyIcon width={13} height={13} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default CopyButton;
