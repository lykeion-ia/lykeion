import { useApi } from "../../api/ApiContext";
import { usePromise } from "../../hooks/usePromise";
import { ArtifactViewer } from "../../viewers/ArtifactViewer";
import { CloseIcon } from "../icons";

/**
 * The right-pane inspector for one opened artifact — fetches its bytes with
 * `readArtifact` and hands them to the content-type-dispatching `ArtifactViewer`
 * (CSV/image/PDF/ipynb/text). The missing seam between the Files list and the
 * viewers, which take an already-loaded blob.
 */
export function ArtifactPane({
  studyId,
  path,
  onClose,
}: {
  studyId: string;
  path: string;
  onClose?: () => void;
}) {
  const api = useApi();
  const blob = usePromise(
    () => api.readArtifact(studyId, path),
    [api, studyId, path],
  );
  const name = path.split("/").pop() || path;

  return (
    <section className="artifact-pane" data-testid="artifact-pane">
      <header className="art-header">
        <span className="art-title" title={path}>
          {name}
        </span>
        {onClose && (
          <button
            type="button"
            className="art-icon-btn"
            title="Close artifact"
            aria-label="Close artifact"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        )}
      </header>
      <div className="artifact-pane-body">
        {blob.loading && <p className="nbp-empty">Loading {name}…</p>}
        {blob.error && (
          <p className="nbp-repl-error">
            Could not open {name}: {blob.error}
          </p>
        )}
        {blob.data && <ArtifactViewer blob={blob.data} />}
      </div>
    </section>
  );
}
