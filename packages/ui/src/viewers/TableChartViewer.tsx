import { useMemo, useState } from "react";
import type { ArtifactBlob } from "@lykeion/api";
import { delimiterFor, numericColumns, parseDelimited } from "./csv";

/**
 * TableChart viewer — CSV/TSV rendered as (1) a dense table and
 * (2) a small, self-contained SVG chart when the data has a numeric column.
 * Zero chart deps: the parser and the SVG are hand-rolled here.
 *
 * Chart forms (dataviz skill): a bar chart of the first numeric column, and —
 * when there are ≥2 numeric columns — a scatter of the first two. Colors are
 * the validated dark categorical blue (never the lavender brand accent), on a
 * faint grid with an emphasized max mark and axis titles.
 */
export function TableChartViewer({ blob }: { blob: ArtifactBlob }) {
  const { header, rows, numeric } = useMemo(() => {
    const grid = parseDelimited(blob.data, delimiterFor(blob.contentType));
    const head = grid[0] ?? [];
    const body = grid.slice(1);
    return { header: head, rows: body, numeric: numericColumns(head, body) };
  }, [blob.data, blob.contentType]);

  const numericSet = useMemo(() => new Set(numeric), [numeric]);
  const canChart = numeric.length >= 1;
  const canScatter = numeric.length >= 2;

  const [view, setView] = useState<"table" | "chart">("table");
  const [kind, setKind] = useState<"bar" | "scatter">("bar");
  const chartKind = kind === "scatter" && canScatter ? "scatter" : "bar";

  return (
    <div className="viz-root artifact-tablechart">
      <div className="viz-toolbar">
        <div className="seg" role="group" aria-label="View">
          <button
            type="button"
            className={`seg-btn${view === "table" ? " is-active" : ""}`}
            aria-pressed={view === "table"}
            onClick={() => setView("table")}
          >
            Table
          </button>
          <button
            type="button"
            className={`seg-btn${view === "chart" ? " is-active" : ""}`}
            aria-pressed={view === "chart"}
            onClick={() => setView("chart")}
            disabled={!canChart}
          >
            Chart
          </button>
        </div>
        {view === "chart" && canScatter && (
          <div className="seg" role="group" aria-label="Chart type">
            <button
              type="button"
              className={`seg-btn${chartKind === "bar" ? " is-active" : ""}`}
              aria-pressed={chartKind === "bar"}
              onClick={() => setKind("bar")}
            >
              Bar
            </button>
            <button
              type="button"
              className={`seg-btn${chartKind === "scatter" ? " is-active" : ""}`}
              aria-pressed={chartKind === "scatter"}
              onClick={() => setKind("scatter")}
            >
              Scatter
            </button>
          </div>
        )}
        <span className="viz-meta">
          {rows.length} row{rows.length === 1 ? "" : "s"} · {header.length} col
          {header.length === 1 ? "" : "s"}
        </span>
      </div>

      {view === "table" ? (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {header.map((h, i) => (
                  <th key={i} className={numericSet.has(i) ? "num" : undefined}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {header.map((_, ci) => (
                    <td
                      key={ci}
                      className={numericSet.has(ci) ? "num" : undefined}
                    >
                      {r[ci] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !canChart ? (
        <div className="viz-note">No numeric columns to chart.</div>
      ) : chartKind === "scatter" ? (
        <ScatterChart header={header} rows={rows} numeric={numeric} />
      ) : (
        <BarChart header={header} rows={rows} numeric={numeric} />
      )}
    </div>
  );
}

// ---- chart geometry ----------------------------------------------------

const W = 560;
const H = 260;
const M = { top: 16, right: 18, bottom: 44, left: 48 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;

/** Nice round tick step for a [0..max] axis (~4 ticks). */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks: number[] = [];
  for (let t = 0; t <= max + 1e-9; t += step) ticks.push(t);
  return ticks;
}

function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, "");
}

/** A bar chart of the first numeric column across rows. */
function BarChart({
  header,
  rows,
  numeric,
}: {
  header: string[];
  rows: string[][];
  numeric: number[];
}) {
  const valCol = numeric[0];
  // Label column: the first non-numeric column, else the row index.
  const labelCol = header.findIndex((_, i) => !numeric.includes(i));
  const points = rows
    .map((r, i) => ({
      label: labelCol >= 0 ? (r[labelCol] ?? String(i + 1)) : String(i + 1),
      value: Number((r[valCol] ?? "").trim()),
    }))
    .filter((p) => Number.isFinite(p.value));

  const max = Math.max(0, ...points.map((p) => p.value));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const y = (v: number) => M.top + PLOT_H - (v / top) * PLOT_H;
  const band = PLOT_W / Math.max(1, points.length);
  const barW = Math.min(46, band * 0.62);
  const maxValue = Math.max(...points.map((p) => p.value));

  return (
    <figure className="viz-figure">
      <figcaption className="viz-caption">
        {header[valCol]} by {labelCol >= 0 ? header[labelCol] : "row"}
      </figcaption>
      <div className="chart-scroll">
        <svg
          className="viz-svg"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Bar chart of ${header[valCol]}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* faint horizontal grid + y ticks */}
          {ticks.map((t, i) => (
            <g key={i}>
              <line
                className="viz-grid"
                x1={M.left}
                x2={W - M.right}
                y1={y(t)}
                y2={y(t)}
              />
              <text
                className="viz-tick"
                x={M.left - 6}
                y={y(t) + 3}
                textAnchor="end"
              >
                {fmtNum(t)}
              </text>
            </g>
          ))}
          {/* emphasized baseline/axis */}
          <line
            className="viz-axis"
            x1={M.left}
            x2={W - M.right}
            y1={y(0)}
            y2={y(0)}
          />
          {/* bars — the max bar is emphasized + directly labeled */}
          {points.map((p, i) => {
            const x = M.left + band * i + (band - barW) / 2;
            const h = y(0) - y(p.value);
            const emph = p.value === maxValue;
            return (
              <g key={i}>
                <rect
                  className={`viz-bar${emph ? " is-emph" : ""}`}
                  x={x}
                  y={y(p.value)}
                  width={barW}
                  height={Math.max(0, h)}
                  rx={3}
                />
                {emph && (
                  <text
                    className="viz-datalabel"
                    x={x + barW / 2}
                    y={y(p.value) - 5}
                    textAnchor="middle"
                  >
                    {fmtNum(p.value)}
                  </text>
                )}
                <text
                  className="viz-tick"
                  x={x + barW / 2}
                  y={H - M.bottom + 15}
                  textAnchor="middle"
                >
                  {p.label}
                </text>
              </g>
            );
          })}
          {/* axis titles */}
          <text className="viz-axis-title" x={M.left} y={H - 8}>
            {labelCol >= 0 ? header[labelCol] : "row"}
          </text>
          <text
            className="viz-axis-title"
            x={0}
            y={0}
            transform={`translate(12 ${M.top + PLOT_H / 2}) rotate(-90)`}
            textAnchor="middle"
          >
            {header[valCol]}
          </text>
        </svg>
      </div>
    </figure>
  );
}

/** A scatter of the first two numeric columns. */
function ScatterChart({
  header,
  rows,
  numeric,
}: {
  header: string[];
  rows: string[][];
  numeric: number[];
}) {
  const [cx, cy] = numeric;
  const pts = rows
    .map((r) => ({
      x: Number((r[cx] ?? "").trim()),
      y: Number((r[cy] ?? "").trim()),
    }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMax = Math.max(...ys);
  const xPad = (xMax - xMin || 1) * 0.06;
  const sx = (v: number) =>
    M.left +
    ((v - (xMin - xPad)) / (xMax + xPad - (xMin - xPad) || 1)) * PLOT_W;
  const yTop = niceTicks(yMax).slice(-1)[0] || 1;
  const sy = (v: number) => M.top + PLOT_H - (v / yTop) * PLOT_H;
  const yTicks = niceTicks(yMax);
  const emphIdx = ys.indexOf(yMax);

  return (
    <figure className="viz-figure">
      <figcaption className="viz-caption">
        {header[cy]} vs {header[cx]}
      </figcaption>
      <div className="chart-scroll">
        <svg
          className="viz-svg"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Scatter of ${header[cy]} against ${header[cx]}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {yTicks.map((t, i) => (
            <g key={i}>
              <line
                className="viz-grid"
                x1={M.left}
                x2={W - M.right}
                y1={sy(t)}
                y2={sy(t)}
              />
              <text
                className="viz-tick"
                x={M.left - 6}
                y={sy(t) + 3}
                textAnchor="end"
              >
                {fmtNum(t)}
              </text>
            </g>
          ))}
          <line
            className="viz-axis"
            x1={M.left}
            x2={W - M.right}
            y1={sy(0)}
            y2={sy(0)}
          />
          <line
            className="viz-axis"
            x1={M.left}
            x2={M.left}
            y1={M.top}
            y2={M.top + PLOT_H}
          />
          {pts.map((p, i) => (
            <circle
              key={i}
              className={`viz-dot${i === emphIdx ? " is-emph" : ""}`}
              cx={sx(p.x)}
              cy={sy(p.y)}
              r={i === emphIdx ? 5.5 : 4.5}
            />
          ))}
          {/* x tick labels: min and max */}
          <text
            className="viz-tick"
            x={M.left}
            y={H - M.bottom + 15}
            textAnchor="start"
          >
            {fmtNum(xMin)}
          </text>
          <text
            className="viz-tick"
            x={W - M.right}
            y={H - M.bottom + 15}
            textAnchor="end"
          >
            {fmtNum(xMax)}
          </text>
          <text
            className="viz-axis-title"
            x={M.left + PLOT_W / 2}
            y={H - 8}
            textAnchor="middle"
          >
            {header[cx]}
          </text>
          <text
            className="viz-axis-title"
            transform={`translate(12 ${M.top + PLOT_H / 2}) rotate(-90)`}
            textAnchor="middle"
          >
            {header[cy]}
          </text>
        </svg>
      </div>
    </figure>
  );
}
