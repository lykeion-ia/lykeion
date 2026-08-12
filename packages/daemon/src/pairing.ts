import { createHash, randomBytes } from "node:crypto";
import { execFile, type spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { DAEMON_VERSION, type DaemonConfig } from "./config";
import { platformTag } from "./probe";
import { labLabel, writeState, type PairedState } from "./state";
import { exchangeCode } from "./lab";
import { agentAuthStates, startSignIn, type AgentAuth } from "./agent-auth";
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
   * Throws away this request and opens another in its place — a new nonce,
   * and with it a new verifier, challenge and state — answering with the
   * link to the replacement. This is what an unanswered request expiring
   * amounts to, and the difference between it and {@link rotateNonce} is
   * everything a lab could already have been told: a rotated nonce leaves
   * the request the approval screen is looking at intact, and this ends it.
   */
  rotateRequest(): string;
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
  /** The request whose first successful `/connect` already chose its lab.
   *  Kept separate from `currentLab`: a lab supplied on the command line is
   *  merely a prefilled choice and remains editable until the browser
   *  actually commits this request. A later request has a different state
   *  and can choose again. */
  let committedState: string | undefined;
  /** Counts down to the open request being replaced. Re-armed by every step
   *  that shows somebody is still working through the flow. */
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
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
      // Before the timer is cleared, so nothing between the two lines can
      // arm another: `touchDeadline` refuses outright once this is set.
      pairedMachine = outcome.state;
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = undefined;
      resolvePaired(outcome.state);
    } else {
      rejectPaired(outcome.error);
    }
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
    // A machine that already holds a token has no request left to expire, and
    // arming this for one is not merely pointless: the timer's own callback
    // calls `rotateRequest`, which mints a fresh, WORKING pairing link and
    // announces it — forever, every ttl seconds, on a machine that is already
    // paired. `finishPaired` stops the timer that is running when a session
    // pairs; this is what keeps `rotateNonce` from arming another one
    // afterwards, now that `status` mints an admission link for a paired
    // daemon too.
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
  async function landingPage(): Promise<string> {
    if (pairedMachine === undefined)
      return renderSetupPage({
        lab: currentLab ?? "",
        machineName: hostname(),
        challenge,
        state,
        platform: platformTag(),
        version: DAEMON_VERSION,
        redirect: `${base}/paired`,
      });
    return renderAgentSignInPage({
      machineName: pairedMachine.machineName,
      labLabel: labLabel(pairedMachine),
      labUrl: pairedMachine.lab,
      agents: await readAgentAuthStates(),
    });
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
        if (!authorized(req)) return sendJson(res, 403, { error: "run lykeion-daemon status for a fresh link" });
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
          return sendJson(res, 403, { error: "run lykeion-daemon status for a fresh link" });
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
        ].join("&");
        res.writeHead(302, { location: `${lab}/#/pair?${query}` });
        return res.end();
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
        const agents = await readAgentAuthStates();
        return sendJson(res, 200, { agents });
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
          await finishPaired(
            res,
            200,
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
    rotateRequest,
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
 */
function openBrowser(url: string): void {
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
 * Opens pairing for an unpaired daemon: mints the loopback session, prints
 * the one line a person or a log needs to find it, and opens a browser onto
 * it unless suppressed. The session is handed back still running rather
 * than awaited here, because a daemon has more to answer for while it waits
 * — a person who lost the link asks it for another one, and only the
 * session that is still open can mint that.
 */
export async function beginPairing(config: DaemonConfig): Promise<PairingSession> {
  const session = await startPairing({
    port: config.port,
    dataDir: config.dataDir,
    lab: config.lab,
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
  if (config.openBrowser) openBrowser(link);
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
 * neither of whom is watching this process start. `lykeion-daemon status` is
 * what mints the link, on the same terms it already mints a pairing one:
 * fresh on every ask, retiring the last.
 */
export async function beginSignIn(
  config: DaemonConfig,
  machine: PairedState,
): Promise<PairingSession> {
  return startPairing({
    port: config.port,
    dataDir: config.dataDir,
    lab: machine.lab,
    alreadyPaired: machine,
  });
}
