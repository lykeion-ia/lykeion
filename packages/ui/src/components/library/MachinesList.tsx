import { useState } from "react";
import type {
  KernelEnvDeclaration,
  MachineCompute,
  RunningKernel,
  Machine,
} from "@lykeion/api";
import { useApi, useInvalidateData } from "../../api/ApiContext";
import { ChevronDownIcon } from "../icons";
import { ConfirmModal } from "../ui/ConfirmModal";
import { cn } from "../../lib/utils";
import { formatAgo } from "../../lib/task-meta";
import { formatBytes, formatCores, UNREPORTED } from "../../lib/format";
import { kernelSummary, MachineKernels } from "./KernelTree";
import { KernelEnvCard } from "./KernelEnvCard";
import { Sparkline } from "./Sparkline";

interface HealthMeta {
  label: string;
  dotClass: string;
  textClass: string;
}

const HEALTH_META: Record<Machine["health"], HealthMeta> = {
  online: {
    label: "Online",
    dotClass: "bg-success",
    textClass: "text-success",
  },
  unstable: { label: "Unstable", dotClass: "bg-warn", textClass: "text-warn" },
  offline: {
    label: "Offline",
    dotClass: "bg-fg-tertiary",
    textClass: "text-fg-tertiary",
  },
};

// Shared by the header row and every data row, in both tables, so their
// columns line up — the trailing slot holds Remove and stays empty wherever
// that control is not offered.
// One column narrower than it was: what this machine has on its PATH is
// answered in full by the per-machine agent list below this roster —
// installed and not, with versions and sign-in state — and the roster's own
// cell was a worse second copy of it.
const GRID_COLS =
  "grid-cols-[minmax(0,1.3fr)_100px_90px_120px_130px_110px_84px]";

