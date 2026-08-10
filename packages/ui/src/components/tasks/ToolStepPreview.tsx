import type { ExecutionLogEntry } from "@lykeion/api";
import { outputPartsOf, outputText, stepOutcome } from "./ToolStepDetail";

/**
 * The `IN`/`OUT` pane under a COLLAPSED step row: the argument the call was
 * made with over the first few lines of what it produced, so a transcript says
 * what each step actually did without the researcher opening anything.
 *
 * Its own file because `ToolStep.tsx` is already long, and because this is the
 * one thing on the row that reads the step's OUTPUT rather than its label.
 *
 * Never rendered while the row is OPEN. The opened `ToolStepDetail` carries the
 * same content in full — the command as a code block over its STDOUT, an edit's
 * diff — so drawing both would show it twice. That is the same rule the live
 * `stdout` tail already followed on its own; there is now one rule, and it
 * covers the persisted result too.
 */

/**
 * What a step produced, as the `OUT` row shows it.
 *
 * `stepOutcome` decides, not the presence of text: a call that NEVER RAN may
 * still carry a string (the reason it was refused), and that reason is not
 * output. The opened detail states it as a reason; the preview draws nothing,
 * rather than passing it off as something the call returned.
 *
 * Trailing whitespace goes — real command output ends in a newline, and a blank
 * final line inside a four-line clamp costs a quarter of the pane. Leading
 * whitespace stays: indentation is content.
 */
function previewOutput(entry: ExecutionLogEntry, stdout?: string): string {
  if (stepOutcome(entry, stdout) !== "output") return "";
  return outputText(outputPartsOf(entry, stdout)).replace(/\s+$/, "");
}

export function ToolStepPreview({
  entry,
  input,
  stdout,
}: {
  entry: ExecutionLogEntry;
  /** The literal argument, when the row's own description is not already it —
   *  see `ToolStepCard`, which owns that decision because it owns the
   *  description. */
  input?: string;
  /** This tool's live output while it is still running (matched by
   *  `toolUseId` by the caller). Never persisted. */
  stdout?: string;
}) {
  const out = previewOutput(entry, stdout);
  // The tail is LIVE exactly when the entry carries no result of its own: a
  // running call is announced once, and its result merges in later without a
  // second announcement. `step-stdout` is the hook the live tests query, and it
  // must not appear over a landed result.
  const live = out !== "" && entry.result === undefined;
  if (!input && out === "") return null;
  return (
    <div className="step-io" data-testid="step-io">
      {input && (
        <div className="step-io-line">
          <span className="step-io-key">IN</span>
          <span className="step-io-in">{input}</span>
        </div>
      )}
      {out !== "" && (
        <div className="step-io-line step-io-line--out">
          <span className="step-io-key">OUT</span>
          <pre
            className={`step-io-out${live ? " step-stdout" : ""}`}
            {...(live ? { "data-testid": "step-stdout" } : {})}
          >
            {out}
          </pre>
        </div>
      )}
    </div>
  );
}

export default ToolStepPreview;
