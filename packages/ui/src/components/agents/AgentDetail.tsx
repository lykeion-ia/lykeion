import { type ReactNode, type SVGProps, useState } from "react";
import type { Agent } from "@lykeion/api";
import {
  ChevronDownIcon,
  ClockIcon,
  FileIcon,
  LinkIcon,
  SparkleIcon,
} from "../icons";
import { agentAvatar } from "../../lib/assignee";
import { cn } from "../../lib/utils";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-3 flex items-center gap-1.5 text-sub font-semibold text-fg-muted">
        <ChevronDownIcon width={10} height={10} className="text-fg-tertiary" />
        {title}
      </div>
      {children}
    </div>
  );
}

function PropRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center text-sub">
      <span className="w-24 shrink-0 text-fg-subtle">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-fg-muted">
        {children}
      </span>
    </div>
  );
}

function AgentProperties({ agent }: { agent: Agent }) {
  const avatar = agentAvatar(agent.name);
  return (
    <aside className="w-[312px] min-w-[312px] shrink-0 overflow-y-auto border-r border-line px-[18px] pb-6 pt-4">
      <div
        className="grid h-10 w-10 place-items-center rounded-xl text-read font-semibold text-white"
        style={{
          backgroundImage: `linear-gradient(135deg, ${avatar.gradient[0]}, ${avatar.gradient[1]})`,
        }}
      >
        {avatar.initial}
      </div>
      <div className="mb-1 mt-3 text-read font-semibold leading-snug tracking-[-0.25px] text-fg">
        {agent.name}
      </div>
      <p className="mb-4 text-sub leading-relaxed text-fg-muted">
        {agent.description}
      </p>

      <Section title="Properties">
        <PropRow label="Model">{agent.model ?? "Default"}</PropRow>
        <PropRow label="Tools">{agent.tools.length}</PropRow>
        <PropRow label="Connectors">{agent.connectors.length}</PropRow>
      </Section>
    </aside>
  );
}

type TabKey = "instructions" | "tools" | "connectors" | "activity";

const TABS: { key: TabKey; label: string }[] = [
  { key: "instructions", label: "Instructions" },
  { key: "tools", label: "Tools" },
  { key: "connectors", label: "Connectors" },
  { key: "activity", label: "Activity" },
];

function EmptyPanel({
  icon: Icon,
  title,
  description,
}: {
  icon: (p: SVGProps<SVGSVGElement>) => ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center">
      <div className="grid h-9 w-9 place-items-center rounded-lg border border-line bg-surface-2 text-fg-subtle">
        <Icon width={16} height={16} />
      </div>
      <div className="text-ui font-medium text-fg">{title}</div>
      <p className="max-w-[280px] text-sub leading-relaxed text-fg-subtle">
        {description}
      </p>
    </div>
  );
}

export interface AgentDetailProps {
  agent: Agent;
}

export function AgentDetail({ agent }: AgentDetailProps) {
  const [tab, setTab] = useState<TabKey>("instructions");

  return (
    <div className="flex min-h-0 flex-1">
      <AgentProperties agent={agent} />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-line px-5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-pressed={tab === t.key}
              className={cn(
                "border-b-2 px-2.5 py-2.5 text-sub transition-colors duration-[120ms]",
                tab === t.key
                  ? "border-accent text-fg"
                  : "border-transparent text-fg-subtle hover:text-fg",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
          {tab === "instructions" &&
            (agent.systemPrompt.trim() ? (
              <pre className="whitespace-pre-wrap font-mono text-sub leading-relaxed text-fg-muted">
                {agent.systemPrompt}
              </pre>
            ) : (
              <EmptyPanel
                icon={FileIcon}
                title="No instructions"
                description={`${agent.name} follows the workspace default system prompt.`}
              />
            ))}
          {tab === "tools" &&
            (agent.tools.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {agent.tools.map((t) => (
                  <span
                    key={t}
                    className="rounded-md border border-line bg-surface-2 px-2 py-1 text-sub text-fg-muted"
                  >
                    {t}
                  </span>
                ))}
              </div>
            ) : (
              <EmptyPanel
                icon={SparkleIcon}
                title="No tools"
                description="This expert has no tool allowlist — it uses the workspace default."
              />
            ))}
          {tab === "connectors" &&
            (agent.connectors.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {agent.connectors.map((c) => (
                  <span
                    key={c}
                    className="rounded-md border border-line bg-surface-2 px-2 py-1 text-sub text-fg-muted"
                  >
                    {c}
                  </span>
                ))}
              </div>
            ) : (
              <EmptyPanel
                icon={LinkIcon}
                title="No connectors assigned"
                description={`${agent.name} inherits every connector enabled in the Lab.`}
              />
            ))}
          {tab === "activity" && (
            <EmptyPanel
              icon={ClockIcon}
              title="No recent activity"
              description={`Tasks ${agent.name} runs will show up here.`}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default AgentDetail;
