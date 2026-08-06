/**
 * Reverts in flight: one per run, waiting on the machine that holds the
 * files to say whether they are back.
 *
 * The ordering this exists to enforce is restore first, truncate second. The
 * record is only truncated once the machine has answered, so a truncated
 * record can never stand over a directory that was not restored.
 */

/** How long a revert waits for the machine to answer before it is refused.
 *  Restoring is a directory clone, so a machine that is there answers in
 *  well under this; one that does not answer has not restored anything, and
 *  a revert that never settles is a surface stuck on a spinner. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RevertRegistry {
  /** Waits for the machine holding `runId` to report how the restore went.
   *  Rejects, naming why, when it failed or never answered. */
  await(runId: string, timeoutMs?: number): Promise<void>;
  /** What the machine said. A report for a revert nobody is waiting on is
   *  ignored rather than remembered: the caller has already given up, and
   *  truncating for them afterwards would remove a turn nobody asked to
   *  remove any more. */
  settle(runId: string, ok: boolean, error?: string): void;
}

export function createRevertRegistry(): RevertRegistry {
  const waiting = new Map<string, (outcome: { ok: boolean; error?: string }) => void>();
  return {
    await(runId, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(runId);
          reject(
            new Error(
              "the machine holding this Task's files did not answer, so nothing was restored and the turn was kept",
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        waiting.set(runId, (outcome) => {
          clearTimeout(timer);
          waiting.delete(runId);
          if (outcome.ok) resolve();
          else reject(new Error(outcome.error ?? "the files could not be restored"));
        });
      });
    },
    settle(runId, ok, error) {
      waiting.get(runId)?.({ ok, ...(error === undefined ? {} : { error }) });
    },
  };
}
