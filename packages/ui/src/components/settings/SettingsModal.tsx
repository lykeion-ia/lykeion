import { useEffect } from "react";
import { CloseIcon } from "../icons";
import { ScreenHeader } from "../ui/ScreenHeader";
import { SettingsSurface } from "./SettingsSurface";

/**
 * Settings as a centered modal — opened by the Task sidebar's "Customize"
 * so capabilities can be adjusted without leaving the conversation.
 *
 * Renders the same `SettingsSurface` as the `#/settings` screen, so the two
 * can never drift. The tab is uncontrolled here: a modal has no URL to keep in
 * sync, and it opens on General like the screen does.
 */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
        // A flex column with a bounded height, so each tab's own scroll
        // container (Skills/Connectors) scrolls inside the dialog. `relative`
        // anchors the close button, which is taken out of flow below.
        className="relative flex h-[80vh] w-full max-w-[1040px] flex-col overflow-hidden rounded-xl border border-line bg-canvas shadow-2xl"
      >
        {/* The same `ScreenHeader` the #/settings screen hands over, at `h2`:
            this dialog opens over a Task that already owns the page's `h1`.
            Handing it to the surface rather than rendering it above puts the
            title in the nav's column, which is what runs the rule between the
            columns to the dialog's top edge and starts the body column level
            with the title — the screen and the modal, cut the same way. */}
        <SettingsSurface header={<ScreenHeader title="Settings" level={2} />} />
        {/* Out of flow, and so NOT in the surface's header: a dialog's close
            control belongs at the dialog's own top-right, not at the inner
            edge of a 220px column. `top-3` centres it on the 52px title row. */}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-4 top-3 grid h-7 w-7 place-items-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
        >
          <CloseIcon width={15} height={15} />
        </button>
      </div>
    </div>
  );
}

export default SettingsModal;
