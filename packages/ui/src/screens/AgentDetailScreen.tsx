import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { AgentDetail } from "../components/agents/AgentDetail";

/** Expert detail (#/agents/:name) — the persona's properties + instructions/tools. */
export function AgentDetailScreen({ agentId }: { agentId: string }) {
  const api = useApi();
  const q = usePromise(() => api.listAgents(), [api]);
  const agent = (q.data ?? []).find((a) => a.name === agentId);

  if (q.error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-ui text-danger">
        {q.error}
      </div>
    );
  }
  if (!q.loading && !agent) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-ui text-fg-subtle">
        Expert not found
      </div>
    );
  }
  if (!agent) return <div className="flex min-h-0 flex-1" aria-busy="true" />;

  return <AgentDetail agent={agent} />;
}

export default AgentDetailScreen;
