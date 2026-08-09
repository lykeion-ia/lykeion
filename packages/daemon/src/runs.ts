import type { RunEvent, RunEventFrame } from "@lykeion/api";
import { addBounded } from "./bounded-set";
import {
  backoffDelayMs,
  LabFrameConflict,
  LabRefused,
  openCommands,
  postKernelCell,
  postKernelList,
  postRunEvents,
  postRunGrant,
  postRunLive,
  postRunReverted,
  postRunSnapshot,
  type KernelCellReport,
  type RunCommand,
} from "./lab";
import { createRetryLoop } from "./retry";
import { ensureTaskDir } from "./workspace";
import { confinementFor } from "./agent-home";
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
import { boundaryOf, policyFor } from "./sandbox";
import { restoreSnapshot, takeSnapshot } from "./snapshot";
import { startSession, type LiveSession, type McpServer, type StandingGrant } from "./session";

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
   */
  async function kernelsFor(
    cwd: string,
    taskId: string,
    sessionId: string,
    agent: string,
    grants: StandingGrant[],
  ): Promise<McpServer[]> {
    if (options.kernelHost === undefined) return [];
    const token = kernelSessionToken();
    // Decided before anything is asked of the host, and outside the catch
    // below, so a name that cannot be bound leaves this as a refusal rather
    // than as a session quietly opened with no tools.
    const socket = kernelSocketPath(cwd);
    const reaching = async (): Promise<void> => {
      const host = options.kernelHost!();
      if (cellRoutingHost !== host) {
        forwardKernelCells(
          host,
          (sid) => runOfSession.get(sid),
          emit,
          (sid, source) => liveSessions.get(sid)?.claimKernelCall(source),
        );
        cellRoutingHost = host;
      }
      const hello = (await host.call("host.hello", {})) as {
        protocol?: unknown;
        environment?: string;
        reads?: string[];
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
      const { prefix } = kernelConfinementFor({
        platform: options.platform ?? process.platform,
        workspace: cwd,
        dataDir: options.dataDir,
        grants,
        reads: hello.reads ?? [],
      });
      // The directory the socket goes in, before the host is asked to bind
      // one inside it.
      ensureKernelSocketDir();
      await host.call("kernel.configure_session", {
        session_id: sessionId,
        task_id: taskId,
        workspace: cwd,
        environment: hello.environment ?? "",
        prefix,
        socket,
        token,
      });
    };
    try {
      await withDeadline(
        reaching(),
        options.kernelReachMs ?? KERNEL_REACH_MS,
        "this machine's kernels did not answer in time",
      );
      return [kernelBridgeFor({ workspace: cwd, sessionId, taskId, agent, token })];
    } catch (err) {
      console.error(
        `this machine could not put a kernel within reach of ${taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
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
      try {
        mcpServers = await kernelsFor(cwd, taskId, sessionId, agent, grants);
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
          env: process.env,
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
      refuse(runId, `this machine has no adapter for "${agent ?? "no agent named"}"`);
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
   * `kernel.restart` need, and the same id the lab resolved a runtime from
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

  function handleCommand(seq: number, command: RunCommand): void {
    lastCommandSeq = seq;
    if (command.type === "start-run") return handleStartRun(command);
    if (command.type === "decision") return handleDecision(command);
    if (command.type === "cancel") return handleCancel(command);
    if (command.type === "revert") return handleRevert(command);
    if (command.type === "kernel-interrupt") return handleKernelInterrupt(command);
    if (command.type === "kernel-restart") return handleKernelRestart(command);
    if (command.type === "kernel-execute") return handleKernelExecute(command);
    if (command.type === "kernel-list") return handleKernelList(command);
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
