import { useState } from "react";
import { decodeRequest, isLykeionError, type PairRequest } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { type PairParams } from "../router";
import { AuthShell } from "./auth-chrome";
import { Wizard } from "./setup/Wizard";
import { drawsSetupStep } from "./setup/SetupFlow";

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

/** The six a request cannot do without, proven present. `step` is
 *  deliberately not among them and stays optional: it says whether this
 *  approval is happening inside a first run, and most are not. */
type CompleteRequest = PairParams &
  Required<Pick<PairParams, (typeof REQUIRED_KEYS)[number]>>;

function isComplete(params: PairParams): params is CompleteRequest {
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
      <p className="text-ui text-fg-muted">
        The machine it names may be paired already — Machines lists every
        machine this lab knows. If it is not, nothing is waiting on the far
        end of this link: the request behind it is finished either way.
      </p>
      <p className="mt-2.5 text-ui text-fg-muted">
        To pair that machine, restart its daemon — stop the one running there,
        with Ctrl-C in the terminal it is running in or{" "}
        <span className="font-mono text-fg-subtle">lykeion stop</span>, then
        start it again. It opens a fresh request as it comes up and prints a
        link for that one. Asking a daemon that is still running for another
        link, with <span className="font-mono text-fg-subtle">lykeion open</span>
        , is not the same thing: that gives a new address for this same
        request, which the lab refuses for the reason above.
      </p>
    </AuthShell>
  );
}

/** What a link that arrived with only part of a request gets: a link that
 *  was truncated by a chat window or edited by hand. Distinct from an empty
 *  hash, which is not a broken link at all — see `PasteRequest`. */
function NothingToApprove() {
  return (
    <AuthShell
      title="Nothing to approve"
      subtitle="This link doesn't say what machine is asking to join — open the one the daemon printed, not a shortened or hand-edited copy of it."
    >
      <p className="text-ui text-fg-muted">
        A pairing link names the machine asking to join and where to send the
        result back. This one is missing at least part of that.
      </p>
    </AuthShell>
  );
}

/**
 * The way in for a machine that cannot use the ordinary one.
 *
 * A pairing link assumes two things: a browser on the machine asking, and a
 * network path from the researcher's browser back to that machine's loopback
 * address. A cluster node reached over SSH has neither, and no amount of
 * tunnelling should be the price of joining a lab. So its daemon prints the
 * same request as one line, and a person carries it here.
 *
 * Reached by opening `#/pair` with nothing after it, which is why an empty
 * hash is not treated as a broken link. Somebody arriving here by accident
 * is told what the line looks like and where it comes from, which is the
 * only thing they could be missing.
 */
function PasteRequest({ onRead }: { onRead: (request: PairRequest) => void }) {
  const [text, setText] = useState("");
  const [unreadable, setUnreadable] = useState(false);

  const read = () => {
    const request = decodeRequest(text);
    // One refusal for every way it can fail, because they are one thing to
    // the person who pasted it. The line is opaque; there is nothing useful
    // to say about *which* part of it did not parse, and plenty to say
    // about how to get a whole one.
    if (request === undefined) return setUnreadable(true);
    onRead(request);
  };

  return (
    <AuthShell
      title="Add a machine by hand"
      subtitle="For a machine with no browser of its own — a cluster node, a server, anything you reach over SSH."
    >
      <p className="mb-4 text-ui text-fg-muted">
        Start its daemon with{" "}
        <span className="font-mono text-fg-subtle">--no-browser</span>. It
        prints one line beginning{" "}
        <span className="font-mono text-fg-subtle">LYK1.</span> — paste the
        whole of it here.
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-meta font-medium uppercase tracking-[0.4px] text-fg-tertiary">
          The line that machine printed
        </span>
        <textarea
          value={text}
          rows={4}
          autoFocus
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value);
            // Cleared as they edit: a refusal standing over text that has
            // changed since is describing something that is no longer there.
            setUnreadable(false);
          }}
          className="w-full resize-y rounded-md border border-line bg-surface-2 px-2 py-1.5 font-mono text-sub break-all text-fg outline-none focus:border-line-strong focus-visible:outline-none!"
        />
      </label>
      {unreadable && (
        <p className="mt-2 text-sub text-danger">
          That is not a request this lab can read. Copy the whole line, from{" "}
          <span className="font-mono">LYK1.</span> to the end — a terminal may
          have wrapped it across more than one row.
        </p>
      )}
      <button
        type="button"
        onClick={read}
        disabled={text.trim() === ""}
        className="mt-4 rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Read it
      </button>
    </AuthShell>
  );
}

/**
 * The end of the by-hand path: the code, and the one thing left to do with
 * it. Shown instead of a redirect because the address in a pasted request is
 * a loopback address on somebody else's machine — following it would land
 * this browser on nothing and lose the code doing it.
 */
function CodeToCarry({ name, code }: { name: string; code: string }) {
  return (
    <AuthShell
      title="Approved"
      subtitle={`${name} has joined this lab, and needs this code to hear about it.`}
    >
      <p className="rounded-md border border-line bg-surface-2 px-3 py-2.5 text-center font-mono text-ui break-all text-fg">
        {code}
      </p>
      <p className="mt-3 text-ui text-fg-muted">
        Back on that machine, run{" "}
        <span className="font-mono text-fg-subtle">lykeion pair --code</span>{" "}
        followed by the code above.
      </p>
      <p className="mt-2.5 text-sub text-fg-subtle">
        It is good once, and for five minutes. If it expires, stop that
        daemon and start it again — it opens a fresh request and prints a new
        line to paste.
      </p>
    </AuthShell>
  );
}

