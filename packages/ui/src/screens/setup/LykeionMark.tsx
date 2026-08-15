/**
 * The product's own mark, drawn the way the daemon's pages draw it — an
 * accent tile carrying the lambda, with the name beside it.
 *
 * It exists because the first run has no doorway screen to carry it. Setup
 * opens directly on the one question that decides everything after, and a
 * researcher arriving there has just come from a terminal or a link with no
 * other sign of what they have opened. Without this, step 1 is an unsigned
 * question from an unnamed program.
 *
 * Kept in step with `pairing-pages.ts`'s `.brand` deliberately: those pages
 * and this one are the same first run seen either side of a redirect, and two
 * marks that drifted apart would read as two products.
 */
export function LykeionMark() {
  return (
    <div
      data-testid="lykeion-mark"
      aria-label="Lykeion"
      className="flex items-center gap-2 text-meta font-semibold tracking-[0.02em] text-fg"
    >
      <span
        aria-hidden="true"
        className="grid h-6 w-6 place-items-center rounded-[0.45rem] bg-accent text-white"
      >
        λ
      </span>
      <span>Lykeion</span>
    </div>
  );
}

export default LykeionMark;
