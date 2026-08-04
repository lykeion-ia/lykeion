import { useState } from "react";
import { isLykeionError } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { type PairParams } from "../router";
import { AuthShell } from "./auth-chrome";

/** Every field the daemon's link is expected to carry. Used both to decide
 *  whether there is a request to show at all and to build the call to
 *  `pairMachine` once there is. */
const REQUIRED_KEYS = [
  "name",
  "platform",
  "version",
  "challenge",
  "state",
  "redirect",
] as const;

function isComplete(params: PairParams): params is Required<PairParams> {
  return REQUIRED_KEYS.every((key) => {
    const value = params[key];
    return value !== undefined && value !== "";
  });
}

/**
 * Where this browser records the pairing links it has already turned into a
 * code. Not what holds the single-approval rule up — the lab refuses a
 * challenge whose code has been redeemed, whatever any browser remembers —
 * but what lets this screen say so without offering a live-looking form for
 * a request that was settled minutes ago, and then asking the lab to refuse
 * it.
 *
 * It also answers for the one case the lab deliberately allows: a code that
 * was minted and never redeemed leaves the request open, and the lab will
 * mint a second one for it. What was on the other end of the first will not
 * be there to take it — the daemon exits when an exchange fails it — so a
 * link this browser has spent is finished either way.
 *
 * Keyed by the challenge, which a daemon mints once per pairing session and
 * holds for as long as that session lives. That session ends the moment it
 * is approved: the daemon closes it on success and exits on a failed
 * exchange, so a challenge in here can no longer reach the machine that
 * asked. Asking a running daemon for another link rotates only the nonce in
 * it, which happens before any approval and never lands here.
 */
const SPENT_LINKS_KEY = "lykeion.pair.spent-challenges";

/** How many to keep. Enough that a researcher pairing a rack of machines
 *  cannot push their own recent link out of the list, and bounded so this
 *  does not grow for the life of the browser profile. */
const SPENT_LINKS_KEPT = 25;

/** Storage is not always there to be read — a profile with site data
 *  blocked throws on access rather than answering empty. That costs this
 *  screen its record of what it has already approved and nothing else, so
 *  both directions fail quiet and the screen behaves as it would for a link
 *  it has never seen. */
