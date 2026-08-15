import { useEffect } from "react";
import type { AgentCli } from "@lykeion/api";
import { CloseIcon } from "../../components/icons";

/**
 * The one decision in this product that is the researcher's alone.
 *
 * An ACP adapter is a separate program from the agent it speaks for, and it
 * runs inside the boundary a session gets: read and write on the Lykeion-owned
 * agent home, which holds the credential that agent was signed in with, and
 * unrestricted network, because the agent has to reach its vendor's API. When
 * the vendor published it, or the ACP project did, that is the same trust the
 * researcher already extended by installing the CLI. When somebody else did,
 * it is not, and nothing about the program can make it so.
 *
 * So this states facts and stops. It does not score the publisher, does not
 * call the program safe or unsafe, and offers no recommendation — every one of
 * those would be Lykeion answering a question it cannot answer, on a screen
 * whose entire purpose is that the answer is not ours.
 *
 * Opened from the row that needs it rather than given a step of its own: the
 * list stays the single surface for agents, and the same modal answers a
 * consent asked for months later from Machines.
 */

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-sub text-fg-subtle">{label}</span>
      <span className="truncate font-mono text-sub text-fg">{value}</span>
    </div>
  );
}

export function ConsentModal({
  cli,
  onAllow,
  onDismiss,
}: {
  cli: AgentCli;
  /**
   * Absent wherever the answer could not be written down. An acceptance is
   * recorded in the daemon's own data directory, beside the pairing token,
   * because it decides what runs next to a credential only that account may
   * read — so a lab on another computer can show this and cannot record it.
   */
  onAllow?: (id: string) => void;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onClick={onDismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Run ${cli.name}'s adapter?`}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[460px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pb-3 pt-4">
          <h2 className="text-read font-semibold text-fg">{`Run ${cli.name}'s adapter?`}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onDismiss}
            className="grid h-7 w-7 place-items-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
          >
            <CloseIcon width={15} height={15} />
          </button>
        </div>

        <div className="space-y-3 px-5 pb-1">
          <p className="text-ui text-fg-muted">
            {`Lykeion did not publish this program and neither did ${cli.name}'s vendor. Running it means running code from a third party inside the boundary your sessions get.`}
          </p>

          <div className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-2 px-3 py-2.5">
            <Fact label="Program" value={cli.adapterCommand ?? cli.command} />
            {/* Named as missing rather than left blank. A build nobody can
                name is a build nobody can vet, which is itself part of the
                decision — and a blank beside a label reads as zero. */}
            <Fact label="Version" value={cli.adapterVersion ?? "it did not say"} />
            <Fact
              label="Published by"
              value={`neither ${cli.name}'s vendor nor the ACP project`}
            />
            <Fact label="On this machine at" value={cli.adapterPath ?? "not resolved"} />
          </div>

          {onAllow === undefined && (
            <p className="text-sub text-fg-subtle">
              This is recorded on the machine itself, beside its own sign-ins.
              Open that machine's own address to allow it — on that machine,
              run <span className="font-mono">lykeion open</span>.
            </p>
          )}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-md px-3 py-1.5 text-ui text-fg-muted hover:text-fg"
          >
            Not now
          </button>
          {onAllow !== undefined && (
            <button
              type="button"
              autoFocus
              onClick={() => onAllow(cli.id)}
              className="rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity hover:opacity-90"
            >
              Allow on this machine
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ConsentModal;
