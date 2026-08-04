import { artifactDataUrl, type ArtifactBlob } from "@lykeion/api";

/**
 * PDF viewer — an `<embed>` filling the panel, with a caption + open link as
 * a fallback (some sandboxes/jsdom won't render the plugin; the link and the
 * `data:application/pdf` src always exist).
 */
export function PdfViewer({ blob }: { blob: ArtifactBlob }) {
  const src = artifactDataUrl(blob);
  return (
    <figure className="viz-figure artifact-pdf">
      <div className="pdf-stage">
        <embed
          className="pdf-embed"
          type="application/pdf"
          src={src}
          title={blob.path}
          aria-label={`PDF preview of ${blob.path}`}
        />
      </div>
      <figcaption className="viz-caption">
        <span className="image-path">{blob.path}</span>
        <a className="pdf-open" href={src} target="_blank" rel="noreferrer">
          Open PDF
        </a>
      </figcaption>
    </figure>
  );
}