function spentLinks(): string[] {
  try {
    const raw = window.localStorage.getItem(SPENT_LINKS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return [];
  }
}

function rememberSpentLink(challenge: string): void {
  const kept = [
    challenge,
    ...spentLinks().filter((entry) => entry !== challenge),
  ].slice(0, SPENT_LINKS_KEPT);
  try {
    window.localStorage.setItem(SPENT_LINKS_KEY, JSON.stringify(kept));
  } catch {
    return;
  }
}

/**
 * What a link that has already been approved gets, reached either from this
 * browser's own record of having spent it or from the lab refusing it. The
 * two arrive differently and mean one thing to the researcher reading them,
 * so they say one thing — chiefly how to get a link that does open something,
 * which is the part a person stuck here needs and cannot guess.
 */
function SpentLink() {
  return (
    <AuthShell
      title="That link has already been used"
      subtitle="A pairing link is good for exactly one approval, and this one is spent."
    >
      <p className="text-[13px] text-fg-muted">
        The machine it names may be paired already — Runtimes lists every
        machine this lab knows. If it is not, nothing is waiting on the far
        end of this link: the request behind it is finished either way.
      </p>
      <p className="mt-2.5 text-[13px] text-fg-muted">
        To pair that machine, restart its daemon — stop the one running there,
        with Ctrl-C in the terminal it is running in or{" "}
        <span className="font-mono text-fg-subtle">lykeion-daemon stop</span>,
        then start it again. It opens a fresh request as it comes up and
        prints a link for that one. Asking a daemon that is still running for
        another link, with{" "}
        <span className="font-mono text-fg-subtle">lykeion-daemon status</span>
        , is not the same thing: that gives a new address for this same
        request, which the lab refuses for the reason above.
      </p>
    </AuthShell>
  );
}

/**
 * The lab's own approval screen for a machine that has no identity yet. A
 * daemon starting cold sends the researcher's browser here — already
 * signed in — carrying what it claims to be: a name, a platform, its own
 * version, and a loopback address to send a code back to. Approving calls
 * `pairMachine`, which mints that code, and this screen's only job after
 * that is to leave for the address the daemon gave it.
 *
 * Reached only by a link the daemon printed — there is no path to it from
 * inside the workbench, the same way an invite link is reached only by
 * whoever was handed one.
 */
export function PairScreen({ params }: { params: PairParams }) {
  const api = useApi();
  const me = usePromise(() => api.currentUser(), [api]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the lab refuses the challenge as one it has already settled —
  // what a second browser gets, since `spentLinks` is the approving
  // browser's own record and says nothing about anybody else's approval.
  const [refusedAsSpent, setRefusedAsSpent] = useState(false);

  if (!isComplete(params)) {
    return (
      <AuthShell
        title="Nothing to approve"
        subtitle="This link doesn't say what machine is asking to join — open the one the daemon printed, not a shortened or hand-edited copy of it."
      >
        <p className="text-[13px] text-fg-muted">
          A pairing link names the machine asking to join and where to send
          the result back. This one is missing at least part of that.
        </p>
      </AuthShell>
    );
  }

  if (refusedAsSpent || spentLinks().includes(params.challenge)) {
    return <SpentLink />;
  }

  const identity = me.data
    ? me.data.email
    : me.error
      ? "unknown — could not confirm who is signed in"
      : "…";

  // Refusing is an answer, and the machine waiting on the other end of this
  // link is the one party that needs to hear it: nothing else tells a daemon
  // its request was turned down, and one that is never told waits for a code
  // that is not coming. So a refusal goes back the same way an approval does,
  // proving itself with the daemon's own state and carrying no code — which
  // is the whole difference between the two. The link is spent here as well,
  // so reopening it answers instead of offering an Approve that would undo
  // the refusal the researcher just made.
  const refuse = () => {
    rememberSpentLink(params.challenge);
    const target = new URL(params.redirect);
    target.searchParams.set("state", params.state);
    target.searchParams.set("refused", "1");
    window.location.assign(target.toString());
  };

  const approve = async () => {
    setBusy(true);
    setError(null);
    let code: string;
    try {
      ({ code } = await api.pairMachine({
        name: params.name,
        platform: params.platform,
        daemonVersion: params.version,
        challenge: params.challenge,
        redirect: params.redirect,
      }));
    } catch (err) {
      setBusy(false);
      // A challenge the lab has already settled is not a failed call to
      // report and offer again: there is nothing a second Approve can do
      // with it, and the way out is on another machine. It gets the screen
      // that says so, and is recorded here so a reload lands on the same
      // answer without asking the lab to refuse it twice.
      if (isLykeionError(err) && err.code === "conflict") {
        rememberSpentLink(params.challenge);
        setRefusedAsSpent(true);
        return;
      }
      // Everything else the server refuses for, it knows the reason for and
      // this screen does not: an address it will not redirect to, an
      // identity it would not accept. Its own words, not a generic failure —
      // a researcher deciding whether to try again needs to know which.
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    // Before the handoff, not after: the code exists from here on whatever
    // becomes of the navigation below, and it is the minting of one — not
    // its safe arrival — that spends this link.
    rememberSpentLink(params.challenge);
    // Leaves the application for the daemon's own loopback origin, so this
    // is a real navigation rather than anything the router mediates.
    const target = new URL(params.redirect);
    target.searchParams.set("code", code);
    target.searchParams.set("state", params.state);
    window.location.assign(target.toString());
  };

  return (
    <AuthShell
      title="Approve this machine?"
      subtitle={`Signed in as ${identity}. A daemon on another machine is asking to join this lab.`}
    >
      <dl className="mb-4 flex flex-col gap-1.5 text-[13px]">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-fg-subtle">Name</dt>
          <dd className="truncate text-fg">{params.name}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-fg-subtle">Platform</dt>
          <dd className="truncate text-fg">{params.platform}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-fg-subtle">Daemon version</dt>
          <dd className="truncate text-fg">{params.version}</dd>
        </div>
      </dl>
      {error && <p className="mb-3 text-[12.5px] text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={refuse}
          disabled={busy}
          className="rounded-md border border-line px-3.5 py-1.5 text-[13px] font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          Refuse
        </button>
        <button
          type="button"
          onClick={approve}
          disabled={busy}
          className="rounded-md bg-fg px-3.5 py-1.5 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Approving…" : "Approve"}
        </button>
      </div>
    </AuthShell>
  );
}

export default PairScreen;
