import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Store } from "./store/store";
import type { Role } from "@lykeion/api";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/** Cost parameters, stored beside each hash so they can be raised later
 *  without invalidating the passwords already set under the old ones. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
/** A key shorter than this is refused before it ever reaches a comparison.
 *  A stored value truncated to a few bytes turns `timingSafeEqual` into a
 *  near-coin-flip — at one byte, one in 256 wrong passwords would pass. */
const MIN_KEY_LEN = 32;

export const SESSION_COOKIE = "lykeion_session";
/** Thirty days. Long enough not to be a nuisance, and revocable at any
 *  moment because the session is a row rather than a signed claim. */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function encodeHash(n: number, r: number, p: number, salt: Buffer, key: Buffer): string {
  return ["scrypt", n, r, p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return encodeHash(SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, key);
}

/**
 * Whether a stored hash's cost parameters are safe to hand to scrypt at
 * all. These arrive as untyped strings out of a column nothing here
 * controls the writer of; `Number(n)` on something that isn't one, or an
 * `N` that isn't a power of two, is not a wrong password — it is a
 * parameter scrypt itself refuses, and refusing it here is what keeps that
 * failure a plain "wrong credentials" rather than an uncaught throw a
 * caller has to handle differently.
 */
function validScryptCost(n: number, r: number, p: number): boolean {
  const boundedInt = (value: number, max: number) =>
    Number.isInteger(value) && value > 0 && value <= max;
  return (
    boundedInt(n, 2 ** 20) &&
    n > 1 &&
    (n & (n - 1)) === 0 &&
    boundedInt(r, 1024) &&
    boundedInt(p, 1024)
  );
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltB64, keyB64] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!validScryptCost(n, r, p)) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(keyB64, "base64");
  if (expected.length < MIN_KEY_LEN) return false;
  let actual: Buffer;
  try {
    actual = await scryptAsync(password, salt, expected.length, { N: n, r, p });
  } catch {
    // A parameter combination that passed the checks above but that scrypt
    // still refuses — its own memory ceiling, say — is refused the same
    // way any other unreadable hash is, not surfaced as a failure distinct
    // from a wrong password.
    return false;
  }
  // Length-equal by construction, so the comparison itself can be constant
  // time rather than short-circuiting on the first differing byte.
  return timingSafeEqual(actual, expected);
}

/**
 * A hash no real password will ever match, computed once when this module
 * loads. Signin verifies an unrecognized email's password against this and
 * discards the result, so a missing account costs the same scrypt call a
 * wrong password on a real account does — see the timing note where it is
 * used.
 */
export const DUMMY_HASH: string = (() => {
  const salt = randomBytes(16);
  const key = scryptSync("no account will ever hash to this", salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return encodeHash(SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, key);
})();

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A digest of a secret this server generated itself — a pairing code, a
 * machine token — for holding in a column without ever storing the secret
 * in the clear. Not scrypt: scrypt's cost buys protection against guessing
 * a low-entropy human password, and these are neither low-entropy nor
 * guessed — they are looked up, not verified against a small space of
 * candidates, so a fast, deterministic digest is what a lookup needs.
 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Who is calling. Resolved from the cookie on every request, never from
 *  anything the client can name. */
export interface Actor {
  userId: string;
  role: Role;
}

function isRole(value: unknown): value is Role {
  return value === "owner" || value === "member";
}

/**
 * The caller behind a session token, or nobody. The membership join is what
 * makes offboarding immediate: a removed member's row stops satisfying it
 * on their very next request, whatever token they still hold.
 */
export function resolveActor(
  store: Store,
  token: string | undefined,
  now: number,
): Actor | undefined {
  if (!token) return undefined;
  const row = store.get(
    `SELECT m.user_id AS user_id, m.role AS role
       FROM auth_sessions s
       JOIN members m ON m.user_id = s.user_id
      WHERE s.token = ? AND s.expires_ts > ? AND m.removed_ts IS NULL`,
    [token, now],
  );
  if (!row) return undefined;
  // The schema constrains `role` too, but a row this function did not
  // write is not this function's to trust blindly — an unrecognized value
  // refuses rather than becoming an Actor with a role nothing else knows
  // how to check permissions against.
  if (!isRole(row.role)) return undefined;
  return { userId: row.user_id as string, role: row.role };
}

export function ownerExists(store: Store): boolean {
  return (
    store.get(`SELECT user_id FROM members WHERE role = 'owner' LIMIT 1`) !==
    undefined
  );
}
