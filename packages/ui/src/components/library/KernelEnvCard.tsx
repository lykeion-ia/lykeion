import { useState } from "react";
import type { KernelEnvDeclaration, KernelEnvStatus, Language } from "@lykeion/api";
import { ChipIcon } from "../icons";
import { cn } from "../../lib/utils";
import { UNREPORTED } from "../../lib/format";

interface StateMeta {
  label: string;
  dotClass: string;
  textClass: string;
}

/**
 * What each state is called on this screen, and why these three words.
 *
 * `absent` is **not built here** rather than "not set up": the environment
 * exists — the lab declared it and a colleague may be running in it right
 * now — and the only thing missing is the gigabytes on THIS machine. "Not set
 * up" reads as a thing nobody has made yet, which is a different fact and
 * sends a researcher to the wrong place to fix it.
 *
 * `broken` is **half-built**, and telling it apart from `absent` is the whole
 * reason it renders differently: an interpreter present with no completion
 * marker beside it is what an interrupted provision leaves behind, and the fix
 * is to build it again rather than to build it for the first time. Given the
 * same word as `absent`, a researcher watching a build die would see it settle
 * into a state that looks like it never started.
 */
const STATE_META: Record<KernelEnvStatus["state"], StateMeta> = {
  ready: { label: "Built here", dotClass: "bg-success", textClass: "text-success" },
  broken: { label: "Half-built", dotClass: "bg-warn", textClass: "text-warn" },
  absent: {
    label: "Not built here",
    dotClass: "bg-fg-tertiary",
    textClass: "text-fg-tertiary",
  },
};

function languageLabel(language: Language): string {
  return language === "r" ? "R" : "Python";
}

/** What this row is asking somebody to confirm, while it is asking. `null`
 *  the rest of the time, which is nearly always. */
type Asking = "reclaim" | "delete" | null;

/**
 * One managed environment, as a row under the machine that would run kernels
 * in it.
 *
 * Every environment the lab has declared appears under every machine, carrying
 * its state **there**: an environment nobody has built is visible rather than
 * missing, and a machine a revision behind says so.
 *
 * **No Set up control, deliberately.** An `absent` row here is information,
 * not a call to action — this screen is where a researcher understands what a
 * machine holds, not where they prepare it for work they have not started.
 * Setting up happens where the work is actually blocked, which is the Notebook.
 *
 * The two destructive actions are kept apart because their blast radii are
 * nothing alike, and a row offering them as a matched pair of buttons would be
 * inviting the mistake. Freeing this machine's copy is small, local and
 * reversible by anyone from the lockfile the lab still holds. Deleting the
 * environment removes the declaration for everybody.
 */
export function KernelEnvCard({
  status,
  declaration,
  machineName,
  onReclaim,
  onDelete,
}: {
  status: KernelEnvStatus;
  /** The lab's own declaration of this environment, when the caller has the
   *  list. Absent when it does not — and then this row says nothing about
   *  revisions rather than guessing that what is built here is current. */
  declaration?: KernelEnvDeclaration;
  /** Whose disk this row is about, so a confirmation can name it. One that
   *  does not is answered from memory of which row was clicked. */
  machineName: string;
  /** Frees this machine's own copy. Absent where the caller offers no such
   *  action, and the control is then not rendered at all. */
  onReclaim?: (name: string) => void;
  /** Removes the declaration lab-wide. Absent for an environment nobody may
   *  delete — Lykeion's own starter, which the core refuses (D7) and which
   *  must therefore not be offered here either. */
  onDelete?: (name: string) => void;
}) {
  const meta = STATE_META[status.state];
  const [asking, setAsking] = useState<Asking>(null);

  // The pin this machine built from, against the pin the lab currently holds.
  // Both have to be known: a declaration this caller never fetched, or a copy
  // nobody has built, leaves nothing to compare — and this stays silent rather
  // than calling an unknown revision an old one.
  const behind =
    status.lockRevision !== undefined &&
    declaration !== undefined &&
    declaration.lockRevision > status.lockRevision;

  // Only what this machine actually measured. `absent` carries no version and
  // no package count, and a `0 packages` invented for it would be a figure
  // nobody took — of a build that never happened.
  const facts = [
    status.version,
    status.packageCount !== undefined ? `${status.packageCount} packages` : null,
  ].filter((f): f is string => f !== null && f !== undefined);

  // Something is only freeable once something is on this disk. A Free control
  // on an `absent` row would offer to reclaim nothing.
  const freeable = status.state !== "absent";

  return (
    <li className="flex items-center gap-3 border-b border-line-soft py-2 pl-9 pr-3">
      <span
        aria-hidden="true"
        className="grid h-5 w-5 shrink-0 place-items-center rounded border border-line bg-surface-2 text-fg-tertiary"
      >
        <ChipIcon width={12} height={12} />
      </span>

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate font-mono text-meta text-fg">{status.name}</span>
          <span className="shrink-0 text-meta text-fg-tertiary">
            {languageLabel(status.language)}
          </span>
        </span>
        {behind && (
          <span className="mt-0.5 text-meta text-warn">
            A revision behind — built from {status.lockRevision}, the lab now pins{" "}
            {declaration?.lockRevision}
          </span>
        )}
      </span>

      {asking !== null ? (
        /* The confirmation, in the row rather than over the screen — the same
           shape the Stop control established, and for the same reason: what is
           being decided is this one row, and a modal would cover the state of
           every other machine at the moment somebody is deciding between them.
           The sentence names both the environment and the machine, because a
           confirmation that says only "Are you sure?" is answered from memory
           of which row was clicked. */
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-meta text-fg-muted">
            {asking === "reclaim"
              ? `Free ${status.name} from ${machineName}? It can be rebuilt from the lab's lockfile.`
              : `Delete ${status.name} for the whole lab? Every machine's copy becomes reclaimable.`}
          </span>
          <button
            type="button"
            onClick={() => {
              if (asking === "reclaim") onReclaim?.(status.name);
              else onDelete?.(status.name);
              setAsking(null);
            }}
            className="shrink-0 rounded-md border border-line-strong px-2 py-1 text-meta text-danger hover:bg-surface-2"
          >
            {asking === "reclaim" ? "Free" : "Delete"}
          </button>
          <button
            type="button"
            onClick={() => setAsking(null)}
            className="shrink-0 rounded-md px-2 py-1 text-meta text-fg-tertiary hover:bg-surface-2"
          >
            Cancel
          </button>
        </span>
      ) : (
        <>
          <span className="shrink-0 text-meta tabular-nums text-fg-tertiary">
            {facts.length > 0 ? facts.join(" · ") : UNREPORTED}
          </span>
          <span
            className={cn(
              "inline-flex w-[110px] shrink-0 items-center gap-1.5 text-meta",
              meta.textClass,
            )}
          >
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dotClass)} />
            {meta.label}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {onReclaim && freeable && (
              <button
                type="button"
                onClick={() => setAsking("reclaim")}
                aria-label={`Free ${machineName}'s copy of ${status.name}`}
                className="rounded-md border border-line px-2 py-1 text-meta text-fg-muted hover:bg-surface-2"
              >
                Free copy
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={() => setAsking("delete")}
                aria-label={`Delete the environment ${status.name} for the whole lab`}
                className="rounded-md border border-line px-2 py-1 text-meta text-fg-tertiary hover:bg-surface-2"
              >
                Delete for all
              </button>
            )}
          </span>
        </>
      )}
    </li>
  );
}

export default KernelEnvCard;
