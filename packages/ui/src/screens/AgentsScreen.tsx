import { useState } from "react";
import type { Agent, Connector, Runtime, SkillEntry } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { AgentList } from "../components/agents/AgentList";
import { CreateAgentModal } from "../components/agents/CreateAgentModal";
import { PrimaryButton } from "../components/ui/PrimaryButton";
import { ScreenHeader } from "../components/ui/ScreenHeader";
import { PlusIcon } from "../components/icons";

interface AgentsData {
  agents: Agent[];
  /** The caller's own machines, already narrowed — see the read below. */
  runtimes: Runtime[];
  skillNames: string[];
  connectorNames: string[];
}

/** Agents (#/agents) — specialist personas the workbench can run a task as. */
export function AgentsScreen() {
  const api = useApi();
  const [nonce, setNonce] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  const q = usePromise<AgentsData>(async () => {
    const [agents, runtimes, skills, connectors, me] = await Promise.all([
      api.listAgents(),
      api.listRuntimes(),
      api.listSkills(),
      api.listConnectors(),
      api.currentUser(),
    ]);
    return {
      agents,
      // A machine only ever runs for the member who paired it, so the lab's
      // roster is not the set of machines this caller could pick from. Read
      // alongside the rest rather than on its own: everything here settles
      // together, which leaves no moment where the picker is offering the
      // lab's machines because the identity has not landed.
      runtimes: runtimes.filter((r: Runtime) => r.ownerId === me.id),
      skillNames: skills.map((s: SkillEntry) => s.name),
      // Only the Lab's ENABLED connectors are offered for assignment.
      connectorNames: connectors
        .filter((c: Connector) => c.enabled)
        .map((c) => c.name),
    };
  }, [api, nonce]);

  const data = q.data ?? {
    agents: [],
    runtimes: [],
    skillNames: [],
    connectorNames: [],
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        title="Agents"
        action={
          <PrimaryButton onClick={() => setCreateOpen(true)}>
            <PlusIcon width={14} height={14} />
            New agent
          </PrimaryButton>
        }
      />
      {q.error && <p className="px-5 text-[13px] text-danger">{q.error}</p>}
      <AgentList agents={data.agents} loading={q.loading} />

      {createOpen && (
        <CreateAgentModal
          runtimes={data.runtimes}
          skillNames={data.skillNames}
          connectorNames={data.connectorNames}
          onCreate={async (agent) => {
            await api.upsertAgent(agent);
            setNonce((n) => n + 1);
          }}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}

export default AgentsScreen;
