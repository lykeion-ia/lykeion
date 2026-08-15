import { createHash, randomBytes } from "node:crypto";
import { execFile, type spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { encodeRequest } from "@lykeion/api/pair-code";
import { DAEMON_VERSION, type DaemonConfig } from "./config";
import { adapterOnThisMachine, catalogueOnThisMachine, platformTag } from "./probe";
import { labLabel, writeState, type PairedState } from "./state";
import { exchangeCode } from "./lab";
import { appPage, forwardTo, isForwarded, requestPath, serveApp, uiDirectory } from "./front-door";
import { agentAuthStates, startSignIn, type AgentAuth } from "./agent-auth";
import { forgetLabHere, recordLabHere } from "./lab-child";
import { acceptAdapter, revokeAdapter } from "./adapter-consent";
import {
  renderAgentSignInPage,
  renderExchangeFailurePage,
  renderExpiredLinkPage,
  renderExpiredRequestPage,
  renderForeignCallbackPage,
  renderMissingCodePage,
  renderNoSessionPage,
  renderRefusedPage,
  renderSetupPage,
} from "./pairing-pages";
import { secretsMatch } from "./secrets";

/** How long an unclicked link stays good for, and how long the request
 *  behind it waits for an answer. Long enough for a browser to actually be
 *  handed the link and open it; short enough that a link left sitting in a
 *  terminal scrollback is not a standing door into the lab.
 *
 *  It bounds one step rather than the whole flow. Every move a researcher
 *  makes — asking for another link, committing a lab and a name and leaving
 *  for the approval screen — starts it again, so the clock is always the
 *  time left to take the next step, never the time left to finish. A single
 *  span covering all of it would have to be long enough to include signing
 *  in to the lab, which is the one part of pairing this process cannot see
 *  and has no business timing. */
const REQUEST_TTL_SECONDS = 180;

const COOKIE_NAME = "lykeion_pair";

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Every path this server owns, listed so that the front door below cannot
 * take one over.
 *
 * Two of them exist for only part of a session — `/connect` and `/paired` are
 * not routed at all once this machine has paired — and a route that has
 * nothing to say must answer that it does not exist, not hand back the
 * application with a 200. `/` is listed even though every branch of it
 * answers today, because it is the path the nonce gate stands on: if one
 * branch ever stopped answering, an unadmitted browser would be handed the
 * application instead of the refusal, and the gate would have been walked
 * around without anyone editing it.
 */
const OWN_ROUTES = new Set([
  "/",
  "/connect",
  "/agents",
  "/agents/signin",
  "/agents/consent",
  "/paired",
  "/setup/topology",
  "/setup/challenge",
  "/setup/paired",
  "/setup/machine",
  "/setup/still-here",
]);

/**
 * A member said no. Distinguished from every other way pairing ends so the
 * daemon can answer it as the decision it is rather than as a fault: there
 * is nothing here to retry, and nothing wrong with this machine.
 */
export class PairingRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingRefused";
  }
}

export interface PairingSession {
  base: string;
  port: number;
  nonce: string;
  verifier: string;
  challenge: string;
  state: string;
  dataDir: string;
  /** Resolves once a browser has carried a code back through `/paired` and
   *  the lab has traded it for a token that is now on disk. */
  paired: Promise<PairedState>;
  /**
   * Mints a fresh nonce and answers with the link that carries it. Handing
   * out a second link has to retire the first — otherwise every link ever
   * printed stays live, and the guard on this page becomes a list of
   * doors rather than one. The three-minute life starts again from here,
   * so a link minted for somebody an hour into a daemon's run is as good
   * as the one printed at startup.
   */
  rotateNonce(): string;
  /**
   * Points this session's forwarded prefixes at a lab that has just started
   * behind this daemon.
   *
   * Exists because the lab can arrive after the session does: a first run
   * serves its own setup page, asks where the lab lives, and starts one only
   * once the researcher has answered. Until this is called the session
   * forwards nothing and refuses the co-located routes, which is the truth
   * about a daemon with no lab behind it.
   */
  serveLabThrough(labPort: number): void;
  /**
   * Throws away this request and opens another in its place — a new nonce,
   * and with it a new verifier, challenge and state — answering with the
   * link to the replacement. This is what an unanswered request expiring
   * amounts to, and the difference between it and {@link rotateNonce} is
   * everything a lab could already have been told: a rotated nonce leaves
   * the request the approval screen is looking at intact, and this ends it.
   */
  rotateRequest(): string;
  /**
   * The open request as one line a person can carry to another computer.
   *
   * Same request, different transport: the same challenge, state and three
   * facts a pairing link puts in a query string, encoded so they survive
   * being printed into a terminal and pasted into a browser somewhere else.
   * For a machine with no browser of its own and no route back to its own
   * loopback address, which is most of the machines research actually runs
   * on.
   *
   * Taking one stops the expiry timer for good — see `touchDeadline`. It is
   * derived from the live request, so {@link rotateRequest} still replaces
   * it; what must not replace it is a clock counting down while somebody is
   * walking to another building.
   */
  pasteRequest(): string;
  /**
   * Redeems a code a person carried back, by the exchange `/paired` makes.
   *
   * Settles `paired` exactly as the callback does, so a daemon waiting on
   * that promise goes on with its life without knowing which way the answer
   * arrived. Rejects rather than settling when the lab refuses: a failed
   * exchange is not a refused request, and the request this session holds is
   * still the one that would succeed on another try.
   */
  redeemCode(code: string): Promise<PairedState>;
  close(): Promise<void>;
}

