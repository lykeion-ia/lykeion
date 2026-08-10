import { useState } from "react";
import type { KernelMessage, NotebookCell } from "@lykeion/api";
import { useDirectory } from "../../hooks/useDirectory";
import { CodeBlock } from "./CodeBlock";

export function outputSummary(outputs: KernelMessage[]): string {
  if (outputs.some((output) => output.kind === "error")) return "error";
  const records = outputs.filter(
    (output) => output.kind === "display_data" || output.kind === "execute_result",
  );
  if (records.some((output) => typeof output.data["image/png"] === "string")) {
    return "output · figure";
  }
  const text = outputs
    .map((output) => {
      if (output.kind === "stream") return output.text;
      if (output.kind === "display_data" || output.kind === "execute_result") {
        const plain = output.data["text/plain"];
        return typeof plain === "string" ? plain : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
  if (text) {
    const lines = text.replace(/\n$/, "").split("\n").length;
    return `output · ${lines} ${lines === 1 ? "line" : "lines"}`;
  }
  return `output · ${outputs.length} ${outputs.length === 1 ? "message" : "messages"}`;
}

export function NotebookLedger({
  cells,
  loading,
  warning,
  autoOpenCellId,
  contextLabel,
  writable,
}: {
  cells: NotebookCell[];
  loading: boolean;
  warning: string | null;
  autoOpenCellId: string | null;
  contextLabel: string | null;
  writable: boolean;
}): React.JSX.Element {
  return (
    <>
      <div className="nbp-cells" data-testid="notebook-cells">
        {warning && (
          <p className="nbp-warning" role="status">
            {warning}
          </p>
        )}
        {loading ? (
          <p className="nbp-loading">Loading notebook…</p>
        ) : cells.length === 0 ? (
          <p className="nbp-empty">
            No cells yet. Ask the agent to run code, or wait for this context&apos;s
            kernel to start one — each context keeps its own namespace.
          </p>
        ) : (
          cells.map((cell) => (
            <CellView key={cell.id} cell={cell} autoOpenCellId={autoOpenCellId} />
          ))
        )}
      </div>

      {contextLabel && (
        <div className="nbp-footer" data-testid="notebook-footer">
          <span>
            {contextLabel}
            {writable && " — writable"}
          </span>
          <span className="nbp-footer-count">
            {cells.length === 1 ? " · 1 cell" : ` · ${cells.length} cells`}
          </span>
        </div>
      )}
    </>
  );
}

function CellBy({ cell }: { cell: NotebookCell }) {
  const directory = useDirectory();
  const { surface, by } = cell.origin;
  if (surface === "agent") return <>agent · {by}</>;
  if (!directory.loaded) return <>repl</>;
  const user = directory.user(by);
  return <>repl · {user ? user.displayName : "unknown member"}</>;
}

function CellView({
  cell,
  autoOpenCellId,
}: {
  cell: NotebookCell;
  autoOpenCellId: string | null;
}) {
  const label = cell.executionCount > 0 ? cell.executionCount : " ";
  const [open, setOpen] = useState(!cell.ok || cell.id === autoOpenCellId);
  return (
    <div className={`nbp-cell${cell.ok ? "" : " nbp-cell--err"}`}>
      <CodeBlock
        code={cell.source}
        lang={cell.language}
        lineNumbers
        meta={
          <span className="nbp-cell-meta">
            <span className="nbp-gutter">In [{label}]</span>
            <span className="nbp-cell-lang">{cell.language}</span>
            <span className="nbp-cell-by">
              <CellBy cell={cell} />
            </span>
          </span>
        }
      />
      {cell.outputs.length > 0 && (
        <details
          className="nbp-output-wrap"
          open={open}
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary className="nbp-output-summary">{outputSummary(cell.outputs)}</summary>
          <div className="nbp-outputs">
            {cell.outputs.map((output, index) => (
              <OutputView key={index} output={output} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function payload(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function OutputView({ output }: { output: KernelMessage }) {
  if (output.kind === "stream") {
    return <pre className="nbp-out nbp-stream">{output.text}</pre>;
  }
  if (output.kind === "error") {
    const traceback = Array.isArray(output.traceback) ? output.traceback.join("\n") : "";
    return (
      <pre className="nbp-out nbp-error">
        {traceback || `${output.ename}: ${output.evalue}`}
      </pre>
    );
  }
  const data = payload(output.data);
  const png = data["image/png"];
  if (typeof png === "string") {
    const base64 = png.replace(/\s+/g, "");
    return (
      <div className="nbp-out nbp-image">
        <img src={`data:image/png;base64,${base64}`} alt="cell output" />
      </div>
    );
  }
  const text = data["text/plain"];
  if (typeof text === "string") {
    return <pre className="nbp-out nbp-result">{text}</pre>;
  }
  const references = payload(output.data_ref);
  const mimeTypes = Object.keys(references);
  if (mimeTypes.length > 0) {
    return (
      <pre className="nbp-out nbp-result">
        {mimeTypes
          .map((mime) => {
            const meta = references[mime] as { path?: string } | undefined;
            return `[${mime} → ${meta?.path ?? ".lykeion/outputs"}]`;
          })
          .join("\n")}
      </pre>
    );
  }
  return null;
}
