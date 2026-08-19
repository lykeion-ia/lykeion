import { useState, type ReactNode } from "react";
import type { User, WorkspaceSettings } from "@lykeion/api";
import { useApi, useDataVersionIfAny } from "../../api/ApiContext";
import { usePromise } from "../../hooks/usePromise";
import { cn } from "../../lib/utils";
import { DEFAULT_THEME } from "../../lib/themes";
import { SettingsBody, SettingsNav } from "./SettingsView";

interface SettingsData {
  user: User;
  settings: WorkspaceSettings;
}

// A fresh core has none of these set; the tabs render an honest "Not set"
// rather than inventing values.
const EMPTY_SETTINGS: WorkspaceSettings = {
  defaultModel: "",
  reasoningEffort: "",
  subagentModel: "",
  reviewerModel: "",
  useIntent: "",
  dataLocation: "",
  orgName: "",
  orgId: "",
  theme: DEFAULT_THEME,
};

/**
 * The Settings surface itself — the left nav plus the selected tab's body,
 * over the real API. It owns the two columns and nothing above them, so both
 * callers can frame it as they need:
 *
 *  - `SettingsScreen` (the `#/settings` page) drives `tab` from the route, so
 *    a tab is deep-linkable.
 *  - `SettingsModal` (the Task sidebar's Customize) leaves it uncontrolled;
 *    a modal has no URL to keep in sync.
 *
 * Keeping both on this one component is what stops the two surfaces drifting.
 *
 * The caller's title row is passed in as `header` rather than rendered above
 * this surface, because the two columns start at the frame's top edge: the
 * title belongs to the nav's column, and the body column reclaims that height
 * for its own first heading. See `header` for what that buys.
 */
export function SettingsSurface({
  tab: controlledTab,
  onTabChange,
  className,
  header,
}: {
  /** Controlled selection. Omit to let the surface own it (modal case). */
  tab?: string;
  onTabChange?: (tab: string) => void;
  className?: string;
  /**
   * The surface's title row — a `ScreenHeader`, from either caller. It is
   * rendered INSIDE the nav's column, which is what lets the rule between the
   * columns run the frame's full height (it is the column's own border, not a
   * line that starts below a full-width title) and what lets the body's first
   * section heading sit on the title's baseline instead of 52px under it.
   * Pass a `ScreenHeader` and nothing else: the body's top padding is cut to
   * that row's geometry, and any other row breaks the shared baseline.
   */
  header?: ReactNode;
}) {
  const api = useApi();
  // Keyed on the app-wide version so a write from inside a tab — the Profile
  // tab's picture is the one there is — is read back here, which is where the
  // `user` every tab renders from actually comes from.
  const version = useDataVersionIfAny();
  const [localTab, setLocalTab] = useState("general");
  const tab = controlledTab ?? localTab;
  const setTab = (next: string) => {
    setLocalTab(next);
    onTabChange?.(next);
  };

  const q = usePromise<SettingsData>(async () => {
    const [user, settings] = await Promise.all([
      api.currentUser(),
      api.getSettings(),
    ]);
    return { user, settings };
  }, [api, version]);

  const data = q.data ?? {
    user: { id: "", email: "", displayName: "You", createdTs: 0 },
    settings: EMPTY_SETTINGS,
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {q.error && (
        <p className="px-5 pb-1 text-ui text-danger">{q.error}</p>
      )}
      <div className="flex min-h-0 flex-1">
        {/* The nav's column, title row included. Because the title sits inside
            it, this column's right border is the rule between the two panes and
            runs the frame's whole height — no separate line to keep on the
            nav's edge, and nothing above the columns to start it late. */}
        <div className="flex w-[220px] shrink-0 flex-col border-r border-line bg-canvas/40">
          {header}
          <SettingsNav
            tab={tab}
            onTabChange={setTab}
            className="min-h-0 flex-1"
          />
        </div>
        {/* One pane, one scroll container, one gutter — every tab, including
            Skills and Connectors, leads at the same place. `pt-3` is the title
            row's own top inset, so the first section heading lands on the
            title's baseline across the rule. The gutter stays `px-6`: this
            column is read on its own, and matching the title's inset is not
            worth narrowing every tab's measure by 4px. */}
        <div
          data-testid="settings-body"
          className="min-w-0 flex-1 overflow-y-auto px-6 pb-5 pt-3"
        >
          <SettingsBody
            tab={tab}
            user={data.user}
            settings={data.settings}
          />
        </div>
      </div>
    </div>
  );
}

export default SettingsSurface;
