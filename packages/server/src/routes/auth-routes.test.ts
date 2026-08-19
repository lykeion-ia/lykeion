import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../store/sqlite";
import { migrate, nextSeq } from "../store/migrations";
// `verifyPassword` is wrapped, not replaced: it still does the real work,
// and the wrapper only records that it was reached. Whether it runs at all
// on the unknown-email path is the whole of the timing property, and it is
// not observable from the response.
vi.mock("../auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth")>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

import { handleAuthRoute } from "./auth-routes";
import { changeRecorder } from "../api/changes";
import { createChannel } from "../channel";
import {
  clearedCookie,
  DUMMY_HASH,
  resolveActor,
  SESSION_COOKIE,
  verifyPassword,
} from "../auth";
import type { Store } from "../store/store";

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-auth-"));
  dirs.push(dir);
  const store = openStore(join(dir, "workspace.db"));
  opened.push(store);
  migrate(store);
  return store;
}

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = 1_800_000_000;

/** A recorder over the store under test. Real rather than a stub, so the
 *  route's own writes to the change log are exercised here too. */
function recorderFor(store: Store) {
  return changeRecorder({
    store,
    actorId: null,
    now: () => NOW,
    channel: createChannel(store, 1000),
  });
}


function post(store: Store, path: string, body: unknown, now = NOW) {
  return handleAuthRoute({ store, changes: recorderFor(store), method: "POST", path, body, cookie: undefined, secure: false, now });
}

function tokenFrom(result: { setCookie?: string }): string {
  const header = result.setCookie ?? "";
  return header.slice(header.indexOf("=") + 1, header.indexOf(";"));
}

async function setUpOwner(store: Store, email = "owner@lab.example"): Promise<string> {
  await post(store, "/auth/setup", { email, displayName: "Owner", password: "a good long password" });
  return store.get(`SELECT id FROM users WHERE email = ?`, [email])!.id as string;
}

