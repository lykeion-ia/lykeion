/** One request to this machine's kernel host. */
export interface HostRequest {
  id: number;
  method: string;
  params: unknown;
}

/** Something the host wants from the daemon, which only the daemon can do —
 *  it holds the researcher's session and the lab's token, and this process
 *  holds neither. Answered on the same stream the daemon sends its own
 *  requests down, matched against the HOST's id space rather than this
 *  daemon's: each end matches replies against its own outstanding map, so the
 *  two id spaces never meet and cannot collide. */
export interface HostAsk {
  id: number;
  method: string;
  params: unknown;
}

/** What the host sends back: an answer to a request, something it wants
 *  known that nobody asked for, or something it wants FROM this daemon. */
export type HostMessage =
  | { id: number; result: unknown }
  | { id: number; error: { message: string } }
  | { method: string; params: unknown }
  | HostAsk;

export const PROTOCOL_VERSION = 5;

/**
 * Whether this is an answer to something, rather than an announcement or an
 * ask of this daemon's own.
 *
 * Read off the OUTCOME rather than off the id, which is what the second
 * direction cost this predicate. `"id" in message` was exactly right while
 * every message carrying an id was a reply; a `HostAsk` carries one too, and
 * under the old reading it would be handed to the daemon's outstanding map as
 * if it answered a call this daemon made — settling the wrong promise with a
 * `result` nobody asked for, or being dropped where no call is outstanding
 * under that id, and either way never reaching the handler that was going to
 * answer it.
 */
export function isReply(message: HostMessage): message is
  | { id: number; result: unknown }
  | { id: number; error: { message: string } } {
  return "result" in message || "error" in message;
}
