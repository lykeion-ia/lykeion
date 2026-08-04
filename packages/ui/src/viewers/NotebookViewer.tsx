import { useMemo } from "react";
import type { ArtifactBlob } from "@lykeion/api";

/** ipynb source/text fields are a string or an array of line-strings. */
type Source = string | string[];

interface NbOutput {
  output_type: string;
  name?: string;
  text?: Source;
  ename?: string;
  evalue?: string;
  traceback?: string[];
  data?: Record<string, Source>;
  execution_count?: number | null;
}

interface NbCell {
  cell_type: string;
  source?: Source;
  execution_count?: number | null;
  outputs?: NbOutput[];
}

interface Notebook {
  cells?: NbCell[];
  nbformat?: number;
}

function joinSource(s: Source | undefined): string {
  if (s == null) return "";
  return Array.isArray(s) ? s.join("") : s;
}

/**
 * Notebook viewer — parses the .ipynb JSON and renders each cell in order:
 * markdown as text, code as a mono block with an `In[ ]` gutter, and each code
 * output (stream/text-plain → mono; error → red; image/png → an <img>).
 * Dense and notebook-like; malformed JSON falls back to the raw source.
 */
export function NotebookViewer({ blob }: { blob: ArtifactBlob }) {
  const parsed = useMemo(() => {
    try {
      return { nb: JSON.parse(blob.data) as Notebook, error: null as null };
    } catch (e) {
      return { nb: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [blob.data]);

  if (parsed.error || !parsed.nb) {
    return (
      <div className="artifact-notebook">
        <div className="viz-note">
          Could not parse notebook — showing raw source.
        </div>
        <pre className="nb-raw">{blob.data}</pre>
      </div>
    );
  }

  const cells = parsed.nb.cells ?? [];
  return (
    <div className="artifact-notebook">
      {cells.map((cell, i) =>
        cell.cell_type === "code" ? (
          <CodeCell key={i} cell={cell} />
        ) : (
          <div className="nb-cell nb-markdown" key={i}>
            {joinSource(cell.source)}
          </div>
        ),
      )}
    </div>
  );
}

function CodeCell({ cell }: { cell: NbCell }) {
  const count =
    cell.execution_count === null || cell.execution_count === undefined
      ? " "
      : cell.execution_count;
  return (
    <div className="nb-cell nb-code">
      <div className="nb-code-row">
        <span className="nb-gutter" aria-hidden="true">
          In [{count}]:
        </span>
        <pre className="nb-source">{joinSource(cell.source)}</pre>
      </div>
      {(cell.outputs ?? []).map((out, i) => (
        <Output key={i} out={out} />
      ))}
    </div>
  );
}

function Output({ out }: { out: NbOutput }) {
  if (out.output_type === "error") {
    const tb = (out.traceback ?? []).join("\n");
    return (
      <pre className="nb-output nb-error">
        {tb || `${out.ename ?? "Error"}: ${out.evalue ?? ""}`}
      </pre>
    );
  }

  if (out.output_type === "stream") {
    return <pre className="nb-output nb-stream">{joinSource(out.text)}</pre>;
  }

  // execute_result / display_data — image first, then text/plain.
  const data = out.data ?? {};
  const png = data["image/png"];
  if (png) {
    const b64 = joinSource(png).replace(/\s+/g, "");
    return (
      <div className="nb-output nb-image">
        <img src={`data:image/png;base64,${b64}`} alt="cell output" />
      </div>
    );
  }
  const text = data["text/plain"];
  if (text != null) {
    return <pre className="nb-output nb-result">{joinSource(text)}</pre>;
  }
  return null;
}
