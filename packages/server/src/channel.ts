import type { Store } from "./store/store";

export interface ChannelMessage {
  seq: number;
  kind: string;
  payload: unknown;
}

export type Send =
  | { type: "change"; message: ChannelMessage }
  | { type: "resync" };

/**
 * The workspace's change feed. Every write appends to `change_log` inside
 * its own transaction and publishes here once that transaction has
 * committed, so the sequence a subscriber replays from is the same sequence
 * the database committed — there is no second ordering to keep in step with
 * the first.
 */
/** A subscriber the channel can find again — because the person behind it
 *  stopped being a member, and a stream nobody re-authorises keeps
 *  delivering to them forever. */
interface Attached {
  send: (s: Send) => void;
  userId: string;
  disconnect: () => void;
}

export function createChannel(store: Store, retention: number) {
  const subscribers = new Set<Attached>();

  const trim = (): void => {
    const max = store.get(`SELECT MAX(seq) AS s FROM change_log`)?.s as number | null;
    if (max === null) return;
    store.run(`DELETE FROM change_log WHERE seq <= ?`, [max - retention]);
  };

  return {
    /** Fan out one change the caller has already committed. */
    publish(message: ChannelMessage): void {
      trim();
      for (const { send } of subscribers) send({ type: "change", message });
    },

    /**
     * Cut off every stream held by one person. An open stream resolved who
     * was behind it once, when it opened, and never asks again — so somebody
     * offboarded mid-visit would go on receiving every change in the lab
     * from the socket they already had, while every request they made was
     * refused. Their client reconnects, is refused, and shows them the way
     * out, which is what should have happened at the first change.
     */
    evict(userId: string): void {
      for (const attached of [...subscribers])
        if (attached.userId === userId) attached.disconnect();
    },

    /**
     * Attach a subscriber, replaying anything it missed. A cursor older than
     * the retention window gets `resync` and nothing else: a replay with a
     * hole in it is worse than an honest refusal, because the client cannot
     * tell it happened.
     */
    subscribe(
      cursor: number | undefined,
      send: (s: Send) => void,
      holder?: { userId: string; disconnect: () => void },
    ): () => void {
      if (cursor !== undefined) {
        const oldest = store.get(`SELECT MIN(seq) AS s FROM change_log`)?.s as number | null;
        if (oldest !== null && cursor < oldest - 1) {
          send({ type: "resync" });
        } else {
          for (const row of store.all(
            `SELECT seq, kind, payload FROM change_log WHERE seq > ? ORDER BY seq ASC`,
            [cursor],
          )) {
            send({
              type: "change",
              message: {
                seq: row.seq as number,
                kind: row.kind as string,
                payload: JSON.parse(row.payload as string),
              },
            });
          }
        }
      }
      // A subscriber with no holder cannot be evicted by name, which is
      // what a test driving the channel directly wants; a real stream always
      // has one.
      const attached: Attached = {
        send,
        userId: holder?.userId ?? "",
        disconnect: holder?.disconnect ?? (() => subscribers.delete(attached)),
      };
      subscribers.add(attached);
      return () => subscribers.delete(attached);
    },

    trim,
  };
}

export type Channel = ReturnType<typeof createChannel>;
