import { useState } from "react";
import type { AgentCli } from "@lykeion/api";
import { AgentRow } from "../../components/agents/AgentRow";
import { ConsentModal } from "./ConsentModal";
import { cn } from "../../lib/utils";

/**
 * Step 3 of the first run, and the same surface again from Machines months
 * later: every agent this machine knows about, and what stands in each one's
 * way.
 *
 * Two groups, and only two, because installed-or-not is the one line a person
 * moves by doing something. Every other distinction a row can carry — signed
 * in, held back, waiting on a decision — is a state that changes underneath
 * them as probe cycles land, and a screen grouped on those would have rows
 * jumping between headings while they read it.
 *
 * The headers are bare and the chips carry the counting. One number, in one
 * place, is one thing to keep true; a header that counted as well would be a
 * second copy to hold in agreement with the first as rows move.
 *
 * Every catalogue row is listed, including the ones this machine has not got.
 * That is what makes the lower half useful: it is the answer to "what else
 * could I run here", which nothing else in the product gives.
 */

type Which = "all" | "installed" | "not-installed";

function Chip({
  label,
  count,
  on,
  onPick,
}: {
  label: string;
  count: number;
  on: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={on}
      className={cn(
        "inline-flex h-8 shrink-0 items-center rounded-md border px-2.5 text-ui transition-colors",
        on
          ? "border-line-strong bg-surface-2 text-fg"
          : "border-line text-fg-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      {/* Label and count as one text node on purpose. Wrapping the number to
          style it would make the button's own text read as the bare label,
          which is what the group heading below says — and then neither could
          be found without finding the other. */}
      {`${label} ${count}`}
    </button>
  );
}

function Group({ title, clis, onSignIn, onReview }: {
  title: string;
  clis: AgentCli[];
  onSignIn?: (id: string) => void;
  onReview: (id: string) => void;
}) {
  if (clis.length === 0) return null;
  return (
    <section className="mt-6 first:mt-0">
      <h2 className="mb-1 text-ui font-semibold text-fg">{title}</h2>
      <div>
        {clis.map((cli) => (
          <AgentRow key={cli.id} cli={cli} onSignIn={onSignIn} onReview={onReview} />
        ))}
      </div>
    </section>
  );
}

export function AgentsScreen({
  clis,
  platformCanConfine = true,
  compact = false,
  onSignIn,
  onReview,
  onAllow,
  onDismiss,
  onSkip,
  boundList = false,
}: {
  clis: AgentCli[];
  /** False on a platform with no sandbox backend, where no agent is offered
   *  at all — see the daemon's `noBackendReason`. */
  platformCanConfine?: boolean;
  /** Drops the title and the sentence under it, for a caller that is already
   *  saying which machine this is. In the first run this list is the whole
   *  page; under Machines it is one block beneath a heading that names the
   *  computer, and a second title there would say the same thing twice at the
   *  same weight. */
  compact?: boolean;
  onSignIn?: (id: string) => void;
  /** Told which agent's terms were opened. The modal itself is this list's —
   *  it is opened from a row rather than given a step of its own, so the list
   *  stays the single surface for agents. */
  onReview?: (id: string) => void;
  /**
   * Records the acceptance. Absent wherever it could not be written down —
   * an acceptance lives in the daemon's own data directory beside the pairing
   * token, because it decides what runs next to a credential only that
   * account may read, so a lab on another computer can show the terms and
   * cannot record the answer.
   */
  onAllow?: (id: string) => void;
  /** Told that the terms were read and declined. Declining is not a deletion
   *  and not an error: the row goes back to being held back, with Review
   *  still on it. */
  onDismiss?: () => void;
  /** Given during the first run, where leaving is a step. Absent in Machines,
   *  which nobody is passing through. */
  onSkip?: () => void;
  /**
   * Caps the rows at a height and scrolls them inside it, so this step is a
   * card the size of the other two rather than a page of its own.
   *
   * For the first run and nowhere else. Every other step of the wizard is a
   * short block centred in the window; this one lists the whole catalogue, so
   * at twelve agents it stood three times taller than step 1 and turned the
   * flow's last screen into something that scrolled. The ceiling is on the
   * rows alone — the title, the chips that filter them and the way out stay
   * where the eye already found them, which is what makes scrolling the rows
   * read as a list with more in it rather than as a page continuing.
   *
   * Machines passes nothing: there the list IS the page, it is arrived at
   * rather than passed through, and a second scrolling region inside a screen
   * that already scrolls is a worse answer than a long list.
   */
  boundList?: boolean;
}) {
  const [which, setWhich] = useState<Which>("all");
  /** Whose terms are open, by agent id. */
  const [reviewing, setReviewing] = useState<string | null>(null);

  const review = (id: string) => {
    setReviewing(id);
    onReview?.(id);
  };
  const dismiss = () => {
    setReviewing(null);
    onDismiss?.();
  };
  const allow = (id: string) => {
    setReviewing(null);
    onAllow?.(id);
  };

  const installed = clis.filter((cli) => cli.available);
  const notInstalled = clis.filter((cli) => !cli.available);

  // Replaces the list rather than sitting above it. Every row would be held
  // back for this same reason, and a screen that said it eleven times would
  // read as eleven problems rather than as one fact about the computer.
  if (!platformCanConfine) {
    return (
      <div>
        {!compact && (
          <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.03em] text-fg">
            Not on this computer
          </h1>
        )}
        <p className="mt-3 max-w-[34rem] text-read leading-relaxed text-fg-muted">
          Lykeion can only confine a run on macOS today, and it will not start
          an agent it cannot confine. Nothing here is missing or misconfigured
          — this is not a machine Lykeion runs agents on yet.
        </p>
        <p className="mt-3 max-w-[34rem] text-read leading-relaxed text-fg-muted">
          It can still hold Studies and Tasks. Pair a Mac to this lab and the
          work you file here runs there.
        </p>
        {onSkip !== undefined && (
          <button
            type="button"
            onClick={onSkip}
            className="mt-6 rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity hover:opacity-90"
          >
            Continue
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      {!compact && (
        <>
          <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.03em] text-fg">
            Agents on this machine
          </h1>
          <p className="mt-3 max-w-[34rem] text-read leading-relaxed text-fg-muted">
            Sign in to the ones you want to run. You can do this later —
            nothing here is required to finish setting up.
          </p>
        </>
      )}

      <div className="mt-6 flex items-center gap-2">
        <Chip label="All" count={clis.length} on={which === "all"} onPick={() => setWhich("all")} />
        <Chip
          label="Installed"
          count={installed.length}
          on={which === "installed"}
          onPick={() => setWhich("installed")}
        />
        <Chip
          label="Not installed"
          count={notInstalled.length}
          on={which === "not-installed"}
          onPick={() => setWhich("not-installed")}
        />
      </div>

      <div className={cn("mt-5", boundList && "max-h-[16rem] overflow-y-auto pr-2")}>
        {which !== "not-installed" && (
          <Group title="Installed" clis={installed} onSignIn={onSignIn} onReview={review} />
        )}
        {which !== "installed" && (
          <Group title="Not installed" clis={notInstalled} onSignIn={onSignIn} onReview={review} />
        )}
      </div>

      {/* Looked up by id rather than held as an object, so a probe cycle that
          lands while the terms are open redraws them from the fresh row —
          including an adapter that has since moved or been upgraded, which is
          exactly the fact somebody is standing here deciding about. */}
      {reviewing !== null && clis.some((cli) => cli.id === reviewing) && (
        <ConsentModal
          cli={clis.find((cli) => cli.id === reviewing)!}
          onAllow={onAllow === undefined ? undefined : allow}
          onDismiss={dismiss}
        />
      )}

      {/* Owned here rather than by the wizard frame around it. This screen is
          also Machines, where there is no wizard and leaving still has to be
          possible — and a frame that supplied the only way out would leave
          the same list with no way out on the surface people return to. */}
      {onSkip !== undefined && (
        <button
          type="button"
          onClick={onSkip}
          className="mt-8 rounded-md px-3 py-1.5 text-ui text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          Skip
        </button>
      )}
    </div>
  );
}

export default AgentsScreen;
