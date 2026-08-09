import { useTheme } from "../../theme/ThemeContext";
import { THEMES, type ThemeMeta } from "../../lib/themes";
import { CheckIcon } from "../icons";
import { SettingsSectionHeader } from "./SettingsSection";

/**
 * Settings › Appearance — the theme gallery. Each card previews a palette in
 * its own colors; picking one applies it live (via `useTheme`), which stores
 * the choice for the rest of the session. Rendered inside the Settings body
 * pane, so it owns no chrome of its own beyond a section title.
 */
export function AppearanceTab() {
  const { theme, setTheme } = useTheme();

  return (
    <section>
      {/* The tab's own title, not a section inside it — this tab is one
          gallery, so its heading is the top of the tab. */}
      <SettingsSectionHeader title="Appearance" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
        {THEMES.map((t) => (
          <ThemeCard
            key={t.id}
            theme={t}
            active={t.id === theme}
            onSelect={() => setTheme(t.id)}
          />
        ))}
      </div>
    </section>
  );
}

function ThemeCard({
  theme,
  active,
  onSelect,
}: {
  theme: ThemeMeta;
  active: boolean;
  onSelect: () => void;
}) {
  const { swatch } = theme;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className="group flex flex-col overflow-hidden rounded-xl border text-left transition-shadow hover:shadow-lg focus-visible:outline-none"
      style={{
        borderColor: active ? swatch.accent : "var(--hairline)",
        boxShadow: active ? `0 0 0 1px ${swatch.accent}` : undefined,
      }}
    >
      {/* Preview painted in the theme's own colors, regardless of the active app theme. */}
      <div className="p-3" style={{ background: swatch.bg }}>
        <div className="rounded-lg p-3" style={{ background: swatch.surface }}>
          <div
            className="h-2 w-2/3 rounded-full"
            style={{ background: swatch.ink, opacity: 0.9 }}
          />
          <div
            className="mt-1.5 h-2 w-1/2 rounded-full"
            style={{ background: swatch.ink, opacity: 0.45 }}
          />
          <div className="mt-3 flex items-center gap-2">
            <span
              className="rounded-md px-2 py-1 text-meta font-medium"
              style={{ background: swatch.accent, color: swatch.onAccent }}
            >
              Primary
            </span>
            <span
              className="h-4 w-4 rounded-full"
              style={{
                background: swatch.accent,
                border: `1px solid ${swatch.ink}20`,
              }}
            />
          </div>
        </div>
      </div>

      {/* Label row in the app's own chrome. */}
      <div className="flex items-center justify-between gap-2 bg-surface px-3 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-ui font-medium text-fg">
            {theme.label}
          </div>
          <div className="truncate text-meta text-fg-subtle">
            {theme.blurb}
          </div>
        </div>
        {active && (
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent text-[color:var(--on-primary)]">
            <CheckIcon width={12} height={12} />
          </span>
        )}
      </div>
    </button>
  );
}

export default AppearanceTab;
