import { useMemo, useState } from "react";
import type { Agent } from "@lykeion/api";
import { SearchIcon } from "../icons";
import { RowLink } from "../RowLink";
import { agentAvatar } from "../../lib/assignee";
import { cn } from "../../lib/utils";

const GRID_COLS = "grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)]";

export interface AgentListProps {
  agents: Agent[];
  loading?: boolean;
}

export function AgentList({ agents, loading = false }: AgentListProps) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        (a.model ?? "").toLowerCase().includes(q),
    );
  }, [query, agents]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pb-3 pt-2">
        {/* Focus lights the field box rather than the input: the global ring
            is drawn a pixel inside its own element, so on the input it reads
            as a second box within this one. Same treatment as the Inbox
            search — the two search fields are the app's only `outline-none`
            opt-outs and must not drift apart. */}
        <div className="flex h-8 w-[220px] items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 transition-colors duration-[120ms] focus-within:border-accent-focus">
          <SearchIcon
            className="shrink-0 text-fg-subtle"
            width={14}
            height={14}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search experts…"
            className="h-full w-full bg-transparent text-ui text-fg placeholder:text-fg-subtle focus:outline-none"
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-ui text-fg-subtle">
          {agents.length === 0
            ? loading
              ? ""
              : "No experts yet — create one to start."
            : "No experts match your search"}
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-5 pb-5">
          <div
            className={cn(
              "grid items-center gap-3 border-b border-line px-3 py-2 text-meta font-medium uppercase tracking-[0.4px] text-fg-tertiary",
              GRID_COLS,
            )}
          >
            <span>Expert</span>
            <span>Model</span>
            <span>Tools</span>
          </div>

          {visible.map((agent) => {
            const avatar = agentAvatar(agent.name);
            return (
              <RowLink
                key={agent.name}
                to={{ name: "agent", agentId: agent.name }}
                className={cn(
                  "grid items-center gap-3 border-b border-line-soft px-3 py-2.5 text-ui hover:bg-surface-2",
                  GRID_COLS,
                )}
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <span
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-meta font-semibold text-white"
                    style={{
                      backgroundImage: `linear-gradient(135deg, ${avatar.gradient[0]}, ${avatar.gradient[1]})`,
                    }}
                  >
                    {avatar.initial}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-fg">
                      {agent.name}
                    </span>
                    <span className="truncate text-sub text-fg-subtle">
                      {agent.description}
                    </span>
                  </span>
                </span>
                <span className="truncate text-fg-muted">
                  {agent.model ?? "Default"}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-1">
                  {agent.tools.length === 0 ? (
                    <span className="text-fg-tertiary">—</span>
                  ) : (
                    agent.tools.map((t) => (
                      <span
                        key={t}
                        className="rounded bg-surface-3 px-1.5 py-0.5 text-meta text-fg-muted"
                      >
                        {t}
                      </span>
                    ))
                  )}
                </span>
              </RowLink>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default AgentList;
