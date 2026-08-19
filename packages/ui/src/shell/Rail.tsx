import { useState } from "react";
import { ComposeIcon, SearchIcon } from "../components/icons";
import { RowLink } from "../components/RowLink";
import { NewTaskModal } from "../components/tasks/NewTaskModal";
import { configureItems, topItems, laboratoryItems, type NavEntry } from "./nav";
import { useApi, useDataVersion } from "../api/ApiContext";
import { hasWorkspaceServer } from "../api/select";
import { usePromise } from "../hooks/usePromise";
import { railRow, RailGroupLabel } from "./rail-chrome";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { useRoute, type Route } from "../router";

function NavLink({
  route,
  label,
  icon: Icon,
  active,
  unread,
}: NavEntry & { active: boolean; unread?: number }) {
  return (
    <RowLink
      to={route}
      // Each section keeps a tab of its own: clicking Inbox goes to the Inbox
      // tab if it is open, and opens one if it is not, rather than spending the
      // tab you are reading.
      ownTab
      ariaCurrent={active ? "page" : undefined}
      className={railRow(active)}
    >
      <Icon className="shrink-0 opacity-90" />
      <span className="truncate">{label}</span>
      {route.name === "inbox" && unread !== undefined && unread > 0 && (
        // Visually a bare numeral — that's the right shape for a nav badge —
        // but named for what it counts, so a screen reader doesn't hand out
        // an unlabelled number that could as easily be the Inbox's total.
        <span
          aria-label={`${unread} unread conversations`}
          className="ml-auto shrink-0 rounded-full bg-accent/20 px-1.5 text-micro font-semibold text-accent"
        >
          {unread}
        </span>
      )}
    </RowLink>
  );
}

export function Rail({ onOpenPalette }: { onOpenPalette: () => void }) {
  const route = useRoute();
  const api = useApi();
  // Keyed on the app-wide version so reading a thread, or starting one, drops
  // the badge here without a reload — the Inbox invalidates on both.
  const version = useDataVersion();
  const conversations = usePromise(() => api.listConversations(), [api, version]);
  // THREADS waiting, not messages waiting. "3" beside Inbox means three
  // conversations have something in them for you, which is what a chat badge
  // means everywhere else; summing the messages would make one busy thread
  // read as a backlog.
  const unread = (conversations.data ?? []).filter((c) => c.unread > 0).length;
  const [newTaskOpen, setNewTaskOpen] = useState(false);

  // A section's detail screens keep that section's nav item lit: the detail is
  // somewhere inside the section, and an unlit Rail says the reader has left it.
  const isActive = (r: Route) =>
    r.name === route.name ||
    // Everything under a Study — its composer and any of its Tasks — keeps the
    // Studies nav item lit.
    (r.name === "studies" &&
      (route.name === "study" || route.name === "task")) ||
    (r.name === "agents" && route.name === "agent");

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col bg-sidebar px-2 pb-2 pt-2.5">
      {/* Workspace switcher — the anchor the Rail and the Task pane swap
          around, so it is the one shared component, not a look-alike copy. */}
      <WorkspaceSwitcher />

      {/* Search */}
      <button
        type="button"
        onClick={onOpenPalette}
        className={railRow(false, "mb-1 mt-2.5")}
      >
        <SearchIcon className="shrink-0" width={16} height={16} />
        <span className="truncate">Search…</span>
        <span className="ml-auto shrink-0 rounded border border-line px-[5px] py-px font-mono text-micro text-fg-tertiary">
          ⌘K
        </span>
      </button>

      {/* New Task */}
      <button
        type="button"
        onClick={() => setNewTaskOpen(true)}
        className={railRow()}
      >
        <ComposeIcon className="shrink-0 opacity-90" width={16} height={16} />
        <span className="truncate">New Task</span>
        <span className="ml-auto shrink-0 rounded border border-line px-[5px] py-px font-mono text-micro text-fg-tertiary">
          C
        </span>
      </button>

      {topItems.map((item) => (
        <NavLink
          key={item.label}
          {...item}
          active={isActive(item.route)}
          unread={unread}
        />
      ))}

      <RailGroupLabel>Laboratory</RailGroupLabel>
      {laboratoryItems.map((item) => (
        <NavLink key={item.label} {...item} active={isActive(item.route)} />
      ))}

      <RailGroupLabel>Configure</RailGroupLabel>
      {configureItems.map((item) => (
        <NavLink key={item.label} {...item} active={isActive(item.route)} />
      ))}

      <div className="flex-1" />

      {!hasWorkspaceServer() && (
        <div
          className="mx-0.5 mb-1 rounded-md bg-surface-2 px-2.5 py-1 text-micro font-medium uppercase tracking-[0.5px] text-fg-tertiary"
          title="Seeded data that lives for this session. Nothing here is saved."
        >
          Demo
        </div>
      )}

      <button
        type="button"
        aria-label="Help"
        className="mr-0.5 self-end px-2.5 py-2 text-read text-fg-tertiary hover:text-fg-subtle"
      >
        ?
      </button>
      {newTaskOpen && <NewTaskModal onClose={() => setNewTaskOpen(false)} />}
    </aside>
  );
}

export default Rail;