export interface StartPairingOptions {
  port: number;
  /** Defaults to a fresh temporary directory — convenient for a caller that
   *  only wants to drive the loopback server directly and never touches the
   *  file `beginPairing` would otherwise write into `config.dataDir`. */
  dataDir?: string;
  lab?: string;
  now?: () => number;
  /** Overrides {@link REQUEST_TTL_SECONDS}. A caller that needs to watch a
   *  request actually run out cannot wait three minutes to do it. */
  ttlSeconds?: number;
  /** Called when a request runs out of time and is replaced, with the link
   *  to its replacement. Nobody is looking at this process when it happens
   *  — that is what expiring means — so the new link has to be announced
   *  rather than waited for. */
  onRequestExpired?: (link: string) => void;
  /** Who each declared agent is signed in as, on this machine. Defaults to
   *  asking every agent's own CLI (`agentAuthStates`, confined the way
   *  `probe.ts` already confines the identical question — see
   *  `agent-auth.ts`). Injectable for the same reason `probe.ts`'s own
   *  `ProbeOptions.authStates` is — a session under test must not shell out
   *  to whatever the process's real `PATH` happens to resolve
   *  `claude`/`codex` to, and `/paired` answering only once that real,
   *  confined check has run is real wall-clock time a test asserting on
   *  this session's own request-expiry clock cannot spend for free. */
  authStates?: () => Promise<AgentAuth[]>;
  /** The `spawn` `POST /agents/signin` starts a sign-in with, handed
   *  straight through to `startSignIn` (`agent-auth.ts`). Defaults to a
   *  real `spawn` — production never overrides this. Injectable for the
   *  same reason `authStates` is, and for a sharper one: a test that hit
   *  this route with a real, declared agent id under the real default would
   *  launch a real, unconfined CLI login flow that opens a real browser
   *  against a real account, exactly what `agent-auth.test.ts` already
   *  avoids by injecting its own fake here. */
  signInSpawn?: typeof spawn;
  /** The PATH `POST /agents/signin` asks whether a declared agent's CLI is on
   *  before it starts anything, handed through to `startSignIn`. Defaults to
   *  this process's own. Injectable for the reason `signInSpawn` is: whether
   *  that route answers 202 or "not installed on this machine" must not
   *  depend on whether the machine running these tests happens to have Claude
   *  Code installed. */
  signInPath?: string;
  /** Where the built application this server also serves is, defaulting to
   *  `uiDirectory()` — the real one, two directories above this package.
   *  Injectable because the most delicate line in this file is the one that
   *  keeps the front door off the routes above it, and against the real
   *  directory that line is only under test on a machine where the UI happens
   *  to have been built: with nothing there, the front door answers its own
   *  404 and a test asserting a status alone cannot tell the two apart. */
  uiDir?: string;
  /**
   * The machine this daemon has already paired, when this session exists only
   * to serve the sign-in step again.
   *
   * D-5 says that step is "skippable, and reachable again later by re-opening
   * the daemon's local address", and `probe.ts`'s dock string tells whoever
   * skipped it — or whose token lapsed months later — to do exactly that.
   * Before this, the loopback server was created only inside `if (!machine)`,
   * so on every later start of a paired daemon the page that instruction
   * names did not exist at all.
   *
   * A session opened this way serves `/`, `/agents` and `/agents/signin` and
   * nothing else: `/connect` and `/paired` are not routed at all, so a paired
   * daemon cannot be talked into naming a different lab or spending a second
   * code. What guards the three it does serve is unchanged — the same
   * single-use nonce, the same HttpOnly cookie, the same origin gating.
   */
  alreadyPaired?: PairedState;
  /**
   * Where to send the routes the lab answers, when the lab runs on this
   * computer — `forwardTo(labPort)`, and nothing else in production.
   *
   * Undefined is the lab being somewhere else, which is every daemon that
   * joins a lab it did not start: those routes are then not this server's to
   * answer and it says so with a 404, exactly as before this existed.
   */
  forward?: (req: IncomingMessage, res: ServerResponse) => void;
  /**
   * Brings a lab up on this computer, called when the first run says the lab
   * lives here.
   *
   * A hook rather than something this module does itself: starting a child
   * process, supervising it and tearing it down on the way out belongs to
   * whoever owns this daemon's lifetime, and a pairing server that spawned
   * processes would own a lifetime it cannot see the end of. What this module
   * knows is when the researcher answered.
   *
   * It is expected to install forwarding through `serveLabThrough` before it
   * resolves, so that the next request — the application asking the lab who
   * it is — has somewhere to go.
   */
  onLabHere?: () => Promise<void>;
}

