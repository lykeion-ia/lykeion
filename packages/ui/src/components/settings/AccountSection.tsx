import { useId, useState, type ChangeEvent } from "react";
import type { User, WorkspaceSettings } from "@lykeion/api";
import { isLykeionError } from "@lykeion/api";
import { useApi, useInvalidateData } from "../../api/ApiContext";
import { useSignOut } from "../../api/SessionContext";
import { toAvatarDataUrl } from "../../lib/avatar";
import { UserAvatar } from "../UserAvatar";
import { SectionTitle } from "./SettingsSection";
import { Row, OutlineButton, orNotSet, outlineControlClass } from "./SettingsRow";

/** What the picker offers, and what the contract accepts. Stated once and
 *  handed to the input's `accept`, so the file chooser cannot suggest a format
 *  `setAvatar` would then refuse. */
const ACCEPTED = "image/png,image/jpeg,image/gif,image/webp";

/**
 * Settings › Workspace › Profile — who you are in this lab.
 *
 * It leads the Profile tab, above the usage figures: the person comes before
 * what they spent. Lifted out of the General tab, which keeps the settings that
 * are about the lab's models and licensing rather than about the reader.
 */
export function AccountSection({
  user,
  settings,
}: {
  user: User;
  settings: WorkspaceSettings;
}) {
  const api = useApi();
  const invalidate = useInvalidateData();
  const signOut = useSignOut();
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Both writes go through here so the busy flag, the error line and the
  // invalidation cannot come apart between setting a picture and clearing one.
  async function write(next: string | null) {
    setBusy(true);
    setError(null);
    try {
      await api.setAvatar(next);
      // Not just this pane: the account menu and every roster row draw the
      // same face, and the directory behind them re-reads on this signal.
      invalidate();
    } catch (err) {
      setError(
        isLykeionError(err) ? err.message : "that picture could not be saved",
      );
    } finally {
      setBusy(false);
    }
  }

  async function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset first: picking the same file twice in a row fires no `change` at
    // all unless the input has forgotten the first one, which is exactly what
    // someone re-trying after an error does.
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const dataUrl = await toAvatarDataUrl(file);
      await write(dataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "that file could not be read");
      setBusy(false);
    }
  }

  const signedIn = user.email.trim() !== "";

  return (
    <section>
      <SectionTitle>Account</SectionTitle>

      {/* The identity block takes the same border and rhythm as a `Row` but
          not its shape: the face belongs beside the name, and the picture's
          own controls belong under them rather than in the slot holding
          "Sign out". */}
      <div className="flex items-center gap-4 border-b border-line py-4">
        <UserAvatar user={user} size={64} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] text-fg">
            {orNotSet(user.displayName)}
          </div>
          <div className="truncate text-[12.5px] text-fg-subtle">
            {signedIn ? user.email : "Not signed in"}
          </div>
          <div className="mt-2 flex items-center gap-2">
            {/* A label, not a button that clicks a hidden input: the label is
                what makes the input reachable by keyboard and nameable by a
                screen reader. */}
            <label
              htmlFor={inputId}
              className={`${outlineControlClass} ${busy ? "pointer-events-none opacity-50" : ""}`}
            >
              {user.avatarUrl ? "Change picture" : "Upload a picture"}
            </label>
            <input
              id={inputId}
              type="file"
              accept={ACCEPTED}
              disabled={busy}
              onChange={onPick}
              className="sr-only"
            />
            {user.avatarUrl && (
              <OutlineButton disabled={busy} onClick={() => void write(null)}>
                Remove
              </OutlineButton>
            )}
          </div>
          {error && (
            <p role="alert" className="mt-2 text-[12px] text-danger">
              {error}
            </p>
          )}
        </div>
        {signOut && (
          <OutlineButton onClick={signOut}>Sign out</OutlineButton>
        )}
      </div>

      <Row
        label="Organization"
        desc={orNotSet(settings.orgName)}
        control={
          <span className="rounded bg-surface-2 px-2 py-1 font-mono text-[11px] text-fg-subtle">
            {settings.orgId.trim() === ""
              ? "—"
              : `${settings.orgId.slice(0, 18)}…`}
          </span>
        }
      />
    </section>
  );
}

export default AccountSection;
