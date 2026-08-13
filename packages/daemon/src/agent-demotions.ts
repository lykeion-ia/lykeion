/**
 * When an agent's sign-in stopped working, and what it said.
 *
 * Rung 7 asks a CLI who it is signed in as, and a CLI whose grant has been
 * revoked answers happily — the status output carries an account, not a
 * token's validity. So the only place the truth shows up is a turn that
 * failed, and this is where that observation is kept.
 *
 * Timestamped rather than counted, and that is the point. A live revocation
 * was first read as evidence that two OAuth grants on one account collide;
 * the times disproved it — the grant had been minted that morning with 28
 * days of refresh validity left and was blanked in the afternoon, which is
 * revocation and not expiry. Without the times, that question could only
 * have been argued from a theory.
 *
 * In memory, not on disk: this exists to make the next failure explicable to
 * whoever is looking, and a daemon that restarted has re-asked every rung
 * anyway.
 */
export interface Demotion {
  agent: string;
  /** Unix seconds. */
  at: number;
  reason: string;
}

/** How many to keep per agent. Enough to see a pattern across a working day,
 *  bounded so a machine failing every turn for a week does not grow this
 *  without limit. */
const KEPT = 20;

/**
 * How long a demotion holds an agent back.
 *
 * `main.ts` DERIVES `PROBE_INTERVAL_MS` from this constant
 * (`(DEMOTION_HOLD_SECONDS / 2) * 1000`) rather than the two being chosen
 * separately, so they cannot drift apart by one of them being edited without
 * the other.
 *
 * The hold has to be longer than the interval between cycles, not merely
 * equal to it. The real gap between two successive readings of `isDemoted`
 * is not the interval alone: `scheduleProbe` (`main.ts`) arms the next timer
 * only after the current cycle's own work finishes — every rung across the
 * catalogue, plus `report`'s HTTP call and its retries — so the true gap is
 * the interval PLUS however long that work took. A hold equal to the
 * interval is therefore exceeded on every cycle, deterministically, and a
 * demotion recorded early in a cycle would expire before the next cycle ever
 * looks at it — the mechanism would suppress nothing while looking, from a
 * test at the exact interval boundary, like it works. Holding for twice the
 * interval — this many seconds covers two cycles, not one — gives that
 * overrun real margin instead of a comment asserting the two agree.
 *
 * It lives here rather than in `probe.ts` on purpose: `main.ts` imports this
 * constant from here to derive `PROBE_INTERVAL_MS`, and importing the other
 * way would invert that dependency. Keeping the constant beside the records
 * it governs also keeps the seconds in one module: everything in this file
 * is unix SECONDS, and a milliseconds/seconds mix-up across this boundary is
 * silent and total.
 */
export const DEMOTION_HOLD_SECONDS = 10 * 60;

const records = new Map<string, Demotion[]>();

export function recordDemotion(
  agent: string,
  reason: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
): void {
  const kept = records.get(agent) ?? [];
  kept.push({ agent, at: now(), reason });
  records.set(agent, kept.slice(-KEPT));
}

export function demotionsFor(agent: string): Demotion[] {
  return [...(records.get(agent) ?? [])];
}

/**
 * Whether this agent's sign-in is still to be treated as gone.
 *
 * True while the NEWEST demotion is younger than `DEMOTION_HOLD_SECONDS` —
 * a window rather than a latch, and that is the behaviour a researcher
 * depends on: the demotion wins for this cycle, the next cycle asks the CLI
 * again, and somebody who has signed back in is offered the agent without
 * restarting anything.
 *
 * The newest is read by time rather than by position, so a record written
 * against an injected clock (a test, or any caller passing its own `now`)
 * cannot leave a stale entry deciding this by virtue of arriving last.
 *
 * The clock is injectable for the same reason `recordDemotion`'s is: a window
 * is only testable if a test can stand on either side of it without waiting
 * out five real minutes.
 */
export function isDemoted(
  agent: string,
  now: () => number = () => Math.floor(Date.now() / 1000),
): boolean {
  const kept = records.get(agent);
  if (kept === undefined || kept.length === 0) return false;
  const newest = Math.max(...kept.map((demotion) => demotion.at));
  return now() - newest < DEMOTION_HOLD_SECONDS;
}

/** Forgets every record. Tests only. */
export function forgetDemotions(): void {
  records.clear();
}
