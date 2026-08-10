import type { Store } from "../store/store";
import type { ChangeRecorder } from "../api/changes";
import { nextSeq } from "../store/migrations";
import {
  clearedCookie,
  DUMMY_HASH,
  hashPassword,
  newToken,
  ownerExists,
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookie,
  verifyPassword,
} from "../auth";

export interface AuthRequest {
  store: Store;
  /** Where a route records what it changed. Admitting a new member is a
   *  change to the lab like any other, and an owner watching the roster
   *  should see it arrive rather than find it on the next reload. */
  changes: ChangeRecorder;
  method: string;
  path: string;
  body: unknown;
  cookie: string | undefined;
  secure: boolean;
  now: number;
}

export interface AuthResult {
  status: number;
  json: unknown;
  setCookie?: string;
}

function field(body: unknown, name: string): string {
  const value = (body as Record<string, unknown> | null)?.[name];
  return typeof value === "string" ? value.trim() : "";
}

/** One message for every credential failure. Which half was wrong is not
 *  the caller's business, and telling them enumerates the membership. */
const REFUSED = { error: "that email and password do not match an account" };

/** The one answer for a code that cannot be used, whatever the reason. A
 *  reason that distinguishes an unknown code from an address that is
 *  already a member's tells the holder of any valid code who is in the lab. */
const INVITE_REFUSED = "that invite code is not valid";

/** The `(method, path)` pairs this module answers for. Checked once at the
 *  top of `handleAuthRoute` rather than left implicit in the final
 *  fall-through, so a request this module does not own is recognized
 *  before anything below assumes `now` is a request this module is about
 *  to act on. */
const OWNED_ROUTES = new Set([
  "GET /auth/setup",
  "POST /auth/setup",
  "POST /auth/signin",
  "POST /auth/signout",
  "POST /auth/redeem-invite",
]);

function startSession(store: Store, userId: string, now: number, secure: boolean): string {
  const token = newToken();
  store.run(
    `INSERT INTO auth_sessions (token, user_id, created_ts, expires_ts) VALUES (?, ?, ?, ?)`,
    [token, userId, now, now + SESSION_TTL_SECONDS],
  );
  return sessionCookie(token, secure);
}

function createPerson(
  store: Store,
  input: { email: string; displayName: string; passwordHash: string },
  role: "owner" | "member",
  now: number,
): string {
  const userId = `u_${newToken().slice(0, 12)}`;
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq) VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, input.email.toLowerCase(), input.displayName, input.passwordHash, now, nextSeq(store)],
  );
  store.run(`INSERT INTO members (user_id, role, joined_ts, seq) VALUES (?, ?, ?, ?)`, [
    userId,
    role,
    now,
    nextSeq(store),
  ]);
  store.run(`INSERT INTO user_settings (user_id, theme) VALUES (?, 'midnight')`, [userId]);
  return userId;
}

type InviteCheck = { role: "owner" | "member" } | { failure: string };

/**
 * Whether a code can be redeemed right now, for this email. Called twice
 * per redemption — once before the password is hashed, so an invalid code
 * never pays scrypt's cost, and once more inside the transaction that
 * actually writes, so a code that stopped being valid in between (redeemed
 * or revoked by another request) is caught before a second account is
 * created from it.
 */
function checkInvite(store: Store, code: string, email: string, now: number): InviteCheck {
  const invite = store.get(
    `SELECT role, expires_ts, redeemed_ts, revoked_ts FROM invites WHERE code = ?`,
    [code],
  );
  if (!invite) return { failure: INVITE_REFUSED };
  if (invite.revoked_ts !== null) return { failure: "that invite has been withdrawn" };
  if (invite.redeemed_ts !== null) return { failure: "that invite has already been used" };
  if ((invite.expires_ts as number) <= now) return { failure: "that invite has expired" };
  // Answered with the same words an unusable code gets. Naming this case
  // separately turns one valid invite into an oracle: whoever holds it can
  // ask about any address at all, cheaply and without spending the code,
  // because this check runs before anything is written or hashed. Somebody
  // who really does have an account signs in instead, which is the way out
  // the join screen offers.
  if (store.get(`SELECT id FROM users WHERE email = ?`, [email.toLowerCase()]))
    return { failure: INVITE_REFUSED };
  return { role: invite.role as "owner" | "member" };
}

/**
 * The routes that cannot sit on an authenticated contract, because they are
 * how a caller becomes authenticated in the first place. Returns `undefined`
 * for any path this module does not own, so the caller can go on routing.
 */
