import { useMemo, useState } from "react";
import type { MachineCompute, RunningKernel, Machine, Study, Task } from "@lykeion/api";
import { cn } from "../../lib/utils";
import { formatBytes, formatCores, formatSince, UNREPORTED } from "../../lib/format";
import { ChevronDownIcon } from "../icons";
import { Sparkline } from "./Sparkline";

/**
 * A machine's kernels, as a machine → Task → kernel disclosure.
 *
 * Three levels because a lab has several machines and a machine runs several
 * Tasks at once, so the flat list a single-machine product can get away with
 * would put a researcher's own kernel and a colleague's beside each other with
 * nothing between them.
 *
 * The top level is not here. It is the roster row in `MachinesList`, which a
 * machine's kernels now open out of — one list on this screen instead of a
 * tree of running machines above a table of all of them, which named every
 * busy machine twice and made a reader match the two by eye. What this module
 * owns is everything under that row: the Task grouping and the kernel rows.
 *
 * Every figure here is what the machine holding the kernel reported, and no
 * figure is invented to fill a column. A machine now measures each kernel's
 * own process family and sends both the newest reading and the last several,
 * so a row carries memory, processor use, and a sparkline of each. What has
 * not changed is what an unmeasured figure renders as: a machine that could
 * not read a process, or has not read it yet, leaves the key off entirely and
 * the column reads `—`. That is the honest rendering of a measurement nobody
 * took, and it is a different thing from a kernel measured at zero, which
 * reads `0 B`.
 */

/** How a language is marked in a row, short enough for a 20px slot. */
function languageMark(language: RunningKernel["language"]): string {
  return language === "r" ? "R" : "Py";
}

interface StateMeta {
  label: string;
  dotClass: string;
  textClass: string;
}

/**
 * What each kernel state is called and coloured.
 *
 * `unknown` is not a state a machine reports — it is what every one of its
 * kernels becomes when the machine itself stops answering. A kernel whose
 * machine is offline was last seen running, and going on saying "running"
 * would be this lab repeating a fact it can no longer check.
 */
const STATE_META: Record<RunningKernel["state"] | "unknown", StateMeta> = {
  lazy: { label: "not started", dotClass: "bg-fg-tertiary", textClass: "text-fg-tertiary" },
  starting: { label: "starting", dotClass: "bg-accent", textClass: "text-fg-muted" },
  idle: { label: "idle", dotClass: "bg-success", textClass: "text-fg-muted" },
  running: { label: "running", dotClass: "bg-warn", textClass: "text-warn" },
  stopped: { label: "stopped", dotClass: "bg-fg-tertiary", textClass: "text-fg-tertiary" },
  crashed: { label: "crashed", dotClass: "bg-danger", textClass: "text-danger" },
  reclaimed: { label: "reclaimed", dotClass: "bg-fg-tertiary", textClass: "text-fg-tertiary" },
  unknown: { label: "unknown", dotClass: "bg-fg-tertiary", textClass: "text-fg-tertiary" },
};

/** One kernel row's live state, which is a function of its machine's health
 *  on read rather than of anything stored — the same rule `Machine.health`
 *  itself follows. */
function stateOf(kernel: RunningKernel, health: Machine["health"]): keyof typeof STATE_META {
  return health === "offline" ? "unknown" : kernel.state;
}

