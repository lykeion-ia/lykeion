/**
 * Every path prefix that must reach the lab rather than the page.
 *
 * Written once and read by three places: the dev server's proxy table, the
 * daemon's front door, and the test that holds both to it. Two copies of this
 * list drift, and the drift is invisible — production has no proxy at all, so
 * a missing entry shows up only as a feature that does not work while
 * somebody develops it. That has already cost one: `/runs/:id/events` was
 * absent while `/rpc` and `/events` were present, so a run started, persisted
 * and reloaded correctly while its turn rendered nothing at all.
 *
 * `why` is not decoration. A prefix nobody can justify is one somebody will
 * delete, and the entry that was missing was missing because every rule for
 * what belonged here had been written about the page.
 */
export const FORWARDED_PREFIXES: readonly { prefix: string; why: string }[] = [
  { prefix: "/rpc", why: "every RPC method call" },
  { prefix: "/auth", why: "sign-in and sign-out" },
  { prefix: "/events", why: "the workspace change channel" },
  { prefix: "/runs", why: "one run's own event stream — the live turn" },
  // Reached by a daemon, not by any browser. "The client does not ask for it"
  // is not grounds to take one out.
  { prefix: "/daemon", why: "pairing, heartbeats and what a machine may run" },
];
