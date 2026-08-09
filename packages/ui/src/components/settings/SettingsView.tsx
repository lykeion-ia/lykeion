import type { ReactNode } from "react";
import type { Role, User, WorkspaceSettings } from "@lykeion/api";
import { cn } from "../../lib/utils";
import { ChevronDownIcon } from "../icons";
import { SectionTitle, SettingsSectionHeader } from "./SettingsSection";
import { Row, OutlineButton, orNotSet } from "./SettingsRow";
import { AppearanceTab } from "./AppearanceTab";
import { MembersPanel } from "./MembersPanel";
import { SkillsScreen } from "../../screens/SkillsScreen";
import { ConnectorsScreen } from "../../screens/ConnectorsScreen";
import { ProfileScreen } from "../../screens/ProfileScreen";

interface SettingsNavItem {
  key: string;
  label: string;
}

// Left-nav groups (UI chrome, not mock data). "General" is the default tab.
//
// Workspace leads: it holds General, which is where the surface opens, so the
// selected tab is at the top of the nav rather than partway down it.
const SETTINGS_NAV: { group: string; items: SettingsNavItem[] }[] = [
  {
    group: "Workspace",
    // General leads: it is the tab the surface opens on, and a default that
    // sits last reads as an afterthought rather than the way in. Profile
    // follows it — both answer "who am I here and what have I spent", ahead of
    // the tabs that configure the lab itself.
    items: [
      { key: "general", label: "General" },
      { key: "profile", label: "Profile" },
      { key: "appearance", label: "Appearance" },
      { key: "permissions", label: "Permissions" },
      { key: "credentials", label: "Credentials" },
      { key: "storage", label: "Storage" },
      { key: "members", label: "Members" },
    ],
  },
  {
    group: "Capabilities",
    // Skills and Connectors lead: they are the ones researchers actually
    // manage, ahead of the built-in runtime capabilities.
    items: [
      { key: "skills", label: "Skills" },
      { key: "connectors", label: "Connectors" },
      { key: "memory", label: "Memory" },
      { key: "compute", label: "Compute" },
      { key: "network", label: "Network" },
    ],
  },
];

const ALL_ITEMS = SETTINGS_NAV.flatMap((g) => g.items);

export interface SettingsNavProps {
  tab: string;
  onTabChange: (tab: string) => void;
  className?: string;
}

