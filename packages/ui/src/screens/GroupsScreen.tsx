import { useState } from "react";
import type { Agent, Group } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { PlusIcon } from "../components/icons";
import { PrimaryButton } from "../components/ui/PrimaryButton";
import { ScreenHeader } from "../components/ui/ScreenHeader";
import { GroupsView } from "../components/groups/GroupsView";
import { CreateGroupModal } from "../components/groups/CreateGroupModal";

interface GroupsData {
  groups: Group[];
  agents: Agent[];
}

/** Groups (#/groups) — collaborative units with a lead agent. */
export function GroupsScreen() {
  const api = useApi();
  const [nonce, setNonce] = useState(0);
  const [open, setOpen] = useState(false);

  const q = usePromise<GroupsData>(async () => {
    const [groups, agents] = await Promise.all([
      api.listGroups(),
      api.listAgents(),
    ]);
    return { groups, agents };
  }, [api, nonce]);

  const data = q.data ?? { groups: [], agents: [] };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        title="Groups"
        action={
          <PrimaryButton onClick={() => setOpen(true)}>
            <PlusIcon width={14} height={14} />
            New Group
          </PrimaryButton>
        }
      />
      {q.error && <p className="px-5 text-ui text-danger">{q.error}</p>}
      <GroupsView groups={data.groups} loading={q.loading} />
      {open && (
        <CreateGroupModal
          agents={data.agents}
          onClose={() => setOpen(false)}
          onCreate={async (input) => {
            await api.createGroup(input);
            setNonce((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}

export default GroupsScreen;
