import { useEffect } from "react";
import { CheckIcon, SettingsIcon } from "../components/icons";
import { cn } from "../lib/utils";
import { useApi, useDataVersionIfAny } from "../api/ApiContext";
import { useSignOut } from "../api/SessionContext";
import { usePromise } from "../hooks/usePromise";
import { UserAvatar } from "../components/UserAvatar";

export interface AccountMenuProps {
  open: boolean;
  onClose: () => void;
  onSettings?: () => void;
}

export function AccountMenu({ open, onClose, onSettings }: AccountMenuProps) {
  const api = useApi();
  const signOut = useSignOut();
  // Keyed on the app-wide version: a picture set in Settings changes the face
  // here, and this menu is the one place it is seen from every screen.
  const version = useDataVersionIfAny();
  const user = usePromise(() => api.currentUser(), [api, version]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const identity = user.data ?? {
    id: "",
    email: "",
    displayName: "You",
    createdTs: 0,
  };
  const displayName =
    identity.displayName.trim() === "" ? "You" : identity.displayName;

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="menu"
        className="absolute top-full left-0 z-50 mt-2 w-56 rounded-lg border border-line bg-surface p-1 shadow-xl"
      >
        {identity.email.trim() !== "" && (
          <div className="truncate px-2 py-1.5 text-[12px] text-fg-subtle">
            {identity.email}
          </div>
        )}

        <div className="flex items-center gap-2 px-2 py-1.5">
          <UserAvatar user={{ ...identity, displayName }} size={28} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] text-fg">{displayName}</div>
            <div className="truncate text-[11px] text-fg-subtle">Lykeion</div>
          </div>
          <CheckIcon className="shrink-0 text-fg" width={16} height={16} />
        </div>

        <div className="my-1 h-px bg-line" />

        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onSettings?.();
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg",
          )}
        >
          <SettingsIcon className="shrink-0" width={16} height={16} />
          Settings
        </button>
        {signOut && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              signOut();
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            Sign out
          </button>
        )}
      </div>
    </>
  );
}

export default AccountMenu;
