import { backoffDelayMs, LabRefused } from "./lab";

/**
 * The thing that keeps calling a lab that is not answering, and the thing
 * that has to let go of it the instant this machine is asked to stop. Both
 * halves are one object because they share the one piece of state that
 * matters — the waits currently in flight — and a stop that cannot reach
 * them is a daemon that took the request and kept running.
 */
export interface RetryLoop {
  /** Whether stopping has begun. Nothing new is attempted after this. */
  readonly stopping: boolean;
  /**
   * Runs `attempt`, retrying anything but a refusal, until it succeeds or
   * this loop is stopped. Resolves either way: a caller reschedules on
   * completion, and a call that was abandoned because the daemon is leaving
   * is not a failure anybody needs to hear about twice.
   */
  run(lab: string, label: string, attempt: () => Promise<void>): Promise<void>;
  /** Ends every wait in flight now, and refuses to start another. */
  stop(): void;
}

export interface RetryLoopOptions {
  /** What to do when the lab says it no longer knows this machine. No
   *  amount of retrying fixes that, so the loop hands it over and stops. */
  onRefused(err: LabRefused): void;
  /** Where a retry line goes. Defaults to standard error, which for a
   *  daemon in the background is its log file. */
  log?(line: string): void;
}

export function createRetryLoop(options: RetryLoopOptions): RetryLoop {
  const log = options.log ?? ((line: string) => console.error(line));
  /** Every wait sitting out its backoff, with the resolve that ends it
   *  early. A stop that lands thirty seconds into a wait must not have to
   *  sit out the rest of it before the process can end. */
  const waits = new Map<NodeJS.Timeout, () => void>();
  let stopping = false;

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waits.delete(timer);
        resolve();
      }, ms);
      waits.set(timer, resolve);
    });
  }

  return {
    get stopping(): boolean {
      return stopping;
    },

    stop(): void {
      stopping = true;
      for (const [timer, resolve] of waits) {
        clearTimeout(timer);
        resolve();
      }
      waits.clear();
    },

    async run(lab: string, label: string, attempt: () => Promise<void>): Promise<void> {
      let tries = 0;
      while (!stopping) {
        try {
          await attempt();
          return;
        } catch (err) {
          // Checked before this catch does anything else, and it is the
          // whole reason the check is here rather than only at the top of
          // the loop. A stop that landed while the attempt was in flight
          // has already emptied the map of waits it is able to cancel; a
          // wait armed from here would be born after that, answer to
          // nobody, and hold the process open for its full backoff — which
          // by then can be half a minute.
          if (stopping) return;
          if (err instanceof LabRefused) {
            log(err.message);
            options.onRefused(err);
            return;
          }
          tries += 1;
          const message = err instanceof Error ? err.message : String(err);
          const delay = backoffDelayMs(tries);
          // Every line names the lab it is about: a machine paired with one
          // of several labs should never leave a person guessing which of
          // them a retry in the log even concerns.
          log(`${label} to ${lab} failed: ${message} — retrying in ${delay}ms`);
          await wait(delay);
        }
      }
    },
  };
}
