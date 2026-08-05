import type { RunEvent, RunEventFrame } from "@lykeion/api";
import { addBounded } from "./bounded-set";
import { openCommands, postRunEvents, postRunGrant, postRunLive, type RunCommand } from "./lab";
import { createRetryLoop } from "./retry";
import { ensureSessionDir } from "./workspace";
import { startSession, type LiveSession, type StandingGrant } from "./session";

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

export interface RunSubsystem {
  stop(): Promise<void>;
  /** The reason the most recent turn was abandoned, for a caller that has
   *  no event stream to read it from. Absent until one is. */
  lastFailure(): string | undefined;
  /** The working directory of every session this daemon currently holds a
   *  live ACP subprocess for. What a sweep of stale workspaces must never
   *  remove out from under a running agent, however long it has been since
   *  the directory itself was last touched. */
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
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
  dataDir: string;
  adapterFor(agent: string): { command: string; args: string[] } | undefined;
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
  // Every `start-run` this daemon has recently begun handling, bounded by
  // `STARTED_RUNS_LIMIT`. A reconnect can replay a command the lab is not
  // yet sure this daemon saw; without this, a replayed start-run would queue
  // the turn a second time and — since a completed run's `RunPost` is freed
  // once its `completed` frame ships — renumber its frames from 1 again,
  // colliding with the ones already sent.
  const startedRuns = new Set<string>();

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

  interface RunPost {
    pending: RunEventFrame[];
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
  }
  const posts = new Map<string, RunPost>();
  // Every `postRunEvents` call currently in flight, so `stop` can wait for
  // exactly the ones that matter — including one a session's `close()`
  // triggers after `stop` has already moved past the line that started it —
  // rather than guessing at a fixed pause.
  const inFlightFlushes = new Set<Promise<void>>();

  function postFor(runId: string): RunPost {
    const existing = posts.get(runId);
    if (existing) return existing;
    const created: RunPost = { pending: [], nextSeq: 1, ended: false, flushing: false };
    posts.set(runId, created);
    return created;
  }

