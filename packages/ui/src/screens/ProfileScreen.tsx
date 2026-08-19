import { useState } from "react";
import type { Research, Usage, User, WorkspaceSettings } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { ChevronDownIcon, FlaskIcon } from "../components/icons";
import { StatCard } from "../components/usage/StatCard";
import { TokensChart } from "../components/usage/TokensChart";
import { Leaderboard } from "../components/usage/Leaderboard";
import {
  SectionTitle,
  SettingsSectionHeader,
} from "../components/settings/SettingsSection";
import { AccountSection } from "../components/settings/AccountSection";
import { toLeaderboardRows } from "../lib/usage";
import { cn } from "../lib/utils";

const CADENCE_OPTIONS = ["Daily", "Weekly"] as const;
const RANGE_OPTIONS = ["1d", "7d", "30d", "90d"] as const;

// The `.seg` control: only the active option is live; the rest are inert
// (this dashboard has a single dataset — the toggle highlights state without
// recomputing data, per the reskin's visual-only convention).
function Seg<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5">
      {options.map((option) => {
        const isActive = option === value;
        return (
          <button
            key={option}
            type="button"
            disabled={!isActive}
            aria-pressed={isActive}
            onClick={() => onChange(option)}
            className={cn(
              "whitespace-nowrap rounded-md px-2.5 py-1 text-sub transition-colors duration-[120ms]",
              isActive ? "bg-surface-3 text-fg" : "text-fg-subtle",
              !isActive && "cursor-not-allowed opacity-40",
            )}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

function formatDuration(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

// Formats a token count already in thousands ("K" units) as millions.
function formatMillions(kUnits: number): string {
  return `${(kUnits / 1000).toFixed(2)}M`;
}

interface UsageData {
  usage: Usage;
  researches: Research[];
}

/**
 * Profile — who the reader is in this lab, then what they have spent: the
 * Account section over the token and agent figures. Rendered as the Settings ›
 * Workspace › Profile tab (and by the `#/usage` alias, which redirects there).
 *
 * `user` and `settings` come from the settings pane rather than being fetched
 * again here — it already reads both for the General tab, and a second read
 * would leave the two tabs able to disagree about the same account.
 *
 * Leads with `SettingsSectionHeader` rather than the section screens'
 * `ScreenHeader`, so its title sits on exactly the same baseline as General /
 * Appearance / Members. The gutter and the scroll come from the settings pane
 * — this panel adds neither; a scroll container of its own would nest inside
 * that one and strand the leaderboard below a second, inner scrollbar.
 *
 * The title carries no action: this tab holds two sections, and a control on
 * the title row belongs to neither of them. The usage filters live on the
 * Usage section's own line instead.
 */
export function ProfileScreen({
  user,
  settings,
}: {
  user: User;
  settings: WorkspaceSettings;
}) {
  const api = useApi();
  const [cadence, setCadence] =
    useState<(typeof CADENCE_OPTIONS)[number]>("Daily");
  const [range, setRange] = useState<(typeof RANGE_OPTIONS)[number]>("30d");

  const q = usePromise<UsageData>(async () => {
    const [usage, researches] = await Promise.all([
      api.usage(),
      api.listResearches(),
    ]);
    return { usage, researches };
  }, [api]);

  const usage = q.data?.usage ?? { series: [], agents: [], users: [] };
  const researches = q.data?.researches ?? [];
  const rows = toLeaderboardRows(usage.agents);

  const inputK = usage.series.reduce((sum, p) => sum + p.input, 0);
  const outputK = usage.series.reduce((sum, p) => sum + p.output, 0);
  const tokensK = inputK + outputK;
  const totalCost = usage.agents.reduce((sum, a) => sum + a.cost, 0);
  const totalMinutes = usage.agents.reduce((sum, a) => sum + a.timeMinutes, 0);
  const totalTasks = usage.agents.reduce((sum, a) => sum + a.tasks, 0);

  return (
    <div>
      <SettingsSectionHeader title="Profile" />
      <AccountSection user={user} settings={settings} />

      {/* The usage figures are their own section under the account, with the
          same `space-y-8` gap the General tab puts between its sections. */}
      <div className="mt-8">
        <SectionTitle>Usage</SectionTitle>
        {/* The research/cadence/range controls lead the section, on the line its
            description used to hold — not in the tab title's action slot. They
            narrow these figures and nothing else; hung off "Profile" they would
            sit level with the account block and read as filtering that.
            No negative top margin here, unlike the 12px description that was
            here before: these are 32px controls, and pulling them up under the
            heading would leave 4px between the two. */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-[7px] rounded-lg border border-line bg-surface px-[11px] text-sub text-fg"
          >
            <FlaskIcon width={14} height={14} className="text-fg-subtle" />
            All researches
            <ChevronDownIcon
              width={14}
              height={14}
              className="text-fg-subtle"
            />
          </button>
          <Seg
            options={CADENCE_OPTIONS}
            value={cadence}
            onChange={setCadence}
          />
          <Seg options={RANGE_OPTIONS} value={range} onChange={setRange} />
        </div>
        {q.error && <p className="mb-4 text-ui text-danger">{q.error}</p>}

        <div className="mb-4 grid grid-cols-4 gap-3.5">
          <StatCard
            label={`Cost · ${range}`}
            value={`$${totalCost.toFixed(2)}`}
            sub={`Across ${researches.length} researches`}
          />
          <StatCard
            label={`Tokens · ${range}`}
            value={formatMillions(tokensK)}
            sub={
              <>
                Input <b>{formatMillions(inputK)}</b> · Output{" "}
                <b>{formatMillions(outputK)}</b>
              </>
            }
          />
          <StatCard
            label={`Run time · ${range}`}
            value={formatDuration(totalMinutes)}
            sub={`Across ${totalTasks} tasks`}
          />
          <StatCard
            label={`Tasks · ${range}`}
            value={String(totalTasks)}
            sub={`Across ${usage.agents.length} experts`}
          />
        </div>

        <div className="mb-4">
          <TokensChart series={usage.series} />
        </div>

        <Leaderboard rows={rows} />
      </div>
    </div>
  );
}

export default ProfileScreen;
