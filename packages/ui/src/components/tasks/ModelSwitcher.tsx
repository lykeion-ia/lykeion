import { useEffect, useRef, useState } from "react";
import { modelsForCli } from "../../lib/cli-models";

/**
 * The model switcher — the composer's pill that picks which AI model the run
 * uses. Options depend on the currently-selected CLI (the dock below the
 * composer picks the CLI; this picks its model). A CLI with a real model
 * catalogue (Claude Code, via `--model`) gets a working dropdown; a CLI with no
 * catalogue (the ACP agents, whose models are session-dynamic) shows a disabled
 * "Default". `null` = the provider default (no `--model` passed).
 */
export function ModelSwitcher({
  cliId,
  selectedModel,
  onSelect,
}: {
  /** The effective selected CLI id — drives which models are offered. */
  cliId: string | null;
  selectedModel: string | null;
  onSelect: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const models = modelsForCli(cliId);
  const active = models.find((m) => m.value === selectedModel) ?? null;
  const label = active?.label ?? "Default";

  // No catalogue for this CLI — a neutral, non-interactive pill.
  if (models.length === 0) {
    return (
      <span
        className="cli-pill cli-pill--empty"
        title="This CLI selects its model automatically"
      >
        <span className="cli-pill-name">Default</span>
      </span>
    );
  }

  return (
    <div className="cli-switcher" ref={rootRef}>
      <button
        type="button"
        className="cli-pill"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${label}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cli-pill-name">{label}</span>
        <svg
          className="cli-chevron"
          data-open={open}
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
        >
          <path
            d="M2.5 4 5 6.5 7.5 4"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div className="cli-menu" role="listbox" aria-label="Models">
          <div className="cli-menu-head">
            <span className="cli-menu-eyebrow">Model</span>
          </div>
          {models.map((m) => {
            const isSel = m.value === selectedModel;
            return (
              <button
                key={m.value}
                type="button"
                role="option"
                aria-selected={isSel}
                aria-label={`${m.label} — ${m.desc}`}
                className={`cli-row${isSel ? " is-selected" : ""}`}
                onClick={() => {
                  onSelect(m.value);
                  setOpen(false);
                }}
              >
                <span className="cli-row-main">
                  <span className="cli-row-name">{m.label}</span>
                  <span className="cli-row-desc">{m.desc}</span>
                </span>
                <span className="cli-row-status">
                  {isSel && (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      <path
                        d="M2.5 7.5 5.5 10.5 11.5 3.5"
                        stroke="var(--accent)"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ModelSwitcher;
