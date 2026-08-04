import { useEffect, useState } from "react";
import type { QuestionRequest } from "@lykeion/api";
import { PencilIcon, SparkleIcon } from "../icons";

/**
 * A clarifying-question card — the agent asked the researcher to choose before
 * continuing, and the turn is paused until it's answered. Shares the permission
 * card's shape.
 *
 * Answered via `onAnswer(selectedLabels)`. An EMPTY array is a deliberate skip
 * ("let the agent decide"), delivered to the agent as an explicit non-answer
 * rather than a hung turn.
 *
 * Options read as full-width rows, each with a leading badge (a number for
 * single-select, a checkbox for multi-select, a glyph for the special rows)
 * and a label + description that WRAP within the card. Single-select answers on
 * one deliberate CLICK — or the matching number key — while a multi-select
 * accumulates checkboxes behind a Submit, so no stray click commits a partial
 * set. A free-text row lets the researcher type their own answer, which travels
 * back through the same `selected` array.
 */
export function QuestionCard({
  request,
  onAnswer,
}: {
  request: QuestionRequest;
  onAnswer: (selected: string[]) => void;
}) {
  const [checked, setChecked] = useState<string[]>([]);
  const [custom, setCustom] = useState("");

  const toggle = (label: string) =>
    setChecked((prev) =>
      prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
    );

  // Number keys 1–9 pick the matching single-select option (the badges exist to
  // be typed). Ignored while a text field is focused so the free-text row and
  // the composer aren't hijacked; multi-select has no unambiguous key action.
  useEffect(() => {
    if (request.multiSelect) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (!/^[1-9]$/.test(e.key)) return;
      const opt = request.options[Number(e.key) - 1];
      if (opt) {
        e.preventDefault();
        onAnswer([opt.label]);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [request, onAnswer]);

  const trimmed = custom.trim();

  return (
    <div className="card question-card">
      <div className="card-eyebrow">{request.header || "Question"}</div>
      <div className="question-text">{request.question}</div>
      <div className="question-options">
        {request.options.map((opt, i) =>
          request.multiSelect ? (
            <label
              key={opt.label}
              className="question-option question-option--multi"
            >
              <input
                type="checkbox"
                className="question-check"
                checked={checked.includes(opt.label)}
                onChange={() => toggle(opt.label)}
              />
              <span className="question-option-body">
                <span className="question-option-label">{opt.label}</span>
                {opt.description && (
                  <span className="question-option-desc">
                    {opt.description}
                  </span>
                )}
              </span>
            </label>
          ) : (
            <button
              key={opt.label}
              type="button"
              className="question-option question-option--single"
              // Single-select: one deliberate click IS the answer.
              onClick={() => onAnswer([opt.label])}
            >
              <span className="question-badge question-badge--num" aria-hidden>
                {i + 1}
              </span>
              <span className="question-option-body">
                <span className="question-option-label">{opt.label}</span>
                {opt.description && (
                  <span className="question-option-desc">
                    {opt.description}
                  </span>
                )}
              </span>
            </button>
          ),
        )}

        {/* An empty answer — the agent proceeds on its own best judgment. */}
        <button
          type="button"
          className="question-option question-option--special"
          onClick={() => onAnswer([])}
        >
          <span className="question-badge" aria-hidden>
            <SparkleIcon width={13} height={13} />
          </span>
          <span className="question-option-body">
            <span className="question-option-label">Let the agent decide</span>
          </span>
        </button>

        {/* Free text — the typed answer rides back through `selected`. */}
        <div className="question-option question-option--custom">
          <span className="question-badge" aria-hidden>
            <PencilIcon width={13} height={13} />
          </span>
          <input
            type="text"
            className="question-custom-input"
            placeholder="Or type your own answer…"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && trimmed) {
                e.preventDefault();
                onAnswer([trimmed]);
              }
            }}
          />
          <button
            type="button"
            className={`btn question-send${trimmed ? " btn--primary" : ""}`}
            // Empty is a Skip (defer to the agent); typed text
            // becomes the answer.
            onClick={() => onAnswer(trimmed ? [trimmed] : [])}
          >
            {trimmed ? "Send" : "Skip"}
          </button>
        </div>
      </div>

      {request.multiSelect && (
        <div className="card-actions question-actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={checked.length === 0}
            onClick={() => onAnswer(checked)}
          >
            Submit
          </button>
        </div>
      )}
    </div>
  );
}

export default QuestionCard;