function MachineRow({
  machine,
  kernels,
  compute,
  taskLabel,
  now,
  onInterrupt,
  onStop,
  onRestart,
  declarations,
  onReclaim,
  onDelete,
  onRemove,
}: {
  machine: Machine;
  /** What this machine is holding. Empty is the ordinary case — a machine
   *  running nothing is still a machine — and the row is then a plain row
   *  with nothing to open. */
  kernels: RunningKernel[];
  /** What this machine's kernels are using, against what it has. Absent
   *  when the fan-out never reached it — a machine that has never reported
   *  its own size, or one that is offline right now — and every figure
   *  below falls back to an em dash rather than a zero. */
  compute?: MachineCompute;
  taskLabel: (taskId: string) => string;
  now: number;
  onInterrupt: (kernelId: string) => void;
  onStop: (kernelId: string, feedback: string) => void;
  onRestart: (kernelId: string) => void;
  /** What this lab has declared, so a row can say a machine is a revision
   *  behind — and so a starter nobody may delete offers no Delete. Empty
   *  while the list is still loading, which is why a row compares revisions
   *  only when it finds its own declaration rather than assuming the lab
   *  pins nothing. */
  declarations: KernelEnvDeclaration[];
  onReclaim: (machineId: string, name: string) => void;
  onDelete: (name: string) => void;
  /** Present only for a machine the caller owns — the control this renders
   *  must never reach a machine that is not the caller's own. */
  onRemove?: (machine: Machine) => void;
}) {
  const health = HEALTH_META[machine.health];
  const summary = kernelSummary(kernels, machine.health);
  // Open by default, as the tree this replaced was: a machine holding kernels
  // is holding them right now, and the reason to look at this screen while
  // something is running is to see what. A machine holding nothing has no
  // disclosure at all, so this decides nothing for it.
  const [open, setOpen] = useState(true);
  // What this machine has ON it, which is now two different things. An
  // environment is not a kernel — it is gigabytes on a disk, sitting there
  // whether or not anything is running — so a machine holding no kernels but
  // holding environments still has something to open. Before this, such a
  // machine had no disclosure at all and its environments were unreachable
  // on the one screen that exists to say what a machine holds.
  const environments = compute?.environments ?? [];
  const holding = kernels.length > 0 || environments.length > 0;

  // Absent, not zero, whenever the pair itself was never reported — a
  // daemon too old to send its own size, or a machine the fan-out could not
  // reach right now. `formatBytes`/`formatCores` already turn one absent
  // figure into an em dash; this is what keeps a used/total pair that is
  // absent on BOTH sides from reading as "— of —" instead of the single
  // dash every other unreportable figure on this screen renders as.
  const memoryBytes = compute?.memoryBytes;
  const totalMemoryBytes = compute?.totalMemoryBytes;
  const memoryCell =
    memoryBytes === undefined && totalMemoryBytes === undefined
      ? UNREPORTED
      : `${formatBytes(memoryBytes)} of ${formatBytes(totalMemoryBytes)}`;
  const cpuPercent = compute?.cpuPercent;
  const cores = compute?.cores;
  const processorCell =
    cpuPercent === undefined && cores === undefined
      ? UNREPORTED
      : `${formatCores(cpuPercent)} of ${cores ?? UNREPORTED} cores`;

  return (
    <li className="border-b border-line-soft">
      <div className={cn("grid items-center gap-3 px-3 py-2.5 text-ui", GRID_COLS)}>
        {/* The name cell is the disclosure when there is something to
            disclose. A machine holding nothing keeps the same indent, so the
            names still line up down the column rather than stepping in and
            out with whatever happens to be running. */}
        <span className="flex min-w-0 flex-col">
          {holding ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={`${machine.name} — ${summary}`}
              onClick={() => setOpen((o) => !o)}
              className="-ml-1 flex min-w-0 items-center gap-1.5 rounded-md py-0.5 pl-1 pr-1.5 text-left hover:bg-surface-2"
            >
              <ChevronDownIcon
                width={12}
                height={12}
                className={cn(
                  "shrink-0 text-fg-tertiary transition-transform",
                  !open && "-rotate-90",
                )}
              />
              <span className="truncate font-medium text-fg">{machine.name}</span>
            </button>
          ) : (
            <span className="truncate pl-[18px] font-medium text-fg">{machine.name}</span>
          )}
          {/* Under the name rather than in a column of their own. Both used to
              ride along in the CLIs cell, and when that came out they had
              nowhere left to be — but neither is about this machine's tools:
              one says what it is holding right now, the other that it cannot
              hold anything at all. Indented to the name's own left edge, past
              where the disclosure chevron sits. */}
          {summary && (
            <span className="pl-[18px] text-meta tabular-nums text-fg-muted">{summary}</span>
          )}
          {/* Present only once something has actually said this machine
              cannot host a kernel — never on a machine that can, and never
              on one whose daemon has not checked, which stays silent rather
              than guessing. */}
          {machine.kernelsReason !== undefined && (
            <span className="pl-[18px] text-meta text-warn">
              Cannot host kernels — {machine.kernelsReason}
            </span>
          )}
        </span>
        <span
          className={cn("inline-flex items-center gap-1.5", health.textClass)}
        >
          <span className={cn("h-2 w-2 shrink-0 rounded-full", health.dotClass)} />
          {health.label}
        </span>
        <span className="tabular-nums text-fg-muted">
          {formatAgo(machine.lastSeenTs)}
        </span>
        <span className="truncate text-fg-subtle">{machine.platform}</span>
        <span className="tabular-nums text-fg-muted">
          {memoryCell}
          <span className="ml-1.5">
            <Sparkline
              values={compute?.series?.map((s) => s.memoryBytes) ?? []}
              ceiling={totalMemoryBytes}
              label="Memory over time"
            />
          </span>
        </span>
        <span className="tabular-nums text-fg-muted">
          {processorCell}
          <span className="ml-1.5">
            <Sparkline
              values={compute?.series?.map((s) => s.cpuPercent) ?? []}
              ceiling={cores === undefined ? undefined : cores * 100}
              label="Processor over time"
            />
          </span>
        </span>
        <span className="flex justify-end">
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(machine)}
              aria-label={`Remove ${machine.name}`}
              className="shrink-0 rounded-md border border-line-strong px-2.5 py-1 text-sub text-fg hover:bg-surface"
            >
              Remove
            </button>
          )}
        </span>
      </div>

      {/* The kernels themselves, in a list of their own nested in this row —
          `<li>` is the only child an `<ul>` may have, so the levels below
          cannot be siblings of the machines they belong to. */}
      {holding && open && (
        <ul>
          <MachineKernels
            machine={machine}
            kernels={kernels}
            taskLabel={taskLabel}
            now={now}
            compute={compute}
            onInterrupt={onInterrupt}
            onStop={onStop}
            onRestart={onRestart}
          />
          {/* Under the kernels rather than beside them, and under the
              MACHINE rather than in a list of their own on this screen:
              which environments exist is a fact about the lab, but which of
              them are on a disk is a fact about a machine, and that is the
              question this screen answers. The same environment therefore
              appears under every machine, saying something different under
              each.

              Not gated on the machine being online. An environment is what
              this machine last reported holding, persisted rather than
              re-asked, so it stays true while the machine is asleep — unlike
              its kernel counts, which read as unknown the moment nothing can
              ask it. */}
          {environments.map((status) => {
            const declaration = declarations.find((d) => d.name === status.name);
            return (
              <KernelEnvCard
                key={status.name}
                status={status}
                declaration={declaration}
                machineName={machine.name}
                onReclaim={(name) => onReclaim(machine.id, name)}
                // Offered only for an environment somebody actually declared.
                // An absent `createdBy` means Lykeion declared it — the
                // starter — and the core refuses to delete it (D7), so a
                // control here would be one that can only fail. A declaration
                // this caller has not loaded yet offers nothing either,
                // rather than offering a delete against a name it cannot
                // check.
                onDelete={
                  declaration?.createdBy === undefined ? undefined : () => onDelete(status.name)
                }
              />
            );
          })}
        </ul>
      )}
    </li>
  );
}

