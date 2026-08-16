/**
 * `kernel-list` asks in flight: one per outstanding reach into a single
 * machine's own kernel host, made through `RunRelay.deliverNow` and
 * answered — or not — through `/daemon/kernel/list`.
 *
 * Modeled on `run-revert.ts`'s `RevertRegistry`, for the same reason: a
 * command travels down the relay and the answer to it arrives on a
 * different HTTP call entirely, so something has to hold the request open
 * across that gap and settle it when the reply lands, or give up.
 */

/** How long one machine is given to answer before it is treated as holding
 *  nothing. `kernel.list` is a lock-protected read of whatever a host
 *  already has in memory — no I/O, no subprocess — so a machine that is
 *  there answers in well under this; short, because `listRunningKernels`
 *  fans this out to every machine in the lab at once and a researcher
 *  polling the Notebook rail is served far better by an answer that is
 *  missing one slow machine's kernels than by one held up for however long
 *  that machine takes. */
const DEFAULT_TIMEOUT_MS = 2000;

/** One kernel exactly as a host's own `kernel.list` describes it — every
 *  field that call reports, none of which name a machine or a Study: the
 *  host that produced this has no way to know either. */
export interface RawKernelReport {
  id: string;
  sessionId: string;
  taskId: string;
  name: string;
  language: string;
  state: string;
  incarnation: number;
  executionCount: number;
  queueDepth: number;
  environment: string;
  startedTs?: number;
  lastActivityTs?: number;
  reclaimedTs?: number;
  processId?: number;
  stoppedBy?: string;
  stopReason?: string;
  resources?: { memoryBytes?: number; cpuPercent?: number };
  series?: Array<{ memoryBytes?: number; cpuPercent?: number }>;
}

export interface KernelListRegistry {
  /** Waits for `machineId` to answer the `requestId` it was asked with.
   *  Resolves to `[]` once the wait runs out — never rejects: a machine
   *  that does not answer is reported as holding no kernels, the same as
   *  one that answers empty, because a researcher polling the Notebook rail
   *  is served by an incomplete list far better than by a rejection
   *  unwinding a lab-wide read over one slow machine. */
  await(machineId: string, requestId: string, timeoutMs?: number): Promise<RawKernelReport[]>;
  /**
   * What a machine claiming to be `machineId` reported for `requestId`.
   * Accepted, and returns `true`, only when `machineId` is the one this
   * `requestId` was actually minted for — checked here, not left to the
   * caller, because `requestId` is minted off the same globally-sequential
   * counter session ids already are and so is exactly as guessable: a
   * bearer token proves only that some paired machine is calling, never
   * that it is the one a given request was ever addressed to.
   *
   * Refuses and returns `false`, touching nothing, for a mismatched
   * `machineId` or a `requestId` nobody is waiting on — the two are
   * answered identically on purpose, the same discipline
   * `/daemon/run/grant` already holds a run id to, so a caller probing
   * requestIds cannot tell "not yours" from "not real" apart. Refusing
   * never consumes the entry: the machine this request actually belongs to
   * can still settle it correctly afterward.
   */
  settle(machineId: string, requestId: string, kernels: RawKernelReport[]): boolean;
}

export function createKernelListRegistry(): KernelListRegistry {
  const waiting = new Map<string, { machineId: string; resolve: (kernels: RawKernelReport[]) => void }>();
  return {
    await(machineId, requestId, timeoutMs = DEFAULT_TIMEOUT_MS) {
      return new Promise<RawKernelReport[]>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(requestId);
          resolve([]);
        }, timeoutMs);
        timer.unref?.();
        waiting.set(requestId, {
          machineId,
          resolve: (kernels) => {
            clearTimeout(timer);
            waiting.delete(requestId);
            resolve(kernels);
          },
        });
      });
    },
    settle(machineId, requestId, kernels) {
      const entry = waiting.get(requestId);
      if (!entry || entry.machineId !== machineId) return false;
      entry.resolve(kernels);
      return true;
    },
  };
}
