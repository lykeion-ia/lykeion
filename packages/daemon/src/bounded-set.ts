/**
 * Adds to a set that never grows past `limit`, evicting the oldest member
 * once it would. `Set` iteration order is insertion order, so the first
 * value `values()` returns is always the oldest still held — no separate
 * bookkeeping is needed to find it. A general utility, not specific to
 * anything about a run: `runs.ts` uses it to bound how long `startedRuns`
 * remembers a run id, the same shape `run-relay.ts`'s own
 * `RETIRED_RUN_LIMIT` already uses for a completed run's buffer.
 */
export function addBounded(set: Set<string>, value: string, limit: number): void {
  set.add(value);
  if (set.size > limit) {
    const oldest = set.values().next().value as string;
    set.delete(oldest);
  }
}
