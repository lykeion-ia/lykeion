/**
 * One line a machine can print and a person can carry.
 *
 * The ordinary way a daemon asks to join a lab is a link it prints and a
 * browser opens. That assumes two things a lot of research machines do not
 * have: a browser on the machine itself, and a network path from the
 * researcher's browser back to the daemon's loopback address. A cluster node
 * reached over SSH has neither.
 *
 * So the same request is offered a second way — as a blob the daemon prints,
 * the researcher pastes into the lab's own approval screen, and the answer
 * comes back as a short code they type into `lykeion pair --code`. Nothing
 * about the handshake changes: the same challenge, the same one-time code
 * with its five minutes, the same member approving the same three facts.
 * Only the transport is a person instead of a redirect.
 *
 * **The blob is not a secret.** Every field in it is readable by anybody
 * holding it, deliberately — it is printed into terminals, pasted into chat
 * windows, and left in scrollback. What it carries is a *challenge*, and
 * redeeming a challenge takes two things this blob does not contain: a
 * member of the lab approving it, and a daemon still holding the verifier it
 * was derived from. Holding the blob gets you the right to ask, which is the
 * same right anybody reading the daemon's terminal already had.
 *
 * Read by the daemon, which mints these, and by the UI, which reads them.
 * One module rather than two, for the reason `FORWARDED_PREFIXES` is one
 * list: a wire format with an encoder in one package and a decoder in
 * another drifts, and the drift shows up as a paste that will not read.
 */

/**
 * Exactly what a pairing link carries in its query string, and exactly what
 * the approval screen shows. Every field is required — see `decodeRequest`.
 */
export interface PairRequest {
  name: string;
  platform: string;
  version: string;
  challenge: string;
  state: string;
  redirect: string;
}

/**
 * The version tag, and the whole reason there is one. A blob is printed into
 * a terminal on Monday and pasted on Thursday, possibly against a lab that
 * has been upgraded in between. A tag lets a later shape be told apart from
 * this one and refused in one line, instead of being parsed hopefully and
 * failing somewhere further in with a message about a missing field.
 */
const VERSION = "LYK1.";

/**
 * Field names inside the blob, shortened.
 *
 * The blob is meant to survive being printed, wrapped, selected and pasted,
 * and every character is one more chance for that to go wrong. The names
 * cost nothing to shorten because nobody reads the JSON — it is base64 by
 * the time anybody sees it — and the version tag is what makes changing
 * them later safe.
 */
const FIELDS = {
  name: "n",
  platform: "p",
  version: "v",
  challenge: "c",
  state: "s",
  redirect: "r",
} as const;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // Padding is dropped rather than kept: `=` is the one character in
  // standard base64 that a URL, a shell and a chat window each treat
  // differently, and the decoder below does not need it.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(blob: string): string | undefined {
  // Checked before decoding rather than after, because `atob` is forgiving
  // by specification: it skips whitespace and accepts a good deal that was
  // never base64. A request has to be refused as a whole or accepted as a
  // whole, so what is not base64url is not a request.
  if (blob === "" || !/^[A-Za-z0-9_-]+$/.test(blob)) return undefined;
  let binary: string;
  try {
    binary = atob(blob.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return undefined;
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    // Fatal, so bytes that are not UTF-8 are refused here rather than
    // becoming replacement characters inside a machine name.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** The blob a daemon prints for a request it is holding open. */
export function encodeRequest(fields: PairRequest): string {
  const compact: Record<string, string> = {};
  // Driven by `FIELDS` rather than by the object handed in, so the blob
  // carries these six and only these six however much the caller passes.
  // A daemon holds a verifier beside every one of these; widening the blob
  // by accident is the one mistake here that would matter.
  for (const [field, short] of Object.entries(FIELDS)) {
    const value = fields[field as keyof PairRequest];
    if (typeof value === "string") compact[short] = value;
  }
  return VERSION + toBase64Url(JSON.stringify(compact));
}

/**
 * The request inside a blob, or `undefined` for anything that is not one.
 *
 * One answer for every way it can fail — wrong version, not base64, not
 * JSON, not an object, a field missing — because they are one thing to the
 * person who pasted it: this is not the line their machine printed. The
 * screen that reads a paste says that in its own words; splitting it into
 * five refusals here would only give it five ways to say the same sentence.
 */
export function decodeRequest(blob: string): PairRequest | undefined {
  // Whitespace anywhere, not just at the ends. The blob is printed into a
  // terminal that wraps it and selected with a mouse that takes the wrap,
  // and no character of base64url is whitespace, so nothing that belonged
  // to the request is lost by removing it.
  const cleaned = blob.replace(/\s+/g, "");
  if (!cleaned.startsWith(VERSION)) return undefined;
  const json = fromBase64Url(cleaned.slice(VERSION.length));
  if (json === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const compact = parsed as Record<string, unknown>;
  const fields: Partial<PairRequest> = {};
  for (const [field, short] of Object.entries(FIELDS)) {
    const value = compact[short];
    // Empty counts as missing. A blank name or a blank redirect would reach
    // the approval screen as a machine with no name or a code with nowhere
    // to go, and be refused there — after a person had read it and agreed.
    if (typeof value !== "string" || value === "") return undefined;
    fields[field as keyof PairRequest] = value;
  }
  return fields as PairRequest;
}
