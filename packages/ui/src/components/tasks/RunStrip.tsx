import type { Plan } from "@lykeion/api";
import { NotebookIcon } from "../icons";

/**
 * The run strip that sits above the composer during a plan-mode run,
 * showing `Step N of M · Reviewing · Notebook`. It reports live execution
 * progress (from the agent's plan/todo statuses folded into the executing
 * plan), a "Reviewing" pill while the Reviewer checks the finished turn, and a
 * "Notebook" pill that opens the inspector on the live kernel.
 *
 * Shown only when there's actual progress to report: a plan with steps, or the
 * Reviewing phase. A plain (non-plan) run with no agent todos renders nothing.
 */
export function RunStrip({
  plan,
  reviewing,
  onOpenNotebook,
}: {
  plan: Plan | null;
  reviewing: boolean;
  onOpenNotebook?: () => void;
}) {
  const steps = plan?.steps ?? [];
  const total = steps.length;

  if (total === 0 && !reviewing) return null;

  // The current step: the one the agent reports in_progress, else the next
  // not-yet-done step, else (all done) the last. Completed drives the meter.
  const completed = steps.filter(
    (s) => s.status === "completed" || s.done,
  ).length;
  const inProgress = steps.findIndex((s) => s.status === "in_progress");
  const current =
    inProgress >= 0
      ? inProgress + 1
      : completed >= total
        ? total
        : completed + 1;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div className="run-strip" role="status" data-testid="run-strip">
      {total > 0 && (
        <span className="run-strip-progress">
          <span className="run-strip-meter" aria-hidden="true">
            <span className="run-strip-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="run-strip-step">
            Step {current} of {total}
          </span>
        </span>
      )}

      {reviewing && (
        <span className="run-strip-pill run-strip-pill--review">
          <span className="run-strip-dot" aria-hidden="true" />
          Reviewing
        </span>
      )}

      {onOpenNotebook && (
        <button
          type="button"
          className="run-strip-pill run-strip-notebook"
          onClick={onOpenNotebook}
        >
          <NotebookIcon />
          Notebook
        </button>
      )}
    </div>
  );
}
