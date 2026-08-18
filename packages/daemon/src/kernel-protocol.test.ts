import { expect, it } from "vitest";
import { isReply, type HostMessage } from "./kernel-protocol";

/**
 * What this stream carries, told apart.
 *
 * Three shapes travel from the host: an answer to something this daemon
 * asked, an announcement nobody asked for, and — since protocol 4 — an ask
 * of the daemon's own. The first and the third both carry an id, so the id
 * cannot be what separates them.
 */
it("calls an answer an answer, whichever outcome it carries", () => {
  expect(isReply({ id: 1, result: { ok: true } })).toBe(true);
  expect(isReply({ id: 1, error: { message: "no" } })).toBe(true);
});

it("does not call the host's own ask a reply", () => {
  // The sharpening protocol 4 needed. Under `"id" in message` this is a
  // reply, and the daemon would look it up in the map of calls IT made —
  // settling whichever one happened to share the number with a `result`
  // nobody produced, or, where nothing shares it, dropping the ask entirely
  // and leaving the host blocked on an answer that is never written.
  const ask: HostMessage = { id: 1, method: "environment.create", params: {} };
  expect(isReply(ask)).toBe(false);
});

it("does not call a notification a reply", () => {
  expect(isReply({ method: "cell", params: {} })).toBe(false);
});
