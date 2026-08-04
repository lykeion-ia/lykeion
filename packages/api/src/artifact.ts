/**
 * A saved artifact's bytes, typed for the viewer layer. camelCase on the
 * wire: text is returned UTF-8, anything binary as standard base64. The UI's
 * `ArtifactViewer` dispatches on `contentType`.
 */
export interface ArtifactBlob {
  /** Workspace/Study-relative path. */
  path: string;
  /** MIME type inferred from the extension (e.g. `text/csv`, `image/png`). */
  contentType: string;
  /** `"utf8"` for text, `"base64"` for binary. */
  encoding: "utf8" | "base64";
  /** The content — a UTF-8 string, or standard-base64 for binary. */
  data: string;
}

/**
 * A `data:` URL for a blob, suitable for `<img src>`, `<embed src>`, etc.
 * Base64 blobs embed directly; UTF-8 blobs are percent-encoded so commas,
 * newlines, and non-ASCII survive the URL.
 */
export function artifactDataUrl(blob: ArtifactBlob): string {
  if (blob.encoding === "base64") {
    return `data:${blob.contentType};base64,${blob.data}`;
  }
  return `data:${blob.contentType};charset=utf-8,${encodeURIComponent(blob.data)}`;
}
