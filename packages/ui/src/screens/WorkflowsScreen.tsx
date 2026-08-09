import { useState } from "react";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { WorkflowList } from "../components/workflows/WorkflowList";
import { CreateWorkflowModal } from "../components/workflows/CreateWorkflowModal";
import { PrimaryButton } from "../components/ui/PrimaryButton";
import { ScreenHeader } from "../components/ui/ScreenHeader";
import { PlusIcon } from "../components/icons";

/** Workflows (#/workflows) — the research procedures the lab runs, by field. */
export function WorkflowsScreen() {
  const api = useApi();
  const [nonce, setNonce] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  const q = usePromise(() => api.listWorkflows(), [api, nonce]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        title="Workflows"
        action={
          <PrimaryButton onClick={() => setCreateOpen(true)}>
            <PlusIcon width={14} height={14} />
            New workflow
          </PrimaryButton>
        }
      />
      {q.error && <p className="px-5 text-ui text-danger">{q.error}</p>}
      <WorkflowList workflows={q.data ?? []} loading={q.loading} />

      {createOpen && (
        <CreateWorkflowModal
          onCreate={async (workflow) => {
            await api.upsertWorkflow(workflow);
            setCreateOpen(false);
            setNonce((n) => n + 1);
          }}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </div>
  );
}

export default WorkflowsScreen;
