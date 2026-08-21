/**
 * The hash that names an envelope, kept off the contract's main entry point.
 *
 * `provenance.ts` is reached from the browser: the barrel re-exports it, so
 * anything it imports is bundled into the application whether the application
 * calls it or not. `node:crypto` cannot be, and a build that tries says so
 * only when it runs — every type checks, and every test passes, because both
 * of those run under Node.
 *
 * So the shape, the canonical bytes and the version live beside the rest of
 * the contract, and the one function that needs a Node builtin lives here,
 * behind its own entry point. What imports this is what runs on a machine:
 * the lab, which recomputes the hash over the bytes it was handed rather than
 * trusting the id beside them.
 */
import { createHash } from "node:crypto";

import { canonicalJson, type ProvenanceEnvelope } from "./provenance";

/** An envelope's own hash, which is the id a cell references it by. */
export function envelopeHash(envelope: ProvenanceEnvelope): string {
  return createHash("sha256").update(canonicalJson(envelope), "utf8").digest("hex");
}
