import { useEffect, useRef, useState } from "react";
import type { AgentOption } from "@lykeion/api";

/**
 * The model switcher — the composer's pill that picks what the next turn
 * runs on. What it lists is what the agent itself advertised when a session
 * was opened with it, never a catalogue kept here: a catalogue is a second
 * source of truth that goes stale the week a provider ships a model.
 *
 * `option` absent is an agent that offers no choice, or one no session could
 * be opened to ask — a neutral pill reading *Default*, which can now say
 * which of the two it is. `null` selected is the agent's own default.
 *
 * The same widget serves reasoning effort: an option's `category` is all
 * that differs, so nothing here is built twice.
 */
export function ModelSwitcher({
  option,
  reason,
  selectedModel,
  onSelect,
}: {
  /** What this agent advertised under the category being picked. */
  option?: AgentOption;
  /** Why there is no choice, when there is none. */
  reason?: string;
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

  const models = option?.choices ?? [];
  const current = selectedModel ?? option?.currentValue ?? null;
  const active = models.find((m) => m.value === current) ?? null;
  const label = active?.label ?? "Default";

  // This agent offered no choice — a neutral, non-interactive pill, which
  // says why rather than leaving a researcher to guess.
  if (models.length === 0) {
    return (
      <span
        className="cli-pill cli-pill--empty"
        title={reason ?? "This agent offered no choice of model"}
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
            <span className="cli-menu-eyebrow">{CATEGORY_LABEL[option?.category ?? "model"] ?? "Option"}</span>
          </div>
          {models.map((m) => {
            const isSel = m.value === current;
            return (
              <button
                key={m.value}
                type="button"
                role="option"
                aria-selected={isSel}
                aria-label={m.description ? `${m.label} — ${m.description}` : m.label}
                className={`cli-row${isSel ? " is-selected" : ""}`}
                onClick={() => {
                  onSelect(m.value);
                  setOpen(false);
                }}
              >
                <span className="cli-row-main">
                  <span className="cli-row-name">{m.label}</span>
                  {m.description && (
                    <span className="cli-row-desc">{m.description}</span>
                  )}
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

/** What a category is called on screen. An unlisted one is still offered —
 *  the agent named it, and refusing to draw it would hide a real choice. */
const CATEGORY_LABEL: Record<string, string> = {
  model: "Model",
  thought_level: "Reasoning",
};

export default ModelSwitcher;
