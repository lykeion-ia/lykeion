import { useState } from "react";
import { cn } from "../../lib/utils";
import type { UsagePoint } from "@lykeion/api";

const METRICS = ["Tokens", "Cost", "Time", "Tasks"] as const;
type Metric = (typeof METRICS)[number];

// Number of gridlines above zero.
const AXIS_STEPS = 4;
const AXIS_STEP_K = 80;

// Evenly-spaced x-axis label indices across the series.
function tickIndices(length: number, count: number): number[] {
  if (length <= 1) return [0];
  return Array.from({ length: count }, (_, i) =>
    Math.round((i * (length - 1)) / (count - 1)),
  );
}

export interface TokensChartProps {
  series: UsagePoint[];
}

// CHART GOTCHA: `.chart` is a fixed-height (h-[230px]) row with `items-stretch`,
// and each bar column is `h-full flex flex-col justify-end` so its two
// `%`-height segments resolve against a real pixel height, not zero.
export function TokensChart({ series }: TokensChartProps) {
  const [metric, setMetric] = useState<Metric>("Tokens");

  const maxTotal = Math.max(0, ...series.map((p) => p.input + p.output));
  const axisMaxK = Math.max(
    AXIS_STEP_K,
    Math.ceil(maxTotal / AXIS_STEP_K) * AXIS_STEP_K,
  );
  const yLabels = Array.from({ length: AXIS_STEPS + 1 }, (_, i) => {
    const stepsFromTop = AXIS_STEPS - i;
    const value = (axisMaxK * stepsFromTop) / AXIS_STEPS;
    return value === 0 ? "0" : `${Math.round(value)}K`;
  });

  const xTicks = tickIndices(series.length, 5).map((i) => series[i]?.day ?? "");

  return (
    <div className="rounded-xl border border-line bg-surface px-5 py-[18px]">
      <div className="mb-[18px] flex items-center">
        <div className="text-read font-semibold tracking-tight text-fg">
          Daily tokens
        </div>
        <div className="flex-1" />
        <div className="mr-3.5 flex items-center gap-3.5 text-meta text-fg-subtle">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-[9px] w-[9px] rounded-[2px] bg-accent-focus" />
            Input
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-[9px] w-[9px] rounded-[2px] bg-accent-hover" />
            Output
          </span>
        </div>
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5">
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
                  "rounded-md px-2.5 py-1 text-sub transition-colors duration-[120ms]",
                  isActive ? "bg-surface-3 text-fg" : "text-fg-subtle",
                  isInert ? "cursor-not-allowed opacity-40" : "hover:text-fg",
                )}
              >
                {m}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex h-[230px] w-10 shrink-0 flex-col justify-between pb-[18px] text-right text-meta text-fg-tertiary">
          {yLabels.map((label, i) => (
            <span key={`${label}-${i}`}>{label}</span>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex h-[230px] items-stretch gap-[5px] border-b border-line">
            {series.map((point) => {
              const outPct = (point.output / axisMaxK) * 100;
              const inPct = (point.input / axisMaxK) * 100;
              return (
                <div
                  key={point.day}
                  title={`${point.day}: ${point.input + point.output}K tokens`}
                  className="flex h-full min-w-0 flex-1 flex-col justify-end overflow-hidden rounded-t-[3px] transition-opacity hover:opacity-80"
                >
                  <div
                    className="bg-accent-hover"
                    style={{ height: `${outPct}%` }}
                  />
                  <div
                    className="bg-accent-focus"
                    style={{ height: `${inPct}%` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between px-0.5 text-meta text-fg-tertiary">
            {xTicks.map((label, i) => (
              <span key={`${label}-${i}`}>{label}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default TokensChart;
