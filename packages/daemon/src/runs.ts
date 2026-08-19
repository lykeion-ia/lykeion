import { isAbsolute } from "node:path";
import type { KernelEnvDeclaration, KernelEnvStatus, RunEvent, RunEventFrame } from "@lykeion/api";
import { addBounded } from "./bounded-set";
import {
  backoffDelayMs,
  fetchKernelEnvDeclarations,
  LabFrameConflict,
  LabRefused,
  openCommands,
  postKernelCell,
  postKernelEnvAddPackages,
  postKernelEnvCreate,
  postKernelEnvProgress,
  postKernelEnvResult,
  postKernelEnvLock,
  postKernelList,
  postRunEvents,
  postRunGrant,
  postRunLive,
  postRunReverted,
  postRunSnapshot,
  postTaskTitle,
  type KernelCellReport,
  type RunCommand,
} from "./lab";
import { namingDir, summarizeTask } from "./naming";
import { createRetryLoop } from "./retry";
import { ensureTaskDir } from "./workspace";
import { confinementFor } from "./agent-home";
import { confinedEnv } from "./confined-env";
import type { KernelHost } from "./kernel-host";
import {
  daemonProgramPaths,
  ensureKernelSocketDir,
  forwardKernelCells,
  kernelBridgeFor,
  kernelConfinementFor,
  kernelSessionToken,
  kernelSocketPath,
} from "./kernels";
import { PROTOCOL_VERSION } from "./kernel-protocol";
import { alreadySystemReadable, boundaryOf, policyFor } from "./sandbox";
import { restoreSnapshot, takeSnapshot } from "./snapshot";
import { startSession, type LiveSession, type McpServer, type StandingGrant } from "./session";
import {
  provisionerFor,
  materializeEnvironment,
  readEnvStatus,
  removeEnvironment,
  resolveEnvironment,
} from "./environments";

/** How long a run's buffered events wait for company before they are posted
 *  on their own. Long enough that a burst of `assistant-text` chunks travels
 *  as one batch rather than one call each; short enough that a researcher
 *  watching a turn never waits noticeably on it. */
const FLUSH_INTERVAL_MS = 50;

/** Event kinds that skip the batching window and go out the moment they are
 *  produced: a permission card and a proposed plan are both waiting on a
 *  person, a `state` change is what a "thinking / running / done" indicator
 *  reads off, and `completed` is the turn ending — none of those should sit
 *  behind an ordinary text chunk's timer. */
const IMMEDIATE_EVENTS: ReadonlySet<RunEvent["event"]> = new Set([
  "permission-card",
  "plan-proposed",
  "state",
  "completed",
]);

/** How long `stop` gives a run's last batch of events — including the
 *  `completed` frame a subprocess exiting mid-turn produces — to actually
 *  reach the lab, before the signal those posts travel on is allowed to go
 *  away. Long enough for a real POST to land; short enough that stopping
 *  this machine never waits on a lab that has stopped answering. */
const FINAL_FLUSH_GRACE_MS = 2000;
const STOPPED_BEFORE_TURN_REASON = "this machine stopped before this run's turn could begin";

export interface RunSubsystem {
  stop(): Promise<void>;
  /** The reason the most recent turn was abandoned, for a caller that has
   *  no event stream to read it from. Absent until one is. */
  lastFailure(): string | undefined;
  /** The working directory every session this daemon currently holds a live
   *  ACP subprocess for is standing in. What a sweep must never remove out
   *  from under a running agent. Two sessions on one Task name the same
   *  directory, so a caller comparing against it treats this as a set. */
  liveSessionDirs(): string[];
}

/** How many of a run's most recent event frames wait in `RunSubsystem`'s own
 *  outbound queue before it gives up on delivering the rest — the daemon's
 *  own counterpart to `run-relay.ts`'s `RUN_FRAME_LIMIT`, guarding the same
 *  kind of unbounded growth from the sending side rather than the
 *  receiving one. A lab too slow, or too gone, to ever accept a batch must
 *  not leave this daemon holding an ever-growing backlog for it: past this
 *  many, the run is ended on the spot, carrying why, rather than kept
 *  silently piling up frames nobody may ever see. */
const OUTBOUND_QUEUE_LIMIT = 2000;

/** How many run ids `startedRuns` remembers, oldest evicted first. A run's
 *  own `start-run` command is dropped from the lab's own queue the instant
 *  its `completed` frame is processed there — the same cleanup `publish`
 *  performs on every ordinary ending — which is what makes a *stale* replay
 *  of it structurally impossible once the lab has heard the run is over. The
 *  narrow gap this bound actually guards is the daemon finishing a run
 *  locally before the lab has heard about it yet: pruning on a bound, well
 *  past however many runs could plausibly still be in that gap at once,
 *  keeps that guarantee intact for as long as it matters while still
 *  letting a daemon that outlives thousands of runs let go of the ones long
 *  since forgotten by everyone, including the lab. */
const STARTED_RUNS_LIMIT = 1000;

/**
 * How long a session waits for this machine's kernels to be put within reach
 * before it opens without them.
 *
 * The first ask on a machine is also the one that provisions the environment
 * the kernels run in, which is minutes of work on a cold machine and none on
 * a warm one — so this is generous. It is bounded at all because the call it
 * bounds settles only when the host answers or the host process dies: a host
 * that is up and not answering would otherwise hold the turn open with
 * nothing said, which is the one failure a researcher cannot act on.
 */
const KERNEL_REACH_MS = 90_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * `work`, or a rejection carrying `why` once `ms` has passed.
 *
 * `Promise.race` subscribes to `work` either way, so a rejection that arrives
 * after the deadline has already been declared is still handled here rather
 * than surfacing as a rejection nothing was waiting for.
 */
function withDeadline<T>(work: Promise<T>, ms: number, why: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(why)), ms);
      timer.unref?.();
    }),
  ]);
}

/**
 * Holds the lab's command stream open, drives one ACP session per Lykeion
 * session id, and streams every turn's events back. The piece that joins the
 * lab's `start-run` / `decision` / `cancel` commands to `session.ts`'s
 * `LiveSession`.
 */