function readCookie(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("that request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("that request body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

/** How long `endAndFlush` waits on a response before giving up on hearing
 *  anything back about it at all. Everything it ever sends is a few hundred
 *  bytes over loopback — long enough to rule out "still delivering," not to
 *  wait out a connection that is never coming back. */
const FLUSH_TIMEOUT_MS = 3000;

/**
 * Sends a response and waits for Node to confirm what became of it —
 * delivered (`finish`), the connection already gone (`close`), or a write
 * that failed outright (`error`) — rather than returning the moment
 * `res.end()` is called. Every caller of this is about to do the last thing
 * its server will ever do with this client, deciding to end connections
 * outright, and doing that before the response it is standing on has
 * finished flushing would risk taking the very answer reporting success
 * down with it.
 *
 * A client that vanished during whatever was awaited before this is ever
 * called has already closed this response by the time this runs; a listener
 * attached only now cannot catch an event that already fired while this
 * call was waiting on something else, so that case is checked directly
 * rather than assumed away. Whichever of the three events fires first (or
 * the timeout, failing that) removes the other two before resolving, so
 * none of the rest can still fire into a call this has already settled.
 */
export function endAndFlush(
  res: ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string,
): Promise<void> {
  return new Promise((resolve) => {
    if (res.writableEnded || res.destroyed || res.closed) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      res.removeListener("finish", done);
      res.removeListener("close", done);
      res.removeListener("error", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, FLUSH_TIMEOUT_MS);
    timer.unref?.();
    res.once("finish", done);
    res.once("close", done);
    res.once("error", done);
    res.writeHead(status, headers);
    res.end(body);
  });
}

function sendHtmlAndFlush(res: ServerResponse, status: number, body: string): Promise<void> {
  return endAndFlush(res, status, { "content-type": "text/html; charset=utf-8" }, body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/**
 * Starts the loopback setup server: the nonce-guarded page a researcher's
 * browser lands on, the form that names the lab and this machine, and the
 * callback the lab's approval screen sends the browser back to.
 *
 * `options.lab`, when given, is what `/paired` uses to exchange a code
 * without a `/connect` call ever having happened — useful for a caller
 * exercising the callback directly, and exactly what a real run does too
 * when `--lab` was already given on the command line: the setup page still
 * shows the field, prefilled, but a machine that never touches it is
 * pairing with the lab it already named.
 */
export async function startPairing(options: StartPairingOptions): Promise<PairingSession> {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), "lykeion-daemon-"));

  const ttl = options.ttlSeconds ?? REQUEST_TTL_SECONDS;
  const uiDir = options.uiDir ?? uiDirectory();

  /** Whether this session was opened only to serve the sign-in step again,
   *  for a machine that is already paired — see `alreadyPaired`. Decides
   *  which routes exist at all, and is fixed for this session's whole life. */
  const signInOnly = options.alreadyPaired !== undefined;
  /**
   * The machine this session's `/` is serving the sign-in page for, once
   * there is one — set at construction for a session opened `alreadyPaired`,
   * and by `/paired` for one that pairs during its own run.
   *
   * Deliberately not the same question as `signInOnly`. Which routes exist is
   * decided when the session opens; what `/` renders follows whether this
   * machine has a token yet, so the tab a researcher leaves open through
   * pairing and the one they re-open a month later are the same page.
   */
  let pairedMachine: PairedState | undefined = options.alreadyPaired;

  /** Set by `mintRequest`, which is also what mints the first set, so the
   *  request this session starts life with and every later one are made the
   *  same way. */
  let verifier = "";
  let state = "";
  let challenge = "";
  /** The state of the request this one replaced, and only that one. A
   *  browser sent to the lab just before a request ran out comes back with
   *  it, and recognising it is the difference between telling that person
   *  their request expired and telling them their callback belongs to some
   *  other machine. It admits nothing: both answers refuse. */
  let previousState: string | undefined;

  /** Set by `rotateNonce`, which is also what mints the first one, so the
   *  link this session starts life with and every later one are made the
   *  same way and expire on the same clock. */
  let nonce = "";
  let nonceMintedAt = 0;
  let nonceSpent = false;
  /** The nonce `rotateNonce` last replaced, and only that one — the same
   *  one-generation-back shape `previousState` already keeps for `state`.
   *  What `pairedCookie` (below) is checked against alongside the live
   *  `nonce`: a tab admitted on this nonce and then still finishing
   *  pairing after a rotation carries exactly this value, not the live
   *  one, in its cookie. */
  let previousNonce: string | undefined;
  let currentLab = options.lab;

  /**
   * Where the lab's own routes go, when there is a lab behind this daemon.
   *
   * Held here rather than read off `options` on every request because it can
   * arrive AFTER this session opened: a first run serves its own setup page,
   * asks where the lab lives, and only then starts one. The session that
   * asked the question is the session that has to carry the answer.
   */
  let forward = options.forward;

  /**
   * Whether the lab this session pairs with is running behind this daemon.
   *
   * Read off the forwarding handler rather than off a flag, because that
   * handler IS the fact: it exists when, and only when, a lab child is up on
   * this computer and this daemon is the address in front of it. A separate
   * boolean could disagree with it, and the one it would be wrong about is
   * the case that decides whether an approval screen may be skipped.
   */
  const hasLocalLab = (): boolean => forward !== undefined;
  /** The request whose first successful `/connect` already chose its lab.
   *  Kept separate from `currentLab`: a lab supplied on the command line is
   *  merely a prefilled choice and remains editable until the browser
   *  actually commits this request. A later request has a different state
   *  and can choose again. */
  let committedState: string | undefined;
  /** Counts down to the open request being replaced. Re-armed by every step
   *  that shows somebody is still working through the flow. */
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Whether this session's request must stop expiring.
   *
   * Set by the two moments that put a person somewhere this process cannot
   * see, working on something a replaced request would ruin:
   *
   * - a paste request has been handed out, and whoever took it is walking to
   *   another computer to approve it;
   * - the researcher has answered that the lab lives HERE, and is now filling
   *   in the form that creates it.
   *
   * Both are the flow working, and in both the terminal goes quiet — which is
   * the only thing the expiry clock can actually measure. Never unset:
   * `rotateRequest` mints a new request, and the new one is just as committed
   * as the old, since whoever caused this is still on the same path.
   */
  let requestHeldOpen = false;
  /** True once this session has paired — set once, alongside `expiryTimer`
   *  being cleared, and never unset. `/connect` refuses outright once this
   *  is true, rather than `committedState` being reset to let a second one
   *  through: a session that has already turned a code into a token has
   *  nothing left to connect to a lab for, and resetting the field a
   *  same-session replay is guarded by would make the vulnerable case the
   *  default instead of the refused one.
   *
   *  True from the start for a session opened `alreadyPaired`, which has
   *  nothing left to connect anywhere for either. That session does not route
   *  `/connect` at all, so this is a second lock on a door already bricked
   *  up — kept because the first one is a routing decision somebody could
   *  undo without noticing what it was holding. */
  let settled = signInOnly;
  /** The cookie the request that actually completed `/paired`'s exchange
   *  carried, frozen at that moment — not the live, possibly-since-rotated
   *  `nonce`. `rotateNonce` can fire (from `status`, while this machine is
   *  still unpaired) in the window between a tab being admitted and the
   *  lab's callback reaching `/paired`, retiring the cookie that tab
   *  already carries off to the lab. `/paired` tolerates that by design —
   *  it proves itself by `state`, not by cookie — so the tab finishes
   *  regardless; `/agents` and `/agents/signin`, reachable only from the
   *  page that very response rendered, have to tolerate it too, or the
   *  page the daemon just served is bricked before its own script ever
   *  runs a single request.
   *
   *  Only ever set to a cookie this session actually issued — checked
   *  against `nonce` or `previousNonce`, below, never taken on faith from
   *  the request. Cookies are not port-scoped: on loopback, any other
   *  origin on `127.0.0.1` can set `document.cookie =
   *  "lykeion_pair=known; path=/paired"`, and RFC 6265 §5.4 sorts the
   *  longer path first, so `readCookie` would hand that attacker-chosen
   *  value straight back on the very request completing this exchange.
   *  Freezing it unchecked would let that value become this session's own
   *  accepted secret from that point on — worse than merely reachable,
   *  since a cookie set with `SameSite=None` turns `/agents/signin`'s
   *  already-CORS-simple POST into a working cross-origin one too. */
  let pairedCookie: string | undefined;

  /** Every call this server makes outward, and the one way to take them
   *  back. A lab that accepts a reachability probe or exchange and then
   *  never answers would otherwise outlive this session — and the daemon
   *  waiting on it — for the runtime's own request timeout. */
  const outboundCalls = new AbortController();

  /** `/agents` and `/paired` both answer this same question; asked through
   *  one binding so a test overriding it reaches both routes at once. */
  const readAgentAuthStates =
    options.authStates ?? (() => agentAuthStates({ dataDir, signal: outboundCalls.signal }));

  let resolvePaired!: (state: PairedState) => void;
  let rejectPaired!: (err: Error) => void;
  const paired = new Promise<PairedState>((resolve, reject) => {
    resolvePaired = resolve;
    rejectPaired = reject;
  });
  // A session opened for a machine that already holds a token has nothing to
  // wait for. Settled on the spot with what it was handed, so a caller
  // holding one of these has the same shape in hand as a caller holding a
  // session that pairs during its own run — and never a promise that can
  // only ever hang.
  if (options.alreadyPaired !== undefined) resolvePaired(options.alreadyPaired);

  /**
   * The only path that settles `paired` — `resolvePaired`/`rejectPaired`
   * are not called anywhere else in this function. A branch reached for
   * either directly, bypassing this, would settle before its own page had
   * actually gone out; funnelling both through the one function that always
   * flushes first is what makes that mistake require going out of its way
   * rather than being one call away.
   */
  async function finishPaired(
    res: ServerResponse,
    status: number,
    body: string,
    outcome: { ok: true; state: PairedState } | { ok: false; error: Error },
  ): Promise<void> {
    await sendHtmlAndFlush(res, status, body);
    if (outcome.ok) {
      // A paired session has no request left to expire: the one this timer
      // was counting down for just succeeded. Left running, it fires at
      // T+ttl regardless, announces a bogus expiry, and `rotateRequest` —
      // called from inside that very firing — mints a fresh, WORKING
      // pairing link and re-arms itself. Forever, on a machine that already
      // has a token. Closing the session the instant this branch ran used
      // to clear this same timer as a side effect (`close()`, below); now
      // that a paired session is kept open on purpose, to keep serving the
      // sign-in page `/paired` just rendered, this is what has to stop it
      // instead.
      settlePaired(outcome);
    } else {
      rejectPaired(outcome.error);
    }
  }

  /**
   * What pairing actually settles, with nothing said about how the answer was
   * rendered.
   *
   * Split out of `finishPaired` because the co-located path settles the same
   * session without an HTML page anywhere in it: the browser is already on
   * the application and is told in JSON. Two copies of this would be two
   * definitions of "paired", and the one that forgot to stop the timer would
   * mint a fresh, working pairing link on a machine that already holds a
   * token — which is exactly the failure the comment below exists for.
   */
  function settlePaired(outcome: { ok: true; state: PairedState }): void {
    // Before the timer is cleared, so nothing between the two lines can
    // arm another: `touchDeadline` refuses outright once this is set.
    pairedMachine = outcome.state;
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    resolvePaired(outcome.state);
  }

  let base = "";

  /**
   * Retires whatever nonce this session was guarded by and answers with the
   * link carrying its replacement. The cookie handed to a tab admitted on
   * the retired nonce stops being recognised at the same moment, which is
   * the whole point: one link, one browser, and asking for a new link says
   * the last one is not wanted any more. A tab that has already gone on to the
   * lab's approval screen still finishes — `/paired` recognises its own
   * callback by the state it minted, not by a cookie — so what this
   * actually retires is a form nobody has submitted yet.
   */
  function rotateNonce(): string {
    // Not recorded on the very first call: `nonce` is still `""`, the
    // startup sentinel nobody was ever handed, and `secretsMatch` treats
    // two empty strings as a match. Recording it anyway would let a
    // request that never carried a cookie at all — one sending
    // `lykeion_pair=` with nothing after the `=`, which `readCookie`
    // returns as `""`, not `undefined` — satisfy `pairedCookie`'s
    // `previousNonce` fallback for free, on every session, before a
    // single real nonce had ever been rotated out.
    if (nonce !== "") previousNonce = nonce;
    nonce = randomBytes(32).toString("base64url");
    nonceMintedAt = now();
    nonceSpent = false;
    touchDeadline();
    return `${base}/?nonce=${nonce}`;
  }

  /**
   * Starts the open request's span over, replacing whatever was left of the
   * last one. Called from every step that is evidence somebody is still
   * working through this flow, so what runs out is a stretch of nothing
   * happening rather than the flow's total length.
   *
   * Elapsed time here is real time, not the clock a caller can drive: this
   * measures nobody arriving, and a request that nothing reaches is one no
   * injected clock is being advanced for either. Re-arming cancels first,
   * so there is only ever one of these outstanding and a pushed span cannot
   * be ended by the timer it replaced.
   */
  function touchDeadline(): void {
    // A request somebody is part-way through is not a request nobody is
    // answering — it is the one case where an empty terminal is evidence the
    // flow is working. The clock this timer runs measures nobody arriving,
    // and on both of `requestHeldOpen`'s paths the person is expected to be
    // elsewhere: at another computer approving a pasted request, or in front
    // of a form that creates a lab. Rotating underneath either of them
    // replaces the challenge in play, and what they carry back then redeems
    // against a verifier that no longer exists.
    //
    // That failure was silent and it cost the whole pairing: rotating also
    // retires the cookie the open page holds, so `/setup/machine`,
    // `/setup/challenge` and `/setup/paired` all begin refusing a page that
    // is still on screen. The researcher creates their lab, the machine
    // quietly fails to join it, and nothing on the page says so.
    //
    // Safe to leave standing because the link is what expiring protects. A
    // pairing link is a door into this machine and closes on its own clock,
    // checked at `/` against `nonceMintedAt` and untouched by this.
    if (requestHeldOpen) return;
    // A machine that already holds a token has no request left to expire, and
    // arming this for one is not merely pointless: the timer's own callback
    // calls `rotateRequest`, which mints a fresh, WORKING pairing link and
    // announces it — forever, every ttl seconds, on a machine that is already
    // paired. `finishPaired` stops the timer that is running when a session
    // pairs; this is what keeps `rotateNonce` from arming another one
    // afterwards, now that a paired daemon mints an admission link too, on
    // request through `mintLink` rather than as a side effect of `status`.
    if (pairedMachine !== undefined) return;
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => {
      expiryTimer = undefined;
      options.onRequestExpired?.(rotateRequest());
    }, ttl * 1000);
    // Nothing is waiting on this: a daemon holds itself open on its own
    // listener, and a caller that has closed the session must not be kept
    // alive by a timer counting down to a request nobody is watching.
    expiryTimer.unref?.();
  }

  /** Mints the secrets one pairing request is made of. The challenge is
   *  what the lab is given and the verifier is what redeems it, so the two
   *  are only ever made together and replaced together. */
  function mintRequest(): void {
    verifier = randomBytes(32).toString("base64url");
    state = randomBytes(32).toString("base64url");
    challenge = createHash("sha256").update(verifier).digest("base64url");
  }

  function rotateRequest(): string {
    previousState = state;
    mintRequest();
    return rotateNonce();
  }

  /** @see PairingSession.pasteRequest */
  function pasteRequest(): string {
    requestHeldOpen = true;
    // The timer that is already armed, as well as the ones `touchDeadline`
    // will now decline to arm. Setting the flag alone would leave whatever
    // was counting down when this was called still counting.
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = undefined;
    return encodeRequest({
      name: hostname(),
      platform: platformTag(),
      version: DAEMON_VERSION,
      challenge,
      state,
      // The same callback the redirect names. Nobody on this path can open
      // it — that is the whole reason this path exists — but the lab still
      // checks it is loopback and this daemon still recognises its own, so
      // what changes here is who carries the answer, not what it is about.
      redirect: `${base}/paired`,
    });
  }

  /** @see PairingSession.redeemCode */
  async function redeemCode(code: string): Promise<PairedState> {
    // Before the lab is asked anything. A second code against a machine that
    // already holds a token would overwrite the identity it is running as,
    // and the same guard `/connect` and `/paired` stand behind.
    if (pairedMachine !== undefined) throw new Error("this machine has already paired");
    if (!currentLab)
      throw new Error(
        "this daemon does not know which lab to join — start it again with --lab <url>",
      );
    if (!code) throw new Error("that was not a code");
    const result = await exchangeCode(currentLab, code, verifier, outboundCalls.signal);
    const paired: PairedState = { lab: currentLab, ...result };
    writeState(dataDir, paired);
    settled = true;
    settlePaired({ ok: true, state: paired });
    return paired;
  }

  function authorized(req: IncomingMessage): boolean {
    const cookie = readCookie(req);
    return cookie !== undefined && secretsMatch(cookie, nonce);
  }

  /**
   * `authorized`'s counterpart for `/agents` and `/agents/signin`: either the
   * cookie frozen when this session paired, or the live `nonce`.
   *
   * Both, not one or the other. `pairedCookie` is what lets the tab that
   * carried pairing through keep working across a rotation that retired the
   * nonce it was admitted on — see `pairedCookie`'s own comment. The live
   * `nonce` is what lets a browser admitted *later*, on a link `status`
   * minted after this machine paired, use the page it was just served: `/`
   * admits that browser on the live nonce (`authorized`) and hands it the
   * sign-in page, and checking only `pairedCookie` here refused that page's
   * very first `/agents` poll and every `/agents/signin` it could send. That
   * is the same "bricked before its own script runs a single request"
   * failure `pairedCookie` exists to prevent, reintroduced from the other
   * side. A session that never paired in its own run has no `pairedCookie`
   * at all and is gated on the live nonce alone, which is exactly the gate a
   * daemon restarted `alreadyPaired` already ships with — so accepting it
   * here is no weaker than that.
   */
  function signInAuthorized(req: IncomingMessage): boolean {
    const cookie = readCookie(req);
    if (cookie === undefined) return false;
    if (pairedCookie !== undefined && secretsMatch(cookie, pairedCookie)) return true;
    return secretsMatch(cookie, nonce);
  }

  /**
   * Whether `req` carries proof of coming from somewhere other than this
   * daemon's own page: an `Origin` naming a different origin, or a
   * `Sec-Fetch-Site` other than `same-origin`. Either header being merely
   * absent — which a browser can still choose for a same-origin request
   * under some circumstances — is not itself refused; the admission
   * cookie a forged request cannot produce is what actually gates these
   * routes, this is a second, cheap layer on top of it. `/connect`'s own
   * two checks, factored out rather than duplicated a third time now that
   * `/agents` and `/agents/signin` need them too.
   */
  function crossOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== new URL(base).origin) return true;
    const fetchSite = req.headers["sec-fetch-site"];
    return fetchSite !== undefined && fetchSite !== "same-origin";
  }

  /**
   * What an admitted browser is shown at `/`: the form that names a lab and
   * this machine while there is still pairing to do, and the sign-in step
   * once there is not.
   *
   * One function rather than the three identical `renderSetupPage` calls this
   * route used to make, so the two pages cannot come apart on which one a
   * reload, a nonce and a cookie each get.
   */
  /**
   * What the link this daemon prints actually opens.
   *
   * The application, on the step this machine is up to — step 1 for a machine
   * with no identity yet, step 3 for one that has an identity and may still
   * want to sign an agent in. The same mechanism `/paired` uses, through the
   * same `appPage`, so how a step is carried into the page is decided once.
   *
   * Without this the first run was unreachable. Steps 1 to 3 live at
   * `#/setup/N` inside the application, `/` is a route this server owns so the
   * front door never offers it, and every branch here answered with a page of
   * the daemon's own — so the one address a researcher is ever given opened
   * the surface the wizard was written to replace.
   *
   * Both of those pages stay as the fallback, and that is not politeness: a
   * daemon running from source with no `ui/dist` has a real pairing request to
   * show and nothing to show it on, and its own page works everywhere.
   */
  async function landingPage(): Promise<string> {
    if (pairedMachine === undefined)
      return (
        // Step 1 only while the question step 1 asks is still open. Once a lab
        // is running here that question is answered, and what comes next —
        // creating the owner account IN that lab — lives behind the auth gate
        // rather than in the wizard's own route. Serving step 1 again would
        // ask a researcher where their lab lives while it is already running
        // behind the page they are reading.
        appPage(uiDir, hasLocalLab() ? undefined : 1, { workspace: hasLocalLab() }) ??
        renderSetupPage({
          lab: currentLab ?? "",
          machineName: hostname(),
          challenge,
          state,
          platform: platformTag(),
          version: DAEMON_VERSION,
          redirect: `${base}/paired`,
        })
      );
    return (
      appPage(uiDir, 3, { workspace: hasLocalLab() }) ??
      renderAgentSignInPage({
        machineName: pairedMachine.machineName,
        labLabel: labLabel(pairedMachine),
        labUrl: pairedMachine.lab,
        agents: await readAgentAuthStates(),
      })
    );
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      if (path === "/" && req.method === "GET") {
        // Before the nonce, because a reload sends the address bar back
        // unchanged: the tab that was admitted asks again carrying both its
        // cookie and the nonce it arrived on, now spent. Reading the nonce
        // first turns every reload into a refusal. The cookie is the
        // narrower claim of the two — this daemon handed it to one tab —
        // so a request that can make it is not a second browser following a
        // link, whatever else its URL still carries.
        if (authorized(req)) return sendHtml(res, 200, await landingPage());
        const suppliedNonce = url.searchParams.get("nonce");
        if (suppliedNonce !== null) {
          const expired = now() - nonceMintedAt > ttl;
          if (!secretsMatch(suppliedNonce, nonce) || nonceSpent || expired)
            return sendHtml(res, 403, renderExpiredLinkPage());
          nonceSpent = true;
          res.setHeader("set-cookie", `${COOKIE_NAME}=${nonce}; HttpOnly; SameSite=Lax; Path=/`);
          return sendHtml(res, 200, await landingPage());
        }
        if (!authorized(req)) return sendHtml(res, 403, renderNoSessionPage());
        return sendHtml(res, 200, await landingPage());
      }

      // Not routed at all for a session opened `alreadyPaired`. A paired
      // daemon offers the sign-in step again and nothing else — re-homing
      // this machine to another lab, or spending a second code, is not
      // something the page behind that link may ask for. Falls through to the
      // 404 below, which is what a route that does not exist answers.
      if (path === "/connect" && req.method === "POST" && !signInOnly) {
        // Checked before anything else, including admission: a session
        // that has already turned a code into a token has nothing left to
        // connect anywhere for. Without this, a machine paired with `--lab`
        // already set — so no `/connect` ever committed a `state` — would
        // still accept one after the fact, re-arming the expiry timer
        // `/paired` just stopped and redirecting to whatever lab a caller
        // names.
        if (settled) return sendJson(res, 409, { error: "this machine has already paired" });
        if (!authorized(req)) return sendJson(res, 403, { error: "run lykeion open for a fresh link" });
        const mediaType = (req.headers["content-type"] ?? "")
          .split(";", 1)[0]!
          .trim()
          .toLowerCase();
        if (mediaType !== "application/json")
          return sendJson(res, 415, { error: "that call is application/json" });
        if (crossOrigin(req)) return sendJson(res, 403, { error: "that call must come from this daemon page" });
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        const record = body as Record<string, unknown>;
        const lab = typeof record.lab === "string" ? record.lab.replace(/\/$/, "") : "";
        const name = typeof record.name === "string" ? record.name : "";
        if (!lab || !name)
          return sendJson(res, 400, { error: "a lab address and a machine name are required" });
        let labUrl: URL;
        try {
          labUrl = new URL(lab);
        } catch {
          return sendJson(res, 400, { error: "the lab address must use http or https" });
        }
        if (labUrl.protocol !== "http:" && labUrl.protocol !== "https:")
          return sendJson(res, 400, { error: "the lab address must use http or https" });
        const preflightState = state;
        const preflightNonce = nonce;
        try {
          await fetch(labUrl, {
            method: "HEAD",
            redirect: "manual",
            signal: AbortSignal.any([outboundCalls.signal, AbortSignal.timeout(5_000)]),
          });
        } catch {
          return sendJson(res, 400, { error: `could not reach ${lab}` });
        }
        if (
          !secretsMatch(preflightState, state) ||
          !secretsMatch(preflightNonce, nonce) ||
          !authorized(req)
        )
          return sendJson(res, 403, { error: "run lykeion open for a fresh link" });
        if (committedState !== undefined && secretsMatch(committedState, state))
          return sendJson(res, 409, {
            error: "this pairing request is already continuing to a lab",
          });
        committedState = state;
        currentLab = lab;
        // The handoff is the last thing this daemon sees of a researcher
        // until they come back approved, and everything between the two —
        // reaching the lab, signing in to it, reading the screen — happens
        // where this process cannot watch. Starting the clock again here is
        // what keeps that stretch from being timed against a span that was
        // already half spent on filling in this form.
        touchDeadline();
        const redirect = `${base}/paired`;
        const query = [
          `name=${encodeURIComponent(name)}`,
          `platform=${encodeURIComponent(platformTag())}`,
          `version=${encodeURIComponent(DAEMON_VERSION)}`,
          `challenge=${encodeURIComponent(challenge)}`,
          `state=${encodeURIComponent(state)}`,
          `redirect=${encodeURIComponent(redirect)}`,
          // Which step of the first run this trip is inside, so the lab's
          // approval screen can keep the count going rather than dropping the
          // researcher into what reads as a different product halfway
          // through. Step 2, because the trip out and back happens INSIDE it
          // — the same reason `/paired` brings them back to step 3 and not to
          // a fourth. A pairing link opened cold carries none of this, and
          // that screen stays bare, which is right: whoever opened it is not
          // in a wizard.
          `step=2`,
        ].join("&");
        // Answered as JSON rather than as a 302, because every caller of this
        // route asks with `fetch` — and `fetch` follows a redirect ITSELF. It
        // does not navigate the tab. A 302 here meant the page called this,
        // quietly received the lab's own HTML into a promise nobody read, and
        // stayed exactly where it was; the screen reported that it could not
        // reach the daemon, which was the one thing that had worked.
        //
        // The daemon's own fallback page is unaffected: it asks with
        // `redirect: "manual"`, tolerates anything that is not an error, and
        // builds the same address itself from values baked into it.
        return sendJson(res, 200, { redirect: `${lab}/#/pair?${query}` });
      }

      if (path === "/agents" && req.method === "GET") {
        // The same admission proof `/connect` opens with. Without it this
        // read is a free amplifier — each hit spawns two confined
        // subprocesses — reachable by anything that can reach this
        // loopback port, including a page in another tab via DNS rebinding.
        // The cookie is `HttpOnly; SameSite=Lax`, so neither an ordinary
        // cross-origin script nor a rebound `Host` can produce it. The
        // `Origin`/`Sec-Fetch-Site` pair below closes the one precondition
        // that check alone does not: a cookie-writing foothold already on
        // this same host (see `pairedCookie`'s own comment) could still
        // send a modern browser's own proof of cross-origin headers along
        // with a value it planted — this route refuses on the strength of
        // those headers regardless of whether the cookie check above
        // happened to pass.
        if (!signInAuthorized(req))
          return sendJson(res, 403, { error: "that call must come from this daemon's own sign-in page" });
        if (crossOrigin(req)) return sendJson(res, 403, { error: "that call must come from this daemon page" });
        // The whole catalogue, in catalogue order — the same list
        // `probeAgentClis` walks and therefore the same list the lab shows
        // once it has heard from this machine. Answering only for the agents
        // that can be ASKED about a sign-in made this screen count two while
        // the workbench a moment later counted twelve, about one computer.
        const roster = await catalogueOnThisMachine(process.env.PATH ?? "");
        const asked = await readAgentAuthStates();
        // Each agent's adapter alongside who is signed in, because the page
        // reading this has to decide which of two things is standing in a
        // row's way — a sign-in, or a program nobody has agreed to run. It
        // costs a PATH lookup and a file read per agent; nothing is spawned.
        return sendJson(res, 200, {
          agents: await Promise.all(
            roster.map(async (row) => ({
              ...row,
              // Spread over the roster row, so an entry nothing could ask
              // carries no `signedIn` key at all rather than a `false` —
              // `false` is what puts a Sign in control on a row, and pressing
              // it for an agent with no confined home to sign into would
              // spawn nothing. Where a state does exist its own `available`
              // wins: it ran the command, which is better evidence than a
              // PATH lookup.
              ...(asked.find((state) => state.agent === row.agent) ?? {}),
              ...(await adapterOnThisMachine(row.agent, process.env.PATH ?? "", dataDir)),
            })),
          ),
        });
      }

      /**
       * The page saying it is still open.
       *
       * `touchDeadline`'s rule is "every step that shows somebody is still
       * working through this flow", and a browser sitting on the first
       * question is exactly that — but it was the one kind of evidence
       * nothing reported. So the request expired underneath a researcher who
       * was reading it, the nonce rotated, the cookie their tab holds stopped
       * being recognised, and every control on the page went quiet.
       *
       * Guarded like the rest, which is what makes it safe to let it hold the
       * clock: only a browser this daemon actually admitted can send it, the
       * nonce it was admitted on is already spent, and a tab that is closed
       * stops sending — so the request goes back to expiring the moment
       * nobody is looking at it, which is what the clock is for.
       */
      if (path === "/setup/still-here" && req.method === "POST") {
        if (!signInAuthorized(req))
          return sendJson(res, 403, {
            error: "that call must come from this daemon's own setup page",
          });
        if (crossOrigin(req))
          return sendJson(res, 403, { error: "that call must come from this daemon page" });
        touchDeadline();
        return sendJson(res, 200, { ok: true });
      }

      /**
       * The answer to the one question this product asks that only the
       * researcher can settle.
       *
       * Written here rather than at the lab, and that is the whole shape of
       * it: an acceptance decides what runs beside a credential in a home
       * this daemon owns, so it lives in this machine's own data directory
       * next to the pairing token, and a lab on another computer can present
       * the terms but never record the answer.
       *
       * The body names the AGENT and nothing else. Letting it name the
       * command would let whatever can reach this route write an acceptance
       * for a program this machine never declared — and that acceptance is
       * exactly what rung 6 reads before it spawns anything.
       */
      if (path === "/agents/consent" && req.method === "POST") {
        // The same two checks `/agents/signin` opens with, and for the same
        // reasons: this route has no content-type gate either, so it is
        // CORS-simple and reachable cross-origin with no preflight at all.
        if (!signInAuthorized(req))
          return sendJson(res, 403, {
            error: "that call must come from this daemon's own sign-in page",
          });
        if (crossOrigin(req))
          return sendJson(res, 403, { error: "that call must come from this daemon page" });
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        const record = body as Record<string, unknown>;
        const agent = typeof record.agent === "string" ? record.agent : "";
        const found = await adapterOnThisMachine(agent, process.env.PATH ?? "", dataDir);
        if (found.adapterCommand === undefined)
          return sendJson(res, 400, {
            error: `this machine has no adapter for ${agent || "that agent"} to decide about`,
          });
        if (record.accepted === true) acceptAdapter(dataDir, agent, found.adapterCommand);
        else revokeAdapter(dataDir, agent, found.adapterCommand);
        return sendJson(res, 200, { ok: true });
      }

      if (path === "/agents/signin" && req.method === "POST") {
        // Checked first, and unconditionally — this route has no
        // content-type gate the way `/connect` does, which makes it a
        // CORS-simple request: reachable cross-origin with no preflight at
        // all. Without this, any page open in the same browser could spawn
        // a real, unconfined CLI login flow on this machine merely by
        // posting here. See `/agents`, just above, for why the
        // `Origin`/`Sec-Fetch-Site` check below is not redundant with it.
        if (!signInAuthorized(req))
          return sendJson(res, 403, { error: "that call must come from this daemon's own sign-in page" });
        if (crossOrigin(req)) return sendJson(res, 403, { error: "that call must come from this daemon page" });
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        const record = body as Record<string, unknown>;
        const agent = typeof record.agent === "string" ? record.agent : "";
        const outcome = await startSignIn(agent, options.signInSpawn, options.signInPath);
        return sendJson(res, outcome.started ? 202 : 400, outcome);
      }

      // The first run's one branching answer, kept where the daemon can act
      // on it. The lab being here is a fact about this computer, not about
      // the browser that happened to ask — so it is written into the data
      // directory rather than held in a page that a reload would forget.
      //
      // Guarded exactly as `/agents/signin` is, and for the same reason: no
      // content-type gate means a CORS-simple request, so without the
      // admission check any page open in this browser could decide where a
      // researcher's lab lives.
      if (path === "/setup/topology" && req.method === "POST") {
        if (!signInAuthorized(req))
          return sendJson(res, 403, {
            error: "that call must come from this daemon's own setup page",
          });
        if (crossOrigin(req))
          return sendJson(res, 403, { error: "that call must come from this daemon page" });
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        const topology = (body as Record<string, unknown>).topology;
        // Named rather than coerced: this decides whether a lab process is
        // started on this computer, and a spelling nobody recognises must not
        // fall through to either answer.
        if (topology !== "here" && topology !== "elsewhere")
          return sendJson(res, 400, {
            error: `topology must be "here" or "elsewhere", not ${JSON.stringify(topology)}`,
          });
        if (topology !== "here") {
          forgetLabHere(dataDir);
          // Answering the first question is a step somebody took, which is
          // exactly what this clock is for — "every step that shows somebody
          // is still working through the flow". It was never wired here, so
          // the span a researcher had to type a lab address into the next
          // screen was whatever was left of the one they spent reading the
          // first, and running out revoked the cookie their open page held.
          touchDeadline();
          return sendJson(res, 200, { topology });
        }
        recordLabHere(dataDir);
        try {
          // Started now rather than on the next run of this daemon. The step
          // after this one creates the owner account IN that lab, through
          // this daemon's own address — so a researcher told "taken" while
          // nothing was listening would meet the next screen with nothing
          // behind it.
          await options.onLabHere?.();
        } catch (err) {
          // The record goes back too. Keeping it would leave this machine
          // saying its lab is here, on the strength of an attempt that
          // failed, and the researcher was just told it did not work.
          forgetLabHere(dataDir);
          return sendJson(res, 500, {
            error: `the lab for this machine did not start: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        // The request stops expiring from here. What comes next is a person
        // typing their name, their email and a password into a form, and the
        // clock this stops measures nobody arriving — which is exactly what a
        // researcher filling in a form looks like from this process. Rotating
        // underneath them retires the cookie their open page holds, so the
        // pairing this very flow is in the middle of starts refusing itself:
        // the lab gets created, the machine quietly does not join it, and the
        // page says nothing because it never asked anything that failed
        // loudly.
        requestHeldOpen = true;
        if (expiryTimer) clearTimeout(expiryTimer);
        expiryTimer = undefined;
        return sendJson(res, 200, { topology });
      }

      // The two halves of pairing a machine to the lab standing beside it.
      //
      // In this topology the browser already holds both ends: it was admitted
      // to this page by the nonce, it is signed in to the lab as the owner it
      // has just created, and both are the same origin because this daemon
      // proxies the lab. So the page runs the existing handshake itself, and
      // what disappears is the ceremony — a form asking for an address the
      // browser is already at, and an approval screen asking somebody to
      // approve themselves.
      //
      // NOTHING new is trusted. Same PKCE secrets, same one-time code on the
      // same clock, same `owner_id` binding, same loopback redirect. The
      // difference is who carries the code between the two ends: a redirect
      // there, a `fetch` here.
      // What this computer calls itself, answered whatever the topology is.
      //
      // Separate from `/setup/challenge` because that route refuses outright
      // when the lab is not here, and the join branch — where the lab is
      // explicitly somewhere else — still has to offer a machine name the
      // researcher can change. These are facts about the machine, not about
      // a pairing request, and a browser cannot work either of them out: it
      // knows its own user agent, not which daemon build is running here.
      if (path === "/setup/machine" && req.method === "GET") {
        if (!signInAuthorized(req))
          return sendJson(res, 403, {
            error: "that call must come from this daemon's own setup page",
          });
        if (crossOrigin(req))
          return sendJson(res, 403, { error: "that call must come from this daemon page" });
        return sendJson(res, 200, {
          name: hostname(),
          platform: platformTag(),
          daemonVersion: DAEMON_VERSION,
        });
      }

      if (path === "/setup/challenge" && req.method === "GET") {
        if (!signInAuthorized(req))
          return sendJson(res, 403, {
            error: "that call must come from this daemon's own setup page",
          });
        if (crossOrigin(req))
          return sendJson(res, 403, { error: "that call must come from this daemon page" });
        // Refused rather than answered for a lab somewhere else, and this is
        // the check that keeps the shortcut honest. The whole argument for
        // skipping the approval screen is that the person approving and the
        // person asking are demonstrably the same — which holds only because
        // the lab is behind this daemon's own address. A remote lab has
        // members this browser is not, and it approves its own machines.
        if (!hasLocalLab())
          return sendJson(res, 409, {
            error: "the lab for this machine is not on this machine",
          });
        // Everything `pairMachine` needs, so the page composes nothing about
        // this machine out of what a browser can see. A browser knows its own
        // user agent; it does not know which daemon build is running here or
        // what this platform is called, and a page guessing either would put
        // a wrong answer in the lab's own record of the machine.
        return sendJson(res, 200, {
          challenge,
          state,
          redirect: `${base}/paired`,
          name: hostname(),
          platform: platformTag(),
          daemonVersion: DAEMON_VERSION,
        });
      }

      if (path === "/setup/paired" && req.method === "POST") {
        if (!signInAuthorized(req))
          return sendJson(res, 403, {
            error: "that call must come from this daemon's own setup page",
          });
        if (crossOrigin(req))
          return sendJson(res, 403, { error: "that call must come from this daemon page" });
        if (!hasLocalLab())
          return sendJson(res, 409, {
            error: "the lab for this machine is not on this machine",
          });
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        const sent = body as Record<string, unknown>;
        // The same comparison `/paired` makes on its own callback, and for
        // the same reason: this is what tells a code this session asked for
        // apart from one somebody else's page obtained.
        if (!secretsMatch(typeof sent.state === "string" ? sent.state : "", state))
          return sendJson(res, 400, { error: "that answer is for a different pairing request" });
        const code = typeof sent.code === "string" ? sent.code : "";
        if (!currentLab || !code)
          return sendJson(res, 400, { error: "that answer carried no code to redeem" });
        try {
          const result = await exchangeCode(currentLab, code, verifier, outboundCalls.signal);
          const paired: PairedState = { lab: currentLab, ...result };
          writeState(dataDir, paired);
          settlePaired({ ok: true, state: paired });
          return sendJson(res, 200, { machineName: paired.machineName, lab: labLabel(paired) });
        } catch (err) {
          // Left unsettled on purpose: a failed exchange is not a refusal,
          // and the request this session is holding is still the one that
          // would succeed on a retry.
          return sendJson(res, 502, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Not routed for an `alreadyPaired` session either, for the same
      // reason: this is the route that turns a code into a token, and a
      // machine that already holds one has nothing to trade.
      if (path === "/paired" && req.method === "GET" && !signInOnly) {
        // Compared before anything else runs: this is what tells the
        // daemon's own callback apart from a forged one, and nothing below
        // it — reading the code, spending it against the lab — should
        // happen on the strength of a state that does not match.
        const suppliedState = url.searchParams.get("state");
        if (suppliedState === null || !secretsMatch(suppliedState, state)) {
          // A state this session minted and has since replaced is the one
          // kind of mismatch that has a useful thing to say: the person
          // holding it did everything right and was slower than the clock.
          // Refused all the same — the verifier that went with it is gone.
          const stale =
            suppliedState !== null &&
            previousState !== undefined &&
            secretsMatch(suppliedState, previousState);
          return sendHtml(
            res,
            400,
            stale ? renderExpiredRequestPage() : renderForeignCallbackPage(),
          );
        }
        // Before the code is looked for, because a refusal arrives without
        // one and would otherwise be read as a callback that lost its code.
        // It gets here on the same proof an approval does — the state above
        // — so this is the lab's own screen speaking, not a stray GET.
        if (url.searchParams.get("refused") === "1")
          return finishPaired(
            res,
            200,
            renderRefusedPage(),
            { ok: false, error: new PairingRefused("that request was refused in the lab") },
          );
        const code = url.searchParams.get("code") ?? "";
        if (!currentLab || !code) return sendHtml(res, 400, renderMissingCodePage());
        try {
          const result = await exchangeCode(currentLab, code, verifier, outboundCalls.signal);
          const paired: PairedState = { lab: currentLab, ...result };
          writeState(dataDir, paired);
          const agents = await readAgentAuthStates();
          // Frozen from the request that is actually completing this
          // exchange, not read back out of `nonce` — see `pairedCookie`'s
          // own comment for why the two can already differ here. Accepted
          // only if it matches a nonce this session actually issued
          // (`nonce` or `previousNonce`) — never taken on faith from the
          // request, which is a value this same host's own loopback lets
          // another origin set.
          const requestCookie = readCookie(req);
          pairedCookie =
            requestCookie !== undefined &&
            (secretsMatch(requestCookie, nonce) ||
              (previousNonce !== undefined && secretsMatch(requestCookie, previousNonce)))
              ? requestCookie
              : undefined;
          settled = true;
          // Back onto the step that was waiting, rather than onto a page of
          // this daemon's own. The trip out to the lab and back happened
          // INSIDE step 2, so the count promised at step 1 still holds and
          // the researcher lands where the flow left off — with the agents
          // step in front of them instead of a seam between two products.
          //
          // The daemon's own sign-in page remains the answer when there is no
          // built application to serve: a daemon running from source with no
          // `ui/dist` has just completed a real pairing, and saying so on a
          // page it renders itself beats a 404 for the page it has not got.
          await finishPaired(
            res,
            200,
            appPage(uiDir, 3, { workspace: hasLocalLab() }) ??
              renderAgentSignInPage({
                machineName: paired.machineName,
                labLabel: labLabel(paired),
                labUrl: paired.lab,
                agents,
              }),
            { ok: true, state: paired },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await finishPaired(
            res,
            502,
            renderExchangeFailurePage(message, [nonce, verifier, code, state, suppliedState ?? ""]),
            {
              ok: false,
              error: new Error(message),
            },
          );
        }
        return;
      }

      // Everything the application asks for once its page has loaded: its own
      // assets, and any deep link a researcher types or a reload sends back.
      // Last, and only for paths this server does not own, so that it widens
      // what one address serves without touching what any route decides —
      // admission to `/` is still the cookie or a live nonce, and the front
      // door has no say in it.
      //
      // Asked of `path` — the pathname every route above matched on — rather
      // than of the request target, and then of `requestPath` for the two
      // things the URL parser leaves alone. The parser has already collapsed
      // the dot segments, so `/x/../paired` and `//elsewhere/paired` arrive
      // here as `/paired`; `requestPath` decodes `/%70aired` and drops the
      // slash off `/paired/`. Between them the guard sees every spelling the
      // route table sees and a few it does not, which is the direction this
      // has to err in: a route that answers 404 because it does not exist on
      // this daemon must not be reachable by writing its name differently.
      const named = requestPath(path);
      const ours = named !== undefined && OWN_ROUTES.has(named);
      if (!ours && serveApp(req, res, uiDir, undefined, hasLocalLab())) return;

      // What the application calls once its page has loaded, when the lab it
      // calls is running beside this daemon. `serveApp` hands these back
      // deliberately — a forwarded prefix is never a page — and this is the
      // other half of that: with a lab here they go to it, and with the lab
      // somewhere else they were never this server's to answer and fall
      // through to the 404 below.
      //
      // Behind the same `ours` guard as the front door, so that widening
      // what one address serves cannot reach a route this server owns. No
      // route it owns is a forwarded prefix today, and this is what keeps
      // that from being something the next prefix has to remember: a path
      // this daemon answers means this machine here and something else
      // entirely at a lab, and it must not stop meaning the first because a
      // lab happens to be running behind it.
      if (!ours && forward !== undefined && isForwarded(req.url)) {
        forward(req, res);
        return;
      }

      return sendJson(res, 404, { error: "no such route" });
    })().catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: "the pairing server failed" });
      console.error("[pairing] unhandled", err);
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : options.port);
    });
  });
  base = `http://127.0.0.1:${port}`;
  mintRequest();
  rotateNonce();

  return {
    base,
    port,
    // A getter, not the value: rotation replaces what this session is
    // guarded by, and a copy taken at startup would go on naming a link
    // that no longer opens anything.
    get nonce(): string {
      return nonce;
    },
    rotateNonce,
    serveLabThrough(labPort) {
      // One call sets both halves of the same fact. Where the lab's routes go
      // and what address this daemon redeems a pairing code against are the
      // same lab, and setting them apart is how they come to disagree — the
      // co-located exchange would then be offered (forwarding is up) with
      // nothing to redeem against (no lab named).
      forward = forwardTo(labPort);
      currentLab = `http://127.0.0.1:${labPort}`;
    },
    rotateRequest,
    pasteRequest,
    redeemCode,
    // Getters for the same reason `nonce` is one: a request that runs out
    // of time is replaced in place, and a copy taken at startup would go on
    // naming secrets this session has stopped answering to.
    get verifier(): string {
      return verifier;
    },
    get challenge(): string {
      return challenge;
    },
    get state(): string {
      return state;
    },
    dataDir,
    paired,
    close: () =>
      new Promise<void>((resolve) => {
        // First, because the sockets below are not the only thing this
        // session can be holding: a preflight or exchange still out at the
        // lab is a handle too, and one no amount of closing servers reaches.
        outboundCalls.abort();
        // Before the server, so a session closed between the timer firing
        // and this running cannot mint a request onto a dead listener.
        if (expiryTimer) clearTimeout(expiryTimer);
        expiryTimer = undefined;
        // A browser sitting on the "paired" page holds its connection open
        // on HTTP keep-alive. `server.close()` on its own only ends the
        // connections it considers idle, and does so already, on its own —
        // which the socket a real browser leaves behind here evidently does
        // not count as: closing every socket outright is what actually ends
        // this, confirmed by running the whole flow against a real browser
        // with each option in turn. `sendHtmlAndFlush` is what makes that
        // safe: nothing calls this until the `/paired` response it would
        // otherwise cut off has already been handed to the OS in full.
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/**
 * Opens the platform's browser on `url`. A failure to launch one is not
 * this process's problem to raise — the link is already sitting on screen
 * for a person to click themselves — so it prints a line rather than
 * throwing.
 *
 * Exported for `runOpen` in `main.ts`, which mints a link the same way
 * `beginPairing` below does but outside a pairing session — `lykeion
 * open` asks a daemon that is already running rather than starting one —
 * and has no reason to carry a second copy of what opening a browser takes.
 */
export function openBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  execFile(command, args, (error) => {
    if (error) process.stdout.write("Could not open a browser automatically — open the link above.\n");
  });
}

/**
 * What a machine with no browser prints instead of a link nobody there can
 * open: which lab, what this machine will be called in it, the address to
 * open somewhere that does have a browser, the line to paste, and the one
 * command that finishes it.
 *
 * Exported for its own test. Every part of it is something a person has to
 * be able to act on from another computer, and the failure mode is silent —
 * a researcher who cannot work out what to do with this simply does not
 * pair the machine.
 */
export function pasteInstructions(lab: string, name: string, blob: string): string {
  // A lab written with a trailing slash is a lab somebody typed, and
  // `https://lab.example.edu//#/pair` is not an address anybody should be
  // asked to notice is wrong.
  const at = lab.replace(/\/+$/, "");
  return [
    `This machine needs to join ${at} as "${name}".`,
    `Open ${at}/#/pair in a browser and paste this:`,
    "",
    `  ${blob}`,
    "",
    "Then bring back the code it gives you:",
    "",
    "  lykeion pair --code <code>",
    "",
  ].join("\n");
}

/**
 * Opens pairing for an unpaired daemon: mints the loopback session, prints
 * the one line a person or a log needs to find it, and opens a browser onto
 * it unless suppressed. The session is handed back still running rather
 * than awaited here, because a daemon has more to answer for while it waits
 * — a person who lost the link asks it for another one, and only the
 * session that is still open can mint that.
 */
export async function beginPairing(
  config: DaemonConfig,
  forward?: StartPairingOptions["forward"],
  onLabHere?: StartPairingOptions["onLabHere"],
): Promise<PairingSession> {
  const session = await startPairing({
    port: config.port,
    dataDir: config.dataDir,
    lab: config.lab,
    forward,
    onLabHere,
    // A request that ran out is replaced rather than fatal: nobody decided
    // anything, so there is nothing to honour by giving up, and a daemon
    // that exited here would punish walking away from the keyboard. The
    // banner is printed in the same shape as the first one, so whatever was
    // reading the output for a link — a person, a log — still finds it.
    onRequestExpired: (link) => {
      process.stdout.write("That pairing request expired without an answer.\n");
      process.stdout.write(`Pair this machine -> ${link}\n`);
    },
  });
  const link = `${session.base}/?nonce=${session.nonce}`;
  process.stdout.write(`Pair this machine -> ${link}\n`);
  if (config.openBrowser) {
    openBrowser(link);
    return session;
  }
  // Somebody asked for no browser AND is watching this terminal — which is
  // this program's best evidence that the machine it is running on has no
  // browser of its own. A detached start is not that: it prints into a log
  // for a researcher who is sitting at this same computer and will open the
  // link there, and taking a paste request on their behalf would stop this
  // session's request from ever expiring for a flow nobody is using.
  //
  // A lab has to be named, because the instructions are entirely about where
  // to go: without one there is no address to open and no page to paste
  // into, and the link above is all this can honestly offer.
  if (!config.detached && config.lab !== undefined)
    process.stdout.write(`\n${pasteInstructions(config.lab, hostname(), session.pasteRequest())}`);
  return session;
}

/**
 * Opens the sign-in step for a daemon that is already paired: the same
 * loopback server, serving `/`, `/agents` and `/agents/signin` and nothing
 * else.
 *
 * Nothing is printed and no browser is opened, unlike `beginPairing`. Pairing
 * is a thing somebody is standing at a terminal waiting to finish; this is a
 * door left unlocked for whoever skipped signing an agent in, or whose token
 * lapsed months later — both of whom `probe.ts`'s dock string sends here, and
 * neither of whom is watching this process start. `lykeion open` is
 * what mints the link, on the same terms it mints a pairing one: fresh on
 * every ask, retiring the last.
 */
export async function beginSignIn(
  config: DaemonConfig,
  machine: PairedState,
  forward?: StartPairingOptions["forward"],
): Promise<PairingSession> {
  return startPairing({
    port: config.port,
    dataDir: config.dataDir,
    lab: machine.lab,
    alreadyPaired: machine,
    forward,
  });
}
