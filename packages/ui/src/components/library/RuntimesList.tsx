import { useState, type ReactNode } from "react";
import type { RunningKernel, Runtime } from "@lykeion/api";
import { useApi, useInvalidateData } from "../../api/ApiContext";
import { ChevronDownIcon, MonitorIcon } from "../icons";
import { ConfirmModal } from "../ui/ConfirmModal";
import { CopyButton } from "../tasks/CopyButton";
import { cn } from "../../lib/utils";
import { formatAgo } from "../../lib/task-meta";
import { kernelSummary, MachineKernels } from "./KernelTree";

interface HealthMeta {
  label: string;
  dotClass: string;
  textClass: string;
}

const HEALTH_META: Record<Runtime["health"], HealthMeta> = {
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
const GRID_COLS =
  "grid-cols-[minmax(0,1.3fr)_100px_90px_120px_minmax(0,1.4fr)_84px]";

/**
 * What one machine was found to have. The daemon reports the whole
 * catalogue, availability flag and all, so the lab knows what was looked
 * for rather than only what turned up — but this column answers "what can
 * this machine run", and a machine with four tools on it would spend nine
 * rows here saying what it has not got. The misses are worth a number, not
 * a list; a researcher who wants to know whether a particular one was
 * looked for has the catalogue, which is the same on every machine.
 */
function CliInventory({ clis }: { clis: NonNullable<Runtime["clis"]> }) {
  const found = clis.filter((cli) => cli.available);
  const missing = clis.length - found.length;

  // Nothing found at all: the count would be the only thing in the column.
  if (found.length === 0) {
    return <span className="text-fg-subtle">No agent CLIs found on this machine.</span>;
  }

  return (
    <>
      {found.map((cli) => (
        <span key={cli.id} className="truncate">
          {cli.name}{" "}
          {cli.version ? (
            <span className="font-mono">{cli.version}</span>
          ) : (
            // Installed, and the command would not say which build. A bare
            // name here reads as a rendering fault rather than as the
            // half-answer it is.
            <span className="text-fg-subtle">— version unknown</span>
          )}
        </span>
      ))}
      {missing > 0 && (
        <span className="text-fg-subtle">{missing} others not installed</span>
      )}
    </>
  );
}

/**
 * What one block on this screen calls itself.
 *
 * Deliberately not `SectionTitle`, which is the size a SCREEN titles a section
 * in: this screen's own h1 already says Machines, and three more headings at
 * that size under it left the page reading as a stack of equal shouts with no
 * top to it. These name which half of one roster a reader is looking at —
 * captions on a table, not sections of the app — so they take a caption's
 * weight, one clear step under the title and one clear step over the column
 * headers they sit on.
 *
 * `id` is for a block whose content carries its own role: point the content's
 * `aria-labelledby` here and the group is announced once, by this heading,
 * rather than by a second copy of the same words beside it.
 */
function BlockTitle({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="mb-2 text-ui font-semibold text-fg">
      {children}
    </h3>
  );
}

function RuntimeRow({
  runtime,
  kernels,
  taskLabel,
  now,
  onInterrupt,
  onRestart,
  onRemove,
}: {
  runtime: Runtime;
  /** What this machine is holding. Empty is the ordinary case — a machine
   *  running nothing is still a machine — and the row is then a plain row
   *  with nothing to open. */
  kernels: RunningKernel[];
  taskLabel: (taskId: string) => string;
  now: number;
  onInterrupt: (kernelId: string) => void;
  onRestart: (kernelId: string) => void;
  /** Present only for a machine the caller owns — the control this renders
   *  must never reach a machine that is not the caller's own. */
  onRemove?: (runtime: Runtime) => void;
}) {
  const health = HEALTH_META[runtime.health];
  const summary = kernelSummary(kernels, runtime.health);
  // Open by default, as the tree this replaced was: a machine holding kernels
  // is holding them right now, and the reason to look at this screen while
  // something is running is to see what. A machine holding nothing has no
  // disclosure at all, so this decides nothing for it.
  const [open, setOpen] = useState(true);
  const holding = kernels.length > 0;

  return (
    <li className="border-b border-line-soft">
      <div className={cn("grid items-center gap-3 px-3 py-2.5 text-ui", GRID_COLS)}>
        {/* The name cell is the disclosure when there is something to
            disclose. A machine holding nothing keeps the same indent, so the
            names still line up down the column rather than stepping in and
            out with whatever happens to be running. */}
        {holding ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${runtime.name} — ${summary}`}
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
            <span className="truncate font-medium text-fg">{runtime.name}</span>
          </button>
        ) : (
          <span className="truncate pl-[18px] font-medium text-fg">{runtime.name}</span>
        )}
        <span
          className={cn("inline-flex items-center gap-1.5", health.textClass)}
        >
          <span className={cn("h-2 w-2 shrink-0 rounded-full", health.dotClass)} />
          {health.label}
        </span>
        <span className="tabular-nums text-fg-muted">
          {formatAgo(runtime.lastSeenTs)}
        </span>
        <span className="truncate text-fg-subtle">{runtime.platform}</span>
        <span className="flex flex-col gap-0.5 text-meta text-fg-tertiary">
          {/* Absent and empty mean different things here, and an empty cell
              would read as the second whichever one it was: a machine that is
              not the caller's own carries no `clis` key at all, because the
              lab never tells anybody what is on somebody else's PATH. */}
          {runtime.clis === undefined ? (
            <span className="text-fg-subtle">
              Not shown — only the member who paired this machine sees its
              tools.
            </span>
          ) : (
            <CliInventory clis={runtime.clis} />
          )}
          {/* What this machine is holding, under what it can run: the counts
              the header of the old tree carried, in the one place that now
              names this machine. */}
          {summary && <span className="tabular-nums text-fg-muted">{summary}</span>}
        </span>
        <span className="flex justify-end">
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(runtime)}
              aria-label={`Remove ${runtime.name}`}
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
            runtime={runtime}
            kernels={kernels}
            taskLabel={taskLabel}
            now={now}
            onInterrupt={onInterrupt}
            onRestart={onRestart}
          />
        </ul>
      )}
    </li>
  );
}

function RuntimeTable({
  label,
  runtimes,
  kernels,
  taskLabel,
  now,
  meId,
  onInterrupt,
  onRestart,
  onRemove,
}: {
  label: string;
  runtimes: Runtime[];
  /** Every kernel the lab can see, across all machines — split per row here
   *  rather than by the caller, so a machine holding none is not a case
   *  anybody upstream has to remember to pass. */
  kernels: RunningKernel[];
  taskLabel: (taskId: string) => string;
  now: number;
  /** Which of these machines are the caller's own. Not a heading any more —
   *  one roster carries every machine — but still what decides which rows
   *  may offer Remove, and that is a rule about ownership, never about where
   *  a row happens to sit. */
  meId: string;
  onInterrupt: (kernelId: string) => void;
  onRestart: (kernelId: string) => void;
  onRemove: (runtime: Runtime) => void;
}) {
  if (runtimes.length === 0) return null;
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
          <span>CLIs</span>
          <span />
        </li>
        {runtimes.map((runtime) => (
          <RuntimeRow
            key={runtime.id}
            runtime={runtime}
            kernels={kernels.filter((k) => k.runtimeId === runtime.id)}
            taskLabel={taskLabel}
            now={now}
            onInterrupt={onInterrupt}
            onRestart={onRestart}
            // Passed only for a machine the caller owns, so the control
            // cannot be rendered against somebody else's in the first place.
            {...(runtime.ownerId === meId ? { onRemove } : {})}
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
  runtime,
  onClose,
  onConfirm,
}: {
  runtime: Runtime;
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
      subject={
        <p className="truncate text-ui font-medium text-fg">{runtime.name}</p>
      }
      body={
        <p className="text-sub leading-snug text-fg-subtle">
          Its daemon loses access to this lab immediately and has to be paired
          again to come back.
        </p>
      }
    />
  );
}

/**
 * How a machine gets into this lab, written as the three things a person
 * actually does.
 *
 * The middle one is the point. Pairing hands off to a page the daemon serves
 * on the machine itself, and until now nothing said so — a browser tab
 * appeared, from a command typed in a terminal, and whoever it happened to
 * had to work out that it was part of this. Saying it first turns a jump cut
 * into a handoff. The lab cannot link to that page: the port is whatever was
 * free, and the link carries a single-use nonce the daemon mints, which is
 * what stops any other page on this machine from driving pairing.
 *
 * Collapsed once the member has a machine, because then it is a chore rather
 * than the reason they are here.
 */
function AddAMachine({ firstMachine }: { firstMachine: boolean }) {
  const [open, setOpen] = useState(firstMachine);
  const command = `pnpm daemon --lab ${window.location.origin}`;

  // A member who already has a machine came for the roster, and a second
  // machine is a chore rather than the reason they are here — so it waits
  // behind one quiet line instead of holding a section of its own.
  if (!open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-4 flex items-center gap-2 rounded-md px-2 py-1.5 text-sub text-fg-muted hover:bg-surface-2 hover:text-fg"
      >
        <MonitorIcon width={14} height={14} />
        Add a machine
      </button>
    );

  return (
    <section className="mb-4">
      <BlockTitle>
        {firstMachine ? "Add your first machine" : "Add a machine"}
      </BlockTitle>
      <div className="rounded-lg border border-dashed border-line bg-surface p-5">
        {/* Three steps and nothing else. What a daemon is for is answered by
            the roster above once one is running, and a card that explained
            itself first put a paragraph between somebody and the command
            they came here to run. */}
        <ol className="flex flex-col">
          <Step n={1}>
            {/* The command, not a path — a researcher reading this has a
                browser open and nothing else, and a file name they cannot
                click is somewhere they still have to be told how to get to.
                The lab's own address is filled in because it is the one
                part of this they would otherwise have to go and find. */}
            <span className="text-fg">
              In a checkout of this workspace, on the machine you want to add:
            </span>
            <CopyCommand command={command} />
          </Step>
          <Step n={2}>
            <span className="text-fg">
              A setup page opens in your browser, served by that machine
            </span>
            <span className="mt-0.5 block text-fg-subtle">
              Name the machine there. The page is the daemon's own, on this
              side of the network — the lab cannot link to it.
            </span>
          </Step>
          <Step n={3} last>
            <span className="text-fg">Approve the request back here</span>
            <span className="mt-0.5 block text-fg-subtle">
              The machine then appears above, and stays until you remove it.
            </span>
          </Step>
        </ol>
      </div>
    </section>
  );
}

/**
 * The command, with a way to take it.
 *
 * It is meant to be run somewhere else — on the machine being added, which is
 * often not the one reading this — so it is copied far more often than it is
 * typed, and selecting monospace text by hand across a line break is the kind
 * of small failure that ends an onboarding.
 *
 * The control is the transcript's own `CopyButton`, not a second one shaped
 * like it: one drawing of Copy across the app, and its "Copied" is already the
 * right answer to "did that do anything" — said once and then dropped, because
 * nothing was lost and nothing needs confirming. Bare rather than bordered,
 * which is what taking that control brings with it: the field it sits in is
 * already a box, and a pill inside it drew a second one.
 */
function CopyCommand({ command }: { command: string }) {
  return (
    <span className="mt-1.5 flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2">
      <code className="min-w-0 flex-1 select-all break-all font-mono text-meta leading-relaxed text-fg-tertiary">
        {command}
      </code>
      {/* Named, unlike the transcript's: there the message above answers "copy
          what", and here the word alone would not. */}
      <span className="shrink-0">
        <CopyButton text={command} label="Copy the command" />
      </span>
    </span>
  );
}

/** One numbered line of the three, ruled off from the next the way the rows
 *  above it are. The number is decorative — the list is already ordered, and
 *  a screen reader counting it aloud a second time is noise. */
function Step({
  n,
  last,
  children,
}: {
  n: number;
  last?: boolean;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-3 py-2.5 text-sub leading-relaxed",
        !last && "border-b border-line-soft",
      )}
    >
      <span
        aria-hidden="true"
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-line bg-surface-2 text-meta font-medium text-fg-tertiary"
      >
        {n}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </li>
  );
}

export function RuntimesList({
  runtimes,
  kernels = [],
  taskLabel = () => "",
  now = 0,
  meId,
  onInterrupt = () => {},
  onRestart = () => {},
}: {
  runtimes: Runtime[];
  /** What the lab can see running, for the rows to open onto. Defaulted, so
   *  a caller that only wants the roster — and every test that predates the
   *  kernels living here — still gets one. */
  kernels?: RunningKernel[];
  taskLabel?: (taskId: string) => string;
  now?: number;
  /** `null` while the caller's identity is unknown — not yet answered, or
   *  the answer failed. The roster needs it to decide which rows may offer
   *  Remove; the onboarding card below does not. */
  meId: string | null;
  onInterrupt?: (kernelId: string) => void;
  onRestart?: (kernelId: string) => void;
}) {
  const api = useApi();
  const invalidate = useInvalidateData();
  const [pendingRemove, setPendingRemove] = useState<Runtime | null>(null);

  const removeRuntime = async (runtimeId: string) => {
    await api.removeRuntime(runtimeId);
    setPendingRemove(null);
    invalidate();
  };

  // The screen around this owns the scroll, so that the roster and the
  // environments below it move together rather than each holding a viewport
  // of its own.
  return (
    <div>
      {meId !== null && (
        <RuntimeTable
          label="Lab's machines"
          // One roster: the lab's machines are the lab's, and splitting them
          // into "yours" and "theirs" made a heading out of something every
          // row already says for itself — a Remove control, and a CLIs cell
          // that reads "not shown" on a machine that is not the caller's.
          // The caller's own still read first, so the machines they can act
          // on do not have to be hunted for in a roster of somebody else's.
          runtimes={[
            ...runtimes.filter((r) => r.ownerId === meId),
            ...runtimes.filter((r) => r.ownerId !== meId),
          ]}
          kernels={kernels}
          taskLabel={taskLabel}
          now={now}
          meId={meId}
          onInterrupt={onInterrupt}
          onRestart={onRestart}
          onRemove={setPendingRemove}
        />
      )}

      <AddAMachine
        // The first machine is onboarding; the second is a chore. Somebody
        // with none is on this screen to be told what to do, so the steps
        // are the page. Somebody who already has one came for the roster,
        // and the same card left open would be the loudest thing on it.
        //
        // An unknown `meId` matches no machine, so it resolves to onboarding
        // — which is the right way round: the steps are safe to show someone
        // who turns out to have a machine already, and hiding them from
        // someone who has none because their identity failed to resolve
        // would take away the one thing this screen is for.
        firstMachine={!runtimes.some((r) => r.ownerId === meId)}
      />

      {pendingRemove && (
        <RemoveMachineModal
          runtime={pendingRemove}
          onClose={() => setPendingRemove(null)}
          onConfirm={() => removeRuntime(pendingRemove.id)}
        />
      )}
    </div>
  );
}

export default RuntimesList;
