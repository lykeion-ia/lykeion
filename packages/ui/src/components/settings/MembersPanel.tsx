import { useEffect, useState } from "react";
import type { Invite, Member, Role } from "@lykeion/api";
import { useApi, useDataVersion, useInvalidateData } from "../../api/ApiContext";
import { usePromise } from "../../hooks/usePromise";
import { cn } from "../../lib/utils";
import { CheckIcon, CopyIcon } from "../icons";
import { SectionTitle, SettingsSectionHeader } from "./SettingsSection";
import { primaryActionClass } from "../ui/PrimaryButton";

export interface MembersPanelProps {
  /**
   * The signed-in caller's own standing in this lab, as the mounting screen
   * read it off the roster. Hiding owner-only controls from it is a
   * courtesy — the server refuses the calls behind them regardless, and a
   * write this component makes anyway still has to be handled honestly
   * rather than assumed to succeed.
   */
  role: Role;
}

interface MembersData {
  members: Member[];
  invites: Invite[];
  meId: string;
}

/**
 * Whether this code will still let somebody in. The list holds every invite
 * an owner has not withdrawn, and a used or expired one is kept because
 * which code somebody arrived on is worth being able to look up — but it is
 * no longer a credential, and nothing that treats it as one should be
 * offered against it.
 *
 * `expiresTs` and `redeemedTs` are unix seconds, the same convention every
 * other timestamp in the app follows.
 */
function isLive(invite: Invite): boolean {
  return invite.redeemedTs === undefined && invite.expiresTs > Date.now() / 1000;
}

/**
 * Settings › Members — who is in this lab, and, for its owner, the way to
 * bring somebody else in or take them back out. A member sees the roster
 * with none of the owner's controls; an owner sees those too, because the
 * server answers to them.
 */
