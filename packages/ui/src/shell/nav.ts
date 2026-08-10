import type { ComponentType, SVGProps } from "react";
import type { Route } from "../router";
import {
  FlaskIcon,
  InboxIcon,
  ListIcon,
  MonitorIcon,
  SettingsIcon,
  SparkleIcon,
  UserIcon,
  UsersIcon,
  WorkflowIcon,
} from "../components/icons";

type IconType = ComponentType<SVGProps<SVGSVGElement>>;

export interface NavEntry {
  label: string;
  icon: IconType;
  route: Route;
}

export const topItems: NavEntry[] = [
  { label: "Inbox", icon: InboxIcon, route: { name: "inbox" } },
  // A profile glyph, not a target: this section is the one cut of the Lab
  // defined by who you are rather than by what kind of thing it holds, and
  // "Tasks" below already owns the flat list of work.
  { label: "My Tasks", icon: UserIcon, route: { name: "my-tasks" } },
];

// Skills and Connectors are deliberately absent: they are configuration, not
// lab content, and live under Settings › Capabilities.
export const laboratoryItems: NavEntry[] = [
  // Above Studies: the Lab's work seen flat, before it is seen by research
  // line. It is also where unfiled Tasks live — they have no Study to be
  // reached through, so this is the only surface that holds them.
  { label: "Tasks", icon: ListIcon, route: { name: "tasks" } },
  { label: "Studies", icon: FlaskIcon, route: { name: "studies" } },
  {
    label: "Research Groups",
    icon: UsersIcon,
    route: { name: "research-groups" },
  },
  { label: "Agents", icon: SparkleIcon, route: { name: "agents" } },
  { label: "Workflows", icon: WorkflowIcon, route: { name: "workflows" } },
];

// Usage left the Rail with Skills and Connectors, for the same reason: it
// reports on the lab rather than being somewhere you work. It is the Settings ›
// Workspace › Profile tab now.
export const configureItems: NavEntry[] = [
  // "Machines", not "Runtimes": the screen behind this is a roster of
  // computers a researcher paired, and a runtime is what runs ON one. The
  // route keeps its name — it is a URL people have bookmarked, and renaming
  // the label is the whole of what this changes.
  { label: "Machines", icon: MonitorIcon, route: { name: "runtimes" } },
  { label: "Settings", icon: SettingsIcon, route: { name: "settings" } },
];

export const NAV_ALL: NavEntry[] = [
  ...topItems,
  ...laboratoryItems,
  ...configureItems,
];