function KernelRow({
  kernel,
  health,
  now,
  compute,
  onInterrupt,
  onStop,
  onRestart,
}: {
  kernel: RunningKernel;
  health: Machine["health"];
  now: number;
  /** What the kernel's own machine has, so its sparklines scale against the
   *  machine's capacity rather than against this one kernel's own peak.
   *  Absent when the machine never reported its size — the sparklines then
   *  render nothing, which is correct: there is no ceiling to judge the
   *  readings against. */
  compute?: MachineCompute;
  onInterrupt: (kernelId: string) => void;
  onStop: (kernelId: string, feedback: string) => void;
  onRestart: (kernelId: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  // The sentence being typed, or `null` when nothing is being said. Held on
  // the row rather than in a dialog: what is being ended is this kernel, and
  // a modal over the screen would take away the figures the researcher is
  // deciding from while they write about them.
  const [saying, setSaying] = useState<string | null>(null);
  const state = stateOf(kernel, health);
  const meta = STATE_META[state];
  const since = formatSince(kernel.lastActivityTs ?? kernel.startedTs, now);
  const runs =
    kernel.executionCount === 1 ? "1 cell run" : `${kernel.executionCount} cells run`;
  const memoryCeiling = compute?.totalMemoryBytes;
  const processorCeiling = compute?.cores === undefined ? undefined : compute.cores * 100;
  const stopWith = (said: string) => {
    onStop(kernel.id, said);
    setSaying(null);
  };

  return (
    <li className="grid grid-cols-[20px_minmax(0,1fr)_90px_90px_28px] items-center gap-3 border-b border-line-soft py-2 pl-9 pr-3">
      <span
        aria-hidden="true"
        className="grid h-5 w-5 place-items-center rounded border border-line bg-surface-2 font-mono text-micro text-fg-tertiary"
      >
        {languageMark(kernel.language)}
      </span>

      <span className="min-w-0">
        <span className="flex items-center gap-1.5">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dotClass)} />
          <span className={cn("text-meta", meta.textClass)}>{meta.label}</span>
          {/* A duration means nothing on a machine that is not answering:
              what it would measure is how long ago this lab last heard, not
              how long the kernel has been sitting there. */}
          {state !== "unknown" && since !== UNREPORTED && (
            <span className="text-meta tabular-nums text-fg-tertiary">{since}</span>
          )}
          <span className="text-meta text-fg-tertiary">· {runs}</span>
          {kernel.queueDepth > 0 && (
            <span className="text-meta text-fg-tertiary">· {kernel.queueDepth} queued</span>
          )}
        </span>
        {/* Only when the machine said what it last ran. Nothing populates
            this today, so the line is absent rather than a placeholder
            standing in for a description that was never reported. */}
        {kernel.lastCellTitle && (
          <span className="mt-0.5 block truncate text-meta text-fg-subtle">
            {kernel.lastCellTitle}
          </span>
        )}
      </span>

      {saying !== null ? (
        /* The row's trailing area, for as long as somebody is writing in it.
           Not a dialog over the screen: what is being ended is this one
           kernel, and a modal would cover the figures the researcher is
           deciding from at the moment they are writing about them. */
        <span className="col-span-3 flex items-center gap-1.5">
          <input
            // Focused on arrival, which an input that appears unbidden must
            // never be: this one appears only because somebody chose Stop from
            // the menu, and the caret belongs where they are already looking.
            autoFocus
            value={saying}
            onChange={(event) => setSaying(event.target.value)}
            onKeyDown={(event) => {
              // Esc backs out, and nothing is stopped. A researcher who opened
              // this by mistake must not have to send a sentence to get out of
              // it.
              if (event.key === "Escape") setSaying(null);
              if (event.key === "Enter") stopWith(saying);
            }}
            placeholder="Why? The agent reads this."
            aria-label={`Why the ${languageMark(kernel.language)} kernel is being stopped`}
            className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-meta text-fg placeholder:text-fg-tertiary"
          />
          <button
            type="button"
            onClick={() => stopWith(saying)}
            className="shrink-0 rounded-md border border-line-strong px-2 py-1 text-meta text-danger hover:bg-surface-2"
          >
            Stop
          </button>
        </span>
      ) : (
        <>
          <span className="text-right text-meta tabular-nums text-fg-muted">
            {formatBytes(kernel.resources?.memoryBytes)}
            <span className="ml-1 text-fg-tertiary">RSS</span>
            <span className="ml-1.5">
              <Sparkline
                values={kernel.series?.map((s) => s.memoryBytes) ?? []}
                ceiling={memoryCeiling}
                label="Memory over time"
              />
            </span>
          </span>
          <span className="text-right text-meta tabular-nums text-fg-muted">
            {formatCores(kernel.resources?.cpuPercent)}
            <span className="ml-1 text-fg-tertiary">CPU</span>
            <span className="ml-1.5">
              <Sparkline
                values={kernel.series?.map((s) => s.cpuPercent) ?? []}
                ceiling={processorCeiling}
                label="Processor over time"
              />
            </span>
          </span>

          <span className="relative flex justify-end">
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`Actions for the ${languageMark(kernel.language)} kernel`}
              onClick={() => setMenuOpen((o) => !o)}
              onBlur={() => setMenuOpen(false)}
              className="grid h-6 w-6 place-items-center rounded-md text-meta text-fg-tertiary hover:bg-surface-2 hover:text-fg"
            >
              ⋯
            </button>
            {menuOpen && (
              <div
                role="menu"
                aria-label="Kernel actions"
                className="absolute right-0 top-7 z-20 flex min-w-[150px] flex-col rounded-lg border border-line bg-surface-3 p-1 shadow-xl"
              >
                {/* Interrupt reaches a cell, so it is offered only while one is
                    running. Neither control is offered for a machine that is not
                    answering: the command would be accepted here and delivered
                    nowhere. */}
                {state === "running" && (
                  <button
                    type="button"
                    role="menuitem"
                    onMouseDown={() => onInterrupt(kernel.id)}
                    className="rounded-md px-2 py-1.5 text-left text-meta text-fg hover:bg-surface-4"
                  >
                    Interrupt
                  </button>
                )}
                {/* Stop for the same reason Interrupt is: the sentence it
                    carries is answered to the cell that is running, and a
                    kernel with nothing in it has no call for it to reach. */}
                {state === "running" && (
                  <button
                    type="button"
                    role="menuitem"
                    onMouseDown={() => setSaying("")}
                    className="rounded-md px-2 py-1.5 text-left text-meta text-fg hover:bg-surface-4"
                  >
                    Stop
                  </button>
                )}
                {state !== "unknown" && (
                  <button
                    type="button"
                    role="menuitem"
                    onMouseDown={() => onRestart(kernel.id)}
                    className="rounded-md px-2 py-1.5 text-left text-meta text-fg hover:bg-surface-4"
                  >
                    Restart
                  </button>
                )}
                {state === "unknown" && (
                  <span className="px-2 py-1.5 text-meta text-fg-tertiary">
                    This machine is offline.
                  </span>
                )}
              </div>
            )}
          </span>
        </>
      )}
    </li>
  );
}

