import { expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import {
  clearedCookie,
  DUMMY_HASH,
  hashPassword,
  newToken,
  readCookie,
  sessionCookie,
  verifyPassword,
} from "./auth";

// node:crypto's own export object is frozen, so vi.spyOn cannot wrap
// randomBytes on it directly; replacing the module is the only way to
// observe what newToken() actually calls. Every export but randomBytes
// passes straight through, and randomBytes itself defaults to its real
// implementation too — only the one test below overrides it, once.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

it("verifies a password against its own hash", async () => {
  const stored = await hashPassword("correct horse");
  expect(await verifyPassword("correct horse", stored)).toBe(true);
});

it("rejects the wrong password", async () => {
  const stored = await hashPassword("correct horse");
  expect(await verifyPassword("correct horsf", stored)).toBe(false);
});

it("salts, so one password hashed twice stores differently", async () => {
  // Without a salt, two members who choose the same password are visibly
  // the same row to anyone who reads the table.
  expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
});

it("refuses a stored value it cannot parse instead of admitting anyone", async () => {
  expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
  expect(await verifyPassword("anything", "")).toBe(false);
});

it("refuses cost parameters scrypt itself would reject, rather than throwing past the caller", async () => {
  const stored = await hashPassword("correct horse");
  const [, , r, p, salt, key] = stored.split("$");
  // N not a number at all.
  expect(await verifyPassword("correct horse", ["scrypt", "x", r, p, salt, key].join("$"))).toBe(
    false,
  );
  // N not a power of two — scryptSync itself throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS
  // on this input if it ever reaches the call.
  expect(await verifyPassword("correct horse", ["scrypt", "3", r, p, salt, key].join("$"))).toBe(
    false,
  );
  // N absurdly large — scryptSync throws over its memory ceiling if it
  // ever reaches the call.
  expect(
    await verifyPassword("correct horse", ["scrypt", String(2 ** 30), r, p, salt, key].join("$")),
  ).toBe(false);
  // r zero. scrypt does not refuse it; it computes the same output as the
  // default r of 8, so a stored "0" would verify successfully against a
  // hash actually made with 8. What refuses it is this function's own
  // bound (r > 0), not anything scrypt raises.
  expect(await verifyPassword("correct horse", ["scrypt", "16384", "0", p, salt, key].join("$"))).toBe(
    false,
  );
  // N and r each within this function's own bounds, but their product
  // exceeds scrypt's default memory ceiling, which raises
  // ERR_CRYPTO_INVALID_SCRYPT_PARAMS. Nothing checked above catches the
  // combination; only the catch around the scrypt call itself does.
  expect(
    await verifyPassword(
      "correct horse",
      ["scrypt", String(2 ** 20), "1024", p, salt, key].join("$"),
    ),
  ).toBe(false);
});

it("refuses a stored key truncated below the floor a real hash never falls under, even when the truncated byte would itself match", async () => {
  // scrypt's output is prefix-consistent: the first byte of a 64-byte
  // derivation is the same as the whole of a 1-byte derivation for the same
  // password, salt, and cost. So the byte stored here is not an arbitrary
  // stand-in for "truncated" — it is exactly what a length-1 comparison
  // against "correct horse" would call a match. A floor that only ever
  // caught mismatched bytes would still pass this by chance; refusing this
  // specific, matching byte is what proves the floor runs before any byte
  // is compared at all.
  const stored = await hashPassword("correct horse");
  const [scrypt, n, r, p, salt, fullKeyB64] = stored.split("$");
  const oneByteKey = Buffer.from(fullKeyB64, "base64").subarray(0, 1).toString("base64");
  expect(await verifyPassword("correct horse", [scrypt, n, r, p, salt, oneByteKey].join("$"))).toBe(
    false,
  );
});

it("carries a dummy hash usable by verifyPassword, valid in shape but matching no password", async () => {
  expect(await verifyPassword("anything at all", DUMMY_HASH)).toBe(false);
});

it("mints tokens that do not repeat", () => {
  const seen = new Set(Array.from({ length: 200 }, () => newToken()));
  expect(seen.size).toBe(200);
});

it("mints tokens by base64url-encoding node:crypto's randomBytes, not a counter or a formatted UUID", () => {
  const mocked = vi.mocked(randomBytes);
  const fixed = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
  mocked.mockReturnValueOnce(fixed as never);
  try {
    expect(newToken()).toBe(fixed.toString("base64url"));
    expect(mocked).toHaveBeenCalledWith(32);
  } finally {
    mocked.mockClear();
  }
});

it("produces tokens with the length and alphabet a 32-byte base64url encoding always has", () => {
  const token = newToken();
  expect(token).toHaveLength(Buffer.alloc(32).toString("base64url").length);
  expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
});

it("reads one cookie out of a header holding several", () => {
  const header = "theme=midnight; lykeion_session=abc123; other=x";
  expect(readCookie(header, "lykeion_session")).toBe("abc123");
});

it("does not confuse a cookie whose name ends with the one asked for", () => {
  // `my_lykeion_session` must not answer for `lykeion_session`.
  expect(readCookie("my_lykeion_session=wrong", "lykeion_session")).toBeUndefined();
});

it("returns nothing when there is no cookie header at all", () => {
  expect(readCookie(undefined, "lykeion_session")).toBeUndefined();
});

it("marks the cookie httpOnly and same-site, and secure only under TLS", () => {
  const plain = sessionCookie("t", false);
  expect(plain).toMatch(/HttpOnly/);
  expect(plain).toMatch(/SameSite=Lax/);
  expect(plain).not.toMatch(/Secure/);
  expect(sessionCookie("t", true)).toMatch(/Secure/);
});

it("clears by expiring in the past, not by omitting the value", () => {
  expect(clearedCookie(false)).toMatch(/Max-Age=0/);
});

it("clears the same Path the session cookie was set with, since a browser only drops a cookie whose scope matches exactly", () => {
  const pathOf = (cookie: string) => cookie.match(/(?:^|; )Path=([^;]*)/)?.[1];
  expect(pathOf(clearedCookie(false))).toBe(pathOf(sessionCookie("t", false)));
});
