import { useMemo, useState } from "react";
import type { Study, Task } from "@lykeion/api";
import { useApi, useDataVersion, useInvalidateData } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { useRouter } from "../router";
import { FilterBar } from "../components/filters/FilterBar";
import { StudiesTable } from "../components/studies/StudiesTable";
import { StudyFormModal } from "../components/studies/StudyFormModal";
import { DeleteStudyModal } from "../components/studies/DeleteStudyModal";
import { PrimaryButton } from "../components/ui/PrimaryButton";
import { ScreenHeader } from "../components/ui/ScreenHeader";
import { PlusIcon } from "../components/icons";
import { closeTaskTabsForStudy } from "../lib/task-tabs";
import { closeTabsForStudy } from "../lib/tabs";
import { closeNotebookTabsForStudy } from "../lib/notebook-tabs";
import { createStudyFromInput } from "../lib/study-meta";
import {
  applyStudyFilters,
  EMPTY_FILTERS,
  studyDimensions,
  type FilterState,
} from "../lib/task-filters";

interface StudiesData {
  studies: Study[];
  tasksByStudy: Record<string, Task[]>;
}

/** The Lab's research lines — a filterable Studies table on real data. */
export function StudiesScreen() {
  const api = useApi();
  const { navigate } = useRouter();
  const version = useDataVersion();
  const invalidate = useInvalidateData();
  const [showCreate, setShowCreate] = useState(false);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  // Which row is being renamed in place, and which Study the delete modal is
  // asking about — at most one of each at a time.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Study | null>(null);
  // A failed rename/delete surfaces next to the load error, not silently.
  const [actionError, setActionError] = useState<string | null>(null);

  // Always read the archive. Which shelf you see is the FilterBar's "Archived"
  // dimension, applied below over what is already loaded — that is what lets it
  // count both shelves honestly, and what keeps toggling it off the network.
  const q = usePromise<StudiesData>(async () => {
    const studies = await api.listStudies({ includeArchived: true });
    const details = await Promise.all(studies.map((s) => api.getStudy(s.id)));
    const tasksByStudy: Record<string, Task[]> = {};
    for (const d of details) tasksByStudy[d.study.id] = d.tasks;
    return { studies, tasksByStudy };
  }, [api, version]);

  const studies = q.data?.studies ?? [];
  const tasksByStudy = q.data?.tasksByStudy ?? {};
  const dimensions = useMemo(
    () => studyDimensions(studies, tasksByStudy),
    [studies, tasksByStudy],
  );
  const shown = useMemo(
    () => applyStudyFilters(studies, filters, tasksByStudy),
    [studies, filters, tasksByStudy],
  );

  // Rename is optimistic-free: write, then re-read. A rejected rename (a blank
  // title never reaches here — the input cancels instead) leaves the row as the
  // core still has it.
  const renameStudy = async (studyId: string, title: string) => {
    setRenamingId(null);
    setActionError(null);
    try {
      await api.updateStudy(studyId, { title });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    invalidate();
  };

  // Archive/restore: no confirm — both are reversible and lose nothing, which
  // is exactly what tells them apart from delete.
  const archiveStudy = async (study: Study) => {
    setActionError(null);
    try {
      await api.archiveStudy(study.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    invalidate();
  };

  const restoreStudy = async (study: Study) => {
    setActionError(null);
    try {
      await api.restoreStudy(study.id);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
    invalidate();
  };

  // Delete: the Study leaves the Lab for good, taking everything it held with
  // it. Nothing about it is recoverable from inside the workbench — archive is
  // the reversible operation. Drop any breadcrumb tabs it owned — they'd point
  // at a Study that no longer opens — then re-read the list.
  const deleteStudy = async (studyId: string) => {
    setActionError(null);
    await api.deleteStudy(studyId);
    closeTaskTabsForStudy(studyId);
    closeNotebookTabsForStudy(studyId);
    // And the app strip, which holds the Study itself as well as its Tasks —
    // both are places that no longer open.
    closeTabsForStudy(studyId);
    setPendingDelete(null);
    invalidate();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        title="Studies"
        action={
          <PrimaryButton onClick={() => setShowCreate(true)}>
            <PlusIcon width={14} height={14} />
            New Study
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
          always loaded: a Lab with no Studies at all, and a filter — "Archived"
          on a Lab that has never archived anything — that matches none of the
          ones it has. Saying which is which is the difference between an
          invitation and a dead end. */}
      {!q.loading && studies.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-ui text-fg-subtle">
          No studies yet — create one to start a research line.
        </div>
      ) : !q.loading && shown.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-ui text-fg-subtle">
          No studies match these filters.
        </div>
      ) : (
        <StudiesTable
          studies={shown}
          tasksByStudy={tasksByStudy}
          renamingId={renamingId}
          onStartRename={setRenamingId}
          onRename={renameStudy}
          onCancelRename={() => setRenamingId(null)}
          onDelete={setPendingDelete}
          onArchive={archiveStudy}
          onRestore={restoreStudy}
        />
      )}

      {pendingDelete && (
        <DeleteStudyModal
          study={pendingDelete}
          taskCount={(tasksByStudy[pendingDelete.id] ?? []).length}
          onClose={() => setPendingDelete(null)}
          onConfirm={() => deleteStudy(pendingDelete.id)}
        />
      )}

      {showCreate && (
        <StudyFormModal
          onClose={() => setShowCreate(false)}
          onSubmit={async (input) => {
            const study = await createStudyFromInput(api, input);
            setShowCreate(false);
            invalidate();
            navigate({ name: "study", studyId: study.id });
          }}
        />
      )}
    </div>
  );
}
