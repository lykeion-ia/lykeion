import { useMemo, useState } from "react";
import type { Study, Task } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { useDirectory } from "../hooks/useDirectory";
import { Board } from "../components/board/Board";
import { TaskList } from "../components/tasks/TaskList";
import { FilterBar } from "../components/filters/FilterBar";
import { NewTaskModal } from "../components/tasks/NewTaskModal";
import { TaskDetailsModal } from "../components/tasks/TaskDetailsModal";
import { TaskImportExport } from "../components/tasks/TaskImportExport";
import { Popover } from "../components/ui/Popover";
import { PrimaryButton } from "../components/ui/PrimaryButton";
import { ScreenHeader } from "../components/ui/ScreenHeader";
import { Calendar } from "../components/filters/CalendarPopover";
import {
  CalendarIcon,
  GridIcon,
  ListIcon,
  PlusIcon,
} from "../components/icons";
import {
  applyTaskFilters,
  EMPTY_FILTERS,
  taskDimensions,
  sortTasks,
  type FilterState,
  type SortKey,
} from "../lib/task-filters";
import { formatTargetDate } from "../lib/task-meta";
import { cn } from "../lib/utils";

interface MyTasksData {
  tasks: Task[];
  studyById: Record<string, Study>;
}

/** Everything assigned to me that isn't Done — a board / list view. */
export function MyTasksScreen() {
  const api = useApi();
  const dir = useDirectory();
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  const [view, setView] = useState<"board" | "list">("board");
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [ioMsg, setIoMsg] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = () => setReloadKey((k) => k + 1);

  const q = usePromise<MyTasksData>(async () => {
    // Archived studies included: archiving tidies the Studies list, it does
    // not finish the work. A row whose study is missing from this map cannot
    // render, so leaving them out would quietly drop assigned tasks that the
    // filter counts still include.
    const [tasks, studies] = await Promise.all([
      api.myWork(),
      api.listStudies({ includeArchived: true }),
    ]);
    const studyById: Record<string, Study> = {};
    for (const s of studies) studyById[s.id] = s;
    return { tasks, studyById };
  }, [api, reloadKey]);

  const tasks = q.data?.tasks ?? [];
  const studyById = q.data?.studyById ?? {};
  const dimensions = useMemo(
    () => taskDimensions(tasks, studyById, dir),
    [tasks, studyById, dir],
  );
  const shown = useMemo(
    () => sortTasks(applyTaskFilters(tasks, filters), sortKey),
    [tasks, filters, sortKey],
  );

  const dueLabel = filters.targetDate
    ? `Due ${formatTargetDate(filters.targetDate)}`
    : "Due date";
  const editingStudy =
    editing?.studyId !== undefined ? studyById[editing.studyId] : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        title="My Tasks"
        action={
          <PrimaryButton onClick={() => setNewTaskOpen(true)}>
            <PlusIcon width={14} height={14} />
            New task
          </PrimaryButton>
        }
      />

      <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pb-3 pt-2">
        <FilterBar
          dimensions={dimensions}
          state={filters}
          onChange={setFilters}
          sortKey={sortKey}
          onSort={setSortKey}
        />
        <span className="flex-1" />

        {/* Target-date (calendar) popover */}
        <Popover
          align="end"
          panelClassName="w-auto"
          trigger={({ toggle, open }) => (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[12.5px] transition-colors",
                filters.targetDate ? "text-fg" : "text-fg-subtle hover:text-fg",
              )}
            >
              <CalendarIcon width={14} height={14} className="text-fg-subtle" />
              {dueLabel}
            </button>
          )}
        >
          {({ close }) => (
            <Calendar
              value={filters.targetDate}
              onSelect={(iso) => {
                setFilters((f) => ({ ...f, targetDate: iso }));
                close();
              }}
            />
          )}
        </Popover>

        <TaskImportExport
          tasks={shown}
          studyById={studyById}
          fileName="my-tasks.json"
          onImported={reload}
          onMessage={setIoMsg}
        />

        {/* View toggle. p-px (not p-0.5) keeps the segmented control at 32px
            — h-7 buttons + 2px padding + 2px border — so it matches the
            toolbar's other h-8 controls instead of standing 2px taller and
            pushing the whole filter row (and the Filter button's centre) down. */}
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface p-px">
          <button
            type="button"
            aria-label="Board view"
            aria-pressed={view === "board"}
            onClick={() => setView("board")}
            className={cn(
              "grid h-7 w-7 place-items-center rounded-md transition-colors duration-[120ms]",
              view === "board"
                ? "bg-surface-3 text-fg"
                : "text-fg-subtle hover:text-fg",
            )}
          >
            <GridIcon width={16} height={16} />
          </button>
          <button
            type="button"
            aria-label="List view"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
            className={cn(
              "grid h-7 w-7 place-items-center rounded-md transition-colors duration-[120ms]",
              view === "list"
                ? "bg-surface-3 text-fg"
                : "text-fg-subtle hover:text-fg",
            )}
          >
            <ListIcon width={16} height={16} />
          </button>
        </div>
      </div>

      {ioMsg && <p className="px-5 pb-1 text-[12px] text-fg-subtle">{ioMsg}</p>}
      {q.error && <p className="px-5 text-[13px] text-danger">{q.error}</p>}

      {!q.loading && tasks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-fg-subtle">
          Nothing assigned to you yet — work you own shows up here.
        </div>
      ) : view === "board" ? (
        <Board
          tasks={shown}
          studyById={studyById}
          onAddTask={() => setNewTaskOpen(true)}
          onEditTask={setEditing}
        />
      ) : (
        <TaskList
          tasks={shown}
          studyById={studyById}
          showStudy
          emptyLabel="No tasks match these filters"
        />
      )}

      {newTaskOpen && (
        <NewTaskModal
          onClose={() => setNewTaskOpen(false)}
          onCreated={reload}
        />
      )}
      {/* Gated on `editing` alone: an unfiled Task has no Study, and also
          requiring one would make its Details silently refuse to open. */}
      {editing && (
        <TaskDetailsModal
          task={editing}
          study={editingStudy}
          studies={Object.values(studyById)}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

export default MyTasksScreen;
