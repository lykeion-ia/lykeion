import { LykeionError } from "./errors";

/** A person with an account on this lab's workbench. */
export interface User {
  id: string;
  email: string;
  displayName: string;
  createdTs: number;
  /**
   * The person's profile picture as a `data:image/…` URL, absent until they
   * set one — every surface that draws a face falls back to their initials,
   * so absent is a rendering state rather than a gap.
   *
   * Carried inline rather than as a URL to fetch: it is read on every roster
   * row and message avatar, and a second round trip per face is a worse trade
   * than the bytes. `MAX_AVATAR_BYTES` is what keeps that trade honest.
   */
  avatarUrl?: string;
}

/**
 * The largest profile picture the contract accepts, as the length of the data
 * URL itself.
 *
 * It rides on every `User` the lab hands out — a roster of thirty is thirty
 * copies — so this is sized for a downscaled square, not for whatever came off
 * a camera. Clients are expected to resize before calling; this is the backstop
 * that stops one that doesn't from making every member list slow for everyone.
 */
export const MAX_AVATAR_BYTES = 256 * 1024;

/**
 * The one definition of what `setAvatar` accepts, so the two implementations
 * cannot come to different answers about the same picture.
 *
 * Data URLs only. A profile picture that could name an arbitrary URL would let
 * whoever set it learn the address of every member who later loaded the roster,
 * and would leave a face that renders today broken the day that host goes away.
 */
export function assertAvatarDataUrl(dataUrl: string): void {
  if (!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl))
    throw new LykeionError(
      "invalid",
      "a profile picture must be a base64 data URL for a png, jpeg, gif or webp image",
    );
  if (dataUrl.length > MAX_AVATAR_BYTES)
    throw new LykeionError(
      "invalid",
      `a profile picture may be at most ${Math.floor(MAX_AVATAR_BYTES / 1024)}KB; this one is ${Math.floor(dataUrl.length / 1024)}KB — resize it before uploading`,
    );
}

/**
 * What a person may do. An owner invites and offboards members and edits lab
 * settings; a member does everything else.
 */
export type Role = "owner" | "member";

/**
 * A person's standing in this lab. The user is embedded rather than
 * referenced, because every surface that lists members immediately needs
 * their display name to render a row.
 */
export interface Member {
  user: User;
  role: Role;
  joinedTs: number;
  /**
   * Set when offboarded. Removal is soft: a removed member's Studies, Tasks
   * and links stay attributable to them, because orphaning authorship to
   * reclaim a row would corrupt the record.
   */
  removedTs?: number;
}

/**
 * A redeemable code that admits one person to the lab. It lapses on its own
 * and can be withdrawn before it is used — a code that can only be waited out
 * is a code that gets shared once and regretted.
 */
export interface Invite {
  code: string;
  role: Role;
  /** The `User.id` of the owner who minted it. */
  createdBy: string;
  createdTs: number;
  expiresTs: number;
  /**
   * Set once the code has been redeemed. `listInvites` keeps a redeemed
   * invite listed — "revoked" and "used" are different states, and only the
   * former drops a code from the list — so a reader that wants to know
   * whether a listed code is still good needs this to tell the two states
   * of "still listed" apart from `expiresTs` alone.
   */
  redeemedTs?: number;
}
