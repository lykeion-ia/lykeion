/** Heartbeats arrive every 15 seconds, so three may be missed before a
 *  machine looks doubtful — one lost packet is not an outage. Derived on
 *  every read rather than stored: a daemon that is killed writes nothing,
 *  and a stored value would leave it reading "online" forever. */
export const ONLINE_WITHIN_SECONDS = 45;
export const UNSTABLE_WITHIN_SECONDS = 300;

export function healthFor(lastSeenTs: number, now: number): "online" | "unstable" | "offline" {
  const silent = now - lastSeenTs;
  if (silent <= ONLINE_WITHIN_SECONDS) return "online";
  if (silent <= UNSTABLE_WITHIN_SECONDS) return "unstable";
  return "offline";
}