function MachineTable({
  label,
  machines,
  kernels,
  compute,
  taskLabel,
  now,
  meId,
  onInterrupt,
  onStop,
  onRestart,
  declarations,
  onReclaim,
  onDelete,
  onRemove,
}: {
  label: string;
  machines: Machine[];
  /** Every kernel the lab can see, across all machines — split per row here
   *  rather than by the caller, so a machine holding none is not a case
   *  anybody upstream has to remember to pass. */
  kernels: RunningKernel[];
  /** What every machine in the lab is holding, against what it has — one
   *  entry matched to its row the same way `kernels` is. */
  compute: MachineCompute[];
  taskLabel: (taskId: string) => string;
  now: number;
  /** Which of these machines are the caller's own. Not a heading any more —
   *  one roster carries every machine — but still what decides which rows
   *  may offer Remove, and that is a rule about ownership, never about where
   *  a row happens to sit. */
  meId: string;
  onInterrupt: (kernelId: string) => void;
  onStop: (kernelId: string, feedback: string) => void;
  onRestart: (kernelId: string) => void;
  /** The lab's declarations, passed straight down to the rows — one list for
   *  the whole roster, since what a lab has declared is the same fact under
   *  every machine and only its state differs. */
  declarations: KernelEnvDeclaration[];
  onReclaim: (machineId: string, name: string) => void;
  onDelete: (name: string) => void;
  onRemove: (machine: Machine) => void;
}) {
  if (machines.length === 0) return null;
  return (
    <section className="mb-4">
      {/* No visible heading: one roster on a screen that is already called
          Machines, where a title would only say the word again. The name
          survives as an `aria-label` — with nothing on screen to repeat, it
          duplicates nothing, and a list of machines still announces as one
          rather than as an unnamed list. */}
      <ul aria-label={label}>
        <li
          className={cn(
            // `text-nano`, the rung that exists for this line: it names what
            // each column holds, is read once, and then wants to get out of
            // the way of the machines, which are what the screen is for. Size
            // alone did not do it — one rung under the row text is not a step
            // a reader sees — so the weight comes down to normal and the ink
            // a shade with it. Tracking goes up as the size comes down, or
            // small uppercase closes into a block.
            "grid items-center gap-3 border-b border-line px-3 py-2 text-nano font-normal uppercase tracking-[0.7px] text-fg-subtle",
            GRID_COLS,
          )}
        >
          {/* Indented past where a disclosure chevron sits, so the label
              stands over the names rather than over the arrows. */}
          <span className="pl-[18px]">Machine</span>
          <span>Health</span>
          <span>Last seen</span>
          {/* What the cell under it actually holds: `macos-aarch64`, an OS and
              a CPU architecture joined by a dash. "Platform" is the word the
              contract uses for the field and it names nothing a reader can
              see — it would just as well head a column of "web" and "desktop". */}
          <span>OS &amp; arch</span>
          <span>Memory</span>
          <span>Processor</span>
          <span />
        </li>
        {machines.map((machine) => (
          <MachineRow
            key={machine.id}
            machine={machine}
            kernels={kernels.filter((k) => k.machineId === machine.id)}
            compute={compute.find((m) => m.machineId === machine.id)}
            taskLabel={taskLabel}
            now={now}
            onInterrupt={onInterrupt}
            onStop={onStop}
            onRestart={onRestart}
            declarations={declarations}
            onReclaim={onReclaim}
            onDelete={onDelete}
            // Passed only for a machine the caller owns, so the control
            // cannot be rendered against somebody else's in the first place.
            {...(machine.ownerId === meId ? { onRemove } : {})}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * Confirm taking a machine out of the lab, one step before a control that
 * ends a daemon's standing in the lab outright. There is no undo from inside
 * the workbench: the machine's token is revoked, and it has to be paired
 * again to come back — which is the sentence this dialog exists to say.
 */
function RemoveMachineModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <ConfirmModal
      label="Remove machine"
      heading="Remove this machine?"
      confirmLabel="Remove"
      onClose={onClose}
      onConfirm={onConfirm}
      body={
        <p className="text-sub leading-snug text-fg-subtle">
          Its daemon loses access to this lab immediately and has to be paired
          again to come back.
        </p>
      }
    />
  );
}

export function MachinesList({
  machines,
  kernels = [],
  compute = [],
  taskLabel = () => "",
  now = 0,
  meId,
  onInterrupt = () => {},
  onStop = () => {},
  onRestart = () => {},
  declarations = [],
  onReclaim = () => {},
  onDelete = () => {},
}: {
  machines: Machine[];
  /** What the lab can see running, for the rows to open onto. Defaulted, so
   *  a caller that only wants the roster — and every test that predates the
   *  kernels living here — still gets one. */
  kernels?: RunningKernel[];
  /** What every machine in the lab is holding, against what it has.
   *  Defaulted for the same reason `kernels` is — a caller, or a test, that
   *  never mentions a machine's own size still gets a roster, every figure
   *  on it reading as unreported rather than missing a prop. */
  compute?: MachineCompute[];
  taskLabel?: (taskId: string) => string;
  now?: number;
  /** `null` while the caller's identity is unknown — not yet answered, or
   *  the answer failed. The roster needs it to decide which rows may offer
   *  Remove, and holds off drawing itself until it knows. */
  meId: string | null;
  onInterrupt?: (kernelId: string) => void;
  onStop?: (kernelId: string, feedback: string) => void;
  onRestart?: (kernelId: string) => void;
  /** What this lab has declared. Defaulted to empty for the same reason
   *  `kernels` and `compute` are — a caller that wants only the roster still
   *  gets one. An empty list is NOT "this lab declares nothing" here: it is
   *  a list this caller did not pass, and the rows treat it as nothing known
   *  rather than as a lab with no environments, which is why a row with no
   *  declaration of its own compares no revisions and offers no delete. */
  declarations?: KernelEnvDeclaration[];
  /** Frees one machine's own copy — the declaration stands, and anyone can
   *  rebuild it from the lockfile the lab still holds. */
  onReclaim?: (machineId: string, name: string) => void;
  /** Removes the declaration for everybody. A different blast radius from
   *  `onReclaim` entirely, which is why they are two props and not one with
   *  a flag. */
  onDelete?: (name: string) => void;
}) {
  const api = useApi();
  const invalidate = useInvalidateData();
  const [pendingRemove, setPendingRemove] = useState<Machine | null>(null);

  const removeMachine = async (machineId: string) => {
    await api.removeMachine(machineId);
    setPendingRemove(null);
    invalidate();
  };

  // The screen around this owns the scroll, so that the roster and the
  // environments below it move together rather than each holding a viewport
  // of its own.
  return (
    <div>
      {meId !== null && (
        <MachineTable
          label="Lab's machines"
          // One roster: the lab's machines are the lab's, and splitting them
          // into "yours" and "theirs" made a heading out of something every
          // row already says for itself — a Remove control, and a CLIs cell
          // that reads "not shown" on a machine that is not the caller's.
          // The caller's own still read first, so the machines they can act
          // on do not have to be hunted for in a roster of somebody else's.
          machines={[
            ...machines.filter((r) => r.ownerId === meId),
            ...machines.filter((r) => r.ownerId !== meId),
          ]}
          kernels={kernels}
          compute={compute}
          taskLabel={taskLabel}
          now={now}
          meId={meId}
          onInterrupt={onInterrupt}
          onStop={onStop}
          onRestart={onRestart}
          declarations={declarations}
          onReclaim={onReclaim}
          onDelete={onDelete}
          onRemove={setPendingRemove}
        />
      )}

      {pendingRemove && (
        <RemoveMachineModal
          onClose={() => setPendingRemove(null)}
          onConfirm={() => removeMachine(pendingRemove.id)}
        />
      )}
    </div>
  );
}

export default MachinesList;