/**
 * A by-hand request that was turned down. Its own screen rather than the
 * link path's redirect, because there is nobody to redirect to: this browser
 * cannot reach that daemon, which is the whole reason the request came in on
 * a person. Saying that plainly matters — a researcher who assumed the
 * machine had been told would leave it waiting.
 */
function RefusedByHand({ name }: { name: string }) {
  return (
    <AuthShell
      title="Refused"
      subtitle={`${name} has not joined this lab, and no code was made for it.`}
    >
      <p className="text-ui text-fg-muted">
        That machine has not been told. Nothing reaches it from here — a
        request that arrives by hand has no way back — so it will go on
        waiting until somebody stops its daemon.
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
 * Reached by a link the daemon printed, or — for a machine that has no
 * browser and no route back to its own loopback address — by a person
 * pasting the same request in as one line. The handshake is identical
 * either way; what differs is that the by-hand path shows the code instead
 * of leaving for an address it cannot reach.
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
  // A request that arrived on a person rather than in the address bar. Once
  // read it stands in for the hash, and everything below is the same screen.
  const [pasted, setPasted] = useState<PairRequest | undefined>(undefined);
  const [codeToCarry, setCodeToCarry] = useState<string | null>(null);
  const [refusedByHand, setRefusedByHand] = useState(false);

  const request: PairParams = pasted ?? params;
  const byHand = pasted !== undefined;

  if (!isComplete(request)) {
    // An empty hash is not a broken link — it is how this screen is reached
    // on purpose, by somebody holding a line their machine printed. A hash
    // carrying *part* of a request is a link that lost something on the way.
    if (REQUIRED_KEYS.every((key) => params[key] === undefined)) {
      return <PasteRequest onRead={setPasted} />;
    }
    return <NothingToApprove />;
  }

  if (codeToCarry !== null) {
    return <CodeToCarry name={request.name} code={codeToCarry} />;
  }

  if (refusedByHand) return <RefusedByHand name={request.name} />;

  if (refusedAsSpent || spentLinks().includes(request.challenge)) {
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
    // Nothing is spent on the by-hand path, and the record would be a lie
    // if it said otherwise: no code was minted and no daemon was told, so
    // the request on that machine really is still open. A researcher who
    // changes their mind and pastes the line again should find it live.
    if (byHand) return setRefusedByHand(true);
    rememberSpentLink(request.challenge);
    const target = new URL(request.redirect);
    target.searchParams.set("state", request.state);
    target.searchParams.set("refused", "1");
    window.location.assign(target.toString());
  };

  const approve = async () => {
    setBusy(true);
    setError(null);
    let code: string;
    try {
      ({ code } = await api.pairMachine({
        name: request.name,
        platform: request.platform,
        daemonVersion: request.version,
        challenge: request.challenge,
        redirect: request.redirect,
      }));
    } catch (err) {
      setBusy(false);
      // A challenge the lab has already settled is not a failed call to
      // report and offer again: there is nothing a second Approve can do
      // with it, and the way out is on another machine. It gets the screen
      // that says so, and is recorded here so a reload lands on the same
      // answer without asking the lab to refuse it twice.
      if (isLykeionError(err) && err.code === "conflict") {
        rememberSpentLink(request.challenge);
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
    rememberSpentLink(request.challenge);
    // The address in a by-hand request is a loopback address on a machine
    // this browser cannot reach — following it would land on nothing and
    // lose the code doing it. So the code is shown to the person who is
    // going to carry it there.
    if (byHand) return setCodeToCarry(code);
    // Leaves the application for the daemon's own loopback origin, so this
    // is a real navigation rather than anything the router mediates.
    const target = new URL(request.redirect);
    target.searchParams.set("code", code);
    target.searchParams.set("state", request.state);
    window.location.assign(target.toString());
  };

  // Inside a first run, or opened cold? Only a daemon composing its own
  // redirect says which step this is, so a marker that is not a step this
  // build draws — a value somebody typed into the address — is no marker.
  const insideStep = Number(request.step);
  const inWizard = Number.isInteger(insideStep) && drawsSetupStep(insideStep);

  const shell = (
    <AuthShell
      title="Approve this machine?"
      subtitle={`Signed in as ${identity}. A daemon on another machine is asking to join this lab.`}
      // The wizard supplies the full-height frame and the strip beneath it, so
      // this must not claim the window as well — a second `min-h-screen` makes
      // the page taller than the viewport and pushes the dots below the fold.
      framed={!inWizard}
    >
      <dl className="mb-4 flex flex-col gap-1.5 text-ui">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-fg-subtle">Name</dt>
          <dd className="truncate text-fg">{request.name}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-fg-subtle">Platform</dt>
          <dd className="truncate text-fg">{request.platform}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-fg-subtle">Daemon version</dt>
          <dd className="truncate text-fg">{request.version}</dd>
        </div>
      </dl>
      {error && <p className="mb-3 text-sub text-danger">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={refuse}
          disabled={busy}
          className="rounded-md border border-line px-3.5 py-1.5 text-ui font-medium text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          Refuse
        </button>
        <button
          type="button"
          onClick={approve}
          disabled={busy}
          className="rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Approving…" : "Approve"}
        </button>
      </div>
    </AuthShell>
  );

  // The count kept going. This screen belongs to the lab and is reached on a
  // different origin, which is why it wears nothing by default — a colleague
  // approving somebody else's machine from their own browser is in no wizard,
  // and dots there would claim a continuity that does not exist. A researcher
  // who arrived here from their own first run is the opposite case, and the
  // daemon that sent them said so.
  return inWizard ? (
    <Wizard step={insideStep} total={3}>
      {shell}
    </Wizard>
  ) : (
    shell
  );
}

export default PairScreen;
