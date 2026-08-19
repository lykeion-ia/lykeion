import { useEffect, useState } from "react";
import type { Invite } from "@lykeion/api";
import { cn } from "../../lib/utils";
import { CheckIcon, CloseIcon, CopyIcon } from "../icons";
import { SectionTitle } from "../settings/SettingsSection";
import { primaryActionClass } from "../ui/PrimaryButton";

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

export interface InviteModalProps {
  invites: Invite[];
  /**
   * What the last mint or withdraw failed with, shown inside the dialog. It
   * has to live here rather than on the screen behind: this dialog covers the
   * viewport, so a message rendered by the screen would be reported where
   * nobody triggering these controls can see it.
   */
  error?: string | null;
  onMint: () => Promise<void>;
  onWithdraw: (code: string) => Promise<void>;
  onClose: () => void;
}

/**
 * Invite a colleague — mint a code, hand it over, take it back. Owner-only:
 * the screen only mounts this behind that check, and the server refuses the
 * calls behind it regardless.
 */
export function InviteModal({
  invites,
  error,
  onMint,
  onWithdraw,
  onClose,
}: InviteModalProps) {
  const [minting, setMinting] = useState(false);
  const live = invites.filter(isLive);
  const spent = invites.filter((invite) => !isLive(invite));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const mint = async () => {
    setMinting(true);
    try {
      await onMint();
    } finally {
      setMinting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Invite a colleague"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 className="text-read font-semibold text-fg">
            Invite a colleague
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
          >
            <CloseIcon width={15} height={15} />
          </button>
        </div>
        <p className="px-5 text-ui text-fg-subtle">
          A code admits one person and lapses after seven days.
        </p>

        <div className="space-y-5 px-5 py-4">
          <button
            type="button"
            onClick={() => void mint()}
            disabled={minting}
            className={cn(
              primaryActionClass,
              minting && "cursor-not-allowed opacity-60",
            )}
          >
            {minting ? "Minting…" : "Mint a code"}
          </button>

          {error && <p className="text-sub text-danger">{error}</p>}

          <section>
            <SectionTitle>Outstanding</SectionTitle>
            {live.length === 0 ? (
              <p className="text-ui text-fg-subtle">
                No invites outstanding. Mint one to bring somebody in.
              </p>
            ) : (
              <ul
                aria-label="Outstanding invites"
                className="divide-y divide-line-soft"
              >
                {live.map((invite) => (
                  <InviteRow
                    key={invite.code}
                    invite={invite}
                    onWithdraw={() => void onWithdraw(invite.code)}
                  />
                ))}
              </ul>
            )}
          </section>

          {/* Kept in sight, because which code somebody came in on is worth
              being able to look up — but apart, and without the controls,
              because a code that has been used is not one an owner can hand
              out or take back. Listed under "Outstanding" beside a live one,
              it reads as a door still open. */}
          {spent.length > 0 && (
            <section>
              <SectionTitle>No longer usable</SectionTitle>
              <ul
                aria-label="No longer usable"
                className="divide-y divide-line-soft"
              >
                {spent.map((invite) => (
                  <InviteRow key={invite.code} invite={invite} />
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
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
            <span className="shrink-0 text-meta text-fg-subtle">Expired</span>
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

export default InviteModal;
