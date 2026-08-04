import type { Plan } from "@lykeion/api";

/**
 * The proposed plan as a checklist; Approve/Reject only while it's pending.
 *
 * Its own component rather than markup inside the screen that renders it, so
 * a plan card cannot drift between the parent-turn, delegated-subagent, and
 * Task placements that all draw one.
 */
export function PlanCard({
  plan,
  pending,
  onApprove,
  onReject,
}: {
  plan: Plan;
  pending: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <div className="card plan-card">
      <div className="card-eyebrow">Plan</div>
      <ul className="plan-steps">
        {plan.steps.map((step, i) => (
          <li className={`plan-step${step.done ? " is-done" : ""}`} key={i}>
            <span className="plan-check" aria-hidden="true">
              {step.done ? "✓" : ""}
            </span>
            {step.title}
          </li>
        ))}
      </ul>
      {pending && (
        <div className="card-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={onApprove}
          >
            Approve
          </button>
          <button type="button" className="btn btn--neutral" onClick={onReject}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}

export default PlanCard;
