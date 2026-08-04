import type { Assignee, Member, User } from "@lykeion/api";

/**
 * Presentation for a Task's assignees: a deterministic avatar (initial plus
 * gradient) over the real identity, so the same person is the same colour on
 * every screen.
 */

/** Looks a user up by id. Backed by the member list. */
export interface Directory {
  /**
   * Whether the member list has arrived. Before it has, a lookup that
   * finds nothing is pending, not missing — and the two must not render
   * the same way.
   */
  loaded: boolean;
  user(userId: string): User | undefined;
  /**
   * The members who are still in the lab, in the order the list arrived.
   * Assigning work is the one thing that needs the roster rather than a
   * single name, and it must not offer someone who has left — so the filter
   * lives here, where the list already is, instead of in a second fetch.
   */
  activeMembers(): Member[];
}

export function directoryOf(members: Member[]): Directory {
  const byId = new Map(members.map((m) => [m.user.id, m.user]));
  const active = members.filter((m) => m.removedTs === undefined);
  return {
    loaded: true,
    user: (userId) => byId.get(userId),
    activeMembers: () => active,
  };
}

/** The directory before the member list has arrived. Every lookup misses. */
export function pendingDirectory(): Directory {
  return { loaded: false, user: () => undefined, activeMembers: () => [] };
}

/**
 * A stable identity string. People and agents are keyed into separate
 * namespaces on purpose: an agent named after a member must not collide with
 * that member, or one would render as the other.
 */
export function assigneeKey(assignee: Assignee): string {
  return assignee.kind === "user"
    ? `user:${assignee.userId}`
    : `agent:${assignee.name}`;
}

export function displayName(assignee: Assignee, dir: Directory): string {
  if (assignee.kind === "agent")
    return assignee.name.charAt(0).toUpperCase() + assignee.name.slice(1);
  const user = dir.user(assignee.userId);
  if (user) return user.displayName;
  // A removed member is still listed, so once the directory has loaded a
  // miss is a genuinely unknown id — render it rather than dropping the
  // avatar and losing the assignment. Before it loads, a miss is only
  // pending: blank lets the chip fill in rather than flash a wrong name.
  return dir.loaded ? "Unknown member" : "";
}

const GRADIENTS: [string, string][] = [
  ["#3D8FCB", "#6FB9EC"],
  ["#8a86d8", "#b6b2ee"],
  ["#27a644", "#5fd39a"],
  ["#d9a441", "#efc773"],
  ["#e5705b", "#f2a08f"],
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export interface AssigneeAvatar {
  label: string;
  initial: string;
  gradient: [string, string];
}

export function assigneeAvatar(
  assignee: Assignee,
  dir: Directory,
): AssigneeAvatar {
  const label = displayName(assignee, dir);
  return {
    label,
    initial: label.charAt(0).toUpperCase(),
    gradient: GRADIENTS[hash(assigneeKey(assignee)) % GRADIENTS.length],
  };
}

/**
 * An agent's avatar, keyed on its name alone. An agent is never looked up in
 * the member directory, so callers outside a Task's assignees — an Agent
 * persona, a Research Group's lead, a usage row — don't need one.
 */
export function agentAvatar(name: string): AssigneeAvatar {
  return assigneeAvatar({ kind: "agent", name }, directoryOf([]));
}

/**
 * Up to two initials for a person, first word and last: "Diego Marono" reads
 * "DM", a one-word name reads its single letter.
 *
 * Split by code point rather than by index, so a name that begins with an
 * astral character (an emoji, or a script outside the BMP) yields that
 * character rather than half of its surrogate pair, which renders as U+FFFD.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const first = [...words[0]][0];
  const last = words.length > 1 ? [...words[words.length - 1]][0] : "";
  return (first + last).toUpperCase();
}

/** A person's face: their own picture when they have set one, and the
 *  initials-on-a-gradient stand-in when they have not. */
export interface UserFace {
  label: string;
  initials: string;
  gradient: [string, string];
  /** Their uploaded picture, absent until they set one. */
  pictureUrl?: string;
}

/**
 * How a member is drawn anywhere their face appears.
 *
 * The gradient comes off the same `user:<id>` key `assigneeAvatar` uses, so
 * someone without a picture is the same colour on a Task chip as in the account
 * menu — a second colour scheme for the same person would read as two people.
 */
export function userFace(user: User): UserFace {
  const label = user.displayName.trim() === "" ? user.email : user.displayName;
  return {
    label,
    // The email is the fallback because a lab always has one for a member,
    // even before they have named themselves.
    initials: initialsOf(label) || initialsOf(user.email) || "?",
    gradient:
      GRADIENTS[hash(assigneeKey({ kind: "user", userId: user.id })) % GRADIENTS.length],
    ...(user.avatarUrl ? { pictureUrl: user.avatarUrl } : {}),
  };
}
