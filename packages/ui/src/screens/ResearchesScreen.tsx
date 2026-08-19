import { useMemo, useState } from "react";
import type { Research, Task } from "@lykeion/api";
import { useApi, useDataVersion, useInvalidateData } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { useRouter } from "../router";
import { FilterBar } from "../components/filters/FilterBar";
import { ResearchesTable } from "../components/researches/ResearchesTable";
import { ResearchFormModal } from "../components/researches/ResearchFormModal";
import { DeleteResearchModal } from "../components/researches/DeleteResearchModal";
import { PrimaryButton } from "../components/ui/PrimaryButton";
import { ScreenHeader } from "../components/ui/ScreenHeader";
import { PlusIcon } from "../components/icons";
import { closeTaskTabsForResearch } from "../lib/task-tabs";
import { closeTabsForResearch } from "../lib/tabs";
import { closeNotebookTabsForResearch } from "../lib/notebook-tabs";
import { createResearchFromInput } from "../lib/research-meta";
import {
  applyResearchFilters,
  EMPTY_FILTERS,
  studyDimensions,
  type FilterState,
} from "../lib/task-filters";

interface ResearchesData {
  researches: Research[];
  tasksByResearch: Record<string, Task[]>;
}

/** The Lab's research lines — a filterable Researches table on real data. */
export function ResearchesScreen() {
  const api = useApi();
  const { navigate } = useRouter();
  const version = useDataVersion();
  const invalidate = useInvalidateData();
  const [showCreate, setShowCreate] = useState(false);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  // Which row is being renamed in place, and which Research the delete modal is
  // asking about — at most one of each at a time.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Research | null>(null);
  // A failed rename/delete surfaces next to the load error, not silently.
  const [actionError, setActionError] = useState<string | null>(null);

  // Always read the archive. Which shelf you see is the FilterBar's "Archived"
  // dimension, applied below over what is already loaded — that is what lets it
  // count both shelves honestly, and what keeps toggling it off the network.
  const q = usePromise<ResearchesData>(async () => {
    const researches = await api.listResearches({ includeArchived: true });
    const details = await Promise.all(researches.map((s) => api.getResearch(s.id)));
    const tasksByResearch: Record<string, Task[]> = {};
    for (const d of details) tasksByResearch[d.research.id] = d.tasks;
    return { researches, tasksByResearch };
  }, [api, version]);

  const researches = q.data?.researches ?? [];
  const tasksByResearch = q.data?.tasksByResearch ?? {};
  const dimensions = useMemo(
    () => studyDimensions(researches, tasksByResearch),
    [researches, tasksByResearch],
  );
  const shown = useMemo(
    () => applyResearchFilters(researches, filters, tasksByResearch),
    [researches, filters, tasksByResearch],
  );

  // Rename is optimistic-free: write, then re-read. A rejected rename (a blank
  // title never reaches here — the input cancels instead) leaves the row as the
  // core still has it.
  const renameResearch = async (researchId: string, title: string) => {
    setRenamingId(null);
    setActionError(null);
    try {
      await api.updateResearch(researchId, { title });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    invalidate();
  };

  // Archive/restore: no confirm — both are reversible and lose nothing, which
  // is exactly what tells them apart from delete.
  const archiveResearch = async (research: Research) => {
    setActionError(null);
    try {
      await api.archiveResearch(research.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    invalidate();
  };

  const restoreResearch = async (research: Research) => {
    setActionError(null);
    try {
      await api.restoreResearch(research.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    invalidate();
  };

  // Delete: the Research leaves the Lab for good, taking everything it held with
  // it. Nothing about it is recoverable from inside the workbench — archive is
  // the reversible operation. Drop any breadcrumb tabs it owned — they'd point
  // at a Research that no longer opens — then re-read the list.
  const deleteResearch = async (researchId: string) => {
    setActionError(null);
    await api.deleteResearch(researchId);
    closeTaskTabsForResearch(researchId);
    closeNotebookTabsForResearch(researchId);
    // And the app strip, which holds the Research itself as well as its Tasks —
    // both are places that no longer open.
    closeTabsForResearch(researchId);
    setPendingDelete(null);
    invalidate();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        title="Researches"
        action={
          <PrimaryButton onClick={() => setShowCreate(true)}>
            <PlusIcon width={14} height={14} />
            New Research
          </PrimaryButton>
        }
      />

      <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pb-3 pt-2">
        <FilterBar
          dimensions={dimensions}
          state={filters}
          onChange={setFilters}
        />
      </div>

      {(q.error || actionError) && (
        <p className="px-5 text-ui text-danger">{q.error ?? actionError}</p>
      )}
      {/* An empty table has two quite different causes now that the archive is
          always loaded: a Lab with no Researches at all, and a filter — "Archived"
          on a Lab that has never archived anything — that matches none of the
          ones it has. Saying which is which is the difference between an
          invitation and a dead end. */}
      {!q.loading && researches.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-ui text-fg-subtle">
          No researches yet — create one to start a research line.
        </div>
      ) : !q.loading && shown.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-ui text-fg-subtle">
          No researches match these filters.
        </div>
      ) : (
        <ResearchesTable
          researches={shown}
          tasksByResearch={tasksByResearch}
          renamingId={renamingId}
          onStartRename={setRenamingId}
          onRename={renameResearch}
          onCancelRename={() => setRenamingId(null)}
          onDelete={setPendingDelete}
          onArchive={archiveResearch}
          onRestore={restoreResearch}
        />
      )}

      {pendingDelete && (
        <DeleteResearchModal
          research={pendingDelete}
          taskCount={(tasksByResearch[pendingDelete.id] ?? []).length}
          onClose={() => setPendingDelete(null)}
          onConfirm={() => deleteResearch(pendingDelete.id)}
        />
      )}

      {showCreate && (
        <ResearchFormModal
          onClose={() => setShowCreate(false)}
          onSubmit={async (input) => {
            const research = await createResearchFromInput(api, input);
            setShowCreate(false);
            invalidate();
            navigate({ name: "research", researchId: research.id });
          }}
        />
      )}
    </div>
  );
}
