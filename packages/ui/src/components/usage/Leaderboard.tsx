import { useState } from "react";
import { cn } from "../../lib/utils";
import type { LeaderboardRow } from "../../lib/usage";

const METRICS = ["Tokens", "Cost", "Time", "Tasks"] as const;
type Metric = (typeof METRICS)[number];

// Column template shared by the header and every row: agent · bar · 4
// right-aligned value columns.
const GRID_COLS = "grid-cols-[210px_1fr_96px_74px_84px_62px]";

export interface LeaderboardProps {
  rows: LeaderboardRow[];
}

export function Leaderboard({ rows }: LeaderboardProps) {
  const [metric, setMetric] = useState<Metric>("Tokens");

  return (
    <div className="rounded-xl border border-line bg-surface px-5 py-[18px]">
      <div className="mb-[18px] flex items-center">
        <div className="text-[14px] font-semibold tracking-tight text-fg">
          Leaderboard
        </div>
        <div className="flex-1" />
        <div className="mr-3 inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5">
          {METRICS.map((m) => {
            const isActive = m === metric;
            const isInert = m !== "Tokens";
            return (
              <button
                key={m}
                type="button"
                disabled={isInert}
                aria-pressed={isActive}
                onClick={() => setMetric(m)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[12px] transition-colors duration-[120ms]",
                  isActive ? "bg-surface-3 text-fg" : "text-fg-subtle",
                  isInert ? "cursor-not-allowed opacity-40" : "hover:text-fg",
                )}
              >
                {m}
              </button>
            );
          })}
        </div>
        <span className="text-[12px] text-fg-subtle">{rows.length} agents</span>
      </div>

      <div
        className={cn(
          "grid items-center gap-3 border-b border-line pb-2.5 text-[11px] text-fg-tertiary",
          GRID_COLS,
        )}
      >
        <span>Agent</span>
        <span />
        <span className="text-right">Tokens</span>
        <span className="text-right">Cost</span>
        <span className="text-right">Time</span>
        <span className="text-right">Tasks</span>
      </div>

      {rows.map((row, i) => (
        <div
          key={row.agentId}
          className={cn(
            "grid items-center gap-3 py-3 text-[13px]",
            GRID_COLS,
            i < rows.length - 1 && "border-b border-line-soft",
          )}
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              className="grid h-5 w-5 shrink-0 place-items-center rounded-[6px] text-[10px] font-semibold text-white"
              style={{
                backgroundImage: `linear-gradient(135deg, ${row.gradient[0]}, ${row.gradient[1]})`,
              }}
            >
              {row.initial}
            </span>
            <span className="truncate text-fg">{row.name}</span>
          </span>

          <span className="h-2 overflow-hidden rounded-full bg-surface-3">
            <span
              className="block h-full rounded-full bg-accent"
              style={{ width: `${Math.round(row.frac * 100)}%` }}
            />
          </span>

          <span className="text-right tabular-nums text-fg-muted">
            {row.tokens}
          </span>
          <span className="text-right tabular-nums text-fg-subtle">
            {row.cost}
          </span>
          <span className="text-right tabular-nums text-fg-subtle">
            {row.time}
          </span>
          <span className="text-right tabular-nums text-fg-subtle">
            {row.tasks}
          </span>
        </div>
      ))}
    </div>
  );
}

export default Leaderboard;
