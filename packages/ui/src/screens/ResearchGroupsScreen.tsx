import { useState } from "react";
import type { Agent, ResearchGroup } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { PlusIcon } from "../components/icons";
import { PrimaryButton } from "../components/ui/PrimaryButton";
import { ScreenHeader } from "../components/ui/ScreenHeader";
import { ResearchGroupsView } from "../components/research-groups/ResearchGroupsView";
import { CreateResearchGroupModal } from "../components/research-groups/CreateResearchGroupModal";

interface GroupsData {
  groups: ResearchGroup[];
  agents: Agent[];
}

/** Research Groups (#/research-groups) — collaborative units with a lead agent. */
export function ResearchGroupsScreen() {
  const api = useApi();
  const [nonce, setNonce] = useState(0);
  const [open, setOpen] = useState(false);

  const q = usePromise<GroupsData>(async () => {
    const [groups, agents] = await Promise.all([
      api.listResearchGroups(),
      api.listAgents(),
    ]);
    return { groups, agents };
  }, [api, nonce]);

  const data = q.data ?? { groups: [], agents: [] };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        title="Research Groups"
        action={
          <PrimaryButton onClick={() => setOpen(true)}>
            <PlusIcon width={14} height={14} />
            New Research Group
          </PrimaryButton>
        }
      />
      {q.error && <p className="px-5 text-ui text-danger">{q.error}</p>}
      <ResearchGroupsView groups={data.groups} loading={q.loading} />
      {open && (
        <CreateResearchGroupModal
          agents={data.agents}
          onClose={() => setOpen(false)}
          onCreate={async (input) => {
            await api.createResearchGroup(input);
            setNonce((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

export default ResearchGroupsScreen;
