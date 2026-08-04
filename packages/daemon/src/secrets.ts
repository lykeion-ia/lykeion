import { timingSafeEqual } from "node:crypto";

/**
 * Whether two secret-derived strings match, without leaking how far the
 * comparison got before it found a difference. `timingSafeEqual` requires
 * equal-length buffers; unequal lengths are refused outright rather than
 * padded, since padding would itself have to be constant-time to be worth
 * anything.
 *
 * Every secret this daemon compares goes through here: the control token, the
 * nonce that admits one browser tab to the setup page, the cookie that tab
 * carries afterwards, and the state that tells this machine's own pairing
 * callback from a forged one. `===` on any of them answers in a time that
 * depends on how many leading characters were right, which over enough
 * attempts is a way of being told the rest.
 */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
