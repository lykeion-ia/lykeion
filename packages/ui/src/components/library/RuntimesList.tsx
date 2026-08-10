import { useId, useState, type ReactNode } from "react";
import type { Runtime } from "@lykeion/api";
import { useApi, useInvalidateData } from "../../api/ApiContext";
import { MonitorIcon } from "../icons";
import { ConfirmModal } from "../ui/ConfirmModal";
import { CopyButton } from "../tasks/CopyButton";
import { cn } from "../../lib/utils";
import { formatAgo } from "../../lib/task-meta";

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
  onRemove,
}: {
  runtime: Runtime;
  /** Present only for a row in "Your machines" — the control this renders
   *  must never reach a machine that is not the caller's own. */
  onRemove?: (runtime: Runtime) => void;
}) {
  const health = HEALTH_META[runtime.health];
  return (
    <li
      className={cn(
        "grid items-center gap-3 border-b border-line-soft px-3 py-2.5 text-ui",
        GRID_COLS,
      )}
    >
      <span className="truncate font-medium text-fg">{runtime.name}</span>
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
    </li>
  );
}

function RuntimeTable({
  label,
  runtimes,
  onRemove,
}: {
  label: string;
  runtimes: Runtime[];
  onRemove?: (runtime: Runtime) => void;
}) {
  // The heading IS the list's accessible name rather than a second copy of
  // the same words beside it. Two tables with identical column headers and
  // nothing between them are indistinguishable on screen, and the split is
  // the privacy rule made visible — which of these machines are yours.
  const headingId = useId();
  if (runtimes.length === 0) return null;
  return (
    <section className="mb-4">
      <BlockTitle id={headingId}>{label}</BlockTitle>
      <ul aria-labelledby={headingId}>
        <li
          className={cn(
            "grid items-center gap-3 border-b border-line px-3 py-2 text-meta font-medium uppercase tracking-[0.4px] text-fg-tertiary",
            GRID_COLS,
          )}
        >
          <span>Machine</span>
          <span>Health</span>
          <span>Last seen</span>
          <span>Platform</span>
          <span>CLIs</span>
          <span />
        </li>
        {runtimes.map((runtime) => (
          <RuntimeRow key={runtime.id} runtime={runtime} onRemove={onRemove} />
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
function AddAComputer({ firstMachine }: { firstMachine: boolean }) {
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
        Add a computer
      </button>
    );

  return (
    <section className="mb-4">
      <BlockTitle>
        {firstMachine ? "Add your first computer" : "Add a computer"}
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
  meId,
}: {
  runtimes: Runtime[];
  /** `null` while the caller's identity is unknown — not yet answered, or
   *  the answer failed. The grouped lists need it to sort "yours" from
   *  everyone else's; the onboarding card below does not. */
  meId: string | null;
}) {
  const api = useApi();
  const invalidate = useInvalidateData();
  const [pendingRemove, setPendingRemove] = useState<Runtime | null>(null);

  const removeRuntime = async (runtimeId: string) => {
    await api.removeRuntime(runtimeId);
    setPendingRemove(null);
    invalidate();
  };

  // The screen around this owns the scroll, so that the kernel tree above and
  // the environments below move with the roster rather than each holding a
  // viewport of its own.
  return (
    <div>
      {meId !== null && (
        <>
          <RuntimeTable
            label="Your machines"
            runtimes={runtimes.filter((r) => r.ownerId === meId)}
            onRemove={setPendingRemove}
          />
          <RuntimeTable
            label="Lab's machines"
            runtimes={runtimes.filter((r) => r.ownerId !== meId)}
          />
        </>
      )}

      <AddAComputer
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