export function SettingsNav({ tab, onTabChange, className }: SettingsNavProps) {
  return (
    <nav className={cn("overflow-y-auto px-2 py-3", className)}>
      {SETTINGS_NAV.map((group) => (
        <div key={group.group} className="mb-4">
          <div className="px-2 pb-1 text-meta text-fg-subtle">
            {group.group}
          </div>
          {group.items.map((item) => (
            <button
              key={item.key}
              onClick={() => onTabChange(item.key)}
              className={cn(
                "flex w-full items-center rounded-md px-2 py-1.5 text-left text-ui transition-colors",
                tab === item.key
                  ? "bg-surface text-fg"
                  : "text-fg-muted hover:bg-surface hover:text-fg",
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

export interface SettingsBodyProps {
  tab: string;
  user: User;
  settings: WorkspaceSettings;
  /** The signed-in caller's own standing in the lab, read off the roster.
   *  Only `MembersPanel` reads it, but it is threaded down here rather than
   *  fetched again inside that one tab. */
  role: Role;
}

export function SettingsBody({ tab, user, settings, role }: SettingsBodyProps) {
  const title = ALL_ITEMS.find((i) => i.key === tab)?.label ?? "Settings";
  if (tab === "general") return <GeneralTab settings={settings} />;
  if (tab === "appearance") return <AppearanceTab />;
  if (tab === "storage") return <StorageTab settings={settings} />;
  // Rendered verbatim — these four own their title row and its CTA. The pane
  // still owns the gutter and the scroll.
  if (tab === "skills") return <SkillsScreen />;
  if (tab === "connectors") return <ConnectorsScreen />;
  if (tab === "members") return <MembersPanel role={role} />;
  if (tab === "profile")
    return <ProfileScreen user={user} settings={settings} />;
  return <PlaceholderTab title={title} />;
}

/* ---------- shared bits ---------- */

function Pill({ children }: { children: ReactNode }) {
  return (
    <button className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-2.5 h-8 text-ui text-fg hover:bg-surface">
      {children}
      <ChevronDownIcon width={14} height={14} className="text-fg-subtle" />
    </button>
  );
}

/* ---------- tabs ---------- */

/**
 * General — the lab's models and licensing.
 *
 * The Account section left for the Profile tab, which is where the reader's own
 * identity now lives: General answers "how does this lab run", Profile answers
 * "who am I here and what have I spent", and an account block in both would be
 * two places to change a face.
 *
 * Titled the way Profile, Skills and Connectors are: the tab names itself at
 * the top, and its sections sit under that. Without it this tab opened straight
 * onto "Model", which reads as the name of the tab rather than of its first
 * section — and General is the tab the surface opens on, so it was the one tab
 * where that was the reader's first impression of the pane.
 */
function GeneralTab({ settings }: { settings: WorkspaceSettings }) {
  return (
    <div>
      <SettingsSectionHeader title="General" />
      {/* The sections themselves keep the same 32px rhythm they have on every
          other tab; the title above them is outside that gap, the way the
          Profile tab's is. */}
      <div className="space-y-8">
        <section>
          <SectionTitle>Model</SectionTitle>
          <Row
            label="Default model"
            desc="Applied as your default for new tasks."
            control={<Pill>{orNotSet(settings.defaultModel)}</Pill>}
          />
          <Row
            label="Reasoning effort"
            desc="How long the Daemon thinks before responding. Higher effort is more thorough but slower and uses more of your limits."
            control={<Pill>{orNotSet(settings.reasoningEffort)}</Pill>}
          />
          <Row
            label="Subagent model"
            desc="Model used by subagents when Delegation is on."
            control={<Pill>{orNotSet(settings.subagentModel)}</Pill>}
          />
          <Row
            label="Reviewer model"
            desc="Model the Reviewer uses for background review when work completes. Applies to all tasks; a task's own Reviewer model setting overrides it."
            control={<Pill>{orNotSet(settings.reviewerModel)}</Pill>}
          />
        </section>

        <section>
          <SectionTitle>Licensing</SectionTitle>
          <Row
            label="Use intent"
            desc="Selects which license notice you see for skills that restrict non-commercial use."
            control={
              <span className="flex items-center gap-2 text-ui text-fg">
                <span className="grid h-4 w-4 place-items-center rounded-full border-2 border-accent">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                </span>
                {orNotSet(settings.useIntent)}
              </span>
            }
          />
        </section>
      </div>
    </div>
  );
}

function StorageTab({ settings }: { settings: WorkspaceSettings }) {
  return (
    <div>
      {/* The last tab that opened straight onto a section heading. With the tab
          title a size up, "Data location" at the top read as this tab's name
          and the two below it as its equals. */}
      <SettingsSectionHeader title="Storage" />
      <div className="space-y-8">
        <section>
          <div className="flex items-start justify-between">
            <div>
              <SectionTitle>Data location</SectionTitle>
              <p className="-mt-2 mb-2 text-sub text-fg-subtle">
                Where your studies and generated files are stored.
              </p>
            </div>
            <OutlineButton>Change location</OutlineButton>
          </div>
          <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
            <div className="font-mono text-ui text-fg">
              {orNotSet(settings.dataLocation)}
            </div>
            <div className="mt-0.5 text-sub text-fg-subtle">
              default location
            </div>
          </div>
        </section>

        <section>
          <SectionTitle>Disk usage</SectionTitle>
          {/* Nothing measures this, so nothing is under way — and a line that
              says otherwise is a wait with no end at the other side of it. */}
          <p className="text-ui text-fg-subtle">
            Not measured. Nothing in this lab reports the space it takes up yet.
          </p>
        </section>

        <section>
          <div className="flex items-start justify-between">
            <div>
              <SectionTitle>Cloud storage</SectionTitle>
              <p className="-mt-2 text-sub text-fg-subtle">
                Browse and manage bucket connections
              </p>
            </div>
            <OutlineButton>Go to Credentials</OutlineButton>
          </div>
          <p className="mt-3 text-ui text-fg-subtle">
            No cloud storage configured. Add credentials with bucket access in
            the Credentials tab to connect cloud storage.
          </p>
        </section>
      </div>
    </div>
  );
}

function PlaceholderTab({ title }: { title: string }) {
  return (
    <div>
      {/* The tab's name, so an unbuilt tab is titled at the same level as a
          built one — a placeholder that titled itself a step lower would read
          as a section of whatever tab the reader came from. */}
      <SettingsSectionHeader title={title} />
      <div className="grid h-[360px] place-items-center rounded-xl border border-dashed border-line text-center">
        <div>
          <p className="text-read text-fg-muted">
            Nothing configured in {title} yet.
          </p>
          <p className="mt-1 text-sub text-fg-subtle">
            This section is part of the workbench UI.
          </p>
        </div>
      </div>
    </div>
  );
}
