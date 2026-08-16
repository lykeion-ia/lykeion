/**
 * The REPL cells this lab has asked a machine to run and has not yet been
 * told the outcome of.
 *
 * A machine reports a finished cell on `/daemon/cell`, a call authenticated
 * by a machine token and by nothing else. Everything else about that report
 * can be bound to something durable — the session to the machine that opened
 * it, the Task to the turn that opened the session for it — but the cell's
 * own id and the member it is attributed to are neither: they were minted
 * here, handed to a browser, and sent down the relay. This is where they wait
 * to be recognized on the way back, so a cell lands in a notebook only where
 * this lab actually asked for one.
 *
 * Process-lived, the way the run relay and the revert registry already are: a
 * kernel command is delivered to a live connection or refused, so the gap
 * between minting an id and hearing about it is one round trip, and a lab
 * that restarts inside that gap has already dropped the command itself.
 */

/**
 * How many asks are held at once. A cell can take as long as the researcher's
 * code takes, so this is not a queue that drains on a timer; it is a bound on
 * what a machine that never answers can make this lab hold. Past it the
 * longest-standing ask is forgotten, which costs that one cell its record and
 * costs nothing else.
 */
const MOST_PENDING = 256;

export interface PendingCells {
  /** Records that this lab minted `cellId` for a cell it is asking
   *  `machineId` to run on the member `by`'s behalf. */
  mint(machineId: string, cellId: string, by: string): void;
  /**
   * The member this lab minted `cellId` for, when `machineId` is the machine
   * it was minted for, and `undefined` otherwise — an id nothing here asked
   * for, one already reported, or one minted for a different machine, which
   * are answered identically so a caller cannot tell them apart by trying.
   *
   * Taken rather than read: one ask is one cell, and an id reported twice
   * would otherwise be a second row under an id a browser already holds.
   */
  claim(machineId: string, cellId: string): string | undefined;
}

export function createPendingCells(): PendingCells {
  const waiting = new Map<string, { machineId: string; by: string }>();
  return {
    mint(machineId, cellId, by) {
      // Insertion order is what makes the oldest the first out, so an entry
      // re-minted under an id already held would keep its original place.
      // Nothing mints one twice, and deleting first says so.
      waiting.delete(cellId);
      waiting.set(cellId, { machineId, by });
      while (waiting.size > MOST_PENDING) {
        const oldest = waiting.keys().next();
        if (oldest.done) break;
        waiting.delete(oldest.value);
      }
    },
    claim(machineId, cellId) {
      const entry = waiting.get(cellId);
      if (!entry || entry.machineId !== machineId) return undefined;
      waiting.delete(cellId);
      return entry.by;
    },
  };
}
