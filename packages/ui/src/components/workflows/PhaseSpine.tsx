import { METHOD_PHASE_LABELS, type Workflow } from "@lykeion/api";
import { PHASE_META, skippedPhases } from "../../lib/workflow-meta";
import { cn } from "../../lib/utils";

/**
 * The phases one procedure runs, in spine order, and the Skill behind each.
 *
 * Only the phases this procedure declares are listed. The rest are one line
 * naming them: ten rows with half of them greyed would say those steps were
 * skipped, and a literature summary has nothing to pre-register rather than a
 * pre-registration it neglected.
 */
export function PhaseSpine({ workflow }: { workflow: Workflow }) {
  const skipped = skippedPhases(workflow);

  return (
    <section aria-label="Method phases">
      <div className="flex items-baseline gap-2 pb-2">
        <h2 className="text-[13px] font-medium text-fg">Method</h2>
        <span className="text-[12px] tabular-nums text-fg-subtle">
          {workflow.phases.length} of {workflow.phases.length + skipped.length}{" "}
          phases
        </span>
      </div>

      <ol className="flex flex-col">
        {workflow.phases.map((phase, index) => {
          const meta = PHASE_META[phase];
          return (
            <li
              key={phase}
              className="flex items-center gap-3 border-b border-line-soft py-2 last:border-b-0"
            >
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-line text-[10px] tabular-nums text-fg-tertiary">
                {index + 1}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded border px-1.5 py-0.5 text-[11px]",
                  meta.badgeClass,
                )}
              >
                {meta.label}
              </span>
              <span className="flex-1" />
              <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">
                {meta.skill}
              </span>
            </li>
          );
        })}
      </ol>

      {skipped.length > 0 && (
        <p className="pt-2 text-[12px] leading-relaxed text-fg-subtle">
          Skips: {skipped.map((p) => METHOD_PHASE_LABELS[p]).join(", ")}.
        </p>
      )}
    </section>
  );
}

export default PhaseSpine;
