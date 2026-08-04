import type { Channel } from "../channel";
import type { Store } from "../store/store";

export interface ChangeRecorder {
  /** `actorId` names whoever made the change when it is not the caller the
   *  recorder was built for — the route that admits a new member has nobody
   *  signed in until it has finished making them. */
  record(kind: string, payload: unknown, actorId?: string): void;
  /** Called once the request's writes have committed. */
  flush(): void;
}

interface PendingMessage {
  seq: number;
  kind: string;
  payload: string;
}

/**
 * Append a change and fan it out. The row is written inside the caller's
 * transaction so its sequence is the one the database committed; the
 * fan-out happens later, at `flush`, because a subscriber told about a
 * change that then rolls back has been told something untrue.
 *
 * One recorder is built per request and handed to every family module
 * through `Deps`, so whichever family wrote something and the handler that
 * flushes afterwards are looking at one pending queue rather than one each.
 */
export function changeRecorder(parts: {
  store: Store;
  /** Null on a route that runs before anybody is signed in. */
  actorId: string | null;
  now(): number;
  channel: Channel;
}): ChangeRecorder {
  const { store, actorId, now, channel } = parts;
  const pending: PendingMessage[] = [];

  return {
    record(kind, payload, madeBy) {
      const json = JSON.stringify(payload);
      // `RETURNING` rather than a separate `last_insert_rowid()` read: the
      // sequence comes back from the statement that produced it, not from a
      // connection-wide "most recent" a later insert on the same connection
      // could move out from under this call.
      const row = store.get(
        `INSERT INTO change_log (ts, kind, payload, actor_id) VALUES (?, ?, ?, ?) RETURNING seq`,
        [now(), kind, json, madeBy ?? actorId],
      )!;
      pending.push({ seq: row.seq as number, kind, payload: json });
    },

    flush() {
      const staged = pending.splice(0);
      if (staged.length === 0) return;

      // A sequence a rolled-back transaction consumed CAN come back. The
      // counter behind AUTOINCREMENT lives in an ordinary table, so a
      // rollback — including the `ROLLBACK TO` a nested transaction uses —
      // takes the counter back with it, and the next insert is handed the
      // same number. Presence alone therefore does not distinguish a change
      // that committed from one that was undone and had its sequence
      // reissued to a different change.
      //
      // Two things separate them. Keeping only the last entry staged for a
      // sequence drops the undone one, because a reissued sequence is
      // always handed to a later record than the one that gave it up. The
      // row then has to be there at all, which is what catches a rollback
      // whose sequence nothing reclaimed. Comparing kind and payload as
      // well is not load-bearing against either of those on its own — it is
      // here so that a sequence arriving from somewhere this reasoning did
      // not anticipate publishes the change the log holds, or nothing.
      const lastPerSeq = new Map<number, PendingMessage>();
      for (const message of staged) lastPerSeq.set(message.seq, message);

      const seqs = [...lastPerSeq.keys()];
      const placeholders = seqs.map(() => "?").join(", ");
      const committed = new Map<number, { kind: string; payload: string }>();
      for (const row of store.all(
        `SELECT seq, kind, payload FROM change_log WHERE seq IN (${placeholders})`,
        seqs,
      )) {
        committed.set(row.seq as number, {
          kind: row.kind as string,
          payload: row.payload as string,
        });
      }

      for (const seq of seqs.sort((a, b) => a - b)) {
        const message = lastPerSeq.get(seq)!;
        const row = committed.get(seq);
        if (!row || row.kind !== message.kind || row.payload !== message.payload) continue;
        channel.publish({ seq, kind: message.kind, payload: JSON.parse(message.payload) });
      }
    },
  };
}
