import type { NotebookCell } from "@lykeion/api";

/**
 * The cells one Execution Log step produced.
 *
 * A kernel call is one event seen from two sides — a step in the transcript
 * and a cell in the notebook — and this is the side of that join a reader
 * arrives at from the transcript. It renders nothing at all where a step
 * produced no cells, which is every step that is not a kernel execution.
 */
export function StepCells({ cells }: { cells: NotebookCell[] }): React.ReactElement | null {
  if (cells.length === 0) return null;
  return (
    <section className="step-cells">
      <h4 className="step-cells-heading">
        {cells.length === 1 ? "1 cell" : `${cells.length} cells`}
      </h4>
      {cells.map((cell) => (
        <div
          key={cell.id}
          data-testid="step-cell"
          className={`step-cell${cell.ok ? "" : " step-cell--err"}`}
        >
          <span className="step-cell-lang">{cell.language}</span>
          <pre data-testid="step-cell-source" className="step-cell-source">
            {cell.source}
          </pre>
        </div>
      ))}
    </section>
  );
}
