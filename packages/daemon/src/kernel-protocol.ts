/** One request to this machine's kernel host. */
export interface HostRequest {
  id: number;
  method: string;
  params: unknown;
}

/** What the host sends back: an answer to a request, or something it wants
 *  known that nobody asked for. */
export type HostMessage =
  | { id: number; result: unknown }
  | { id: number; error: { message: string } }
  | { method: string; params: unknown };

export const PROTOCOL_VERSION = 2;

/** Whether this is an answer to something, rather than an announcement. */
export function isReply(message: HostMessage): message is
  | { id: number; result: unknown }
  | { id: number; error: { message: string } } {
  return "id" in message;
}
