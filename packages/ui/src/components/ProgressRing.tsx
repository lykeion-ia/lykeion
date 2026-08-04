import "./components.css";

const R = 5;
const C = 2 * Math.PI * R;

/** Tiny donut showing a study's done/total task fraction. */
export function ProgressRing({ done, total }: { done: number; total: number }) {
  const frac = total === 0 ? 0 : done / total;
  return (
    <svg
      className="progress-ring"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      aria-hidden="true"
    >
      <circle
        cx="7"
        cy="7"
        r={R}
        fill="none"
        stroke="var(--hairline-strong)"
        strokeWidth="2"
      />
      {frac > 0 && (
        <circle
          cx="7"
          cy="7"
          r={R}
          fill="none"
          stroke="var(--status-done)"
          strokeWidth="2"
          strokeDasharray={`${frac * C} ${C}`}
          strokeLinecap="round"
          transform="rotate(-90 7 7)"
        />
      )}
    </svg>
  );
}
