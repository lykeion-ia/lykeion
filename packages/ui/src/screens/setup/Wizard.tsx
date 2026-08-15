import type { ReactNode } from "react";
import { cn } from "../../lib/utils";

/**
 * The frame every setup step wears: a strip that counts, and the two controls
 * a step can offer.
 *
 * The strip shows dots rather than names, and that is load-bearing rather than
 * a matter of taste. Step 2 is a different screen on each branch — *create the
 * lab* on one, *which lab?* on the other — so a strip promising names would
 * have had to either lie on one path or renumber itself mid-flow, and
 * renumbering is the one thing a progress indicator may never do. Dots keep
 * the promise made at step 1: three steps, wherever the branch goes.
 *
 * It wears the app's own theme through the same tokens every other surface
 * uses, so a researcher who has chosen a dark theme is not handed a light
 * setup flow on their first run and a dark application immediately after.
 */
export interface WizardProps {
  /** Which step this is, counting from 1. */
  step: number;
  /** How many there are — the number promised at step 1 and kept after it. */
  total: number;
  /** Absent on the first step, where there is nowhere behind to go. */
  onBack?: () => void;
  /** Absent on a screen that commits some other way: the branch screen
   *  commits on a card, not on a footer button. */
  onContinue?: () => void;
  continueLabel?: string;
  /** What the back control says when going back is not what it means. Step 3
   *  leaves setup entirely rather than returning, and calling that "Back"
   *  would describe the wrong direction. */
  backLabel?: string;
  children: ReactNode;
}

export function Wizard({
  step,
  total,
  onBack,
  onContinue,
  continueLabel,
  backLabel,
  children,
}: WizardProps) {
  // A label rather than a heading, and given to the strip rather than to a
  // dot: a screen reader gets the count once, in words, while the dots stay
  // what they are on screen — a position, not a list of six things to hear.
  const dots = (
    <div
      role="group"
      aria-label={`Step ${step} of ${total}`}
      className="flex items-center gap-2"
    >
      {Array.from({ length: total }, (_, i) => i + 1).map((n) => (
        <span
          key={n}
          data-testid="wizard-dot"
          data-on={String(n === step)}
          className={cn(
            "h-1.5 rounded-full transition-all",
            n === step ? "w-6 bg-fg" : "w-1.5 bg-fg-tertiary",
          )}
        />
      ))}
    </div>
  );

  // Rendered when the caller gave it something to do, or its own word for
  // leaving — "Skip" is not a way back and is still a way out, and a frame
  // that only knew about "back" would have hidden it.
  //
  // Not "any step past the first". A step can legitimately have nowhere
  // behind it while still not being step 1: coming back from a lab already
  // paired lands on step 3, and the step before it is a question that has
  // been answered and cannot be asked again. That used to draw a Back button
  // wired to nothing, which is the one control worse than no control.
  const showBack = onBack !== undefined || backLabel !== undefined;

  return (
    // The window itself, not a minimum. `min-h-screen` let a step taller than
    // the viewport grow the whole frame, and the strip that counts went with
    // it: step 3 lists twelve agents, so the heading scrolled away off the top
    // and the dots sat below the fold, on the one screen whose whole job is to
    // say how much is left. Every step now wears the frame step 1 establishes —
    // a column in the middle, the count along the bottom, always both on screen.
    <div className="flex h-screen flex-col bg-canvas text-fg">
      {/* Overflow belongs to this region rather than to the page, so a long
          step scrolls its own content under a footer that stays put.

          Centred with `m-auto` rather than `items-center`, and the difference
          only shows on the step that needed this: a flex child centred by the
          container is centred even when it is taller than the container, which
          pushes its first line above the top of the scroll box where nothing
          can scroll back to it. Auto margins give up when there is no room to
          spare, so a short step sits in the middle and a tall one starts at the
          top and scrolls. */}
      <div className="flex flex-1 overflow-y-auto px-6 py-10">
        <div className="m-auto w-full max-w-[560px]">{children}</div>
      </div>

      <div className="shrink-0 border-t border-line px-6 py-4">
        <div className="mx-auto flex w-full max-w-[560px] items-center justify-between gap-4">
          {showBack ? (
            <button
              type="button"
              onClick={onBack}
              className="rounded-md px-3 py-1.5 text-ui text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              {backLabel ?? "Back"}
            </button>
          ) : (
            // Holds the row's shape so the dots sit where they sat on the
            // step before, rather than sliding left the moment a way back
            // appears.
            <span />
          )}

          {dots}

          {onContinue ? (
            <button
              type="button"
              onClick={onContinue}
              className="rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity hover:opacity-90"
            >
              {continueLabel ?? "Continue"}
            </button>
          ) : (
            <span />
          )}
        </div>
      </div>
    </div>
  );
}

export default Wizard;
