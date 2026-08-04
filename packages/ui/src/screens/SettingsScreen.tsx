import { useRouter } from "../router";
import { SettingsSurface } from "../components/settings/SettingsSurface";
import { ScreenHeader } from "../components/ui/ScreenHeader";

/**
 * Settings (#/settings) — workspace configuration over the real API.
 *
 * The tab lives in the route (`#/settings/skills`), so a section is
 * deep-linkable and the ⌘K palette can jump straight to it. General is the
 * default and stays on the bare `#/settings`, so every route round-trips.
 */
export function SettingsScreen({ tab }: { tab?: string }) {
  const { navigate } = useRouter();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The title row goes THROUGH the surface rather than above it, so it
          lands inside the nav's column: that is what carries the rule between
          the columns up to the panel's top edge and lets the body column start
          level with the title instead of 52px under it. */}
      <SettingsSurface
        header={<ScreenHeader title="Settings" />}
        tab={tab ?? "general"}
        onTabChange={(next) =>
          navigate({
            name: "settings",
            tab: next === "general" ? undefined : next,
          })
        }
      />
    </div>
  );
}

export default SettingsScreen;
