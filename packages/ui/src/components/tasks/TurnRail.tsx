import type { ReactNode } from "react";

/**
 * The timeline rail a turn's reply is drawn on: one continuous hairline down
 * the leading edge with a marker per event on it — prose, thinking, and every
 * tool step alike — so a turn that ran fifteen tools reads as one run and the
 * eye travels straight down the markers instead of over fifteen boxes.
 *
 * Two exports rather than one, and both are used by every surface that draws a
 * reply: the live in-flight turn and the same turn reopened months later go
 * through `StreamView`, so neither can draw a rail the other doesn't.
 *
 * What does NOT go on the rail: the researcher's prompt bubble (its own
 * right-aligned treatment), and the pending asks — plan, permission, question.
 * The rail is the record of what the agent did and said; demoting a card that
 * wants an answer to a node on it would bury the one thing on screen that is
 * waiting for the researcher.
 */

/**
 * What a row's marker says about its event. Colour NEVER carries a bad outcome
 * on its own: `blocked` and `error` draw a GLYPH, and every non-`ok` tool row
 * also renders its status as a word (below) — so a researcher who cannot tell
 * the green dot from the amber one still reads the same transcript.
 */
export type RailMarker =
  | "prose"
  | "thinking"
  | "ok"
  | "running"
  | "blocked"
  | "error";

/** The markers drawn as a character rather than as a dot. The rest are shapes
 *  drawn in CSS (a hollow ring for prose, a small filled dot for thinking, a
 *  filled dot for a tool that ran or is running). */
const MARKER_GLYPH: Partial<Record<RailMarker, string>> = {
  blocked: "⊘",
  error: "✕",
};

/**
 * The status word a marker carries for a screen reader.
 *
 * This is not decoration. A rail row is labelled TOOL NAME + ARGUMENT
 * ("Write  results/out.csv"), which is tenseless by design — the marker, not
 * the verb, says whether the call ran. That fact used to live in the label
 * itself ("Write" vs "Wrote"), and it must not simply vanish for anyone who
 * cannot see the marker. `ok` carries no word: it is the unremarkable case,
 * and announcing "ok" before every one of fifteen steps is noise.
 */
const MARKER_STATUS_WORD: Partial<Record<RailMarker, string>> = {
  running: "running",
  blocked: "blocked",
  error: "failed",
};

/**
 * The rail itself: a grid of rows with NO gap between them. The gap is
 * deliberately absent — each row draws its own segment of the line (see
 * `RailRow`), and any space between two rows would show as a break in what has
 * to read as one continuous rail. Rows carry their own vertical padding
 * instead, so the rhythm is unchanged and the line is unbroken.
 *
 * `nested` is the body of an open step GROUP: the same rail one column in, drawn
 * dimmer, so the group's children read as hanging off their header rather than
 * as peers of the steps around it.
 */
export function TurnRail({
  children,
  nested = false,
}: {
  children: ReactNode;
  nested?: boolean;
}) {
  return (
    <div
      className={`turn-rail${nested ? " turn-rail--nested" : ""}`}
      data-testid={nested ? "turn-rail-nested" : "turn-rail"}
    >
      {children}
    </div>
  );
}

/**
 * One node on the rail: a marker cell and a content cell.
 *
 * The line is drawn per ROW (`.rail-row::before`, a full-height 1px bar at the
 * rail column's centre) rather than once on the container. Adjacent rows join
 * into one unbroken line, and a nested group body can carry its own dimmer line
 * without the outer rail having to know anything about it.
 *
 * The marker is `aria-hidden` — it is a shape, and the row's own text says what
 * happened. The status WORD beside it is not: see [`MARKER_STATUS_WORD`].
 */
export function RailRow({
  marker,
  className,
  testid,
  children,
}: {
  marker: RailMarker;
  /** Extra classes for the row element itself — the step card's status and
   *  open-state modifiers ride here rather than on a wrapper, so the row IS the
   *  card and nothing sits between it and the rail. */
  className?: string;
  testid?: string;
  children: ReactNode;
}) {
  const word = MARKER_STATUS_WORD[marker];
  return (
    <div
      className={`rail-row rail-row--${marker}${className ? ` ${className}` : ""}`}
      data-marker={marker}
      {...(testid ? { "data-testid": testid } : {})}
    >
      <span className={`rail-marker rail-marker--${marker}`} aria-hidden="true">
        {MARKER_GLYPH[marker]}
      </span>
      <div className="rail-body">
        {word && <span className="sr-only">{word}</span>}
        {children}
      </div>
    </div>
  );
}
