import type { ArtifactBlob } from "@lykeion/api";
import { TableChartViewer } from "./TableChartViewer";
import { ImageViewer } from "./ImageViewer";
import { PdfViewer } from "./PdfViewer";
import { NotebookViewer } from "./NotebookViewer";
import "./viewers.css";

/** Byte length of a blob's content (decoded for base64, UTF-8 for text). */
export function blobByteLength(blob: ArtifactBlob): number {
  if (blob.encoding === "base64") {
    // Drop whitespace, then the padding, and derive the decoded byte count
    // from the remaining base64 characters (3 bytes per 4 chars).
    const chars = blob.data.replace(/\s+/g, "").replace(/=+$/, "");
    return Math.floor((chars.length * 3) / 4);
  }
  return new TextEncoder().encode(blob.data).length;
}

/**
 * The viewer dispatcher: pick a viewer by content type. Table/chart for
 * CSV/TSV, an image for `image/*`, an embed for PDF, a notebook for ipynb,
 * a mono code block for JSON/other text, and a labelled placeholder for
 * anything binary we can't preview.
 */
export function ArtifactViewer({ blob }: { blob: ArtifactBlob }) {
  const ct = blob.contentType;
  if (ct === "text/csv" || ct === "text/tab-separated-values") {
    return <TableChartViewer blob={blob} />;
  }
  if (ct.startsWith("image/")) {
    return <ImageViewer blob={blob} />;
  }
  if (ct === "application/pdf") {
    return <PdfViewer blob={blob} />;
  }
  if (ct === "application/x-ipynb+json") {
    return <NotebookViewer blob={blob} />;
  }
  if (ct === "application/json" || ct.startsWith("text/")) {
    return <TextViewer blob={blob} />;
  }
  return <UnsupportedViewer blob={blob} />;
}

/** Mono/code fallback for JSON and plain-text artifacts. */
function TextViewer({ blob }: { blob: ArtifactBlob }) {
  return (
    <div className="artifact-text">
      <div className="viz-caption">
        <span className="image-path">{blob.path}</span>
        <span className="viz-meta">{blob.contentType}</span>
      </div>
      <pre className="code-text">{blob.data}</pre>
    </div>
  );
}

/** "Preview not available" placeholder for unpreviewable binary. */
function UnsupportedViewer({ blob }: { blob: ArtifactBlob }) {
  const bytes = blobByteLength(blob);
  return (
    <div className="artifact-unsupported">
      <p className="unsupported-title">Preview not available</p>
      <p className="unsupported-detail">
        <span className="image-path">{blob.path}</span> ({blob.contentType},{" "}
        {bytes} byte{bytes === 1 ? "" : "s"})
      </p>
      <p className="unsupported-note">
        This artifact type has no inline viewer yet — it is stored intact in the
        provenance record.
      </p>
    </div>
  );
}
