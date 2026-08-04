import { useRef } from "react";
import type { Study, Task } from "@lykeion/api";
import { useApi } from "../../api/ApiContext";
import { ActionMenu } from "../ui/ActionMenu";
import { ChevronDownIcon, FileIcon, UploadIcon } from "../icons";
import {
  exportTasksJson,
  parseTasksJson,
  patchHasFields,
} from "../../lib/task-io";

export interface TaskImportExportProps {
  /** The tasks in view — export writes exactly what the filters left. */
  tasks: Task[];
  studyById: Record<string, Study>;
  /** Download name for the exported document, e.g. "my-tasks.json". */
  fileName: string;
  /** Refetch: the imported tasks are not in `tasks` until the board reloads. */
  onImported: () => void;
  /** The one-line outcome — reported up so each board can place it itself. */
  onMessage: (message: string) => void;
}

/**
 * The toolbar's Import / Export menu and the file input behind it. Shared by
 * every task board, so the two of them cannot drift into different rules about
 * what a JSON document means.
 */
export function TaskImportExport({
  tasks,
  studyById,
  fileName,
  onImported,
  onMessage,
}: TaskImportExportProps) {
  const api = useApi();
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleExport() {
    const json = exportTasksJson(tasks, studyById);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    onMessage(`Exported ${tasks.length} task(s).`);
  }

  async function handleImportFile(file: File) {
    const text = await file.text();
    const { tasks: parsed, skipped } = parseTasksJson(text);
    let created = 0;
    let unknownStudy = 0;
    for (const { create, patch } of parsed) {
      // A row with no studyId imports as unfiled; only a named-but-unknown
      // Study is a reason to drop it.
      if (create.studyId !== undefined && !studyById[create.studyId]) {
        unknownStudy++;
        continue;
      }
      try {
        const task = await api.createTask(create);
        if (patchHasFields(patch)) await api.updateTask(task.id, patch);
        created++;
      } catch {
        // Skip a row the core rejected; keep importing the rest.
      }
    }
    const dropped = skipped + unknownStudy;
    onMessage(
      `Imported ${created} task(s)${dropped ? `, skipped ${dropped}` : ""}.`,
    );
    onImported();
  }

  return (
    <>
      <ActionMenu
        align="end"
        width="w-52"
        items={[
          {
            id: "export",
            icon: FileIcon,
            label: "Export as JSON",
            detail: `${tasks.length} shown task(s)`,
            onSelect: handleExport,
          },
          {
            id: "import",
            icon: UploadIcon,
            label: "Import from JSON",
            separatorBefore: true,
            onSelect: () => fileInputRef.current?.click(),
          },
        ]}
      >
        {({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[12.5px] text-fg-subtle transition-colors hover:text-fg"
          >
            Import / Export
            <ChevronDownIcon width={13} height={13} />
          </button>
        )}
      </ActionMenu>

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleImportFile(file);
          e.target.value = "";
        }}
      />
    </>
  );
}

export default TaskImportExport;
