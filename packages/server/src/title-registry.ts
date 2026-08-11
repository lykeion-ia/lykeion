/**
 * `name-task` asks in flight: one per outstanding request to a machine to
 * summarize a Task's opening message, made through `RunRelay.deliverNow` and
 * answered — or not — through `/daemon/task/title`.
 *
 * Modeled on `kernel-list-registry.ts`, which solves the identical problem for
 * the identical reason: the command travels down the relay and the answer
 * arrives on a different HTTP call entirely, so something has to hold the
 * request open across that gap and settle it when the reply lands, or give up.
 */

/**
 * How long one machine is given to name a Task before the Task is left with
 * the name it already has.
 *
 * Far longer than the kernel registry's two seconds, because what is being
 * waited on is different in kind: this spends an agent CLI's cold start — a
 * process launch, a protocol handshake, and a model round trip — where
 * `kernel.list` is a read of memory a host already holds. Generous enough
 * that a laptop launching `claude` for the first time in a while still
 * answers in time; bounded because nobody is watching this wait, and a
 * request nothing ever settles is a promise held forever.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface TitleRegistry {
  /** Waits for `runtimeId` to answer the `requestId` it was asked with.
   *  Resolves to `null` once the wait runs out — never rejects: a machine
   *  that does not answer leaves the Task named as it already was, which is
   *  the same outcome as one that answers with nothing. */
  await(runtimeId: string, requestId: string, timeoutMs?: number): Promise<string | null>;
  /**
   * What a machine claiming to be `runtimeId` summarized for `requestId`.
   * `null` is a machine saying it got nowhere — an answer, and a better one
   * than silence, because it releases the wait now rather than at the
   * deadline.
   *
   * Accepted, and returns `true`, only when `runtimeId` is the one this
   * `requestId` was actually minted for — checked here rather than left to
   * the caller, for the reason `kernel-list-registry.ts` checks it there: a
   * request id is minted off the same globally-sequential counter session ids
   * are and is exactly as guessable, and a bearer token proves only that some
   * paired machine is calling, never that it is the one a given request was
   * addressed to.
   *
   * Refuses and returns `false`, touching nothing, for a mismatched
   * `runtimeId` or a `requestId` nobody is waiting on. The two are answered
   * identically on purpose, so a caller probing request ids cannot tell "not
   * yours" from "not real" apart. Refusing never consumes the entry: the
   * machine this request actually belongs to can still settle it afterward.
   */
  settle(runtimeId: string, requestId: string, title: string | null): boolean;
}

export function createTitleRegistry(): TitleRegistry {
  const waiting = new Map<string, { runtimeId: string; resolve: (title: string | null) => void }>();
  return {
    await(runtimeId, requestId, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(requestId);
          resolve(null);
        }, timeoutMs);
        timer.unref?.();
        waiting.set(requestId, {
          runtimeId,
          resolve: (title) => {
            clearTimeout(timer);
            waiting.delete(requestId);
            resolve(title);
          },
        });
      });
    },
    settle(runtimeId, requestId, title) {
      const entry = waiting.get(requestId);
      if (!entry || entry.runtimeId !== runtimeId) return false;
      entry.resolve(title);
      return true;
    },
  };
}
