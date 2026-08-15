import type { AgentCli } from "@lykeion/api";

/**
 * One agent on one machine, and what stands in its way.
 *
 * The states a row can be in are the rungs of the daemon's own ladder, and
 * they are deliberately not equal. Two of them are a person's to move — not
 * signed in, and a community adapter nobody has agreed to — and those get a
 * control. Every other one is a fact: the platform cannot confine anything,
 * the CLI is not installed, the isolation could not be demonstrated. A button
 * on one of those looks like the way out and does nothing, which is worse
 * than no button at all, so a held-back row carries none.
 */

/** Whether a row is one a researcher could sign in to right now: a CLI that
 *  was asked and said no. Absent is a CLI nothing got far enough to ask — see
 *  `AgentCli.signedIn` — and offering a sign-in there spawns nothing. */
function awaitsSignIn(cli: AgentCli): boolean {
  return cli.available && cli.signedIn === false && cli.heldBackReason === undefined;
}

/** Whether a row is waiting on the one decision only the researcher can make:
 *  running a program neither this agent's vendor nor the ACP project
 *  published, inside the boundary that holds this agent's credential. */
function awaitsConsent(cli: AgentCli): boolean {
  return (
    cli.available &&
    !cli.sessionReady &&
    cli.adapterProvenance === "community" &&
    cli.heldBackReason === undefined
  );
}

/**
 * The line under the name. One sentence, chosen by what the row is actually
 * waiting on rather than assembled from every fact at once — a row that
 * recited its whole state would make the reader do the sorting this is for.
 */
function detailFor(cli: AgentCli): string {
  if (!cli.available) {
    // The lower half is a shopping list, so this says what installing it
    // would take. A vendor adapter IS the CLI under a flag: install one thing
    // and it is done. No declared adapter at all means Lykeion has no way to
    // speak to it yet, whatever the researcher installs.
    if (cli.adapterProvenance === "vendor") return `${cli.command} · speaks ACP itself`;
    if (cli.adapterProvenance === undefined)
      return `${cli.command} · no ACP adapter is known yet`;
    return cli.command;
  }
  if (cli.heldBackReason !== undefined) return cli.heldBackReason;
  if (awaitsConsent(cli))
    return `published by an individual or a company that is neither ${cli.name}'s vendor nor the ACP project`;
  if (cli.signedIn === false) return "installed, and not signed in";
  if (cli.signedIn === true && cli.account !== undefined)
    // The account, because it is the whole proof the sign-in worked — and,
    // for anybody with two of them, the proof it worked as the right person.
    return `signed in as ${cli.account}`;
  if (cli.sessionReady) return "ready";
  return cli.sessionReadyReason ?? "";
}

export function AgentRow({
  cli,
  onSignIn,
  onReview,
}: {
  cli: AgentCli;
  /** Absent wherever nothing could start a sign-in — the lab displays this
   *  list, and only the machine's own front door can spawn a CLI login. */
  onSignIn?: (id: string) => void;
  /** Always supplied by the list, which owns the modal this opens. Reading
   *  the terms is worth doing wherever this row appears — including where the
   *  answer cannot be recorded, which the modal itself says. */
  onReview: (id: string) => void;
}) {
  const control = awaitsSignIn(cli) && onSignIn !== undefined ? (
    <button
      type="button"
      onClick={() => onSignIn(cli.id)}
      className="shrink-0 rounded-md bg-fg px-3 py-1 text-ui font-medium text-canvas transition-opacity hover:opacity-90"
    >
      Sign in
    </button>
  ) : awaitsConsent(cli) ? (
    <button
      type="button"
      onClick={() => onReview(cli.id)}
      className="shrink-0 rounded-md border border-line px-3 py-1 text-ui font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      Review
    </button>
  ) : null;

  return (
    <div
      data-testid={`row-${cli.id}`}
      className="flex items-center justify-between gap-4 border-b border-line py-2.5 last:border-b-0"
    >
      <span className="flex min-w-0 flex-col">
        <span className="text-read text-fg">{cli.name}</span>
        <span className="text-sub text-fg-subtle">{detailFor(cli)}</span>
      </span>
      {cli.available && cli.version !== "" && (
        <span className="shrink-0 font-mono text-sub text-fg-tertiary">{cli.version}</span>
      )}
      {control}
    </div>
  );
}

export default AgentRow;