export function MembersPanel({ role }: MembersPanelProps) {
  const api = useApi();
  const version = useDataVersion();
  const invalidate = useInvalidateData();
  const [actionError, setActionError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);

  const q = usePromise<MembersData>(async () => {
    const [members, invites, me] = await Promise.all([
      api.listMembers(),
      // Asking for the invite list as a member would only ever come back
      // refused — the server keeps it owner-only — so there is nothing to
      // gain by making the call.
      role === "owner" ? api.listInvites() : Promise.resolve([]),
      api.currentUser(),
    ]);
    return { members, invites, meId: me.id };
  }, [api, version, role]);

  const members = q.data?.members ?? [];
  const invites = q.data?.invites ?? [];
  const live = invites.filter(isLive);
  const spent = invites.filter((invite) => !isLive(invite));
  const owners = members.filter((m) => m.role === "owner" && m.removedTs === undefined);

  /**
   * Whether to offer Remove on a row. Beyond the obvious — a member cannot
   * offboard anyone, and somebody already gone cannot go again — this keeps
   * back the two the lab would refuse: nobody offboards themselves from a
   * surface with no way back, and the last owner cannot leave a lab with no
   * owner in it.
   */
  const canRemove = (member: Member): boolean => {
    if (role !== "owner" || member.removedTs !== undefined) return false;
    if (member.user.id === q.data?.meId) return false;
    return member.role !== "owner" || owners.length > 1;
  };

  const mintInvite = async () => {
    setActionError(null);
    setMinting(true);
    try {
      await api.createInvite("member");
      invalidate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setMinting(false);
    }
  };

  const withdrawInvite = async (code: string) => {
    setActionError(null);
    try {
      await api.revokeInvite(code);
      invalidate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeMember = async (userId: string) => {
    setActionError(null);
    try {
      await api.removeMember(userId);
      invalidate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-8">
      <section>
        <SettingsSectionHeader
          title="Members"
          action={
            role === "owner" ? (
              <button
                type="button"
                onClick={() => void mintInvite()}
                disabled={minting}
                className={cn(primaryActionClass, minting && "cursor-not-allowed opacity-60")}
              >
                {minting ? "Minting…" : "Mint an invite"}
              </button>
            ) : undefined
          }
        />
        {actionError && (
          <p className="mb-3 text-sub text-danger">{actionError}</p>
        )}
        <ul aria-label="Members" className="divide-y divide-line-soft">
          {members.map((member) => (
            <MemberRow
              key={member.user.id}
              member={member}
              canRemove={canRemove(member)}
              onRemove={() => void removeMember(member.user.id)}
            />
          ))}
        </ul>
      </section>

      {role === "owner" && (
        <section>
          <SectionTitle>Outstanding invites</SectionTitle>
          {live.length === 0 ? (
            <p className="text-ui text-fg-subtle">
              No invites outstanding. Mint one to bring somebody in.
            </p>
          ) : (
            <ul aria-label="Outstanding invites" className="divide-y divide-line-soft">
              {live.map((invite) => (
                <InviteRow
                  key={invite.code}
                  invite={invite}
                  onWithdraw={() => void withdrawInvite(invite.code)}
                />
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Kept in sight, because which code somebody came in on is worth
          being able to look up — but apart, and without the controls, because
          a code that has been used is not one an owner can hand out or take
          back. Listed under "Outstanding" beside a live one, it reads as a
          door still open. */}
      {role === "owner" && spent.length > 0 && (
        <section>
          <SectionTitle>No longer usable</SectionTitle>
          <ul aria-label="No longer usable" className="divide-y divide-line-soft">
            {spent.map((invite) => (
              <InviteRow key={invite.code} invite={invite} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function MemberRow({
  member,
  canRemove,
  onRemove,
}: {
  member: Member;
  canRemove: boolean;
  onRemove: () => void;
}) {
  const offboarded = member.removedTs !== undefined;
  return (
    <li className="flex items-center gap-3 py-3">
      <span
        aria-hidden="true"
        className={cn(
          "grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-2 text-ui text-fg",
          offboarded && "opacity-50",
        )}
      >
        {member.user.displayName.charAt(0).toUpperCase() || "?"}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              "truncate text-ui font-medium",
              offboarded ? "text-fg-subtle" : "text-fg",
            )}
          >
            {member.user.displayName}
          </span>
          {offboarded && (
            <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-meta text-fg-subtle">
              No longer a member
            </span>
          )}
        </span>
        <span className="block truncate text-sub text-fg-subtle">
          {member.user.email}
        </span>
      </span>
      <span className="shrink-0 text-sub capitalize text-fg-muted">
        {member.role}
      </span>
      {canRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${member.user.displayName}`}
          className="shrink-0 rounded-md border border-line-strong px-2.5 py-1 text-sub text-fg hover:bg-surface"
        >
          Remove
        </button>
      )}
    </li>
  );
}

const COPIED_RESET_MS = 1500;

export function InviteRow({
  invite,
  onWithdraw,
}: {
  invite: Invite;
  /** Absent on a code that can no longer be handed out, which is also one
   *  there is nothing left to take back. */
  onWithdraw?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const expired = invite.expiresTs <= Date.now() / 1000;
  const redeemed = invite.redeemedTs !== undefined;
  const live = isLive(invite);

  const [copyFailed, setCopyFailed] = useState(false);
  // The clipboard is not always there — an insecure origin has no
  // `navigator.clipboard` at all, and a denied permission rejects. Either
  // way the owner has to be told, because handing the code over is the
  // whole job of this control and the code is still on screen to select.
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite.code);
    } catch {
      setCopyFailed(true);
      return;
    }
    setCopyFailed(false);
    setCopied(true);
  };

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_RESET_MS);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <li className="flex items-center gap-3 py-3">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <code className="truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-sub text-fg">
            {invite.code}
          </code>
          {redeemed && (
            <span className="shrink-0 text-meta text-fg-subtle">
              Already joined
            </span>
          )}
          {!redeemed && expired && (
            <span className="shrink-0 text-meta text-fg-subtle">
              Expired
            </span>
          )}
          {copyFailed && (
            <span className="shrink-0 text-meta text-danger">
              Could not copy — select it above
            </span>
          )}
        </span>
        <span className="block text-meta text-fg-subtle">
          {invite.role} invite
        </span>
      </span>
      {live && (
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={`Copy ${invite.code}`}
          className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-sub text-fg hover:bg-surface"
        >
          {copied ? (
            <>
              <CheckIcon width={12} height={12} />
              Copied
            </>
          ) : (
            <>
              <CopyIcon width={12} height={12} />
              Copy
            </>
          )}
        </button>
      )}
      {live && onWithdraw && (
        <button
          type="button"
          onClick={onWithdraw}
          aria-label={`Withdraw ${invite.code}`}
          className="shrink-0 rounded-md border border-line-strong px-2.5 py-1 text-sub text-fg hover:bg-surface"
        >
          Withdraw
        </button>
      )}
    </li>
  );
}

export default MembersPanel;
