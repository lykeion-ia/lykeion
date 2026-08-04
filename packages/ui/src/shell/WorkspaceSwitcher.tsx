import { useState } from "react";
import { ChevronDownIcon } from "../components/icons";
import { useRouter } from "../router";
import { AccountMenu } from "./AccountMenu";

/**
 * The "Lykeion" workspace switcher — the dropdown that heads both the app Rail
 * and the Task's left-side pane. The two swap in the same slot, so keeping the
 * switcher identical in both makes it stay put across the swap. Opens the
 * AccountMenu, which carries the signed-in identity and the way to Settings.
 */
export function WorkspaceSwitcher() {
  const { navigate } = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label="Workspace"
        onClick={() => setOpen((v) => !v)}
        className="mx-0.5 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface"
      >
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-gradient-to-br from-accent-focus to-iris text-[11px] font-semibold text-white">
          L
        </span>
        <span className="truncate text-[13px] font-semibold tracking-[-0.1px] text-fg">
          Lykeion
        </span>
        <ChevronDownIcon
          className="ml-auto shrink-0 text-fg-subtle"
          width={11}
          height={11}
        />
      </button>
      <AccountMenu
        open={open}
        onClose={() => setOpen(false)}
        onSettings={() => navigate({ name: "settings" })}
      />
    </div>
  );
}

export default WorkspaceSwitcher;