export async function handleAuthRoute(req: AuthRequest): Promise<AuthResult | undefined> {
  const { store, method, path, body, now, secure, changes } = req;
  if (!OWNED_ROUTES.has(`${method} ${path}`)) return undefined;

  // Every write below stamps a `*Ts` column with `now` under the project's
  // own invariant that those columns hold whole epoch seconds. A caller
  // passing milliseconds or a fractional value would otherwise land
  // straight in storage and corrupt every ordered read that trusts it.
  if (!Number.isInteger(now) || now < 0)
    return { status: 400, json: { error: "now must be a whole, non-negative number of seconds" } };

  if (path === "/auth/setup" && method === "GET") {
    return ownerExists(store)
      ? { status: 404, json: { error: "this lab already has an owner" } }
      : { status: 200, json: { setupRequired: true } };
  }

  if (path === "/auth/setup" && method === "POST") {
    const email = field(body, "email");
    const displayName = field(body, "displayName");
    const password = field(body, "password");
    // The lab's own name, asked for on the one screen that can ask for it.
    // Optional, because a lab created before this route took it has none and
    // is not broken by that: everything that says a lab's name falls back to
    // the address it was reached at.
    const labName = field(body, "labName");
    if (!email || !displayName || password.length < 8)
      return { status: 400, json: { error: "an email, a display name, and a password of at least 8 characters are required" } };

    // Checked before the password is hashed so that a submission arriving
    // after the lab already has an owner — the common case for every
    // request after the first — costs one indexed read, not a full scrypt
    // call. The recheck inside the transaction below is what the actual
    // one-owner guarantee rests on; see the comment there for why.
    if (ownerExists(store)) return { status: 409, json: { error: "this lab already has an owner" } };
    const passwordHash = await hashPassword(password);

    // This recheck does not, by itself, make two truly concurrent writers
    // resolve to a clean 409 — SQLite defers taking a write lock until the
    // first write inside BEGIN, so a second connection racing the first
    // past this SELECT can still collide with SQLite's own locking once it
    // tries to write, rather than with this check. What holds on this
    // store is that tx() runs one caller's whole block before the next one
    // starts, so the recheck always sees whichever transaction committed
    // first — worth keeping even though nothing here can demonstrate the
    // multi-connection case it also has to be correct for.
    let conflict = false;
    let cookie = "";
    store.tx(() => {
      if (ownerExists(store)) {
        conflict = true;
        return;
      }
      const userId = createPerson(store, { email, displayName, passwordHash }, "owner", now);
      // The name is whatever the owner called this lab, and blank when they
      // called it nothing — an empty string is what every reader of this
      // column already treats as "unnamed", so a lab created without one is
      // in exactly the state every lab was in before the field existed.
      //
      // The id stays blank regardless. A lab that has just been created has
      // no identifier for an organization, and minting an opaque token here
      // would put a random string in front of a researcher as their
      // organization's id, and would make every honest read of the column
      // answer with it.
      store.run(`INSERT INTO lab_settings (id, org_name, org_id) VALUES (1, ?, '')`, [labName]);
      cookie = startSession(store, userId, now, secure);
    });
    return conflict
      ? { status: 409, json: { error: "this lab already has an owner" } }
      : { status: 200, json: { ok: true }, setCookie: cookie };
  }

  if (path === "/auth/signin" && method === "POST") {
    const email = field(body, "email").toLowerCase();
    const password = field(body, "password");
    const row = store.get(
      `SELECT u.id AS id, u.password AS password
         FROM users u JOIN members m ON m.user_id = u.id
        WHERE u.email = ? AND m.removed_ts IS NULL`,
      [email],
    );
    // Verified against the real row's hash when there is one, and against
    // a fixed dummy hash when there is not — never skipped. Skipping scrypt
    // on a missing row is what let "no such account" answer roughly 30x
    // faster than a wrong password on a real one, which is its own way of
    // telling an attacker which emails are members.
    const valid = await verifyPassword(password, row ? (row.password as string) : DUMMY_HASH);
    if (!row || !valid) return { status: 401, json: REFUSED };
    return { status: 200, json: { ok: true }, setCookie: startSession(store, row.id as string, now, secure) };
  }

  if (path === "/auth/signout" && method === "POST") {
    const token = readCookie(req.cookie, SESSION_COOKIE);
    if (token) store.run(`DELETE FROM auth_sessions WHERE token = ?`, [token]);
    return { status: 200, json: { ok: true }, setCookie: clearedCookie(secure) };
  }

  // path === "/auth/redeem-invite" && method === "POST", the only
  // remaining member of OWNED_ROUTES.
  const code = field(body, "code");
  const email = field(body, "email");
  const displayName = field(body, "displayName");
  const password = field(body, "password");
  if (!code || !email || !displayName || password.length < 8)
    return { status: 400, json: { error: "a code, an email, a display name, and a password of at least 8 characters are required" } };

  const preCheck = checkInvite(store, code, email, now);
  if ("failure" in preCheck) return { status: 400, json: { error: preCheck.failure } };
  const passwordHash = await hashPassword(password);

  let failure: string | undefined;
  let cookie = "";
  store.tx(() => {
    const check = checkInvite(store, code, email, now);
    if ("failure" in check) {
      failure = check.failure;
      return;
    }
    const userId = createPerson(store, { email, displayName, passwordHash }, check.role, now);
    store.run(`UPDATE invites SET redeemed_ts = ? WHERE code = ?`, [now, code]);
    cookie = startSession(store, userId, now, secure);
    // Attributed to the person who just joined, since nobody is signed in
    // here to attribute it to. Two things changed and both are on screen
    // somewhere: the roster gained a member, and an outstanding invite
    // stopped being outstanding.
    changes.record("member-joined", { userId }, userId);
    changes.record("invite-redeemed", {}, userId);
  });
  return failure
    ? { status: 400, json: { error: failure } }
    : { status: 200, json: { ok: true }, setCookie: cookie };
}
