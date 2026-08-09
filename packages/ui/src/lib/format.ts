/**
 * Operational figures, formatted the one way every surface renders them.
 *
 * The distinction these enforce is the whole reason they are shared: a figure
 * the machine holding a thing could not report is ABSENT and renders as an
 * em dash, while zero is a measurement and renders as zero. A formatter that
 * folded the two together would let a kernel using no memory and a kernel
 * nobody could ask look identical on the same row.
 */

/** The em dash every unreportable figure renders as. */
export const UNREPORTED = "—";

/**
 * A byte count, at the precision a researcher reads at a glance: whole bytes
 * below a kilobyte, whole kilobytes below a megabyte, and one decimal above
 * that. A resident set size is not a figure anybody needs to the byte, and
 * more digits than this only make two rows harder to compare.
 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return UNREPORTED;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Processor use as a count of cores rather than a percentage, because a
 * researcher deciding whether a machine has room left is comparing against
 * how many cores it has. The platform reports a percentage of one core, so
 * 250% is 2.5 cores.
 */
export function formatCores(cpuPercent: number | undefined): string {
  if (cpuPercent === undefined || !Number.isFinite(cpuPercent)) return UNREPORTED;
  return (cpuPercent / 100).toFixed(1);
}

/**
 * How long ago something happened, in the shortest form that is still exact
 * enough to act on: seconds under a minute, whole minutes under an hour, and
 * whole hours above it. Absent when nothing has happened yet, which is a
 * different fact from happening a long time ago.
 */
export function formatSince(ts: number | undefined, now: number): string {
  if (ts === undefined || !Number.isFinite(ts)) return UNREPORTED;
  const seconds = Math.max(0, Math.floor(now - ts));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}
