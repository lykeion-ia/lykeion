import { useMemo, useState } from "react";
import type { Research, Task } from "@lykeion/api";
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
  sortTasks,
  taskDimensions,
  type FilterState,
  type SortKey,
} from "../lib/task-filters";
import { formatTargetDate } from "../lib/task-meta";
import { cn } from "../lib/utils";

interface TasksData {
  tasks: Task[];
  studyById: Record<string, Research>;
}

/**
 * Every Task in the Lab — mine and everyone else's, across every Research, plus
 * the unfiled ones that belong to no Research at all. The flat counterpart to
 * Researches, and the only surface an unfiled Task can be reached from.
 */
export function TasksScreen() {
  const api = useApi();
  const dir = useDirectory();
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [sortKey, setSortKey] = useState<SortKey>("updated");
  // Board, like My Tasks: the first question asked of a Lab's work is where it
  // stands, and the stage columns answer it before anything is read. The list
  // is one click away for scanning a long backlog.
  const [view, setView] = useState<"board" | "list">("board");
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [ioMsg, setIoMsg] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = () => setReloadKey((k) => k + 1);

  const q = usePromise<TasksData>(async () => {
    // `includeDone`: this is the Lab's record of its work, not a queue —
    // seeing what someone else finished is half the reason to come here.
    // `includeArchived`: archiving tidies the Researches list, it does not
    // finish the work, and a task whose Research is missing from this map
    // loses the title its row shows.
    const [tasks, researches] = await Promise.all([
      api.listTasks({ includeDone: true }),
      api.listResearches({ includeArchived: true }),
    ]);
    const studyById: Record<string, Research> = {};
    for (const s of researches) studyById[s.id] = s;
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
  const editingResearch =
    editing?.researchId !== undefined ? studyById[editing.researchId] : undefined;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        title="Tasks"
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
                "inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-sub transition-colors",
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
          fileName="tasks.json"
          onImported={reload}
          onMessage={setIoMsg}
        />

        {/* View toggle. p-px (not p-0.5) keeps the segmented control at 32px
            so it matches the toolbar's other h-8 controls. */}
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

      {ioMsg && <p className="px-5 pb-1 text-sub text-fg-subtle">{ioMsg}</p>}
      {q.error && <p className="px-5 text-ui text-danger">{q.error}</p>}

      {!q.loading && tasks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-ui text-fg-subtle">
          No tasks in the lab yet — create one to get started.
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
          showResearch
          emptyLabel="No tasks match these filters"
        />
      )}

      {newTaskOpen && (
        <NewTaskModal onClose={() => setNewTaskOpen(false)} onCreated={reload} />
      )}
      {editing && (
        <TaskDetailsModal
          task={editing}
          research={editingResearch}
          researches={Object.values(studyById)}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

export default TasksScreen;
