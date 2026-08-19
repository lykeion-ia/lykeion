import { useState } from "react";
import type { Research, Task, TaskStatus } from "@lykeion/api";
import { useApi, useInvalidateData } from "../../api/ApiContext";
import { ResearchFormModal } from "../researches/ResearchFormModal";
import { InlineRename } from "../ui/InlineRename";
import { TaskRowMenu } from "./TaskRowMenu";
import { SettingsModal } from "../settings/SettingsModal";
import { railRow, RailGlyph, RailGroupLabel } from "../../shell/rail-chrome";
import { WorkspaceSwitcher } from "../../shell/WorkspaceSwitcher";

/**
 * The Task's left-side pane — a project header (the Research), a New ·
 * Customize · Files menu, the Research's Task list, and a settings/avatar
 * footer. Same width as the app nav Rail (w-56 / 224px), which it swaps with
 * via the rail FABs (the collapse button here triggers the same swap).
 *
 * One list, because there is one thing to list: every Task in the Research is a
 * chat, so navigating the Research's conversations and navigating its work are
 * the same act.
 *
 * Keeps `data-testid="context-rail"` so the FABs and tests keep addressing it.
 */
export function TaskSidebar({
  research,
  filesActive,
  onNew,
  onOpenFiles,
  tasks,
  activeTaskId,
  onOpenTask,
  onDeleteTask,
  onRenameTask,
  onPinTask,
  onMoveTask,
  onSetTaskStatus,
  researches,
}: {
  research: Research;
  filesActive: boolean;
  onNew: () => void;
  onOpenFiles: () => void;
  /** The Research's Tasks, in the order they should read. */
  tasks: Task[];
  /** The Task on screen, drawn as the active row. */
  activeTaskId?: string;
  onOpenTask?: (taskId: string) => void;
  /** Delete a Task. Omit to hide the per-row actions menu. */
  onDeleteTask?: (taskId: string) => void;
  /** Rename a Task. Omit to drop Rename from the actions menu. */
  onRenameTask?: (taskId: string, title: string) => void;
  /** Pin/unpin a Task. Omit to drop Pin from the actions menu. */
  onPinTask?: (taskId: string, pinned: boolean) => void;
  /** File a Task under another Research. Omit to drop Move from the menu. */
  onMoveTask?: (taskId: string, researchId: string) => void;
  /** Move a Task along its lifecycle. Omit to drop Status from the actions
   *  menu. */
  onSetTaskStatus?: (taskId: string, status: TaskStatus) => void;
  /** Every Research, as move destinations. This one is dropped from the list. */
  researches?: Research[];
}) {
  const api = useApi();
  const invalidate = useInvalidateData();
  // Which row is being renamed in place — at most one at a time.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // Customize opens Settings over the conversation rather than navigating away.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The project header names the Research it belongs to, so it opens that Research to
  // be corrected — the same form, on the same record, as the Research page's own
  // Edit action.
  const [editOpen, setEditOpen] = useState(false);
  const pinned = tasks.filter((t) => t.pinned);
  const recent = tasks.filter((t) => !t.pinned);

  const renderRow = (t: Task) => (
    <div
      key={t.id}
      className={`tsb-task${t.id === activeTaskId ? " is-active" : ""}`}
    >
      {renamingId === t.id && onRenameTask ? (
        <InlineRename
          title={t.title}
          label={`Rename ${t.title}`}
          className="tsb-task-rename"
          onCommit={(next) => {
            setRenamingId(null);
            if (next !== t.title) onRenameTask(t.id, next);
          }}
          onCancel={() => setRenamingId(null)}
        />
      ) : (
        <>
          {/* The row is marked twice over: `is-active` paints it, and
              `aria-current` says it. Both are needed — the paint is the only
              thing that ever said which conversation was on screen once the
              breadcrumb's tabs (which said it with `aria-pressed`) came off
              the strip, and a colour is not something a screen reader can
              read. */}
          <button
            type="button"
            className="tsb-task-open"
            aria-current={t.id === activeTaskId ? "page" : undefined}
            onClick={() => onOpenTask?.(t.id)}
          >
            <span className="tsb-task-dot" aria-hidden="true" />
            <span className="tsb-task-title">{t.title}</span>
          </button>
          <TaskRowMenu
            title={t.title}
            pinned={!!t.pinned}
            status={t.status}
            className="tsb-task-actions"
            triggerClassName="tsb-task-kebab"
            researches={researches}
            currentResearchId={research.id}
            onRename={onRenameTask ? () => setRenamingId(t.id) : undefined}
            onPin={onPinTask ? () => onPinTask(t.id, !t.pinned) : undefined}
            onMove={
              onMoveTask ? (researchId) => onMoveTask(t.id, researchId) : undefined
            }
            onDelete={onDeleteTask ? () => onDeleteTask(t.id) : undefined}
            onSetStatus={
              onSetTaskStatus
                ? (status) => onSetTaskStatus(t.id, status)
                : undefined
            }
          />
        </>
      )}
    </div>
  );

  return (
    <aside className="task-sidebar" data-testid="context-rail">
      <WorkspaceSwitcher />

      <div className="tsb-header">
        <button
          type="button"
          className="tsb-project"
          aria-label="Edit research"
          onClick={() => setEditOpen(true)}
        >
          <span className="tsb-project-name">{research.title}</span>
          <svg width="11" height="11" viewBox="0 0 10 10" fill="none">
            <path
              d="M2.5 4 5 6.5 7.5 4"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="tsb-menu">
        <button type="button" className={railRow()} onClick={onNew}>
          <RailGlyph>
            <span aria-hidden="true" className="text-read leading-none">
              +
            </span>
          </RailGlyph>
          New
        </button>
        <button
          type="button"
          className={railRow()}
          onClick={() => setSettingsOpen(true)}
        >
          <RailGlyph>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect
                x="2.5"
                y="5"
                width="11"
                height="7.5"
                rx="1.4"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <path
                d="M6 5V4a2 2 0 0 1 4 0v1M2.8 8.4h10.4"
                stroke="currentColor"
                strokeWidth="1.2"
              />
            </svg>
          </RailGlyph>
          Customize
        </button>
        <button
          type="button"
          className={railRow(filesActive)}
          onClick={onOpenFiles}
        >
          <RailGlyph>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect
                x="4.5"
                y="2.5"
                width="8"
                height="9.5"
                rx="1.4"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <path
                d="M3 4.5v8a1.4 1.4 0 0 0 1.4 1.4h6"
                stroke="currentColor"
                strokeWidth="1.2"
              />
            </svg>
          </RailGlyph>
          Files
        </button>
      </div>

      <div className="tsb-tasks">
        {tasks.length === 0 ? (
          <>
            <RailGroupLabel>Tasks</RailGroupLabel>
            <div className="tsb-tasks-empty">No tasks yet</div>
          </>
        ) : (
          <>
            {/* The Pinned group only exists while something is pinned — an
                empty eyebrow would be noise on a fresh Research. */}
            {pinned.length > 0 && (
              <>
                <RailGroupLabel>Pinned</RailGroupLabel>
                {pinned.map(renderRow)}
              </>
            )}
            {recent.length > 0 && (
              <>
                <RailGroupLabel>Tasks</RailGroupLabel>
                {recent.map(renderRow)}
              </>
            )}
          </>
        )}
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {editOpen && (
        <ResearchFormModal
          research={research}
          onClose={() => setEditOpen(false)}
          onSubmit={async (input) => {
            await api.updateResearch(research.id, input);
            setEditOpen(false);
            invalidate();
          }}
        />
      )}
    </aside>
  );
}

export default TaskSidebar;
