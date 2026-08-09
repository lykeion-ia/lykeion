import type { ReactNode } from "react";

export interface StatCardProps {
  label: string;
  value: string;
  sub: ReactNode;
}

// Uppercase label, a large tabular-nums figure, and a muted sub-line (callers
// pass a <b> for the emphasized fragments, e.g. "Input <b>4.66M</b>").
export function StatCard({ label, value, sub }: StatCardProps) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-micro font-semibold uppercase tracking-[0.6px] text-fg-tertiary">
        {label}
      </div>
      <div className="mb-2 mt-2.5 text-hero font-semibold tracking-tight tabular-nums text-fg">
        {value}
      </div>
      <div className="text-sub text-fg-subtle [&_b]:font-medium [&_b]:text-fg-muted">
        {sub}
      </div>
    </div>
  );
}

export default StatCard;
