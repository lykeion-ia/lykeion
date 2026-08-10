import type { Language, RunningKernel } from "@lykeion/api";
import { languageLabel } from "./notebook-model";

/**
 * One line under the ledger saying what the kernel is, and nothing else.
 *
 * It replaces a dock that carried five labelled spans and a researcher REPL.
 * The REPL is gone because this surface is a record of what the agent ran, not
 * a second place to run things from — a prompt here invited typing into a
 * namespace the agent owns. What is left is the fact a reader needs to
 * interpret the cells above: which language held them, whether anything is
 * still holding that namespace, and how many cells there are.
 *
 * Interrupt and Restart stay, as text rather than as a menu. They were the one
 * part of the old strip that did something rather than said something, and a
 * running kernel with no way to stop it is a worse screen than a busy one.
 */
export function NotebookStatusBar({
  kernel,
  language,
  cellCount,
  onInterrupt,
  onRestart,
}: {
  kernel: RunningKernel | undefined;
  language: Language | null;
  cellCount: number;
  onInterrupt: () => void;
  onRestart: () => void;
}) {
  const named = kernel?.language ?? language;
  // Nothing has ever run here: no language to name, so no line to draw.
  if (named === null || named === undefined) return null;

  return (
    <div className="nbp-status" data-testid="notebook-status">
      <span className="nbp-status-fact">
        {languageLabel(named)}
        {kernel ? (
          <>
            {" · "}
            <span className={`nbp-status-state nbp-status-state--${kernel.state}`}>
              {kernel.state}
            </span>
            {" · shared with the agent"}
          </>
        ) : (
          " · view only — nothing is holding that namespace now"
        )}
      </span>

      <span className="nbp-status-right">
        {kernel && kernel.state === "running" && (
          <button type="button" className="nbp-status-action" onClick={onInterrupt}>
            Interrupt
          </button>
        )}
        {kernel && (
          <button
            type="button"
            className="nbp-status-action"
            onClick={onRestart}
            title="Clears every variable"
          >
            Restart
          </button>
        )}
        <span className="nbp-status-count">
          {cellCount === 1 ? "1 cell" : `${cellCount} cells`}
        </span>
      </span>
    </div>
  );
}
