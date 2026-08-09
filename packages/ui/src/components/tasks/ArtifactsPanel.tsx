import { useMemo, useState } from "react";
import type { RunArtifact } from "@lykeion/api";
import { cn } from "../../lib/utils";
import { formatBytes } from "../../lib/format";

/**
 * The "Files" surface: header ("Files" + optional close) · controls (search ·
 * count · grid/list) · grouped artifact cards. Fed by the run's REAL artifacts
 * (code + outputs); nothing is seeded, so a Task with no run shows the empty
 * state.
 *
 * Rendered in two placements (same component): as the main-area "Files" tab,
 * and as the top-right-toggled slide-in right pane (`onClose` shows the Close
 * control).
 */
export interface FileItem {
  name: string;
  path: string;
  size: number;
  kind: FileKind;
}

export interface ArtifactGroup {
  title: string;
  items: FileItem[];
}

type FileKind = "image" | "table" | "notebook" | "doc" | "code" | "file";

const EXT_KIND: Record<string, FileKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  svg: "image",
  webp: "image",
  csv: "table",
  tsv: "table",
  parquet: "table",
  ipynb: "notebook",
  md: "doc",
  pdf: "doc",
  txt: "doc",
  py: "code",
  ts: "code",
  tsx: "code",
  js: "code",
  r: "code",
  json: "code",
  sh: "code",
};

export function fileKind(path: string): FileKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_KIND[ext] ?? "file";
}

export function toFileItem(a: RunArtifact): FileItem {
  const name = a.path.split("/").pop() || a.path;
  return { name, path: a.path, size: a.size, kind: fileKind(a.path) };
}

function KindGlyph({ kind }: { kind: FileKind }) {
  // 24-viewBox line icons, in a consistent stroke style.
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (kind) {
    case "image":
      return (
        <svg {...common}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="M4 17l4.5-4 3 2.5 3-3L20 17" />
        </svg>
      );
    case "table":
      return (
        <svg {...common}>
          <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
          <path d="M3.5 9.5h17M9 4.5v15" />
        </svg>
      );
    case "notebook":
      return (
        <svg {...common}>
          <rect x="5" y="3.5" width="14" height="17" rx="2" />
          <path d="M8 3.5v17M11 8h5M11 12h5" />
        </svg>
      );
    case "code":
      return (
        <svg {...common}>
          <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />
        </svg>
      );
    case "doc":
      return (
        <svg {...common}>
          <path d="M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9m-6-6 6 6m-6-6v6h6M8.5 13h7M8.5 16.5h5" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9m-6-6 6 6m-6-6v6h6" />
        </svg>
      );
  }
}

function ArtifactCard({
  item,
  onOpen,
}: {
  item: FileItem;
  onOpen?: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="art-card"
      onClick={() => onOpen?.(item.path)}
      title={item.path}
    >
      <div className="art-card-preview">
        <KindGlyph kind={item.kind} />
      </div>
      <div className="art-card-foot">
        <div className="art-card-name">{item.name}</div>
        <div className="art-card-meta">{formatBytes(item.size)}</div>
      </div>
    </button>
  );
}

export function ArtifactsPanel({
  groups,
  onClose,
  onOpenArtifact,
}: {
  groups: ArtifactGroup[];
  onClose?: () => void;
  onOpenArtifact?: (path: string) => void;
}) {
  const [view, setView] = useState<"grid" | "list">("grid");
  const [query, setQuery] = useState("");

  const total = useMemo(
    () => groups.reduce((n, g) => n + g.items.length, 0),
    [groups],
  );
  const matches = (name: string) =>
    query.trim() === "" || name.toLowerCase().includes(query.toLowerCase());

  return (
    <section className="artifacts-panel" data-testid="artifacts-panel">
      <header className="art-header">
        <span className="art-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path
              d="M13 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V9m-6-6 6 6m-6-6v6h6"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Files
        </span>
        {onClose && (
          <button
            type="button"
            className="art-icon-btn"
            aria-label="Close files"
            onClick={onClose}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <rect
                x="3.5"
                y="4.5"
                width="17"
                height="15"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.75"
              />
              <path d="M15 4.5v15" stroke="currentColor" strokeWidth="1.75" />
            </svg>
          </button>
        )}
      </header>

      <div className="art-controls">
        <div className="art-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle
              cx="11"
              cy="11"
              r="6.5"
              stroke="currentColor"
              strokeWidth="1.75"
            />
            <path
              d="M16 16l4 4"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
            />
          </svg>
          <input
            className="art-search-input"
            placeholder="Filter files…"
            aria-label="Filter files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="art-view-toggle" role="group" aria-label="View">
          <button
            type="button"
            className={cn("art-view-btn", view === "grid" && "is-active")}
            aria-pressed={view === "grid"}
            aria-label="Grid view"
            onClick={() => setView("grid")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <rect
                x="4"
                y="4"
                width="7"
                height="7"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.75"
              />
              <rect
                x="13"
                y="4"
                width="7"
                height="7"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.75"
              />
              <rect
                x="4"
                y="13"
                width="7"
                height="7"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.75"
              />
              <rect
                x="13"
                y="13"
                width="7"
                height="7"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.75"
              />
            </svg>
          </button>
          <button
            type="button"
            className={cn("art-view-btn", view === "list" && "is-active")}
            aria-pressed={view === "list"}
            aria-label="List view"
            onClick={() => setView("list")}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path
                d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <div className="art-body">
        {total === 0 ? (
          <div className="art-empty">
            No files yet — artifacts a run produces show up here.
          </div>
        ) : (
          groups.map((group) => {
            const items = group.items.filter((i) => matches(i.name));
            return (
              <div className="art-group" key={group.title}>
                <div className="art-group-head">
                  <span className="art-group-title">{group.title}</span>
                  <span className="art-group-count">{group.items.length}</span>
                </div>
                {view === "grid" ? (
                  <div className="art-grid">
                    {items.map((item) => (
                      <ArtifactCard
                        key={item.path}
                        item={item}
                        onOpen={onOpenArtifact}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="art-list">
                    {items.map((item) => (
                      <button
                        key={item.path}
                        type="button"
                        className="art-list-row"
                        onClick={() => onOpenArtifact?.(item.path)}
                        title={item.path}
                      >
                        <span className="art-list-glyph">
                          <KindGlyph kind={item.kind} />
                        </span>
                        <span className="art-list-name">{item.name}</span>
                        <span className="art-list-size">
                          {formatBytes(item.size)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

export default ArtifactsPanel;
