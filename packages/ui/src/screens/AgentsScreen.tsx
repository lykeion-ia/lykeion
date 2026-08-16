import { useState } from "react";
import type { Agent, Connector, Machine, SkillEntry } from "@lykeion/api";
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
  machines: Machine[];
  skillNames: string[];
  connectorNames: string[];
}

/** Experts (#/agents) — specialist personas the workbench can run a task as. */
export function AgentsScreen() {
  const api = useApi();
  const [nonce, setNonce] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  const q = usePromise<AgentsData>(async () => {
    const [agents, machines, skills, connectors, me] = await Promise.all([
      api.listAgents(),
      api.listMachines(),
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
      machines: machines.filter((r: Machine) => r.ownerId === me.id),
      skillNames: skills.map((s: SkillEntry) => s.name),
      // Only the Lab's ENABLED connectors are offered for assignment.
      connectorNames: connectors
        .filter((c: Connector) => c.enabled)
        .map((c) => c.name),
    };
  }, [api, nonce]);

  const data = q.data ?? {
    agents: [],
    machines: [],
    skillNames: [],
    connectorNames: [],
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        title="Experts"
        action={
          <PrimaryButton onClick={() => setCreateOpen(true)}>
            <PlusIcon width={14} height={14} />
            New expert
          </PrimaryButton>
        }
      />
      {q.error && <p className="px-5 text-ui text-danger">{q.error}</p>}
      <AgentList agents={data.agents} loading={q.loading} />

      {createOpen && (
        <CreateAgentModal
          machines={data.machines}
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
