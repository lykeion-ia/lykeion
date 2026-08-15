/**
 * A series of readings as eight Unicode blocks, scaled against a ceiling the
 * caller supplies rather than against the series' own maximum.
 *
 * Auto-scaling to the maximum is what every sparkline library does by
 * default, and it is wrong here: it would draw an idle kernel holding 600 KB
 * exactly like one eating 6 GB, since each is its own peak. Against a
 * machine's capacity, the first reads as almost nothing — which is what it
 * is, and what a researcher deciding where to run something needs to see.
 */
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

export function Sparkline({
  values,
  ceiling,
  label,
}: {
  values: Array<number | undefined>;
  ceiling: number | undefined;
  label?: string;
}) {
  const drawable = values.filter((v): v is number => v !== undefined);
  // No readings, or no ceiling to judge them against: a shape drawn from
  // either would be decoration standing where a measurement should be.
  if (!drawable.length || ceiling === undefined || ceiling <= 0) return null;
  const marks = drawable
    .map((value) => {
      const share = Math.min(1, Math.max(0, value / ceiling));
      return BLOCKS[Math.min(BLOCKS.length - 1, Math.round(share * (BLOCKS.length - 1)))];
    })
    .join("");
  return (
    <span aria-label={label} className="font-mono text-meta text-fg-tertiary">
      {marks}
    </span>
  );
}
