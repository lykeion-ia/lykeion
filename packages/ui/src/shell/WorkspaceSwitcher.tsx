import { useState } from "react";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "../components/icons";
import { back, forward, useHistoryState } from "../lib/tabs";
import { useRouter } from "../router";
import { AccountMenu } from "./AccountMenu";

/**
 * The "Lykeion" workspace switcher — the dropdown that heads both the app Rail
 * and the Task's left-side pane. The two swap in the same slot, so keeping the
 * switcher identical in both makes it stay put across the swap. Opens the
 * AccountMenu, which carries the signed-in identity and the way to Settings.
 *
 * The ‹ › history controls ride on the same row, right-aligned into the space
 * the short workspace name leaves over. They sat in the TabBar before, where
 * they were the only thing left of the pill; here they land where the rest of
 * the navigation already is, and — because this component heads both panes —
 * they stay in one place across the Rail/Task-pane swap.
 *
 * They walk the ACTIVE TAB's stack, not the browser's history. Those were the
 * same thing while the router pushed an entry per navigation; each tab carries
 * its own history now, and the URL is a `replaceState` mirror with no entries
 * of its own. That is also what makes a disabled state possible:
 * `window.history` never says whether there is anywhere to go, so these
 * controls used to be permanently enabled and silently did nothing at the ends
 * of a session — indistinguishable, from the outside, from a click the app had
 * dropped.
 */
export function WorkspaceSwitcher() {
  const { navigate } = useRouter();
  const [open, setOpen] = useState(false);
  const { canGoBack, canGoForward } = useHistoryState();

  const historyBtn =
    "grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface hover:text-fg disabled:pointer-events-none disabled:opacity-40";

  return (
    <div className="relative flex items-center">
      <button
        type="button"
        aria-label="Workspace"
        onClick={() => setOpen((v) => !v)}
        className="mx-0.5 flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface"
      >
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-gradient-to-br from-accent-focus to-iris text-meta font-semibold text-white">
          L
        </span>
        <span className="truncate text-ui font-semibold tracking-[-0.1px] text-fg">
          Lykeion
        </span>
        <ChevronDownIcon
          className="shrink-0 text-fg-subtle"
          width={11}
          height={11}
        />
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-0.5 pl-1">
        <button
          type="button"
          aria-label="Back"
          onClick={back}
          disabled={!canGoBack}
          className={historyBtn}
        >
          <ChevronLeftIcon width={16} height={16} />
        </button>
        <button
          type="button"
          aria-label="Forward"
          onClick={forward}
          disabled={!canGoForward}
          className={historyBtn}
        >
          <ChevronRightIcon width={16} height={16} />
        </button>
      </div>

      <AccountMenu
        open={open}
        onClose={() => setOpen(false)}
        onSettings={() => navigate({ name: "settings" })}
      />
    </div>
  );
}

export default WorkspaceSwitcher;
