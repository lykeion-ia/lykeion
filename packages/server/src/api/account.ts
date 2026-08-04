import { randomBytes } from "node:crypto";
import {
  assertAvatarDataUrl,
  LykeionError,
  type Invite,
  type LykeionApi,
  type Member,
  type Role,
  type User,
} from "@lykeion/api";
import type { Deps } from "./index";
import type { Row } from "../store/store";
import { nextSeq } from "../store/migrations";
import type { Actor } from "../auth";

export type AccountApi = Pick<
  LykeionApi,
  | "currentUser" | "setAvatar" | "listMembers"
  | "createInvite" | "listInvites" | "revokeInvite" | "removeMember"
>;

/** Seven days: long enough that sharing a link with a colleague across a
 *  weekend still works, short enough that a leaked one is not a standing
 *  door into the lab. */
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

function toUser(row: Row): User {
  return {
    id: row.id as string,
    email: row.email as string,
    displayName: row.display_name as string,
    createdTs: row.created_ts as number,
    // Absent, not null: the contract's key is present only when a picture is
    // set, and every surface that draws a face chooses between the picture and
    // the initials on that presence.
    ...(row.avatar_url ? { avatarUrl: row.avatar_url as string } : {}),
  };
}

function toInvite(row: Row): Invite {
  return {
    code: row.code as string,
    role: row.role as Role,
    createdBy: row.created_by as string,
    createdTs: row.created_ts as number,
    expiresTs: row.expires_ts as number,
    ...(row.redeemed_ts === null ? {} : { redeemedTs: row.redeemed_ts as number }),
  };
}

/** Every membership method below opens with this. Kept as one function
 *  rather than five copies of the same `if`, so the message a caller sees
 *  cannot drift between them. */
function requireOwner(actor: Actor): void {
  if (actor.role !== "owner")
    throw new LykeionError("forbidden", "only an owner may manage this lab's membership");
}