function TaskGroup({
  label,
  kernels,
  health,
  now,
  compute,
  onInterrupt,
  onStop,
  onRestart,
}: {
  label: string;
  kernels: RunningKernel[];
  health: Machine["health"];
  now: number;
  compute?: MachineCompute;
  onInterrupt: (kernelId: string) => void;
  onStop: (kernelId: string, feedback: string) => void;
  onRestart: (kernelId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const running = kernels.filter((k) => stateOf(k, health) === "running").length;
  return (
    <>
      <li className="border-b border-line-soft">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-2 py-2 pl-5 pr-3 text-left hover:bg-surface-2"
        >
          <ChevronDownIcon
            width={11}
            height={11}
            className={cn("shrink-0 text-fg-tertiary transition-transform", !open && "-rotate-90")}
          />
          <span className="min-w-0 flex-1 truncate text-meta text-fg">{label}</span>
          <span className="shrink-0 text-meta tabular-nums text-fg-tertiary">
            {kernels.length === 1 ? "1 kernel" : `${kernels.length} kernels`}
            {running > 0 && ` · ${running} running`}
          </span>
        </button>
      </li>
      {open &&
        kernels.map((kernel) => (
          <KernelRow
            key={kernel.id}
            kernel={kernel}
            health={health}
            now={now}
            compute={compute}
            onInterrupt={onInterrupt}
            onStop={onStop}
            onRestart={onRestart}
          />
        ))}
    </>
  );
}

/**
 * One machine's kernels, grouped by the Task running them — the two inner
 * levels of the tree, rendered as `<li>`s for the roster's own list.
 *
 * The machine level above them is the roster row this nests inside: that row
 * already names the machine, says whether it is answering and when it was
 * last seen, so a header of our own here would say the name twice and put a
 * second, poorer summary of the same machine directly above the first. What
 * the row cannot say on its own is how many kernels are under it and how
 * many are working — `kernelSummary` is that sentence, rendered up there
 * beside the name rather than down here.
 */
export function MachineKernels({
  machine,
  kernels,
  taskLabel,
  now,
  compute,
  onInterrupt,
  onStop,
  onRestart,
}: {
  machine: Machine;
  kernels: RunningKernel[];
  taskLabel: (taskId: string) => string;
  now: number;
  /** What this machine has, so a kernel row's sparklines scale against its
   *  capacity. Absent when the machine's own size was never reported. */
  compute?: MachineCompute;
  onInterrupt: (kernelId: string) => void;
  onStop: (kernelId: string, feedback: string) => void;
  onRestart: (kernelId: string) => void;
}) {
  const byTask = useMemo(() => {
    const groups = new Map<string, RunningKernel[]>();
    for (const kernel of kernels) {
      const held = groups.get(kernel.taskId);
      if (held) held.push(kernel);
      else groups.set(kernel.taskId, [kernel]);
    }
    return [...groups.entries()];
  }, [kernels]);

  return (
    <>
      {byTask.map(([taskId, held]) => (
        <TaskGroup
          key={taskId}
          label={taskLabel(taskId)}
          kernels={held}
          health={machine.health}
          now={now}
          compute={compute}
          onInterrupt={onInterrupt}
          onStop={onStop}
          onRestart={onRestart}
        />
      ))}
    </>
  );
}

/**
 * What a machine is holding, in the few words that fit beside its name on the
 * roster row: how many kernels, and how many of them are actually working.
 *
 * Memory and processor use are still not here, though a machine now reports
 * both. They are not missing from the row — they have a column each, summed
 * over these same kernels by `computeSnapshot` and rendered against what the
 * machine has, which is a used-of-total pair that no sentence beside a name
 * has room for. What this string carries is what a total cannot say: how many
 * kernels, and how many of them are actually working.
 *
 * Empty for a machine holding nothing, so the roster says nothing at all
 * rather than "0 kernels" against every machine that is simply idle.
 */
export function kernelSummary(kernels: RunningKernel[], health: Machine["health"]): string {
  if (kernels.length === 0) return "";
  const count = kernels.length === 1 ? "1 kernel" : `${kernels.length} kernels`;
  const running = kernels.filter((k) => stateOf(k, health) === "running").length;
  return running > 0 ? `${count} · ${running} running` : count;
}

/**
 * Names for the tree's middle level: a Task as a researcher would recognise
 * it, built once for a whole render rather than per kernel.
 */
export function taskLabeller(tasks: Task[], studies: Study[]): (taskId: string) => string {
  const studyOf = new Map(studies.map((s) => [s.id, s]));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return (taskId: string): string => {
    const task = byId.get(taskId);
    // A Task this lab cannot name is named as one it cannot name. Its id is
    // a word this lab minted for itself, and printing it here would read as
    // a title.
    if (!task) return "A Task not in this list";
    const study = task.studyId ? studyOf.get(task.studyId) : undefined;
    const number = study ? `${study.key}-${task.number}` : `TSK-${task.number}`;
    return study ? `${study.title} › ${number} ${task.title}` : `${number} ${task.title}`;
  };
}
