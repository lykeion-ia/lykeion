import { useState } from "react";
import { artifactDataUrl, type ArtifactBlob } from "@lykeion/api";

/**
 * Image viewer — the blob's data URL on a checkerboard backdrop (so
 * transparency reads), with a path/size caption. The natural pixel dimensions
 * are shown once the image loads.
 */
export function ImageViewer({ blob }: { blob: ArtifactBlob }) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const src = artifactDataUrl(blob);

  return (
    <figure className="viz-figure artifact-image">
      <div className="image-stage">
        <img
          className="image-el"
          src={src}
          alt={blob.path}
          onLoad={(e) => {
            const img = e.currentTarget;
            setDims({ w: img.naturalWidth, h: img.naturalHeight });
          }}
        />
      </div>
      <figcaption className="viz-caption">
        <span className="image-path">{blob.path}</span>
        {dims && (
          <span className="image-dims">
            {dims.w}×{dims.h}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
