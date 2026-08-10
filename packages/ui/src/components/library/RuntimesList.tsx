import { useId, useState } from "react";
import type { Runtime } from "@lykeion/api";
import { useApi, useInvalidateData } from "../../api/ApiContext";
import { MonitorIcon } from "../icons";
import { ConfirmModal } from "../ui/ConfirmModal";
import { cn } from "../../lib/utils";
import { formatAgo } from "../../lib/task-meta";
import { SectionTitle } from "../settings/SettingsSection";

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
      <SectionTitle id={headingId}>{label}</SectionTitle>
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
            label="Elsewhere in the lab"
            runtimes={runtimes.filter((r) => r.ownerId !== meId)}
          />
        </>
      )}

      <div className="mt-4 flex items-start gap-3 rounded-lg border border-dashed border-line bg-surface p-4">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-surface-2 text-fg-subtle">
          <MonitorIcon width={16} height={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-ui font-medium text-fg">Add a computer</div>
          {/* What a daemon actually does today, and no more. The composer
              tells a researcher their own machine cannot run a session yet;
              a card promising queued work here would contradict it on the
              same build. */}
          <p className="mt-0.5 text-sub leading-relaxed text-fg-subtle">
            Run the local runtime daemon on any machine — laptop, workstation,
            or cloud instance — and it pairs with this lab, reports which
            coding-agent commands it found, and keeps saying it is still
            there. Running a turn on one is not possible yet.
          </p>
          {/* The command, not a path — a researcher reading this has a
              browser open and nothing else, and a file name they cannot
              click is somewhere they still have to be told how to get to.
              The lab's own address is filled in because it is the one part
              of this they would otherwise have to go and find. */}
          <p className="mt-1.5 text-sub leading-relaxed text-fg-subtle">
            In a checkout of this workspace, on the machine you want to pair:
          </p>
          <p className="mt-1 select-all font-mono text-meta leading-relaxed text-fg-tertiary">
            pnpm daemon --lab {window.location.origin}
          </p>
          <p className="mt-1.5 text-sub leading-relaxed text-fg-subtle">
            The same checkout has{" "}
            <span className="font-mono text-fg-tertiary">
              docs/running-the-daemon.md
            </span>
            , which walks through pairing, every flag, and where the machine's
            token is kept.
          </p>
        </div>
      </div>

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