export function startRuns(options: {
  lab: string;
  token: string;
  /** Where Task workspaces live. Disjoint from `dataDir`, which the sandbox
   *  denies. */
  workDir: string;
  /** Where this machine keeps its own state, so the boundary can deny it. */
  dataDir: string;
  adapterFor(agent: string): { command: string; args: string[] } | undefined;
  /**
   * The probe's own account of why an agent it did not vet cannot run —
   * signed out, isolation unproven, waiting on a decision about its adapter.
   *
   * Absent, or answering nothing, leaves the refusal as it was. What it
   * replaces is one sentence doing the work of five: a run refused for an
   * agent this machine cannot start said it had no adapter for it, which is
   * right for one cause out of several and actively misleading for the
   * commonest — a CLI whose token lapsed overnight, sending the researcher to
   * install a bridge they already have.
   */
  heldBackReason?(agent: string): string | undefined;
  /** The platform whose sandbox backend confines every run here. Production
   *  passes none and this machine's own platform is used; a test naming one
   *  is how the no-backend path is exercised without a second machine. */
  platform?: string;
  /** This machine's kernel host, asked for the first time a session that
   *  could use a kernel is opened. Absent on a machine that holds none: a
   *  session is then told about no tool server at all, rather than about one
   *  whose kernel could never start. */
  kernelHost?: () => KernelHost;
  /** Overrides `KERNEL_REACH_MS` — a test's own way to make a host that never
   *  answers something shorter than real minutes. Production never passes
   *  this. */
  kernelReachMs?: number;
  cancelGraceMs?: number;
  /** Variables put in front of every adapter this subsystem starts, on
   *  purpose rather than by inheritance — `startSession`'s `extraEnv`,
   *  reached from out here.
   *
   *  Production passes none: a confined run is given the allowlist and its
   *  own home, and nothing else. This exists because the stub adapter the
   *  tests drive is configured entirely through variables of its own, and
   *  once a run's environment became an allowlist there was no longer any
   *  ambient channel for a test to reach it through — which is the feature
   *  working, not a gap in it. A seam is honest about being a seam.
   *
   *  Asked once per session opened rather than read once here, because a test
   *  that arranges its stub after starting the subsystem would otherwise hand
   *  over an empty object and watch its adapter do nothing. */
  extraEnv?: () => Record<string, string>;
}): RunSubsystem {
  // Two signals rather than one: aborting the command stream the instant
  // `stop` is called must not also cut off a batch of events that is only
  // just landing because closing a session mid-turn produced its `completed`
  // frame. `commandsController` covers `openCommands`/`postRunLive`;
  // `eventsController` covers `postRunEvents`, and is not aborted until
  // whatever was in flight when sessions closed has had a chance to land.
  const commandsController = new AbortController();
  const eventsController = new AbortController();
  let stopped = false;
  /** Whether a naming session is running right now. One at a time, lab-wide
   *  — see `handleNameTask`. */
  let naming = false;
  // Set by the retry loop's `onRefused`: no amount of retrying fixes a
  // machine the lab has explicitly revoked, so this is what stops
  // `connectLoop` from opening the command stream again.
  let refused = false;
  let lastFailure: string | undefined;
  // The highest command seq this daemon has handled, carried into
  // `openCommands` as `cursor` on every reconnect so the lab knows where to
  // resume rather than replaying its whole backlog.
  let lastCommandSeq: number | undefined;
  // Command sequences belong to one server relay process. A server-only
  // restart creates a new generation whose sequence begins again at one;
  // carrying the old cursor across that boundary would filter its first
  // commands forever.
  let relayGeneration: string | undefined;
  // Every `start-run` this daemon has recently begun handling, bounded by
  // `STARTED_RUNS_LIMIT`. A reconnect can replay a command the lab is not
  // yet sure this daemon saw; without this, a replayed start-run would queue
  // the turn a second time and — since a completed run's `RunPost` is freed
  // once its `completed` frame ships — renumber its frames from 1 again,
  // colliding with the ones already sent.
  const startedRuns = new Set<string>();
  // Terminal ids outlive their transient outbound `RunPost`: once the lab
  // acknowledges a completed batch that post is freed, but a late ACP
  // rejection (notably during shutdown) must still not recreate seq 1 and
  // publish a second ending. Bounded on the same horizon as replayed starts.
  const terminalRuns = new Set<string>();

  // Which kernel host `kernelsFor` last wired `forwardKernelCells` onto, so
  // a listener is registered once per host instance rather than once per
  // session opened against it. Rebuilt whenever the host instance changes —
  // a fresh process starts with no registered listener of its own, and a
  // registration still pointed at the process it replaced would never see
  // another notification.
  let cellRoutingHost: KernelHost | undefined;

  // One reusable ACP subprocess per healthy session id. A subprocess whose
  // stop was not acknowledged moves to `retainedSessions`: it is still held
  // for shutdown cleanup, but no later turn can inherit its uncertain state.
  const liveSessions = new Map<string, LiveSession>();
  const retainedSessions = new Set<LiveSession>();
  // A live session's own working directory, kept alongside `liveSessions`
  // and with the same lifetime — `liveSessionDirs()` is what a sweep of
  // stale workspaces checks before removing anything, so this must name
  // every directory a subprocess might still be using, never fewer.
  const sessionDirs = new Map<string, string>();
  const retainedSessionDirs = new Set<string>();
  // How to describe a live session's environments to the kernel host again,
  // over the socket and token that session's kernels already talk over. Kept
  // alongside `liveSessions` and deleted wherever that map loses an entry:
  // the host forgets a session it has been asked to release, and a handle
  // left behind here would re-configure one nothing on this machine holds.
  //
  // Only sessions that were actually given a kernel appear — a session told
  // about no tool server has no kernels to re-describe.
  const sessionConfigures = new Map<string, () => Promise<void>>();
  // Which language each of a live session's environments is in, by name.
  // Kept alongside `liveSessions` on the same terms as `sessionConfigures`,
  // and written from the very list this machine hands the kernel host — so
  // it is what a cell would actually find, not a second answer derived
  // somewhere else.
  //
  // It exists for the permission card. `serveEnvironmentAddPackages` holds
  // an environment's NAME and nothing else, and a card asking a researcher
  // to approve installing software on every machine in this lab should say
  // what it is installing INTO. The alternative was fetching the lab's
  // declarations on the path that raises the card — a network round trip in
  // front of a person waiting to answer — for a fact this process already
  // had and was throwing away.
  //
  // Absent is absent: a session configured by an older daemon, or one whose
  // environments this machine never described, has no entry and the card
  // says no language rather than guessing one.
  const sessionEnvLanguages = new Map<string, Map<string, "python" | "r">>();
  /** The tail of the retell queue — what the next `retellLiveSessions` waits
   *  on before it reads anything. See that function for why. */
  let retells: Promise<void> = Promise.resolve();
  /**
   * Tells every session open on this machine right now what its kernels
   * would be started with today.
   *
   * Every one of them, and not only the session whose cell asked for
   * whatever changed: an environment appearing on this machine, or leaving
   * it, is a fact about the MACHINE, and any open session may name it in its
   * next cell. A session still confined by the map it was opened with is a
   * session that will refuse an environment that is now here, or hand a
   * kernel an interpreter that is now gone.
   *
   * **This never rejects.** Both callers have already done the thing they
   * were asked to do — a build that succeeded, a copy that is gone — and one
   * of them is holding a researcher's own wait open on saying so. A host
   * that will not take the news costs the sessions it names a restart and
   * nothing else, which is not a reason to report a failure that did not
   * happen. `trouble` says what that costs the session it names, since which
   * session it was is precisely who is owed that restart.
   *
   * **Settled together, not one after another.** Each re-send reaches the
   * host and the lab on its own account, so a serial loop would spend up to
   * one whole `KERNEL_REACH_MS` PER open session before the caller could say
   * anything at all — a researcher on a machine with four sessions and an
   * unresponsive host waiting six minutes to hear that their build finished.
   * One deadline over the whole set instead of one per session.
   *
   * **One at a time, machine-wide.** Both callers reach this after changing
   * what is on disk, and each re-send reads that disk for itself — so two
   * overlapping retells are two boundaries built from two different moments,
   * landing in whichever order the host happens to answer in, last write
   * winning. A reclaim overtaken by a build's slower re-send would leave the
   * session offering an environment this machine has just deleted, which is
   * the very state the reclaim's retell exists to prevent, reached by a race
   * rather than by a missing loop. Globally rather than per session, since a
   * per-session chain is more precise and buys nothing against how rare these
   * are.
   *
   * What chaining costs, stated at the strength the code actually holds it:
   * one retell waits behind each retell already queued, NOT at most one in
   * total. Nothing bounds how many can be in flight — `handleCommand` gives
   * every `kernel-env-setup` and `kernel-env-reclaim` its own fire-and-forget
   * task with no queue of its own — and a retell's deadline starts when its
   * turn begins, not when it queues. So against a silent host, K concurrent
   * env commands can delay the last one's answer to the lab by up to K whole
   * deadlines. That is the same multiplication settling the sessions together
   * removed one paragraph above, moved from per-session to per-command, and
   * it is accepted rather than fixed: it needs a host that has stopped
   * answering AND several env commands at once, where the paragraph above
   * needed only the first. Worth coalescing if that ever stops being true —
   * a retell queued behind one that is still waiting would read the same
   * post-completion disk state, so it could collapse into it.
   */
  async function retellLiveSessions(trouble: (sessionId: string) => string): Promise<void> {
    const mine = retells.then(() => tellEveryOpenSession(trouble));
    // The tail is what the NEXT retell waits on, so it must not be able to
    // carry a failure forward into one — `tellEveryOpenSession` does not
    // reject today and this is what keeps that from becoming load-bearing.
    retells = mine.catch(() => {});
    await mine;
  }
  /** One retell, all of it — everything `retellLiveSessions` documents except
   *  the queueing. Called only from there, so that nothing can reach the
   *  sessions without taking its turn behind whatever retell is already
   *  reading this machine's disk. */
  async function tellEveryOpenSession(trouble: (sessionId: string) => string): Promise<void> {
    // A copy, since the awaits below can outlive any of these sessions and
    // the map is written by whoever ends one.
    const open = [...sessionConfigures];
    // Which of them are done, so the deadline below can say who is not.
    const settled = new Set<string>();
    await withDeadline(
      Promise.allSettled(
        // No per-session liveness check, and what stands in for it is weaker
        // than it looks. The spread above, this `map`, and each callback up
        // to its own first `await` all run in ONE synchronous block, so every
        // task is STARTED while its session is still held — but the send is
        // two awaits further on, after `host.hello` and the lab's
        // declarations fetch (`kernelsFor`'s `configure`), and a session that
        // ends in THAT gap is still handed a boundary.
        //
        // That residual window is accepted rather than guarded. The daemon
        // never sends `kernel.release_session` — it exists in the host
        // (host.py) with no caller on this side — so the host is still
        // holding the session, and a late boundary refreshes it rather than
        // resurrecting one nothing holds. What it costs is a `host.hello`, a
        // declarations fetch and a share of the deadline.
        //
        // Make this loop serial again and the window widens to the whole of
        // every earlier iteration, for every session queued behind them, so
        // whoever does owes it a `sessionConfigures.has(sessionId)` guard at
        // the top of the body.
        open.map(async ([sessionId, reconfigure]) => {
          try {
            await reconfigure();
          } catch (err) {
            console.error(
              `${trouble(sessionId)}: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            settled.add(sessionId);
          }
        }),
      ),
      options.kernelReachMs ?? KERNEL_REACH_MS,
      "this machine's kernels did not answer in time",
    ).catch((err) => {
      // `Promise.allSettled` does not reject, so this is the deadline and
      // only the deadline — and naming the sessions still under it is the
      // whole job here, because the catch above will never speak for them.
      // `host.call` carries no timeout of its own (`call`, kernel-host.ts): a
      // call is settled by a reply or by the host dying and by nothing else,
      // so against a host that is alive and silent those tasks stay pending
      // for as long as this daemon runs. Unnamed, the researcher owed a
      // restart cannot be found — which is what the per-session logging is
      // for, and this is the one branch where it cannot do it.
      //
      // At least one name always comes out: the race settles through the work
      // whenever every task has finished, so reaching here means one had not.
      const why = err instanceof Error ? err.message : String(err);
      for (const [sessionId] of open) {
        if (settled.has(sessionId)) continue;
        console.error(`${trouble(sessionId)}: ${why}`);
      }
    });
  }
  // ACP connections crossing initialize/session-new are not installed in
  // `liveSessions` yet, so cancellation needs a separate ownership handle to
  // reap that subprocess and unblock the per-session turn queue.
  const initializations = new Map<string, AbortController>();
  const releasingRuns = new Map<string, Promise<void>>();
  // Which session a run belongs to, and which run a session is currently
  // working on. Two maps rather than one, so a decision or cancel naming a
  // run that is only queued — not yet the one a session is actually running
  // — is never forwarded to whatever turn happens to be live instead.
  const sessionOfRun = new Map<string, string>();
  const runOfSession = new Map<string, string>();
  // The tail of each session's turn queue. Every start-run naming the same
  // session id is chained onto this, one after another — `prompt()` is
  // documented as not re-entrant, and this is what keeps this subsystem from
  // ever calling it a second time before the first has settled.
  const turnQueues = new Map<string, Promise<void>>();
  // Resolved the moment a run's `completed` event is emitted, so whatever
  // queued behind it in `turnQueues` can go next.
  const settlers = new Map<string, () => void>();
  // A cancel can name a turn waiting behind the session's current prompt.
  // Its completion is emitted immediately; this tombstone makes the queued
  // continuation return without ever invoking `prompt()` once it reaches the
  // head of the session queue.
  const cancelledQueuedRuns = new Set<string>();

  interface RunPost {
    pending: RunEventFrame[];
    /** The exact numbered batch currently being attempted. It stays separate
     *  from `pending` across a transient failure so frames produced later can
     *  neither merge into it nor overtake it. */
    retryBatch?: RunEventFrame[];
    nextSeq: number;
    timer?: NodeJS.Timeout;
    /** Set once this run's `completed` frame has been queued. A daemon that
     *  outlives thousands of runs must not keep one map entry per run id
     *  forever — this is what lets `flush` let go of the entry once there is
     *  nothing left to send for it. */
    ended: boolean;
    /** True while a `postRunEvents` call for this run is in flight. A lab
     *  slow or gone leaves that call hanging rather than settling it —
     *  without this, every 50ms tick would open another concurrent POST
     *  against it, each carrying only whatever had accumulated since the
     *  last one, rather than one growing backlog `emit` can bound. */
    flushing: boolean;
    /** Consecutive transient delivery failures, for bounded exponential
     *  backoff while retaining the exact same numbered batch. */
    retryAttempts: number;
    /** A 409 means the server and daemon cursors cannot be reconciled by a
     *  verbatim retry. Such a run is removed from live reports and ignores
     *  any late adapter events while the server terminally fails it. */
    failed: boolean;
    deliveryError?: string;
  }
  const posts = new Map<string, RunPost>();
  // At most one missing-run reconciliation retry is needed at a time: every
  // report is rebuilt from current state, so it includes all runs retired by
  // any additional conflict while this one is still backing off.
  let reconciliationRetry: Promise<void> | undefined;
  let reconciliationVersion = 0;
  let acknowledgedReconciliationVersion = 0;
  // Every `postRunEvents` call currently in flight, so `stop` can wait for
  // exactly the ones that matter — including one a session's `close()`
  // triggers after `stop` has already moved past the line that started it —
  // rather than guessing at a fixed pause.
  const inFlightFlushes = new Set<Promise<void>>();

  function postFor(runId: string): RunPost {
    const existing = posts.get(runId);
    if (existing) return existing;
    const created: RunPost = {
      pending: [],
      retryBatch: undefined,
      nextSeq: 1,
      ended: false,
      flushing: false,
      retryAttempts: 0,
      failed: false,
    };
    posts.set(runId, created);
    return created;
  }

  function reportedRunIds(): string[] {
    const runIds = new Set(sessionOfRun.keys());
    // A locally ended run is still live from the server's point of view until
    // its terminal batch is acknowledged. Reporting it missing earlier lets a
    // reconnect synthesize a conflicting failure while the real outcome is
    // merely waiting to be retried.
    for (const [runId, post] of posts) {
      if (post.ended && !post.failed) runIds.add(runId);
    }
    return [...runIds];
  }

  function releaseRunAfterSessionClose(runId: string): Promise<void> {
    const existing = releasingRuns.get(runId);
    if (existing) return existing;
    let release!: Promise<void>;
    release = (async () => {
      const sessionId = sessionOfRun.get(runId);
      if (sessionId && sessionOfRun.delete(runId)) publishQueue(sessionId);
      if (!sessionId) {
        settlers.get(runId)?.();
        settlers.delete(runId);
        return;
      }
      if (runOfSession.get(sessionId) !== runId) {
        // Queued behind another turn, or still crossing `startSession()`.
        // There is no installed child to close yet; the tombstone makes that
        // continuation close its own newly-created child before prompting.
        cancelledQueuedRuns.add(runId);
        initializations.get(runId)?.abort();
        settlers.get(runId)?.();
        settlers.delete(runId);
        return;
      }

      // Remove callback authority before asking the old child to leave, but
      // keep the queue's current-run marker and settler until close finishes.
      // Otherwise the next same-session turn can spawn into this cwd while the
      // retired adapter is still executing during its SIGTERM grace period.
      const live = liveSessions.get(sessionId);
      liveSessions.delete(sessionId);
      sessionConfigures.delete(sessionId);
      sessionEnvLanguages.delete(sessionId);
      try {
        if (live) await live.close();
      } finally {
        sessionDirs.delete(sessionId);
        if (runOfSession.get(sessionId) === runId) runOfSession.delete(sessionId);
        settlers.get(runId)?.();
        settlers.delete(runId);
      }
    })().finally(() => {
      if (releasingRuns.get(runId) === release) releasingRuns.delete(runId);
    });
    releasingRuns.set(runId, release);
    return release;
  }

  async function retireLocalRun(runId: string): Promise<void> {
    addBounded(terminalRuns, runId, STARTED_RUNS_LIMIT);
    const post = posts.get(runId);
    if (post) {
      post.failed = true;
      post.pending = [];
      post.retryBatch = undefined;
      if (post.timer) clearTimeout(post.timer);
      post.timer = undefined;
      posts.delete(runId);
    }
    await releaseRunAfterSessionClose(runId);
  }

  async function reportLive(): Promise<void> {
    const report = await postRunLive(
      options.lab,
      options.token,
      reportedRunIds(),
      relayGeneration,
      lastCommandSeq,
      commandsController.signal,
    );
    if (
      report.generation !== undefined &&
      report.generation !== relayGeneration &&
      lastCommandSeq !== undefined
    )
      lastCommandSeq = undefined;
    if (report.generation !== undefined) relayGeneration = report.generation;
    await Promise.all(report.retireRunIds.map((runId) => retireLocalRun(runId)));
  }

  function waitForReconciliationRetry(ms: number): Promise<void> {
    if (commandsController.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        commandsController.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      commandsController.signal.addEventListener("abort", done, { once: true });
    });
  }

  function startMissingRunReconciliation(): void {
    if (reconciliationRetry) return;
    reconciliationRetry = (async () => {
      let attempt = 0;
      while (!stopped && !refused && !commandsController.signal.aborted) {
        const reportingVersion = reconciliationVersion;
        try {
          await reportLive();
          acknowledgedReconciliationVersion = reportingVersion;
          attempt = 0;
          if (acknowledgedReconciliationVersion === reconciliationVersion) return;
        } catch (error) {
          if (error instanceof LabRefused) {
            refused = true;
            return;
          }
          attempt += 1;
          await waitForReconciliationRetry(backoffDelayMs(attempt));
        }
      }
    })().finally(() => {
      reconciliationRetry = undefined;
      // A conflict can land after the final report resolves but before this
      // cleanup runs. Its caller sees an in-flight task and deliberately does
      // not open another; restart here if that newer state was not included
      // in the acknowledged report.
      if (
        !stopped &&
        !refused &&
        !commandsController.signal.aborted &&
        acknowledgedReconciliationVersion < reconciliationVersion
      )
        startMissingRunReconciliation();
    });
  }

  function reconcileMissingRunsUntilAcknowledged(): void {
    reconciliationVersion += 1;
    startMissingRunReconciliation();
  }

  async function failOutOfSync(
    runId: string,
    post: RunPost,
    error: LabFrameConflict,
  ): Promise<void> {
    addBounded(terminalRuns, runId, STARTED_RUNS_LIMIT);
    post.failed = true;
    post.pending = [];
    post.retryBatch = undefined;
    post.ended = true;
    if (post.timer) {
      clearTimeout(post.timer);
      post.timer = undefined;
    }
    lastFailure = `${runId}'s event stream is out of sync with the lab: ${error.message}`;
    await releaseRunAfterSessionClose(runId);

    // This is the explicit resynchronization path: the durable server compares
    // this report with its active rows and writes the only contiguous terminal
    // frame it can still author safely.
    reconcileMissingRunsUntilAcknowledged();
  }

  function flush(runId: string): void {
    const post = posts.get(runId);
    if (!post || post.flushing || (!post.retryBatch && post.pending.length === 0)) return;
    if (post.timer) {
      clearTimeout(post.timer);
      post.timer = undefined;
    }
    // A retry always owns one immutable batch until the lab acknowledges it.
    // Anything emitted while that request is in flight accumulates separately
    // in `pending`, preserving both the durable cursor and event chronology.
    const frames = post.retryBatch ?? post.pending.splice(0, post.pending.length);
    post.retryBatch = frames;
    const isFinal = frames.some((frame) => frame.event.event === "completed");
    post.flushing = true;
    let outcome: "delivered" | "retry" | "failed" = "delivered";
    const sent: Promise<void> = postRunEvents(options.lab, options.token, runId, frames, eventsController.signal)
      .then(() => {
        post.retryBatch = undefined;
        post.retryAttempts = 0;
        if (post.deliveryError !== undefined && lastFailure === post.deliveryError)
          lastFailure = undefined;
        post.deliveryError = undefined;
      })
      .catch(async (error: unknown) => {
        if (error instanceof LabFrameConflict) {
          outcome = "failed";
          await failOutOfSync(runId, post, error);
          return;
        }
        if (eventsController.signal.aborted) {
          outcome = "failed";
          return;
        }
        outcome = "retry";
        post.retryAttempts += 1;
        // `retryBatch` deliberately remains the same array. New frames may
        // have accumulated in `pending`, but the next request is byte-for-byte
        // the numbered batch whose acknowledgement is still unknown.
        if (isFinal) {
          post.deliveryError = `${runId}'s outcome could not be delivered to the lab — retrying`;
          lastFailure = post.deliveryError;
        }
      })
      .finally(() => {
        inFlightFlushes.delete(sent);
        post.flushing = false;
        if (outcome === "failed") {
          if (post.failed && posts.get(runId) === post) posts.delete(runId);
          return;
        }
        if (outcome === "retry") {
          scheduleFlush(runId, backoffDelayMs(post.retryAttempts));
          return;
        }
        if (post.ended && !post.retryBatch && post.pending.length === 0) posts.delete(runId);
        // Whatever accumulated in `pending` while this batch was in flight —
        // including the run's own ending, if it settled only after this
        // batch was already on its way — goes out next rather than waiting
        // on another scheduled tick that may never come if nothing further
        // is ever emitted for this run.
        else flush(runId);
      });
    inFlightFlushes.add(sent);
  }

  /** Waits for every currently in-flight flush to settle, re-reading
   *  `inFlightFlushes` after each wave rather than checking it once. A batch
   *  that only starts once an earlier one on the same run finally settles —
   *  exactly what happens when a run's own `completed` frame is queued
   *  behind an ordinary batch already in flight — did not exist yet at the
   *  moment a caller began waiting, and a single `Promise.all` snapshot
   *  would miss it entirely. */
  async function drainInFlightFlushes(): Promise<void> {
    while (
      !eventsController.signal.aborted &&
      (inFlightFlushes.size > 0 ||
        [...posts.values()].some(
          (post) => !post.failed && (post.retryBatch !== undefined || post.pending.length > 0),
        ))
    ) {
      if (inFlightFlushes.size > 0) await Promise.all(inFlightFlushes);
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function scheduleFlush(runId: string, delayMs = FLUSH_INTERVAL_MS): void {
    const post = posts.get(runId);
    if (!post || post.timer) return;
    post.timer = setTimeout(() => {
      post.timer = undefined;
      flush(runId);
    }, delayMs);
    post.timer.unref?.();
  }

  /** Ends a run on the spot once its outbound queue has grown past
   *  `OUTBOUND_QUEUE_LIMIT` — a lab too slow, or too gone, to ever accept a
   *  batch must not leave this daemon holding an ever-growing backlog for
   *  it. Reported as a failure rather than silently thinned: a turn that
   *  looks complete having quietly lost its middle is worse than one that
   *  honestly says it could not keep up. */
  function overflow(runId: string): void {
    const post = postFor(runId);
    if (post.ended) return;
    const reason =
      `more than ${OUTBOUND_QUEUE_LIMIT} of this run's events could not be sent to the lab in time — ` +
      `the rest were dropped rather than held without limit`;
    post.pending.push({ seq: post.nextSeq, event: { event: "completed", state: { state: "failed", reason } } });
    addBounded(terminalRuns, runId, STARTED_RUNS_LIMIT);
    post.nextSeq += 1;
    post.ended = true;
    lastFailure = reason;
    flush(runId);

    // The session that produced this backlog is not going to stop on its
    // own — it is what "will not stop talking" means. Release the session's
    // turn queue only after that child is actually gone, so a same-session
    // successor cannot overlap it in the same working directory.
    void releaseRunAfterSessionClose(runId);
  }

  function emit(runId: string, event: RunEvent): void {
    if (terminalRuns.has(runId)) return;
    const post = postFor(runId);
    // Nothing follows a run's own ending while its `RunPost` entry still
    // exists — an adapter still producing updates after `overflow` has
    // already closed its session, or a `session/prompt` call rejecting once
    // that close finally lands, must not overwrite the ending this run
    // already has. This covers exactly the entry's own lifetime, not a
    // moment longer: once `flush` has shipped everything and let the entry
    // go (below), `postFor` would rebuild a fresh one right here with
    // `ended: false`, and a still later event would renumber that run's
    // frames from 1 again — the same collision `startedRuns` exists to keep
    // a replayed command from causing, reachable here by a different route
    // that this check alone does not close.
    if (post.ended || post.failed) return;
    if ((post.retryBatch?.length ?? 0) + post.pending.length >= OUTBOUND_QUEUE_LIMIT)
      return overflow(runId);
    post.pending.push({ seq: post.nextSeq, event });
    post.nextSeq += 1;
    if (event.event === "completed") {
      addBounded(terminalRuns, runId, STARTED_RUNS_LIMIT);
      post.ended = true;
      settlers.get(runId)?.();
      settlers.delete(runId);
      if (event.state.state === "failed") lastFailure = event.state.reason;
    }
    if (IMMEDIATE_EVENTS.has(event.event)) flush(runId);
    else scheduleFlush(runId);
  }

  function retireSession(sessionId: string, session: LiveSession): void {
    if (liveSessions.get(sessionId) !== session) return;
    liveSessions.delete(sessionId);
    sessionConfigures.delete(sessionId);
    sessionEnvLanguages.delete(sessionId);
    retainedSessions.add(session);
    const dir = sessionDirs.get(sessionId);
    sessionDirs.delete(sessionId);
    if (dir) retainedSessionDirs.add(dir);
  }

  /** Ends a run before it ever reached a session: the single `completed`
   *  frame this run gets, carrying why it never ran. */
  function refuse(runId: string, reason: string): void {
    emit(runId, { event: "completed", state: { state: "failed", reason } });
  }

  /**
   * Tells a turn still waiting on this session where it now stands.
   * `sessionOfRun` holds one entry per turn this session has taken and not
   * finished, in the order they were taken, so a turn's place in that map is
   * the number of turns in front of it.
   *
   * Every turn in the session is walked either way, since a later turn's
   * count of how many are in front of it depends on knowing how many earlier
   * ones there are — but `only`, when given, restricts which of them actually
   * gets told: joining the tail of the queue changes nothing about where
   * anyone already in it stands, so `handleStartRun` names the one turn that
   * just joined rather than repeating news no one's position has changed.
   * Called with no `only` after `sessionOfRun` loses an entry, since a turn
   * leaving the queue shortens it for everyone behind it at once. A position
   * that is never revised stops being true the moment the turn ahead of it
   * ends, and a queue that never appears to move reads as a queue that is
   * stuck.
   */
  function publishQueue(sessionId: string, only?: string): void {
    let ahead = 0;
    for (const [runId, session] of sessionOfRun) {
      if (session !== sessionId) continue;
      if (ahead > 0 && (only === undefined || only === runId))
        emit(runId, { event: "state", state: { state: "queued", ahead } });
      ahead += 1;
    }
  }

  /**
   * What this machine does when an agent asks for a new environment.
   *
   * The host cannot do any of this itself: raising a card needs the
   * researcher's live session, and declaring the environment needs the lab
   * and this machine's token — and that process holds neither. So it asks,
   * over the second direction of the same stream its kernels answer on, and
   * blocks the one tool call that asked until this settles.
   *
   * In order, and the order is the whole of it:
   *
   * 1. The ask is read by value. Nothing between a model and this checked
   *    anything, and what arrives here decides what a researcher is shown.
   * 2. No live session, no card. Refused by name rather than allowed
   *    silently: consent nobody was asked for is not consent.
   * 3. The card. A denial throws, so the host turns it into the tool's own
   *    refusal rather than an empty success.
   * 4. The lab declares it, attributed to the session's own researcher.
   * 5. The session is reconfigured BEFORE this returns. Without it the agent
   *    creates `crispr`, immediately lists, and is told this lab declares no
   *    such thing — because the confinement its session is holding was built
   *    before the declaration existed. `host.py`'s module docstring is the
   *    rule this relies on: the caller sequences by waiting for the first
   *    reply before sending the second, and this IS that first reply.
   *
   * A failure at any step throws, and every sentence it can throw names the
   * environment: the agent asked for a name and has to write the next call.
   */
  async function serveEnvironmentCreate(params: unknown): Promise<unknown> {
    const asked = (params ?? {}) as {
      session_id?: unknown;
      name?: unknown;
      packages?: unknown;
      language?: unknown;
    };
    const sessionId = asked.session_id;
    const name = asked.name;
    const packages = asked.packages;
    if (
      typeof sessionId !== "string" || sessionId === "" ||
      typeof name !== "string" || name === "" ||
      !Array.isArray(packages) ||
      !packages.every((entry): entry is string => typeof entry === "string" && entry !== "")
    )
      throw new Error(
        "creating an environment needs a session, a name and a list of package names",
      );
    // Refused here as well as in the host, and not because the host's guard
    // is doubted: this method is reachable from anything holding the host
    // socket, and the next thing it does is raise a card in front of a
    // researcher. A language nothing can build must not become a question
    // somebody is asked, because every answer to it is an answer to the
    // wrong question.
    //
    // ABSENT is python — an older host that predates this field still
    // creates the Python environments it always did, rather than having
    // every create refused by a daemon it did not know had changed.
    const language = asked.language === undefined ? "python" : asked.language;
    if (language !== "python" && language !== "r")
      throw new Error(
        `the environment ${name} was not created: an environment is for python or r, ` +
          `and ${JSON.stringify(asked.language)} is neither`,
      );
    const session = liveSessions.get(sessionId);
    if (session === undefined)
      throw new Error(
        `this machine is holding no live session for ${sessionId}, so there is nobody here to ask about ${name}`,
      );
    const answered = await session.askPermission(
      { kind: "environment", target: { name, packages, language } },
      "manage_environments",
      // What the transcript's row for this decision is called. The card
      // itself shows the name and every package below it, so this is not for
      // the screen — it is so that a researcher reading back what they
      // allowed sees which environment they allowed rather than a row saying
      // only that something was.
      // The language is named in the row as well as the name, because the
      // name alone does not say what was installed. A row saying only
      // "Create the environment rstats" leaves a researcher reading back a
      // month later with no way to tell whether they approved a conda R
      // environment or a uv Python one — and the two put different software
      // on every machine in this lab.
      packages.length === 0
        ? `Create the ${language === "r" ? "R" : "Python"} environment ${name}, holding only its interpreter`
        : `Create the ${language === "r" ? "R" : "Python"} environment ${name} with ${packages.join(", ")}`,
    );
    // Every way `false` arrives, said as one thing, because this end cannot
    // tell them apart: refused, answered with a scope this card does not
    // take, or abandoned when the turn ended underneath it. Naming the
    // researcher as having refused it would be a guess, and the wrong one
    // for a card they never saw.
    if (!answered.allowed)
      throw new Error(
        `the environment ${name} was not approved — the card was refused, or the turn ended before it was answered`,
      );
    const declaration = await postKernelEnvCreate(
      options.lab,
      options.token,
      sessionId,
      name,
      packages,
      language,
      eventsController.signal,
    );
    // AFTER the lab wrote the declaration, and this order is the whole of it.
    // "For this conversation" on an environment card is a standing grant over
    // that NAME, and it auto-allows every later `manage_packages` for it with
    // no card at all. `postKernelEnvCreate` can refuse — `conflict`, "this lab
    // already has an environment named python" — and it is a name an agent
    // chooses, so the collision is with an environment somebody else made.
    // Minted before this line, a refused create would leave the session
    // holding uncarded authority to install software into the environment
    // every default Python kernel in this lab runs in, off a card that said
    // *Create environment python?*. It throws above rather than reaching
    // here, and the grant is never made.
    answered.remember();
    // Before returning, never after. See step 5 above.
    await sessionConfigures.get(sessionId)?.();
    return declaration;
  }

  /**
   * What this machine does when an agent asks for packages to be added to an
   * environment this lab already declares.
   *
   * The same ladder as `serveEnvironmentCreate`, in the same order and for
   * the same reasons — read by value, no live session no card, the card, the
   * lab — and it stops one rung short of that one: nothing re-describes the
   * session here. A create adds a NAME the session has never heard of, so the
   * confinement has to be rebuilt before the agent can see it; this changes
   * what a name it already holds will contain, which nothing in a
   * confinement records. The re-describe that matters happens later, on the
   * machine that carries out the rebuild, in `handleKernelEnvSetup`.
   *
   * **This does not wait for the rebuild**, and neither does the lab's own
   * route. A `uv` resolve plus a materialize is minutes; held open, it would
   * park an MCP tool call for the length of a package download, and the model
   * on the other end would be blocked from doing anything else in the
   * meantime — including the work it already has the packages for. What it
   * returns instead is the lab's own answer, which says a build is running,
   * and the host turns that into a sentence telling the model not to import
   * anything yet.
   */
  async function serveEnvironmentAddPackages(params: unknown): Promise<unknown> {
    const asked = (params ?? {}) as {
      session_id?: unknown;
      name?: unknown;
      packages?: unknown;
    };
    const sessionId = asked.session_id;
    const name = asked.name;
    const packages = asked.packages;
    // An empty list is refused HERE as well as at the host: adding nothing is
    // not a state anybody can mean, and a card asking a researcher to approve
    // installing no software is not a question they can answer.
    if (
      typeof sessionId !== "string" || sessionId === "" ||
      typeof name !== "string" || name === "" ||
      !Array.isArray(packages) ||
      packages.length === 0 ||
      !packages.every((entry): entry is string => typeof entry === "string" && entry !== "")
    )
      throw new Error(
        "adding packages needs a session, an environment and at least one package name",
      );
    const session = liveSessions.get(sessionId);
    if (session === undefined)
      throw new Error(
        `this machine is holding no live session for ${sessionId}, so there is nobody here to ask about ${name}`,
      );
    // `undefined` where this machine never described that environment to its
    // host — a name the lab declared and nothing here built, or a session
    // configured before this map existed. The card then reads exactly as it
    // did before, which is the "absent is not zero" rule applied to a
    // sentence: say nothing rather than guess Python.
    const language = sessionEnvLanguages.get(sessionId)?.get(name);
    const answered = await session.askPermission(
      // `packages` is what was ASKED FOR, never the list the environment
      // ends up holding. A researcher approving "add scanpy" must not be
      // shown the environment's entire contents as though all of it were
      // being installed now — and the card's own disclosure renders this
      // list open, so what is in it is what they read.
      // The language where this machine knows it. The create card has said
      // it since R landed, and this one — the card that changes what is
      // installed on every machine in this lab — said less about what it was
      // changing than the card that declares an empty environment.
      {
        kind: "environment",
        target: {
          name,
          packages,
          ...(language === undefined ? {} : { language }),
        },
      },
      "manage_packages",
      // What the transcript's row for this decision is called — see the same
      // argument on `serveEnvironmentCreate`.
      `Add ${packages.join(", ")} to the environment ${name}`,
    );
    // Every way `false` arrives, said as one thing, because this end cannot
    // tell them apart: refused, answered with a scope this card does not
    // take, or abandoned when the turn ended underneath it.
    if (!answered.allowed)
      throw new Error(
        `adding packages to ${name} was not approved — the card was refused, or the turn ended before it was answered`,
      );
    const added = await postKernelEnvAddPackages(
      options.lab,
      options.token,
      sessionId,
      name,
      packages,
      eventsController.signal,
    );
    // After the lab wrote it, for the reason `serveEnvironmentCreate` mints
    // its own here: this call can be refused too — 404 for a declaration
    // deleted between the card being shown and the answer arriving, 403 for a
    // session that ended underneath it — and a grant minted off a change that
    // never happened would stand for the rest of the conversation with
    // nothing to point at.
    answered.remember();
    return added;
  }

  /** One environment a session's kernels may start in, in the shape the host
   *  is handed on the wire: a language, a name, the interpreter, and the
   *  boundary prefix in front of it, with at most one per language marked
   *  `default` for a cell that names none. */
  interface EnvironmentEntry {
    language: string; name: string; interpreter: string;
    prefix: string[]; default?: boolean;
  }

  /**
   * What this machine would tell the kernel host about a session's
   * environments right now: one entry per environment its kernels may start
   * in, and — separately — every name this lab has declared at all.
   *
   * One definition, read from two places. `kernelsFor` sends this when a
   * session is opened, and that same session's `reconfigure` sends it again
   * once this machine has built something new. The two have to agree exactly,
   * down to every case the loops below exist for: a base the baseline already
   * grants, a floor whose reads will not render, a declaration in a language
   * this machine does not run, a lab that would not answer. A second copy of
   * this computation would drift from this one, and the drift would be a
   * researcher told `crispr` is "not built on this machine yet" on the machine
   * that just built it.
   *
   * Raises only for the two conditions that are about the MACHINE rather than
   * about one environment: a host speaking a protocol this daemon does not,
   * and a machine on which not one boundary could be rendered. Everything
   * narrower costs its own entry and nothing else.
   */
  async function kernelEnvironmentsFor(
    host: KernelHost,
    cwd: string,
    taskId: string,
    grants: StandingGrant[],
  ): Promise<{ environments: EnvironmentEntry[]; declared?: string[] }> {
    const hello = (await host.call("host.hello", {})) as {
      protocol?: unknown;
      languages?: Array<{
        language: string;
        environment: string;
        interpreter: string;
        reads: string[];
      }>;
      /** Which languages this host could launch AT ALL, as against which
       *  ones this machine happened to discover an interpreter for. The
       *  gate on a lab's declarations reads this one — see the comment
       *  where it is used. */
      capable?: string[];
    };
    // Read rather than merely declared at both ends. The wire shapes below
    // are written twice, once here and once in the host, and this number is
    // what a host says when it is no longer describing the same ones — a
    // machine whose host was replaced under a daemon that was not.
    if (hello.protocol !== PROTOCOL_VERSION)
      throw new Error(
        `this machine's kernel host speaks protocol ${JSON.stringify(hello.protocol)} ` +
          `and this daemon speaks ${PROTOCOL_VERSION}`,
      );
    // One boundary per language, not one shared. Each descriptor's reads
    // render their own policy, so a kernel confined for one language is
    // never reused for another.
    //
    // What a shared union would actually cost is narrower than it first
    // looks, and worth writing down as measured rather than as assumed. On
    // the common install, most of R's library tree is already reachable
    // from a Python cell whatever this does: `SYSTEM_READ` grants `/opt`,
    // and a Python kernel inside a real boundary lists
    // /opt/homebrew/lib/R/4.6/site-library and reads
    // /opt/homebrew/Cellar/r/4.6.1/lib/R/library/stats/DESCRIPTION today.
    // Splitting the boundary does not take that away and was never going
    // to.
    //
    // The entry the split used to separate out was the one R puts under the
    // researcher's own home — R_LIBS_USER, where install.packages() writes
    // by default and therefore where a researcher's own packages, and
    // whatever data sits beside them, actually live. That was true back when
    // "R" meant this machine's own Rscript: `_r()` (interpreters.py) named
    // `R.home()` plus `.libPaths()` as R's reads, and R_LIBS_USER rode in
    // among them.
    //
    // `_r()` is gone. R now reaches a cell only through a lab-declared
    // environment this machine has built, and a built environment's reads
    // are its own root and the base its interpreter links out to — never a
    // path under the researcher's home, so there is no personal-library
    // entry left for this split (or a union) to do anything about. What
    // still keeps R_LIBS_USER out of a cell is `EFFACED`
    // (kernels/__init__.py, kernel-host): it strips R_LIBS_USER, R_LIBS and
    // R_LIBS_SITE from what a kernel inherits, so the researcher's own
    // shell profile can't even set the value a boundary would otherwise
    // have to deny. `EFFACED`'s own guarantee is measured where it lives —
    // `test_python_kernel.py::test_r_library_variables_are_effaced`, over
    // `environment_of`'s answer. What sandbox.kernel.test.ts measures is
    // the `reads` boundary, which this paragraph has just finished saying
    // is a different mechanism; pointing at it for EFFACED would name the
    // wrong evidence for the claim.
    //
    // Keyed by `(language, name)`, which is the identity the host itself
    // files these under (`built[(language, name)]` in `_environments_from`,
    // registry.py). A list with two entries sharing that pair would leave
    // which one survives to whichever the host happened to read last —
    // an unwritten contract, and one the host's own comment beside that
    // line rejects for defaults in almost these words: a session's kernels
    // landing wherever they happened to be sorted. So the replacement
    // happens HERE, by explicit key, and what goes on the wire has one
    // entry per pair by construction.
    const entries = new Map<string, EnvironmentEntry>();
    /** Files one entry under its `(language, name)`, replacing whatever
     *  stood for that pair before — and keeping the `default` that pair
     *  already carried, since the default is a fact about the NAME and not
     *  about which interpreter is behind it. Written once and used by both
     *  loops below, so the floor and a built environment cannot come to
     *  disagree about what replacing an entry means. */
    const place = (entry: EnvironmentEntry): void => {
      // Refused HERE, per entry, and it is the second half of a fix whose
      // first half is `config.ts` resolving `--work-dir`. The host's
      // `_environments_from` refuses a relative interpreter — rightly, since
      // it would be resolved against the HOST's working directory and put a
      // directory of its choosing in front of every cell's `PATH` — but it
      // refuses the WHOLE confinement on the first bad entry, floor included,
      // and the session then gets no kernel tools at all. Both callers of
      // this are inside a `try` that costs a bad entry one environment, which
      // is the difference between one odd environment and every kernel on the
      // machine. Written as the guard and not only as the resolve above it
      // because a `workDir` is not the only way a path reaches here.
      if (!isAbsolute(entry.interpreter))
        throw new Error(
          `${entry.interpreter} is not an absolute path, and an environment's interpreter has to be one`,
        );
      const key = `${entry.language} ${entry.name}`;
      const inherited = entries.get(key)?.default;
      entries.set(key, {
        ...(inherited === undefined ? {} : { default: inherited }),
        ...entry,
      });
    };
    // What each language's floor is read out of, kept for the built
    // environments below: a venv's own `bin/python3` is a link out to the
    // base interpreter, and a boundary is written where the operating
    // system will look. The default descriptor's reads, since that is the
    // one the machine's floor for that language actually is.
    //
    // It also answers "is this a language this machine actually has",
    // which is the only question the built loop below needs asked — one
    // structure, since a second set tracking the same predicate could
    // only ever drift out of agreement with this one.
    const floorReads = new Map<string, string[]>();
    // Which languages the host could launch at all. Separate from
    // `floorReads`, which records what this machine DISCOVERED — see the
    // gate below for why conflating the two skipped every R environment.
    // Falls back to the discovered languages when a host does not report
    // capability, which is today's behaviour rather than a wider one.
    const capable = new Set<string>(
      hello.capable ?? (hello.languages ?? []).map((descriptor) => descriptor.language),
    );
    // How many boundaries this machine tried to render and could not. Read
    // once at the end, and only to tell "this language is unusable" from
    // "this machine cannot confine a kernel at all" — see below.
    let unrenderable = 0;
    for (const descriptor of hello.languages ?? []) {
      // A read the baseline already grants is left to the baseline — the same
      // filter, and the same argument, as the built loop applies to a venv's
      // base below; the reasoning is written out in full above `ownBase`
      // (`const ownBase =`, the built loop). A kernel host running on a system
      // python reports a `sys.base_prefix` of `/usr`, and `/usr` is one of the
      // paths `renderSeatbeltProfile` puts in EVERY profile unconditionally.
      // Naming it a second time buys the kernel nothing, and is the only
      // reason `policyFor` refuses the boundary — leaving a machine that would
      // run python perfectly offering no python kernel at all, and, once it is
      // the only language, no kernel server whatsoever (the guard below).
      //
      // Entry by entry rather than descriptor by descriptor, because this is a
      // list where the built loop's `base` was a single path: a floor reading
      // out of both `/usr` and somewhere the baseline does not reach keeps the
      // second. A descriptor every one of whose reads is covered renders with
      // an empty list of its own, which is right — the baseline is already
      // carrying all of it.
      //
      // Absent is not zero, here as there: what is dropped stays readable
      // through `SYSTEM_READ`, a grant rendered into this very profile.
      // Restoring it would take the language's kernel away, not give it reach.
      try {
        const reads = (descriptor.reads ?? []).filter((read) => !alreadySystemReadable(read));
        const { prefix } = kernelConfinementFor({
          platform: options.platform ?? process.platform,
          workspace: cwd,
          dataDir: options.dataDir,
          grants,
          reads,
        });
        // At most one default per language, and it is the FIRST floor
        // descriptor of that language. The host refuses a whole confinement
        // carrying two defaults for one language (`_environments_from` in
        // registry.py), and a refused confinement is a session with no
        // kernels at all rather than one degraded kernel — so marking every
        // descriptor was harmless only for as long as the floor happened to
        // report one per language, and nothing here is left resting on that.
        //
        // Recorded only once the boundary is rendered, so this stays the
        // reads of a descriptor a kernel can actually be started under — and
        // the FILTERED list, since the built loop composes this into its own
        // reads. Keeping the baseline's paths here would hand a path back to
        // `policyFor` one loop down and refuse every built environment of a
        // language whose floor happens to sit under `/usr`.
        const isDefault = !floorReads.has(descriptor.language);
        if (isDefault) floorReads.set(descriptor.language, reads);
        place({
          language: descriptor.language,
          name: descriptor.environment,
          interpreter: descriptor.interpreter,
          prefix,
          ...(isDefault ? { default: true } : {}),
        });
      } catch (err) {
        // A boundary this machine will not render around what that language
        // reads out of — `policyFor` refuses a readable path that swallows
        // the boundary. Not `/usr`, which the filter above leaves to the
        // baseline: what reaches here is a floor reading out of a place the
        // baseline does NOT cover and which is still somebody's whole world —
        // a one-segment prefix like Fink's `/sw`, or the researcher's home
        // itself. Raised, it leaves the session with NO kernel tools at all,
        // so one language this machine cannot confine would cost the
        // researcher every kernel on the machine. It costs that language its
        // kernel instead.
        unrenderable += 1;
        console.error(
          `this machine could not confine a ${descriptor.language} kernel for ${taskId}, ` +
            `so ${descriptor.environment} is not offered: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }
    // Every name this lab has declared, which is a different list from the
    // one above: `environments` is what this machine has built and can
    // start a kernel in, and this is what exists at all. The host needs
    // both to tell a cell naming an environment a colleague declared and
    // this machine has not downloaded apart from a cell naming one nothing
    // in this lab has ever heard of — two different absences, owed two
    // different sentences.
    //
    // A lab that will not answer must not be a machine that starts no
    // kernels, so a failed ask leaves the key off the message entirely
    // rather than sending an empty list. Absent is "nobody here knows what
    // this lab declared"; `[]` is "the lab declared nothing", and the host
    // says different things for the two. The same policy `reportIfChanged`
    // applies to `environments` in its own report, for the same reason.
    let declarations: KernelEnvDeclaration[] | undefined;
    try {
      declarations = await fetchKernelEnvDeclarations(
        options.lab, options.token, eventsController.signal,
      );
    } catch (err) {
      console.error(
        `could not read this lab's declared environments before confining ${taskId}'s kernels: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const declared = declarations?.map((declaration) => declaration.name);
    // And now the other half of that pair: one entry per environment this
    // machine has actually BUILT, which is what makes a named environment
    // reachable at all. Without these the map every other piece resolves a
    // name against holds nothing but the language floor, and `crispr` is
    // refused as "not built on this machine yet" on the machine that built
    // it.
    //
    // Read from disk rather than from anything tracked, the same couple of
    // `stat`s the report already makes, and only `ready` sends anything.
    // An `absent` or `broken` copy sends NO entry: its absence from the map
    // is what produces the correct refusal downstream, and offering a
    // half-built one would hand a kernel an interpreter with no packages
    // behind it.
    //
    // Nothing here CLAIMS a default. A built environment is reached only
    // by being named — anything else would make "which environment did
    // this cell run in" depend on what happens to be built on that
    // machine, which is the implicitness the environment was put into the
    // kernel identity to remove.
    //
    // What it does do is inherit one. Where a built name and a floor
    // descriptor's name collide — the lab's own `python` starter, once a
    // machine builds it — the built copy is the more specific fact about
    // the same name and replaces that entry, default and all. The default
    // is a fact about the NAME, not about which interpreter is behind it:
    // a cell that said nothing ran in `python` before the starter was
    // built and runs in `python` after, and the only thing that changed is
    // which interpreter that name resolves to. Taking the default away
    // here would leave the language with none the moment a machine built
    // its own starter.
    //
    // Nothing at all when the ask above failed: a declaration list that
    // could not be fetched is not an empty one, and inventing a list to
    // walk here would be the same absent-is-not-zero error one level down.
    // The floor still goes out, so kernels still start.
    for (const declaration of declarations ?? []) {
      // A language this machine's own floor reported, or nothing. The lab
      // is a different trust domain and its list arrives shape-checked but
      // not field-checked, so `language` here can be a string this floor
      // has never heard of — or, from an older or a broken lab, not a
      // string at all. Either one goes straight through `readEnvStatus`
      // into `configure_session`, where `_environments_from` refuses the
      // WHOLE confinement and the session ends up with no kernel tools at
      // all: one malformed row anywhere in the lab costing every session
      // on every machine its kernels, which is the same failure the guard
      // below was added to prevent, arriving through the door beside it.
      //
      // It also keeps a declaration to the language it says it is —
      // belt and braces, now that `readEnvStatus` routes through
      // `provisionerFor` and probes the manager's own interpreter rather
      // than `bin/python3` for everything. This comment used to give that
      // blind probe as the reason, and stopped being true in the same
      // commit that made the reader manager-aware.
      //
      // Capability, not discovery — and the difference is the whole of a
      // bug this branch shipped and caught. `floorReads` is keyed off what
      // this machine DISCOVERED at startup, and R is deliberately no longer
      // discovered from a bare `Rscript`: it reaches a cell only through an
      // environment the lab declared and this machine built. So a gate
      // asking `floorReads.has("r")` answered no on every machine, forever,
      // and skipped every R environment ever built — reporting it as "not
      // built on this machine yet" while it sat there built, which is worse
      // than a refusal because it is false.
      //
      // What this actually needs to know is whether the host could launch
      // the language at all, which is what `capable` says. The floor's
      // reads are still composed in below where they exist, and their
      // absence is not a reason to withhold the environment: a conda R root
      // is self-contained, so its own root IS the read set.
      if (!capable.has(declaration.language)) {
        console.error(
          `this machine's kernel host cannot launch ${JSON.stringify(declaration.language)}, ` +
            `so the environment ${declaration.name} is not offered to ${taskId}'s kernels`,
        );
        continue;
      }
      // Everything it takes to turn one declaration into one entry, inside
      // one `try`: the name resolved to a path, the boundary rendered around
      // what that environment reads, and the entry filed. Every one of them
      // can raise about THIS environment — a name `envRoot` will not resolve
      // (`envRoot`'s own guard, which the lab does not apply when a
      // declaration is created), a base that swallows the boundary
      // (`policyFor`, for a venv built on a prefix like `/sw` or one equal to
      // the researcher's home) — and none of them is a reason to raise about
      // the session. Unguarded, one such declaration anywhere in the lab
      // leaves every session on every machine with no kernel tools at all,
      // which is a whole machine's kernels lost to one odd environment.
      try {
        const status: KernelEnvStatus = readEnvStatus(options.workDir, declaration);
        if (status.state !== "ready") continue;
        // The prefix of the base THIS venv's `bin/python3` links out to,
        // read off its own `pyvenv.cfg` rather than assumed to be whatever
        // the host process was started from. `uv venv` runs with no
        // `--python` on purpose — an environment's Python is a fact about
        // its lockfile's `requires-python`, not about this daemon — so the
        // two genuinely differ, and a boundary written from the wrong one
        // refuses the kernel before its first instruction.
        //
        // The prefix and not the `bin` directory `pyvenv.cfg` records: the
        // standard library sits at `<prefix>/lib/pythonX.Y`, a sibling of
        // that directory rather than anything beneath it, and a grant is a
        // subpath under a `(deny default)` — so granting `bin` alone gives
        // the kernel its executable and refuses it `os.py`. See `envBase`.
        //
        // `undefined` when the file cannot be read or names no usable
        // `home`, and that is not "this venv has no base": it is this
        // machine unable to say what the base is, so the reads fall back to
        // the composition that was here before rather than dropping the base
        // silently.
        // The MANAGER's, not uv's. A conda prefix is self-contained and
        // answers `undefined` here by design — there is no base outside it
        // to grant — where a uv venv's interpreter is a link out and the
        // base must be read off `pyvenv.cfg`. Asking uv's reader about a
        // conda root would parse a file that was never written.
        const provisioner = provisionerFor(declaration.manager);
        const base = provisioner.base(options.workDir, declaration.name);
        // A base the baseline already grants is left to the baseline. Every
        // profile this renders carries `SYSTEM_READ` — /usr, /bin, /opt,
        // /Library and the rest — unconditionally (`renderSeatbeltProfile`,
        // sandbox.ts), so a venv built on a system python, whose `home` is
        // `/usr/bin` and whose prefix is therefore `/usr`, is READ THROUGH
        // THAT GRANT whatever this does. Naming it a second time buys the
        // kernel nothing and costs it the environment: `/usr` is one segment,
        // which `policyFor` refuses as a path that swallows the boundary.
        //
        // Dropped, and the kernel loses no reach: this is not "absent is
        // zero". The base stays readable through `SYSTEM_READ`, which is a
        // grant rendered into this very profile a few lines above the ones
        // this list produces. Restoring it here would take the environment
        // away, not give the kernel anything.
        const ownBase = base !== undefined && !alreadySystemReadable(base) ? [base] : [];
        const { prefix } = kernelConfinementFor({
          platform: options.platform ?? process.platform,
          workspace: cwd,
          dataDir: options.dataDir,
          grants,
          // The environment's own root, the prefix of the base it links out
          // to, AND the floor's reads for the same language: the interpreter
          // inside a venv is a link out of it, and a boundary granting only
          // the root refuses the kernel before its first instruction.
          reads: [status.root, ...ownBase, ...(floorReads.get(declaration.language) ?? [])],
        });
        // No `default` of its own, and `place` carries over the one the
        // entry it replaces had — see the note above.
        place({
          language: declaration.language,
          name: declaration.name,
          interpreter: provisioner.interpreter(options.workDir, declaration.name),
          prefix,
        });
      } catch (err) {
        unrenderable += 1;
        console.error(
          `this machine could not offer the environment ${declaration.name} ` +
            `to ${taskId}'s kernels: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
    }
    // The two loops above cost a failure ONE entry, which is the whole
    // point of them — but a machine on which every one of them failed is
    // not a session with fewer kernels, it is a machine that cannot confine
    // a kernel at all: no backend for this platform, a workspace that will
    // not resolve. That is the case this function's own contract already
    // answers by naming no server ("a machine that cannot confine a kernel
    // … names no server"), and it stays answered that way rather than
    // becoming a notebook tool the agent can call and no kernel behind it.
    //
    // `unrenderable > 0` and not `entries.size === 0` alone: a host that
    // reports no languages and a lab that declared nothing is a machine with
    // nothing to offer, which is not the same as one that tried and could
    // not. It sends the empty list, as it did before any of this.
    if (entries.size === 0 && unrenderable > 0)
      throw new Error("no kernel on this machine has a boundary that could be rendered");
    return {
      // In the order they were first named: the floor, then whatever this
      // machine has built that the floor did not already stand for. One
      // entry per `(language, name)` by construction, not by whichever the
      // host reads last.
      environments: [...entries.values()],
      // Absent rather than empty when the ask above failed, all the way out
      // to the wire: `[]` would tell the host this lab declared nothing.
      ...(declared === undefined ? {} : { declared }),
    };
  }

  /**
   * Puts a kernel within reach of the session about to open, and answers with
   * the tool server to name to it.
   *
   * The configuration is awaited before this returns, and this returns before
   * the agent is told the relay exists — which is the whole of the ordering
   * this end owes the host. The host holds one kernel's cells in the order
   * they were sent, and orders nothing else against them: a boundary that had
   * not landed by the time a cell arrived would have that cell refused for a
   * boundary nobody had supplied.
   *
   * A machine that cannot confine a kernel, whose host speaks a protocol this
   * one does not, or whose host will not answer, names no server. A run still
   * happens: an agent that can read and write this Task's files is worth much
   * more than a refused turn, and a tool that leads to a kernel which could
   * never start is the empty capability this would otherwise be advertising.
   *
   * A socket name this machine cannot bind is the one thing that raises
   * instead. A host that will not answer is a condition of the moment — one
   * still starting, one being replaced — and a machine that cannot confine
   * anything offers no agent at all, so no turn reaches here on one. A name
   * too long to bind is neither: it is a property of where this machine keeps
   * its files, unchanged by waiting and identical on every turn after.
   * Degraded quietly it would be a lab that never holds a kernel and never
   * says so; raised, it ends this turn in words naming the path and its size,
   * where whoever can move the directory will read them.
   *
   * `reconfigure` comes back beside the server: the same configuration, sent
   * again over the same socket and the same token, for whoever needs this
   * session's kernels to know something the machine has learned since. A
   * fresh token would be a bridge this session's kernels do not talk over, so
   * it is this closure that is kept rather than the arguments to rebuild one.
   * Absent wherever no server is named — a session that was told about no
   * kernels has none to re-describe.
   */
  async function kernelsFor(
    cwd: string,
    taskId: string,
    sessionId: string,
    agent: string,
    grants: StandingGrant[],
  ): Promise<{ servers: McpServer[]; reconfigure?: () => Promise<void> }> {
    if (options.kernelHost === undefined) return { servers: [] };
    const token = kernelSessionToken();
    // Decided before anything is asked of the host, and outside the catch
    // below, so a name that cannot be bound leaves this as a refusal rather
    // than as a session quietly opened with no tools.
    const socket = kernelSocketPath(cwd);
    const configure = async (): Promise<void> => {
      const host = options.kernelHost!();
      if (cellRoutingHost !== host) {
        forwardKernelCells(
          host,
          (sid) => runOfSession.get(sid),
          emit,
          (sid, source) => liveSessions.get(sid)?.claimKernelCall(source),
        );
        // On the same guard, and for the same reason it is here: what is
        // registered belongs to the HOST rather than to any one session.
        // Re-registering per session would be harmless in itself — `serve`
        // replaces a method's handler rather than stacking one, and
        // `serveEnvironmentCreate` closes over this subsystem's own maps and
        // not over a session — but it would be work done per session for a
        // fact about the process pair, and it would say the opposite of what
        // is true about the handler's lifetime to whoever read it next.
        host.serve("environment.create", serveEnvironmentCreate);
        // Beside it, on the same guard and for the same reason: what is
        // registered belongs to the HOST rather than to any one session.
        host.serve("environment.add_packages", serveEnvironmentAddPackages);
        cellRoutingHost = host;
      }
      const { environments, declared } = await kernelEnvironmentsFor(host, cwd, taskId, grants);
      // Recorded from the same list the host is about to be given, so the
      // card and the kernel cannot disagree about what `rstats` is.
      sessionEnvLanguages.set(
        sessionId,
        // Only the two the card knows how to say. A host describing some
        // third language is not something to render on a permission card as
        // a raw token a researcher has never seen — it gets no entry, and
        // the card falls back to naming no language at all.
        new Map(
          environments
            .filter((entry): entry is typeof entry & { language: "python" | "r" } =>
              entry.language === "python" || entry.language === "r")
            .map((entry) => [entry.name, entry.language]),
        ),
      );
      // The directory the socket goes in, before the host is asked to bind
      // one inside it.
      ensureKernelSocketDir();
      await host.call("kernel.configure_session", {
        session_id: sessionId,
        task_id: taskId,
        workspace: cwd,
        environments,
        socket,
        token,
        ...(declared === undefined ? {} : { declared }),
      });
    };
    try {
      await withDeadline(
        configure(),
        options.kernelReachMs ?? KERNEL_REACH_MS,
        "this machine's kernels did not answer in time",
      );
      return {
        servers: [kernelBridgeFor({ workspace: cwd, sessionId, taskId, agent, token })],
        // Handed back rather than filed here: this runs before the session
        // exists, and a session that never opens must leave nothing behind
        // to re-configure. `runTurn` files it at the same line it files the
        // session itself.
        reconfigure: configure,
      };
    } catch (err) {
      console.error(
        `this machine could not put a kernel within reach of ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { servers: [] };
    }
  }

  async function runTurn(
    runId: string,
    sessionId: string,
    studyId: string,
    taskId: string,
    agent: string,
    adapter: { command: string; args: string[] },
    prompt: string,
    grants: StandingGrant[],
    model: string | undefined,
  ): Promise<void> {
    if (cancelledQueuedRuns.delete(runId)) {
      if (sessionOfRun.delete(runId)) publishQueue(sessionId);
      return;
    }
    if (stopped) {
      // Queued behind another turn on the same session when `stop` was
      // called. The turn ahead of it gets a `completed` frame because
      // closing its session underneath it rejects the `session/prompt` call
      // that was holding it open — this one never reaches that point at
      // all, and without an ending of its own here it would sit `running`
      // in the store forever, with no daemon left to ever finish it.
      refuse(runId, STOPPED_BEFORE_TURN_REASON);
      if (sessionOfRun.delete(runId)) publishQueue(sessionId);
      return;
    }
    // What this turn's grants actually permit. A profile is fixed when the
    // process is spawned and cannot be widened or narrowed underneath it, so
    // a session already running is only reusable while the boundary it was
    // rendered from is still the one this turn needs. Where it is not, the
    // subprocess is retired and a new one takes its place: the alternative
    // is a turn running inside a boundary that describes grants the
    // researcher no longer gives it.
    let boundary: string;
    try {
      boundary = boundaryOf(
        policyFor({
          workspace: ensureTaskDir(options.workDir, studyId, taskId),
          grants,
          dataDir: options.dataDir,
          // The same read `startSession` renders, computed the same way. Two
          // readings of it that disagreed would make every turn's boundary
          // look changed, and every turn would retire the session in front of
          // it and spawn another.
          readable: daemonProgramPaths(),
          ...confinementFor(agent, ensureTaskDir(options.workDir, studyId, taskId)),
        }),
      );
    } catch (err) {
      refuse(runId, err instanceof Error ? err.message : String(err));
      if (sessionOfRun.delete(runId)) publishQueue(sessionId);
      return;
    }
    let live = liveSessions.get(sessionId);
    if (live && live.boundary !== boundary) {
      liveSessions.delete(sessionId);
      sessionDirs.delete(sessionId);
      sessionConfigures.delete(sessionId);
      if (runOfSession.get(sessionId) === runId) runOfSession.delete(sessionId);
      await live.close();
      live = undefined;
    }
    if (!live) {
      // The boundary is established before anything is spawned, and a run
      // whose boundary cannot be established never spawns anything at all.
      // That is the whole guarantee: this machine stays up and manageable,
      // and no agent code runs outside one.
      let cwd: string;
      try {
        cwd = ensureTaskDir(options.workDir, studyId, taskId);
        // Taken before the turn starts, and reported whichever way it went,
        // so a Revert control is offered only where it can actually put the
        // files back.
        const snapshot = await takeSnapshot(options.workDir, studyId, taskId);
        void postRunSnapshot(
          options.lab,
          options.token,
          runId,
          snapshot,
          eventsController.signal,
        ).catch(() => {
          // A snapshot the lab never heard about leaves Revert unoffered,
          // which is the safe reading of it: the files are still there, and
          // nothing claims a restore that was never confirmed possible.
        });
      } catch (err) {
        refuse(runId, err instanceof Error ? err.message : String(err));
        if (sessionOfRun.delete(runId)) publishQueue(sessionId);
        return;
      }
      // Before the session opens, so no tool call can reach a kernel this
      // machine has not yet described a boundary for.
      let mcpServers: McpServer[];
      // Held until the session is actually installed below, and filed with
      // it: a session that never opens — cancelled, or stopped, while ACP
      // was still initialising — must leave nothing behind to re-configure.
      let reconfigure: (() => Promise<void>) | undefined;
      try {
        ({ servers: mcpServers, reconfigure } = await kernelsFor(
          cwd,
          taskId,
          sessionId,
          agent,
          grants,
        ));
      } catch (err) {
        refuse(runId, err instanceof Error ? err.message : String(err));
        if (sessionOfRun.delete(runId)) publishQueue(sessionId);
        return;
      }
      const initialization = new AbortController();
      initializations.set(runId, initialization);
      try {
        let created: LiveSession | undefined;
        created = await startSession({
          adapter,
          agent,
          cwd,
          dataDir: options.dataDir,
          ...(options.platform === undefined ? {} : { platform: options.platform }),
          grants,
          mcpServers,
          onEvent: (event) => {
            if (liveSessions.get(sessionId) !== created) return;
            const current = runOfSession.get(sessionId);
            if (!current) return;
            emit(current, event);
            if (
              event.event === "completed" &&
              event.state.state === "cancelled" &&
              event.state.unacknowledged
            )
              retireSession(sessionId, created!);
          },
          onGrant: (grant) => {
            if (liveSessions.get(sessionId) !== created) return;
            // Resolved the same way `onEvent` resolves it — at call time,
            // off the session's current run, never the run that first
            // started this session — since a session outlives any one turn.
            const current = runOfSession.get(sessionId);
            if (!current) return;
            // Tracked in `inFlightFlushes` the same way `flush`'s own post
            // is: a grant is a durable decision, not a replaceable event
            // batch, so `stop` must wait for one still travelling to the lab
            // rather than abort it out from under the researcher's answer.
            const sent: Promise<void> = postRunGrant(
              options.lab,
              options.token,
              current,
              grant,
              eventsController.signal,
            )
              .catch(() => {
                // A grant that could not reach the lab is not retried: the
                // researcher's decision already took effect in this turn —
                // the grant covered the very call that raised the card —
                // losing only whether a later run on this Study gets asked
                // again.
              })
              .finally(() => {
                inFlightFlushes.delete(sent);
              });
            inFlightFlushes.add(sent);
          },
          env: confinedEnv(undefined),
          ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv() }),
          ...(model === undefined ? {} : { model }),
          signal: initialization.signal,
          ...(options.cancelGraceMs !== undefined ? { cancelGraceMs: options.cancelGraceMs } : {}),
        });
        live = created;
      } catch (err) {
        const explicitlyCancelled = cancelledQueuedRuns.delete(runId);
        if (stopped) refuse(runId, STOPPED_BEFORE_TURN_REASON);
        else if (!explicitlyCancelled)
          refuse(runId, err instanceof Error ? err.message : String(err));
        if (sessionOfRun.delete(runId)) publishQueue(sessionId);
        return;
      } finally {
        if (initializations.get(runId) === initialization) initializations.delete(runId);
      }
      // `startSession` crosses the process boundary and can take long enough
      // for a queued run to be cancelled while ACP is still initialising.
      // The cancellation has already published this run's sole terminal
      // frame; do not install the newly-created session or let its prompt run
      // behind that durable ending.
      const cancelledBeforePrompt = cancelledQueuedRuns.delete(runId);
      if (stopped || cancelledBeforePrompt) {
        if (stopped && !cancelledBeforePrompt) {
          refuse(runId, STOPPED_BEFORE_TURN_REASON);
          if (sessionOfRun.delete(runId)) publishQueue(sessionId);
        }
        await live.close();
        return;
      }
      liveSessions.set(sessionId, live);
      sessionDirs.set(sessionId, cwd);
      if (reconfigure !== undefined) sessionConfigures.set(sessionId, reconfigure);
    }

    runOfSession.set(sessionId, runId);
    const settled = new Promise<void>((resolve) => settlers.set(runId, resolve));
    live.prompt(prompt);
    await settled;
    if (runOfSession.get(sessionId) === runId) runOfSession.delete(sessionId);
    if (sessionOfRun.delete(runId)) publishQueue(sessionId);
  }

  function handleStartRun(command: RunCommand): void {
    const { runId, agent, studyId, taskId, sessionId, prompt, model } = command;
    // A reconnect replays commands from its cursor, and the lab cannot always
    // be sure this daemon saw the last one before the connection dropped.
    // Acting on the same run id twice would queue a second turn and, once
    // this run's frames have shipped and its `RunPost` freed, renumber a
    // fresh batch from 1 — colliding with what already went out.
    if (startedRuns.has(runId)) return;
    addBounded(startedRuns, runId, STARTED_RUNS_LIMIT);

    const adapter = agent === undefined ? undefined : options.adapterFor(agent);
    if (agent === undefined || !adapter) {
      // The probe's own sentence where it has one, because it knows which of
      // the several ways this happens actually happened and this does not.
      // The old wording survives for the case it was always right about: an
      // agent nothing has vetted and nothing has anything to say about.
      const why = agent === undefined ? undefined : options.heldBackReason?.(agent);
      refuse(runId, why ?? `this machine has no adapter for "${agent ?? "no agent named"}"`);
      return;
    }
    if (
      studyId === undefined ||
      taskId === undefined ||
      sessionId === undefined ||
      prompt === undefined
    ) {
      refuse(runId, "a start-run command is missing studyId, taskId, sessionId, or a prompt");
      return;
    }
    const grants = command.grants ?? [];

    sessionOfRun.set(runId, sessionId);
    publishQueue(sessionId, runId);
    const tail = turnQueues.get(sessionId) ?? Promise.resolve();
    const next = tail
      .catch(() => {})
      .then(() => runTurn(runId, sessionId, studyId, taskId, agent, adapter, prompt, grants, model));
    turnQueues.set(sessionId, next);
  }

  /** The live session a run may act on right now — only while that run is
   *  the one its session is actually running, never a run only queued
   *  behind it. */
  function liveSessionForRun(runId: string): LiveSession | undefined {
    const sessionId = sessionOfRun.get(runId);
    if (!sessionId || runOfSession.get(sessionId) !== runId) return undefined;
    return liveSessions.get(sessionId);
  }

  function cancelRun(runId: string): void {
    const live = liveSessionForRun(runId);
    if (live) {
      live.cancel();
      return;
    }
    const sessionId = sessionOfRun.get(runId);
    if (!sessionId || runOfSession.get(sessionId) === runId) return;
    cancelledQueuedRuns.add(runId);
    initializations.get(runId)?.abort();
    if (sessionOfRun.delete(runId)) publishQueue(sessionId);
    emit(runId, { event: "completed", state: { state: "cancelled" } });
  }

  function handleDecision(command: RunCommand): void {
    if (!command.decision) return;
    if (command.decision.action === "cancel") return cancelRun(command.runId);
    liveSessionForRun(command.runId)?.decide(command.decision);
  }

  function handleCancel(command: RunCommand): void {
    cancelRun(command.runId);
  }

  /**
   * Puts a Task's working directory back to what it held before this turn
   * ran, and ends the conversation the turn belonged to.
   *
   * The session is closed first: the protocol carries no way to take a turn
   * out of what an agent remembers, so a session left open is an agent that
   * would go on acting on a turn the researcher has just been told was
   * discarded. The next Send opens a new one, in this same directory.
   *
   * How it went is reported back rather than assumed. The lab truncates the
   * record only once this says the files are back.
   */
  function handleRevert(command: RunCommand): void {
    const { runId, studyId, taskId, sessionId } = command;
    void (async () => {
      let error: string | undefined;
      try {
        if (studyId === undefined || taskId === undefined)
          throw new Error("a revert command is missing studyId or taskId");
        if (sessionId !== undefined) {
          const live = liveSessions.get(sessionId);
          liveSessions.delete(sessionId);
          sessionDirs.delete(sessionId);
          sessionConfigures.delete(sessionId);
          if (runOfSession.get(sessionId) === runId) runOfSession.delete(sessionId);
          if (live) await live.close();
        }
        await restoreSnapshot(options.workDir, studyId, taskId);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      await postRunReverted(
        options.lab,
        options.token,
        runId,
        error === undefined ? { ok: true } : { ok: false, error },
        eventsController.signal,
      ).catch(() => {
        // The lab will not truncate what it never heard was restored, which
        // leaves the record standing over files that ARE back. Visible and
        // recoverable; the opposite ordering is neither.
      });
    })();
  }

  /**
   * Signals a kernel this machine's host may be holding, by the bare id the
   * host itself minted for it — the one thing `kernel.interrupt` and
   * `kernel.restart` need, and the same id the lab resolved a machine from
   * to address this machine at all. Neither command carries a reply: a
   * researcher watching a Stop control is better served by nothing
   * happening than by an error this machine has nowhere to show them, so a
   * machine with no kernel host, or one not answering, is left silent
   * rather than surfaced anywhere.
   */
  function signalKernel(method: "kernel.interrupt" | "kernel.restart", command: RunCommand): void {
    const kernelId = command.kernelId;
    if (options.kernelHost === undefined || kernelId === undefined) return;
    void options.kernelHost().call(method, { kernel_id: kernelId }).catch(() => {});
  }

  function handleKernelInterrupt(command: RunCommand): void {
    signalKernel("kernel.interrupt", command);
  }

  function handleKernelRestart(command: RunCommand): void {
    signalKernel("kernel.restart", command);
  }

  /**
   * Ends a kernel, carrying what the researcher said to whatever cell was in
   * it. Not through `signalKernel`, which passes only `kernel_id`: the
   * sentence and who said it are the whole point of this command, and a stop
   * that arrived without them would end the kernel and leave the agent's tool
   * call failing for no stated reason.
   *
   * Silent on failure for the same reason the signals above are — there is no
   * run to attach a frame to, and a researcher watching a Stop control is
   * better served by nothing happening than by an error this machine has
   * nowhere to show them.
   */
  function handleKernelStop(command: RunCommand): void {
    const kernelId = command.kernelId;
    if (options.kernelHost === undefined || kernelId === undefined) return;
    void options
      .kernelHost()
      .call("kernel.stop", {
        kernel_id: kernelId,
        ...(command.feedback === undefined ? {} : { feedback: command.feedback }),
        ...(command.by === undefined ? {} : { by: command.by }),
      })
      .catch(() => {});
  }

  /**
   * A cell the researcher's own REPL asked a kernel to run, outside any
   * agent's turn — so there is no run for its output to travel a
   * `RunEvent` through the way an agent's cell does. `kernel.execute`
   * answers the call itself with the cell it just ran, and that is what
   * reaches the lab: posted directly, under the id the lab already minted
   * and handed back before this command ever arrived. The host announces
   * this cell as well, on the same stream every cell is announced on, and
   * `forwardKernelCells` drops it — a cell carried both ways would be
   * recorded twice, and a researcher would read one cell as two.
   *
   * Silent when this machine holds no kernel host, when the command is
   * missing the identity or attribution a cell must carry, or when the
   * kernel itself refuses the call: there is no run to attach a failure
   * frame to, and the REPL's own error state is what a researcher watching
   * this actually sees.
   */
  function handleKernelExecute(command: RunCommand): void {
    const { kernelId, code, sessionId, taskId, name, language, by, cellId } = command;
    if (options.kernelHost === undefined) return;
    if (
      kernelId === undefined ||
      code === undefined ||
      sessionId === undefined ||
      taskId === undefined ||
      name === undefined ||
      language === undefined ||
      by === undefined ||
      cellId === undefined
    )
      return;
    void options
      .kernelHost()
      .call("kernel.execute", {
        session_id: sessionId,
        task_id: taskId,
        name,
        language,
        source: code,
        origin: { surface: "repl", by },
      })
      .then((cell) =>
        postKernelCell(
          options.lab,
          options.token,
          cellId,
          cell as KernelCellReport,
          eventsController.signal,
        ),
      )
      .catch(() => {});
  }

  /**
   * What this machine's kernel host is holding, answered back to the lab's
   * own `kernel-list` ask. Answered `[]` rather than left silent when this
   * machine holds no kernel host at all, or when the host itself does not
   * answer — the lab's own wait for this reply is bounded either way, but a
   * machine that answers promptly is what keeps a researcher's poll from
   * ever needing to wait out that bound.
   */
  function handleKernelList(command: RunCommand): void {
    const requestId = command.runId;
    if (options.kernelHost === undefined) {
      void postKernelList(options.lab, options.token, requestId, [], eventsController.signal).catch(
        () => {},
      );
      return;
    }
    void options
      .kernelHost()
      .call("kernel.list", {})
      .then((result) => {
        const kernels = (result as { kernels?: unknown } | undefined)?.kernels;
        return postKernelList(
          options.lab,
          options.token,
          requestId,
          Array.isArray(kernels) ? kernels : [],
          eventsController.signal,
        );
      })
      .catch(() =>
        postKernelList(options.lab, options.token, requestId, [], eventsController.signal).catch(
          () => {},
        ),
      );
  }

  /**
   * Builds (or replays) `name` on this machine, answered back to the lab's
   * own `kernel-env-setup` ask.
   *
   * Two shapes, decided entirely by whether `command` carries a `lockfile`:
   * one carrying none means this machine is the first to build `name` and
   * must RESOLVE — its own resolve's lockfile is then handed to the lab
   * through `/daemon/kernel-env/lock`, which is the one call that learns
   * the revision this machine's own completion marker has to record, since
   * nothing here can know it before that lab-side write happens. One
   * carrying a lockfile means a later machine replaying an already-pinned
   * environment (D4): it MATERIALIZES from exactly that text and never
   * calls `resolveEnvironment` at all — the only line in this function that
   * makes D4 true rather than merely stated. `uv`'s own output reaches the
   * lab as it happens, through `/daemon/kernel-env/progress`, from either
   * step; the final outcome — this machine's own `readEnvStatus`, or the
   * reason it failed — settles the lab's own wait through
   * `/daemon/kernel-env/result`, which nothing here proceeds without
   * eventually calling, success or failure: the lab's own promise has
   * nothing else that will ever release it.
   */
  function handleKernelEnvSetup(command: RunCommand): void {
    const requestId = command.runId;
    const name = command.name;
    if (name === undefined) {
      // Answered, never dropped. This lab holds the caller's promise open
      // until something settles it, and the only other thing that will is a
      // forty-minute timeout — so returning silently here turns a malformed
      // command into a researcher watching a Setup that was never going to
      // happen. The same reasoning the kernel host's own loop applies to a
      // method it does not recognize: a request that gets no reply reads as
      // a hung machine rather than as a refused message.
      void postKernelEnvResult(
        options.lab,
        options.token,
        requestId,
        { ok: false, error: "this machine was asked to set up an environment with no name" },
        eventsController.signal,
      ).catch(() => {});
      return;
    }
    const onLine = (line: string): void => {
      void postKernelEnvProgress(
        options.lab,
        options.token,
        requestId,
        name,
        line,
        eventsController.signal,
      ).catch(
        () => {
          // Best-effort, unlike the final result below: a progress line
          // this lab never receives costs nothing but itself.
        },
      );
    };
    void (async () => {
      try {
        let lockfile = command.lockfile;
        let lockRevision = command.lockRevision;
        if (lockfile === undefined) {
          const resolved = await resolveEnvironment({
            workDir: options.workDir,
            dataDir: options.dataDir,
            name,
            packages: command.packages ?? [],
            // Same fallback `readEnvStatus`'s own `manager` field gets below —
            // D1 means this is always `"uv"` today, but the default lives
            // here rather than upstream so a command that predates this
            // field builds exactly what it always built.
            manager: command.manager ?? "uv",
            ...(options.platform === undefined ? {} : { platform: options.platform }),
            onLine,
          });
          lockfile = resolved.lockfile;
          ({ lockRevision } = await postKernelEnvLock(
            options.lab,
            options.token,
            requestId,
            name,
            lockfile,
            eventsController.signal,
          ));
        }
        if (lockRevision === undefined)
          throw new Error(`${name}'s setup command carried a lockfile with no revision to build it under`);
        await materializeEnvironment({
          workDir: options.workDir,
          dataDir: options.dataDir,
          name,
          lockfile,
          lockRevision,
          manager: command.manager ?? "uv",
          ...(options.platform === undefined ? {} : { platform: options.platform }),
          onLine,
        });
        // Read back from disk rather than assembled from what was just
        // built: this is the same fact `readEnvStatus` reports on this
        // machine's own regular report, so the lab's answer and the
        // machine's own next report can never disagree about it.
        // `language` is this phase's own constant everywhere outside a
        // declaration this daemon does not otherwise hold; `manager` is the
        // same `command.manager ?? "uv"` just handed to the two calls above,
        // repeated rather than hoisted because each of the three needs it at
        // a different point in this function.
        const status: KernelEnvStatus = readEnvStatus(options.workDir, {
          name,
          language: command.language ?? "python",
          manager: command.manager ?? "uv",
          packages: [],
          createdTs: 0,
          lockRevision,
        });
        // Before the result and not after. The result is what releases the
        // lab's own wait and unblocks the researcher's Setup, and a session
        // still confined by the map it was opened with would refuse the very
        // cell the build was for — "not built on this machine yet", about an
        // environment this function has just finished building. The opposite
        // order leaves exactly that window open.
        //
        // A second `configure_session` is what the host is built for: it
        // replaces what the earlier one said, and deliberately restarts
        // NOTHING of its own (see `configure_session`, registry.py) — which
        // is why every session's kernels in every OTHER environment survive a
        // build untouched, notebook state and all. That is this call's whole
        // contribution and the reason this is not just "retire the session".
        //
        // The kernels in the environment that was actually rebuilt are a
        // different matter, and the next step ends them deliberately: their
        // interpreter is gone. Do not read the paragraph above as saying this
        // function restarts nothing — it restarts exactly the kernels whose
        // ground `uv venv --clear` has removed, and no others.
        await retellLiveSessions(
          (sessionId) =>
            `${name} is built on this machine, but ${sessionId}'s kernels were not told about it ` +
            `and will need a restart to use it`,
        );
        // Then the kernels that were already running in it, and AFTER the
        // re-describe above rather than before: a relaunch reads the
        // confinement this host currently holds, so a kernel restarted ahead
        // of the new boundary would be started inside the old one.
        //
        // This is correctness, not courtesy. `materializeEnvironment` runs
        // `uv venv --clear`, which removes everything already at the target
        // path — so a kernel still running against a rebuilt environment is a
        // process whose interpreter and site-packages have been deleted out
        // from under it. It answers out of what it has already imported and
        // then fails on the first thing it needs the disk for, which reads to
        // a researcher as their own code breaking for no reason.
        //
        // Every successful setup, not only the ones carrying a `reason`: the
        // directory is cleared whoever asked for the build. What `reason`
        // decides is only what the ending SAYS — an agent's `manage_packages`
        // has a sentence worth carrying, a researcher's own Setup click does
        // not, and the first build of an environment nothing is bound to
        // restarts nothing either way.
        //
        // Best-effort, like `retellLiveSessions` and for the same reason:
        // this machine has already built what it was asked to build, and the
        // lab's own wait is about that. A host that will not take this news
        // costs the kernels in that environment a restart the researcher can
        // perform themselves; reporting a build that happened as a failure
        // would cost them the build.
        try {
          await options.kernelHost?.().call("kernel.restart_environment", {
            name,
            ...(command.reason === undefined ? {} : { reason: command.reason }),
          });
        } catch {
          // See above.
        }
        await postKernelEnvResult(
          options.lab,
          options.token,
          requestId,
          { ok: true, status },
          eventsController.signal,
        );
      } catch (err) {
        await postKernelEnvResult(
          options.lab,
          options.token,
          requestId,
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          eventsController.signal,
        ).catch(() => {
          // The lab's own wait times out on this the same way it would on a
          // machine that vanished mid-build — there is nothing more this
          // call can do about a lab it cannot currently reach.
        });
      }
    })();
  }

  /**
   * Frees this machine's own copy of `name`, answered back to nothing: a
   * researcher freeing disk on their own machine is not a build with
   * progress to watch, and the next report this machine sends is what
   * tells `computeSnapshot` the copy is gone. Silent on failure, the same
   * as `handleKernelInterrupt`/`handleKernelStop`: there is no run to
   * attach a failure frame to.
   *
   * Then every open session is told, for the mirror of the reason a
   * finished build tells them. A session confined by the map it was opened
   * with goes on OFFERING an environment whose interpreter this function
   * has just deleted, and `identity_for` resolves a name against that map
   * without ever asking the filesystem — so the next cell naming it mints a
   * kernel and execs a path that is not there. That is worse than the
   * refusal it replaces: an environment that is not built refuses in a
   * sentence a researcher can act on, while this fails to launch with
   * nothing useful said. Once the re-send lands, `readEnvStatus` reads
   * `absent`, the entry is dropped, and the lab's own declaration still
   * names it — so the host produces exactly that honest refusal again.
   */
  function handleKernelEnvReclaim(command: RunCommand): void {
    const name = command.name;
    if (name === undefined) return;
    void (async () => {
      try {
        removeEnvironment(options.workDir, name);
      } catch {
        // Silent — see the doc comment above.
      }
      // Whether or not that threw. A remove that failed part way leaves a
      // `broken` environment, which the re-sent map drops exactly as it
      // drops an absent one; a map left stale after a partial delete is the
      // worst of the three outcomes, and skipping this on failure is how it
      // would happen. Nothing here answers the lab, so there is no result to
      // order against — this is simply the last thing a reclaim does.
      await retellLiveSessions(
        (sessionId) =>
          `${name} is gone from this machine, but ${sessionId}'s kernels were not told, so that ` +
          `session will go on offering it until it restarts`,
      );
    })();
  }

  /**
   * Summarize a Task's opening message into a name for it, answered back to
   * the lab's own `name-task` ask.
   *
   * One at a time, lab-wide. Opening a chat is a burst activity — a
   * researcher who has just sat down opens four — and each of these launches
   * an agent CLI, so without this a moment of enthusiasm forks four model
   * processes on their laptop while they are waiting on the first real turn.
   * A naming that arrives while one is already running is declined outright
   * rather than queued: the lab is holding a call open on it, and a Task that
   * keeps its prompt-derived name has lost nothing worth making anyone wait
   * for.
   *
   * Nothing here touches the run path. A naming that fails, hangs or is
   * declined is answered `null` and forgotten; no session it opens is ever
   * installed in `liveSessions`, so `stop`, `cancel` and the queueing that
   * serialises real turns are all indifferent to it.
   */
  function handleNameTask(command: RunCommand): void {
    const requestId = command.runId;
    const { agent, prompt } = command;
    const answer = (title: string | null): void => {
      void postTaskTitle(options.lab, options.token, requestId, title, eventsController.signal).catch(
        () => {
          // The lab's own wait covers this: an answer that never lands leaves
          // the Task named as it already was, which is where a failure here
          // leaves it too.
        },
      );
    };
    if (prompt === undefined || agent === undefined || naming || stopped) return answer(null);
    // The same lookup a run resolves through, so naming is never launched
    // through a program probing did not vet.
    const adapter = options.adapterFor(agent);
    if (adapter === undefined) return answer(null);

    naming = true;
    void summarizeTask({
      adapter,
      agent,
      prompt,
      cwd: namingDir(options.workDir),
      dataDir: options.dataDir,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      // The naming session opens its own adapter, so it needs the same
      // deliberate variables a run's does — an allowlist filters this one
      // exactly as hard.
      ...(options.extraEnv === undefined ? {} : { extraEnv: options.extraEnv() }),
    })
      .then(answer, () => answer(null))
      .finally(() => {
        naming = false;
      });
  }

  function handleCommand(seq: number, command: RunCommand): void {
    lastCommandSeq = seq;
    if (command.type === "start-run") return handleStartRun(command);
    if (command.type === "decision") return handleDecision(command);
    if (command.type === "cancel") return handleCancel(command);
    if (command.type === "revert") return handleRevert(command);
    if (command.type === "kernel-interrupt") return handleKernelInterrupt(command);
    if (command.type === "kernel-stop") return handleKernelStop(command);
    if (command.type === "kernel-restart") return handleKernelRestart(command);
    if (command.type === "kernel-execute") return handleKernelExecute(command);
    if (command.type === "kernel-list") return handleKernelList(command);
    if (command.type === "kernel-env-setup") return handleKernelEnvSetup(command);
    if (command.type === "kernel-env-reclaim") return handleKernelEnvReclaim(command);
    if (command.type === "name-task") return handleNameTask(command);
  }

  const retries = createRetryLoop({
    onRefused: () => {
      // "No amount of retrying fixes that" is `retry.ts`'s own contract for
      // this — the loop below reads `refused` and stops opening the command
      // stream again rather than backing off and trying regardless.
      refused = true;
    },
  });

  async function connectLoop(): Promise<void> {
    while (!stopped && !refused) {
      await retries.run(options.lab, "run commands", async () => {
        await reportLive();
        await openCommands(
          options.lab,
          options.token,
          lastCommandSeq,
          handleCommand,
          () => {},
          commandsController.signal,
        );
      });
    }
  }

  const loop = connectLoop();

  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      commandsController.abort();
      for (const initialization of initializations.values()) initialization.abort();
      retries.stop();
      await loop;
      await reconciliationRetry;
      // Runs queued behind a sibling, and runs still awaiting `session/new`,
      // are absent from `liveSessions` and therefore cannot be ended by the
      // close loop below. Give each its durable ending now and leave a
      // tombstone for its queued/initializing continuation to consume before
      // it can ever reach `prompt()`.
      for (const [runId, sessionId] of [...sessionOfRun]) {
        if (runOfSession.get(sessionId) === runId) continue;
        cancelledQueuedRuns.add(runId);
        if (sessionOfRun.delete(runId)) publishQueue(sessionId);
        refuse(runId, STOPPED_BEFORE_TURN_REASON);
      }
      // Closing a session that still has a turn in flight is not silent: the
      // subprocess exiting rejects the `session/prompt` call it was holding
      // open, which `session.ts` turns into a `completed` event reaching
      // `emit`/`flush` right here. Draining every run's batch afterward —
      // including anything a 50ms timer had not yet fired for — is what
      // carries that frame, and anything still queued behind it, to the lab
      // rather than losing it under the abort below. That drain has to keep
      // re-checking rather than wait on one snapshot: a batch already in
      // flight when this line runs can defer this very `completed` frame
      // behind it, so the POST that actually carries it does not start
      // until the first one settles — after a snapshot would already have
      // moved on.
      await Promise.all(
        [...liveSessions.values(), ...retainedSessions].map((session) => session.close()),
      );
      // A session still crossing `session/new` was not present in either
      // collection above. Its queued turn owns the only reference to the
      // child until initialization returns; wait for that continuation to
      // consume the shutdown tombstone and close the child before declaring
      // stop complete. Bound the wait so a broken adapter that never answers
      // initialization cannot make machine shutdown itself unbounded.
      await Promise.race([
        Promise.all([...turnQueues.values()].map((turn) => turn.catch(() => {}))),
        delay(FINAL_FLUSH_GRACE_MS),
      ]);
      liveSessions.clear();
      sessionConfigures.clear();
      retainedSessions.clear();
      sessionDirs.clear();
      retainedSessionDirs.clear();
      for (const runId of posts.keys()) flush(runId);
      await Promise.race([drainInFlightFlushes(), delay(FINAL_FLUSH_GRACE_MS)]);
      eventsController.abort();
      for (const post of posts.values()) {
        if (post.timer) clearTimeout(post.timer);
        post.timer = undefined;
      }
    },
    lastFailure(): string | undefined {
      return lastFailure;
    },
    liveSessionDirs(): string[] {
      return [...sessionDirs.values(), ...retainedSessionDirs];
    },
  };
}