export function accountApi({ store, actor, now, changes, channel }: Deps): AccountApi {
  const { record } = changes;
  return {
    async currentUser() {
      const row = store.get(
        `SELECT id, email, display_name, created_ts, avatar_url FROM users WHERE id = ?`,
        [actor.userId],
      );
      if (!row) throw new LykeionError("not-found", `no member for the current user "${actor.userId}"`);
      return toUser(row);
    },

    async setAvatar(dataUrl) {
      // Validated against the contract's own checker rather than a rule of
      // this server's, so a picture the in-memory implementation accepts is
      // one this one accepts. Ahead of the write, because the column is the
      // sole place the bytes land and an unchecked one is what a member's
      // browser would then try to render on every roster row.
      if (dataUrl !== null) assertAvatarDataUrl(dataUrl);
      store.tx(() => {
        // The row must exist — `resolveActor` already refused a session whose
        // member is gone — but UPDATE says nothing when it matches nothing,
        // and a picture silently discarded is worse than one refused.
        const exists = store.get(`SELECT id FROM users WHERE id = ?`, [actor.userId]);
        if (!exists)
          throw new LykeionError("not-found", `no member for the current user "${actor.userId}"`);
        store.run(`UPDATE users SET avatar_url = ? WHERE id = ?`, [dataUrl, actor.userId]);
        // The roster every other member is holding now shows a stale face, so
        // this goes on the change feed the way a membership edit does — the
        // picture is part of the identity, not a private preference.
        record("member-avatar-changed", { userId: actor.userId });
      });
    },

    async listMembers(): Promise<Member[]> {
      // Joined-date ascending, insertion sequence breaking the tie: two
      // members admitted in the same second still have one order, and it is
      // the order they were admitted in.
      return store
        .all(
          `SELECT u.id, u.email, u.display_name, u.created_ts, u.avatar_url,
                  m.role, m.joined_ts, m.removed_ts
             FROM members m JOIN users u ON u.id = m.user_id
            ORDER BY m.joined_ts ASC, m.seq ASC`,
        )
        .map((row) => ({
          user: toUser(row),
          role: row.role as Member["role"],
          joinedTs: row.joined_ts as number,
          ...(row.removed_ts === null ? {} : { removedTs: row.removed_ts as number }),
        }));
    },

    async createInvite(role) {
      requireOwner(actor);
      // Checked here rather than left to the column's CHECK constraint. The
      // RPC surface takes its arguments from client JSON, so an unknown role
      // arrives as a string like any other, and reaching the database with
      // it turns a caller's own mistake into a 500 and a logged stack.
      if (role !== "owner" && role !== "member")
        throw new LykeionError("invalid", `a role is either owner or member, not ${role}`);
      return store.tx(() => {
        const ts = now();
        const code = randomBytes(12).toString("base64url");
        const seq = nextSeq(store);
        store.run(
          `INSERT INTO invites (code, role, created_by, created_ts, expires_ts, seq)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [code, role, actor.userId, ts, ts + INVITE_TTL_SECONDS, seq],
        );
        // No code in the payload. The change log fans out to every member
        // on the event stream, and an invite code is the one thing recorded
        // here that is a credential — a member who read one off the stream
        // could redeem it, and an owner-role code would make them an owner.
        // An owner who wants the code reads it back through `listInvites`,
        // which is theirs alone.
        record("invite-created", {});
        return toInvite(store.get(`SELECT * FROM invites WHERE code = ?`, [code])!);
      });
    },

    async listInvites() {
      requireOwner(actor);
      // Every invite that has not been revoked — a redeemed one still
      // lists, because "revoked" and "used" are different states and only
      // one of them is what this method promises to exclude.
      return store
        .all(`SELECT * FROM invites WHERE revoked_ts IS NULL ORDER BY created_ts ASC, seq ASC`)
        .map(toInvite);
    },

    async revokeInvite(code) {
      requireOwner(actor);
      store.tx(() => {
        const invite = store.get(`SELECT code, revoked_ts FROM invites WHERE code = ?`, [code]);
        if (!invite) throw new LykeionError("not-found", `no such invite: ${code}`);
        // Withdrawing a withdrawn invite is not an error, the same way
        // archiving an archived Study is not: the state the caller asked
        // for already holds.
        if (invite.revoked_ts === null) {
          store.run(`UPDATE invites SET revoked_ts = ? WHERE code = ?`, [now(), code]);
          record("invite-revoked", {});
        }
      });
    },

    async removeMember(userId) {
      requireOwner(actor);
      let removed = false;
      store.tx(() => {
        const member = store.get(
          `SELECT user_id, role, removed_ts FROM members WHERE user_id = ?`,
          [userId],
        );
        if (!member) throw new LykeionError("not-found", `no such member: ${userId}`);
        // Offboarding someone already offboarded is not an error, the same
        // way withdrawing a withdrawn invite is not — and this has to come
        // before the owner check, or an owner who has already gone would be
        // refused on the grounds of being the last one.
        if (member.removed_ts !== null) return;
        if (member.role === "owner") {
          // Not "an owner may never be offboarded" — a lab with a second
          // owner can still lose the first. What may never happen is the
          // roster reaching zero owners, which is what "the last one"
          // checks for rather than the role alone.
          const owners = store.get(
            `SELECT COUNT(*) AS n FROM members WHERE role = 'owner' AND removed_ts IS NULL`,
          )!.n as number;
          if (owners <= 1) throw new LykeionError("forbidden", "the owner cannot be offboarded");
        }
        store.run(`UPDATE members SET removed_ts = ? WHERE user_id = ?`, [now(), userId]);
        // `resolveActor` already refuses a session whose member is gone, so
        // this is not what closes the door — it is what stops a dead
        // session sitting in the table until its own expiry, waiting for a
        // future change to that join to make it live again.
        store.run(`DELETE FROM auth_sessions WHERE user_id = ?`, [userId]);
        // A machine is only ever as trustworthy as the member who approved
        // it. Offboarding that member and leaving their machines running
        // would leave a bearer token nothing here still vouches for able to
        // keep calling in.
        store.run(`UPDATE runtimes SET removed_ts = ? WHERE owner_id = ? AND removed_ts IS NULL`, [
          now(),
          userId,
        ]);
        store.run(`UPDATE machine_tokens SET revoked_ts = ? WHERE owner_id = ? AND revoked_ts IS NULL`, [
          now(),
          userId,
        ]);
        // A code this member minted and never redeemed is still exchangeable
        // by anyone holding it — the exchange route has no idea the member
        // behind it is gone until `resolveMachine` runs, which is one
        // pairing too late. Spending it here closes that window at its
        // source instead of relying on the daemon side to ever call in.
        store.run(`UPDATE pair_requests SET spent_ts = ? WHERE owner_id = ? AND spent_ts IS NULL`, [
          now(),
          userId,
        ]);
        record("member-removed", { userId });
        removed = true;
      });
      // Outside the transaction, because a rollback would leave somebody
      // cut off from a lab they are still in. An open stream resolved this
      // person once, when it opened; nothing else ever asks again.
      if (removed) channel.evict(userId);
    },
  };
}