function insertInvite(
  store: Store,
  createdBy: string,
  code: string,
  overrides: {
    role?: "owner" | "member";
    expiresTs?: number;
    redeemedTs?: number | null;
    revokedTs?: number | null;
  } = {},
): void {
  store.run(
    `INSERT INTO invites (code, role, created_by, created_ts, expires_ts, redeemed_ts, revoked_ts, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      code,
      overrides.role ?? "member",
      createdBy,
      NOW,
      overrides.expiresTs ?? NOW + 1000,
      overrides.redeemedTs ?? null,
      overrides.revokedTs ?? null,
      nextSeq(store),
    ],
  );
}

function counts(store: Store) {
  return {
    users: store.all(`SELECT id FROM users`).length,
    members: store.all(`SELECT user_id FROM members`).length,
    sessions: store.all(`SELECT token FROM auth_sessions`).length,
  };
}

it("creates the owner on first run and signs them straight in", async () => {
  const store = freshStore();
  const res = await post(store, "/auth/setup", {
    email: "ana@lab.example",
    displayName: "Ana",
    password: "a good long password",
  });
  expect(res!.status).toBe(200);
  expect(res!.setCookie).toBeDefined();
  const actor = resolveActor(store, tokenFrom(res!), NOW);
  expect(actor).toEqual({ userId: expect.any(String), role: "owner" });
});

it("keeps the name the owner gave this lab", async () => {
  // Setup is the only route that can ask: it answers once, and nothing else
  // writes this column. What it holds is what a machine's pairing page, the
  // link back from one, and Settings all call this lab.
  const store = freshStore();
  const res = await post(store, "/auth/setup", {
    labName: "Ferrando Lab",
    email: "ana@lab.example",
    displayName: "Ana",
    password: "a good long password",
  });
  expect(res!.status).toBe(200);
  expect(store.get(`SELECT org_name FROM lab_settings WHERE id = 1`)!.org_name).toBe(
    "Ferrando Lab",
  );
});

it("leaves a lab set up without a name unnamed, rather than inventing one", async () => {
  // Blank is what every reader of this column already treats as unnamed, and
  // it is the state every lab created before the field existed is in. A
  // default here — the address, the owner's name — would be a name nobody
  // chose, shown as though they had.
  const store = freshStore();
  await post(store, "/auth/setup", {
    email: "ana@lab.example",
    displayName: "Ana",
    password: "a good long password",
  });
  expect(store.get(`SELECT org_name FROM lab_settings WHERE id = 1`)!.org_name).toBe("");
});

it("stops offering setup once an owner exists", async () => {
  const store = freshStore();
  await post(store, "/auth/setup", { email: "a@l.example", displayName: "A", password: "password one" });
  const probe = await handleAuthRoute({
    store,
    changes: recorderFor(store), method: "GET", path: "/auth/setup", body: undefined,
    cookie: undefined, secure: false, now: NOW,
  });
  expect(probe!.status).toBe(404);
  const second = await post(store, "/auth/setup", {
    email: "b@l.example", displayName: "B", password: "password two",
  });
  expect(second!.status).toBe(409);
});

it("admits one owner and no more, however many times setup is posted", async () => {
  // Password hashing runs on libuv's threadpool and is awaited, so unlike a
  // handler with no internal await, these two calls really can interleave
  // at that point: both can pass the pre-check before either finishes
  // hashing. What still prevents two owners is the recheck inside
  // store.tx immediately before the write — whichever call's transaction
  // commits first is what the other call's recheck sees, regardless of
  // which one started first or which scrypt call finishes first.
  const store = freshStore();
  const body = { email: "a@l.example", displayName: "A", password: "password one" };
  const results = await Promise.all([
    post(store, "/auth/setup", body),
    post(store, "/auth/setup", { ...body, email: "b@l.example" }),
  ]);
  const created = results.filter((r) => r!.status === 200);
  expect(created).toHaveLength(1);
  expect(store.all(`SELECT user_id FROM members WHERE role = 'owner'`)).toHaveLength(1);
  // And nobody was left half-created: a refused setup must not leave a user
  // row behind with no membership.
  expect(store.all(`SELECT id FROM users`)).toHaveLength(1);
});

it("refuses setup with a password under eight characters, or with a required field missing", async () => {
  const store = freshStore();
  const shortPassword = await post(store, "/auth/setup", { email: "a@l.example", displayName: "A", password: "short" });
  expect(shortPassword!.status).toBe(400);
  const noDisplayName = await post(store, "/auth/setup", { email: "a@l.example", displayName: "", password: "a good long password" });
  expect(noDisplayName!.status).toBe(400);
  expect(store.all(`SELECT id FROM users`)).toHaveLength(0);
});

it("refuses to act on a clock that is not a whole, non-negative number of seconds", async () => {
  const store = freshStore();
  const fractional = await post(store, "/auth/setup", { email: "a@l.example", displayName: "A", password: "password one" }, NOW + 0.5);
  expect(fractional!.status).toBe(400);
  const negative = await post(store, "/auth/setup", { email: "a@l.example", displayName: "A", password: "password one" }, -1);
  expect(negative!.status).toBe(400);
  expect(store.all(`SELECT id FROM users`)).toHaveLength(0);
});

it("passes secure through to the cookie a route sets", async () => {
  const store = freshStore();
  const res = await handleAuthRoute({
    store,
    changes: recorderFor(store), method: "POST", path: "/auth/setup",
    body: { email: "a@l.example", displayName: "A", password: "password one" },
    cookie: undefined, secure: true, now: NOW,
  });
  expect(res!.setCookie).toMatch(/Secure/);
});

it("signs in with the right password and refuses the wrong one", async () => {
  const store = freshStore();
  await post(store, "/auth/setup", { email: "ana@lab.example", displayName: "Ana", password: "a good long password" });

  const good = await post(store, "/auth/signin", { email: "ana@lab.example", password: "a good long password" });
  expect(good!.status).toBe(200);
  expect(resolveActor(store, tokenFrom(good!), NOW)).toBeDefined();

  const bad = await post(store, "/auth/signin", { email: "ana@lab.example", password: "wrong" });
  expect(bad!.status).toBe(401);
  expect(bad!.setCookie).toBeUndefined();
});

it("gives the same answer for an unknown email as for a wrong password", async () => {
  // A different status or message for "no such account" tells an attacker
  // which addresses are members.
  const store = freshStore();
  await post(store, "/auth/setup", { email: "ana@lab.example", displayName: "Ana", password: "a good long password" });
  const unknown = await post(store, "/auth/signin", { email: "nobody@lab.example", password: "x" });
  const wrong = await post(store, "/auth/signin", { email: "ana@lab.example", password: "x" });
  expect(unknown!.status).toBe(wrong!.status);
  expect(unknown!.json).toEqual(wrong!.json);
});

it("refuses signin for a member who has been removed", async () => {
  const store = freshStore();
  const userId = await setUpOwner(store, "a@l.example");
  store.run(`UPDATE members SET removed_ts = ? WHERE user_id = ?`, [NOW, userId]);
  const res = await post(store, "/auth/signin", { email: "a@l.example", password: "a good long password" });
  expect(res!.status).toBe(401);
});

it("signing out stops the token working and hands back the cleared cookie", async () => {
  const store = freshStore();
  const setup = await post(store, "/auth/setup", { email: "a@l.example", displayName: "A", password: "password one" });
  const token = tokenFrom(setup!);
  const signout = await handleAuthRoute({
    store,
    changes: recorderFor(store), method: "POST", path: "/auth/signout", body: undefined,
    cookie: `${SESSION_COOKIE}=${token}`, secure: false, now: NOW,
  });
  expect(signout!.setCookie).toBe(clearedCookie(false));
  expect(resolveActor(store, token, NOW)).toBeUndefined();
});

it("stops resolving a session once its member has been removed, on the member's very next request", async () => {
  const store = freshStore();
  const setup = await post(store, "/auth/setup", { email: "a@l.example", displayName: "A", password: "password one" });
  const token = tokenFrom(setup!);
  const userId = store.get(`SELECT id FROM users WHERE email = 'a@l.example'`)!.id as string;
  expect(resolveActor(store, token, NOW)).toBeDefined();
  store.run(`UPDATE members SET removed_ts = ? WHERE user_id = ?`, [NOW, userId]);
  expect(resolveActor(store, token, NOW)).toBeUndefined();
});

it("stops resolving a session once it has expired", async () => {
  const store = freshStore();
  const setup = await post(store, "/auth/setup", { email: "a@l.example", displayName: "A", password: "password one" });
  const token = tokenFrom(setup!);
  expect(resolveActor(store, token, NOW)).toBeDefined();
  const thirtyOneDaysLater = NOW + 31 * 24 * 60 * 60;
  expect(resolveActor(store, token, thirtyOneDaysLater)).toBeUndefined();
});

it("refuses a role outside the schema's own values at the database layer", async () => {
  const store = freshStore();
  const ownerId = await setUpOwner(store);
  expect(() =>
    store.run(
      `INSERT INTO invites (code, role, created_by, created_ts, expires_ts, seq) VALUES (?, ?, ?, ?, ?, ?)`,
      ["bad-role-code", "superadmin", ownerId, NOW, NOW + 1000, nextSeq(store)],
    ),
  ).toThrow(/CHECK/i);
});

it("refuses to resolve a session whose member row carries a role outside the schema's own values", async () => {
  // A role outside ('owner', 'member') cannot arrive through any insert or
  // update this codebase performs — the CHECK constraint above refuses it.
  // Bypassing that here is what proves resolveActor does not lean on the
  // constraint alone: even a row the schema should never have admitted
  // must not become an Actor.
  const store = freshStore();
  const setup = await post(store, "/auth/setup", { email: "a@l.example", displayName: "A", password: "password one" });
  const token = tokenFrom(setup!);
  const userId = store.get(`SELECT id FROM users WHERE email = 'a@l.example'`)!.id as string;
  expect(resolveActor(store, token, NOW)).toBeDefined();
  store.run(`PRAGMA ignore_check_constraints = ON`);
  store.run(`UPDATE members SET role = 'superadmin' WHERE user_id = ?`, [userId]);
  store.run(`PRAGMA ignore_check_constraints = OFF`);
  expect(resolveActor(store, token, NOW)).toBeUndefined();
});

it("refuses redemption of a code that was never issued", async () => {
  const store = freshStore();
  await setUpOwner(store);
  const res = await post(store, "/auth/redeem-invite", {
    code: "no-such-code", email: "new@lab.example", displayName: "New", password: "a good long password",
  });
  expect(res!.status).toBe(400);
});

it("refuses a revoked invite", async () => {
  const store = freshStore();
  const ownerId = await setUpOwner(store);
  insertInvite(store, ownerId, "revoked-code", { revokedTs: NOW });
  const res = await post(store, "/auth/redeem-invite", {
    code: "revoked-code", email: "new@lab.example", displayName: "New", password: "a good long password",
  });
  expect(res!.status).toBe(400);
});

it("refuses an invite that has already been redeemed", async () => {
  const store = freshStore();
  const ownerId = await setUpOwner(store);
  insertInvite(store, ownerId, "used-code", { redeemedTs: NOW });
  const res = await post(store, "/auth/redeem-invite", {
    code: "used-code", email: "new@lab.example", displayName: "New", password: "a good long password",
  });
  expect(res!.status).toBe(400);
});

it("refuses an expired invite, including one expiring at this exact second", async () => {
  const store = freshStore();
  const ownerId = await setUpOwner(store);
  insertInvite(store, ownerId, "expired-code", { expiresTs: NOW - 1 });
  const longExpired = await post(store, "/auth/redeem-invite", {
    code: "expired-code", email: "new@lab.example", displayName: "New", password: "a good long password",
  });
  expect(longExpired!.status).toBe(400);

  // Expiring exactly at `now` counts as expired, not as still valid for one
  // more second: an invite whose deadline has arrived is not honored.
  insertInvite(store, ownerId, "boundary-code", { expiresTs: NOW });
  const atBoundary = await post(store, "/auth/redeem-invite", {
    code: "boundary-code", email: "new2@lab.example", displayName: "New", password: "a good long password",
  });
  expect(atBoundary!.status).toBe(400);
});

it("refuses redemption for an email that already has an account, and leaves no trace of the attempt behind", async () => {
  const store = freshStore();
  const ownerId = await setUpOwner(store);
  insertInvite(store, ownerId, "dupe-code");
  const before = counts(store);
  const res = await post(store, "/auth/redeem-invite", {
    code: "dupe-code", email: "owner@lab.example", displayName: "Dupe", password: "a good long password",
  });
  expect(res!.status).toBe(400);
  expect(counts(store)).toEqual(before);
});

it("admits a member on a valid invite, marks the code redeemed, and signs them in", async () => {
  const store = freshStore();
  const ownerId = await setUpOwner(store);
  insertInvite(store, ownerId, "good-code", { role: "member" });
  const res = await post(store, "/auth/redeem-invite", {
    code: "good-code", email: "new@lab.example", displayName: "New", password: "a good long password",
  });
  expect(res!.status).toBe(200);
  expect(res!.setCookie).toBeDefined();
  expect(store.get(`SELECT redeemed_ts FROM invites WHERE code = 'good-code'`)!.redeemed_ts).toBe(NOW);
  const actor = resolveActor(store, tokenFrom(res!), NOW);
  expect(actor).toEqual({ userId: expect.any(String), role: "member" });
});

it("refuses redemption with a password under eight characters, or with a required field missing", async () => {
  const store = freshStore();
  const ownerId = await setUpOwner(store);
  insertInvite(store, ownerId, "field-check-code");
  const shortPassword = await post(store, "/auth/redeem-invite", {
    code: "field-check-code", email: "new@lab.example", displayName: "New", password: "short",
  });
  expect(shortPassword!.status).toBe(400);
  const noCode = await post(store, "/auth/redeem-invite", {
    code: "", email: "new@lab.example", displayName: "New", password: "a good long password",
  });
  expect(noCode!.status).toBe(400);
  // Distinct from "that invite code is not valid" — an empty code is
  // refused before any lookup runs, not because the lookup happens to find
  // nothing for an empty string.
  expect((noCode!.json as { error: string }).error).toMatch(/required/);
});

it("leaves paths it does not own alone", async () => {
  const store = freshStore();
  expect(await post(store, "/rpc/listResearches", {})).toBeUndefined();
});

it("hashes on the unknown-email path too, so the answer cannot be timed", async () => {
  // An email with no account must cost what a real one costs. Short-circuiting
  // before the hash returns in a fraction of the time, and the difference is
  // readable across a network — it enumerates the lab's membership without
  // ever guessing a password. The response is identical either way, so only
  // the work done tells the two apart.
  const store = freshStore();
  await setUpOwner(store);
  vi.mocked(verifyPassword).mockClear();

  const refused = await post(store, "/auth/signin", {
    email: "nobody@lab.example",
    password: "a good long password",
  });

  expect(refused!.status).toBe(401);
  expect(vi.mocked(verifyPassword)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(verifyPassword).mock.calls[0][1]).toBe(DUMMY_HASH);
});

it("refuses a role outside the schema's own values on members, not only on invites", async () => {
  // `members.role` is the one every authorisation decision reads. A value
  // outside the set would be cast straight to `Role` and believed.
  const store = freshStore();
  const ownerId = await setUpOwner(store);
  expect(() =>
    store.run(`UPDATE members SET role = ? WHERE user_id = ?`, [
      "superadmin",
      ownerId,
    ]),
  ).toThrow(/CHECK/i);
});