  function flush(runId: string): void {
    const post = posts.get(runId);
    if (!post || post.flushing || post.pending.length === 0) return;
    if (post.timer) {
      clearTimeout(post.timer);
      post.timer = undefined;
    }
    // This run has nothing left to send once this batch lands — the batch
    // about to go out either carries its `completed` frame or already sent
    // it, since `emit` never lets anything past `post.ended` into `pending`.
    // A lab that never accepts *this* delivery is the one failure this
    // subsystem cannot otherwise report: everything else a batch carries is
    // superseded by whatever the run produces next, but a run's own ending,
    // lost here, is lost for good.
    const isFinal = post.ended;
    const frames = post.pending.splice(0, post.pending.length);
    post.flushing = true;
    const sent: Promise<void> = postRunEvents(options.lab, options.token, runId, frames, eventsController.signal)
      .catch(() => {
        // A batch that could not be delivered is not retried: what it carried
        // is gone, and the next thing the lab hears from this run is whatever
        // it produces next — unless there is no "next": a run's own ending
        // failing to land is the one loss this subsystem does surface, since
        // nothing else will ever tell anyone this run had an outcome at all.
        if (isFinal) lastFailure = `${runId}'s outcome could not be delivered to the lab`;
      })
      .finally(() => {
        inFlightFlushes.delete(sent);
        post.flushing = false;
        if (post.ended && post.pending.length === 0) posts.delete(runId);
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
    while (inFlightFlushes.size > 0) await Promise.all(inFlightFlushes);
  }

  function scheduleFlush(runId: string): void {
    const post = posts.get(runId);
    if (!post || post.timer) return;
    post.timer = setTimeout(() => {
      post.timer = undefined;
      flush(runId);
    }, FLUSH_INTERVAL_MS);
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
    post.nextSeq += 1;
    post.ended = true;
    lastFailure = reason;
    settlers.get(runId)?.();
    settlers.delete(runId);
    flush(runId);

    // The session that produced this backlog is not going to stop on its
    // own — it is what "will not stop talking" means — so it is closed here
    // rather than left running to grow a queue that has already been given
    // up on. Removed from `liveSessions` first so a later start-run naming
    // this same session id spawns a fresh subprocess instead of reusing one
    // already being torn down.
    const sessionId = sessionOfRun.get(runId);
    if (sessionId) {
      const live = liveSessions.get(sessionId);
      liveSessions.delete(sessionId);
      sessionDirs.delete(sessionId);
      if (live) void live.close();
    }
  }

  function emit(runId: string, event: RunEvent): void {
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
    if (post.ended) return;
    if (post.pending.length >= OUTBOUND_QUEUE_LIMIT) return overflow(runId);
    post.pending.push({ seq: post.nextSeq, event });
    post.nextSeq += 1;
    if (event.event === "completed") {
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

  async function runTurn(
    runId: string,
    sessionId: string,
    studyId: string,
    adapter: { command: string; args: string[] },
    prompt: string,
    grants: StandingGrant[],
  ): Promise<void> {
    if (stopped) {
      // Queued behind another turn on the same session when `stop` was
      // called. The turn ahead of it gets a `completed` frame because
      // closing its session underneath it rejects the `session/prompt` call
      // that was holding it open — this one never reaches that point at
      // all, and without an ending of its own here it would sit `running`
      // in the store forever, with no daemon left to ever finish it.
      refuse(runId, "this machine stopped before this run's turn could begin");
      sessionOfRun.delete(runId);
      return;
    }
    let live = liveSessions.get(sessionId);
    if (!live) {
      const cwd = ensureSessionDir(options.dataDir, studyId, sessionId);
      try {
        let created: LiveSession | undefined;
        created = await startSession({
          adapter,
          cwd,
          grants,
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
          ...(options.cancelGraceMs !== undefined ? { cancelGraceMs: options.cancelGraceMs } : {}),
        });
        live = created;
      } catch (err) {
        refuse(runId, err instanceof Error ? err.message : String(err));
        sessionOfRun.delete(runId);
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
    sessionOfRun.delete(runId);
  }

  function handleStartRun(command: RunCommand): void {
    const { runId, agent, studyId, sessionId, prompt } = command;
    // A reconnect replays commands from its cursor, and the lab cannot always
    // be sure this daemon saw the last one before the connection dropped.
    // Acting on the same run id twice would queue a second turn and, once
    // this run's frames have shipped and its `RunPost` freed, renumber a
    // fresh batch from 1 — colliding with what already went out.
    if (startedRuns.has(runId)) return;
    addBounded(startedRuns, runId, STARTED_RUNS_LIMIT);

    const adapter = agent === undefined ? undefined : options.adapterFor(agent);
    if (!adapter) {
      refuse(runId, `this machine has no adapter for "${agent ?? "no agent named"}"`);
      return;
    }
    if (studyId === undefined || sessionId === undefined || prompt === undefined) {
      refuse(runId, "a start-run command is missing studyId, sessionId, or a prompt");
      return;
    }
    const grants = command.grants ?? [];

    sessionOfRun.set(runId, sessionId);
    const tail = turnQueues.get(sessionId) ?? Promise.resolve();
    const next = tail.catch(() => {}).then(() => runTurn(runId, sessionId, studyId, adapter, prompt, grants));
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

  function handleDecision(command: RunCommand): void {
    if (!command.decision) return;
    liveSessionForRun(command.runId)?.decide(command.decision);
  }

  function handleCancel(command: RunCommand): void {
    liveSessionForRun(command.runId)?.cancel();
  }

  function handleCommand(seq: number, command: RunCommand): void {
    lastCommandSeq = seq;
    if (command.type === "start-run") return handleStartRun(command);
    if (command.type === "decision") return handleDecision(command);
    if (command.type === "cancel") return handleCancel(command);
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
        await postRunLive(options.lab, options.token, [...sessionOfRun.keys()], commandsController.signal);
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
      retries.stop();
      await loop;
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
      liveSessions.clear();
      retainedSessions.clear();
      sessionDirs.clear();
      retainedSessionDirs.clear();
      for (const runId of posts.keys()) flush(runId);
      await Promise.race([drainInFlightFlushes(), delay(FINAL_FLUSH_GRACE_MS)]);
      eventsController.abort();
    },
    lastFailure(): string | undefined {
      return lastFailure;
    },
    liveSessionDirs(): string[] {
      return [...sessionDirs.values(), ...retainedSessionDirs];
    },
  };
}
