import { useMemo, useState } from "react";
import {
  DISCIPLINES,
  DISCIPLINE_LABELS,
  type Discipline,
  type Workflow,
} from "@lykeion/api";
import { SearchIcon } from "../icons";
import { RowLink } from "../RowLink";
import { DISCIPLINE_COLOR } from "../../lib/workflow-meta";
import { cn } from "../../lib/utils";

const GRID_COLS = "grid-cols-[minmax(0,1fr)_160px_minmax(0,140px)]";

export interface WorkflowListProps {
  workflows: Workflow[];
  loading?: boolean;
}

export function WorkflowList({
  workflows,
  loading = false,
}: WorkflowListProps) {
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workflows;
    return workflows.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        w.description.toLowerCase().includes(q) ||
        DISCIPLINE_LABELS[w.discipline].toLowerCase().includes(q),
    );
  }, [query, workflows]);

  // Grouped in the disciplines' own order, not in the order rows arrived, and
  // a discipline nothing is filed under is left out rather than shown empty.
  const groups = useMemo(
    () =>
      DISCIPLINES.map((discipline) => ({
        discipline,
        rows: visible.filter((w) => w.discipline === discipline),
      })).filter((group) => group.rows.length > 0),
    [visible],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pb-3 pt-2">
        {/* Focus lights the field box rather than the input: the global ring
            is drawn a pixel inside its own element, so on the input it reads
            as a second box within this one. Same treatment as the Inbox and
            Agents searches — these are the app's only `outline-none` opt-outs
            and must not drift apart. */}
        <div className="flex h-8 w-[220px] items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 transition-colors duration-[120ms] focus-within:border-accent-focus">
          <SearchIcon
            className="shrink-0 text-fg-subtle"
            width={14}
            height={14}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workflows…"
            className="h-full w-full bg-transparent text-ui text-fg placeholder:text-fg-subtle focus:outline-none"
          />
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-ui text-fg-subtle">
          {workflows.length === 0
            ? loading
              ? ""
              : "No workflows yet — create one to start."
            : "No workflows match your search"}
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-5 pb-5">
          <div
            className={cn(
              "grid items-center gap-3 border-b border-line px-3 py-2 text-meta font-medium uppercase tracking-[0.4px] text-fg-tertiary",
              GRID_COLS,
            )}
          >
            <span>Workflow</span>
            <span>Discipline</span>
            <span>Phases</span>
          </div>

          {groups.map((group) => (
            <div key={group.discipline}>
              <DisciplineHeading
                discipline={group.discipline}
                count={group.rows.length}
              />
              {group.rows.map((workflow) => (
                <WorkflowRow key={workflow.id} workflow={workflow} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DisciplineHeading({
  discipline,
  count,
}: {
  discipline: Discipline;
  count: number;
}) {
  return (
    <h2 className="flex items-center gap-2 px-3 pb-1 pt-4 text-meta font-medium uppercase tracking-[0.4px] text-fg-tertiary">
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: DISCIPLINE_COLOR[discipline] }}
      />
      <span>{DISCIPLINE_LABELS[discipline]}</span>
      <span className="tabular-nums text-fg-subtle">{count}</span>
    </h2>
  );
}

function WorkflowRow({ workflow }: { workflow: Workflow }) {
  const count = workflow.phases.length;
  return (
    <RowLink
      to={{ name: "workflow", workflowId: workflow.id }}
      className={cn(
        "grid items-center gap-3 border-b border-line-soft px-3 py-2.5 text-ui hover:bg-surface-2",
        GRID_COLS,
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-fg">{workflow.name}</span>
        <span className="truncate text-sub text-fg-subtle">
          {workflow.description}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-2 text-fg-muted">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: DISCIPLINE_COLOR[workflow.discipline] }}
        />
        <span className="truncate">
          {DISCIPLINE_LABELS[workflow.discipline]}
        </span>
      </span>
      {/* Text, not a meter: nothing here is running, and a filled bar beside a
          catalogue entry would read as progress through it. */}
      <span className="tabular-nums text-fg-muted">
        {count} phase{count === 1 ? "" : "s"}
      </span>
    </RowLink>
  );
}

export default WorkflowList;
