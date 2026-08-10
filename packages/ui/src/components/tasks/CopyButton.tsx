import { useState } from "react";
import { CopyIcon } from "../icons";
import "../components.css";

/**
 * Copies text and says so briefly. Nothing is lost, so nothing is confirmed.
 *
 * Its own module because both halves of the conversation copy: `UserBubble`
 * (TaskTranscript.tsx) and `AssistantMessage`, and the latter is imported BY
 * the former — leaving this in TaskTranscript would have the two importing
 * each other. It is now also worn outside the conversation — the Machines
 * screen copies the command that adds a computer with it — which is why the
 * style it wears lives in components.css rather than in task.css.
 *
 * `label` names the button for a reader who cannot see what it sits beside.
 * Under a bubble the answer is the message above it and the visible word is
 * enough; on a line holding one command among several it is not.
 */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="quiet-action"
      {...(label ? { "aria-label": label } : {})}
      onClick={() => {
        // Absent on an insecure origin and rejecting on a denied permission.
        // Either way the text is still on screen and still selectable, so a
        // failure leaves the surface workable rather than broken — there is
        // nothing here worth an error message.
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
    >
      <CopyIcon width={13} height={13} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default CopyButton;
