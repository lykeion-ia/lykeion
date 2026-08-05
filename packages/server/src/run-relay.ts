import type { RunDecision, RunEventFrame } from "@lykeion/api";
import type { StandingGrant } from "./store/sessions";

/**
 * One instruction the lab hands a runtime over its command stream: start a
 * turn, answer something a running turn asked, or stop one. Every kind
 * shares this one shape because they travel the same stream in the same
 * envelope — only `runId` is ever guaranteed present.
 */
export interface RunCommand {
  type: "start-run" | "decision" | "cancel";
  runId: string;
  studyId?: string;
  sessionId?: string;
  agent?: string;
  prompt?: string;
  grants?: StandingGrant[];
  decision?: RunDecision;
}

/** How many of a run's most recent event frames stay available to replay.
 *  Generous relative to how many frames one turn ordinarily produces, so a
 *  browser that reconnects mid-turn almost never finds a gap; not unbounded,
 *  because a process that outlives thousands of runs must not keep growing
 *  one array per run forever. */
const RUN_FRAME_LIMIT = 500;

/** How many completed runs with nobody currently subscribed stay
 *  retrievable, oldest evicted first, once a newer one pushes past the
 *  limit. A run that finishes while its buffer holds no subscriber is the
 *  ordinary case, not a rare one — nobody has to be watching at the exact
 *  moment a turn ends for a later visit to it to still work. What must
 *  never happen is deleting that buffer, completion frame and all, the
 *  instant the last (or the zeroth) subscriber is gone: a run whose viewer
 *  arrives a moment late, or never arrived until after it finished, would
 *  hang forever with no history, no completion signal, and no error. A
 *  buffer that still has a subscriber attached, or belongs to a run that
 *  has not completed, is never counted against this limit or evicted by
 *  it — only the completed-and-currently-unwatched ones age out, and only
 *  once there are more of those than this many. */
const RETIRED_RUN_LIMIT = 200;

interface RuntimeQueue {
  /** The seq assigned to the last command enqueued for this runtime. */
  seq: number;
  /** Every command still-live-relevant to this runtime, in order — what a
   *  fresh `attach` replays before it starts forwarding commands live. A
   *  finished run's commands are removed the moment its `completed` frame
   *  is published: the machine that produced that frame already saw them,
   *  and nobody else's cursor can legitimately ask for them again. */
  commands: { seq: number; command: RunCommand }[];
  /** The one live listener a runtime's command stream currently has, if any
   *  connection is open. A later `attach` for the same runtime replaces it:
   *  a daemon holds exactly one connection to this stream at a time. */
  subscriber?: (seq: number, command: RunCommand) => void;
  /** Run ids this runtime is believed to be holding — every `start-run` that
   *  has actually reached a connected daemon (delivered by `enqueue` to a
   *  live subscriber, or replayed by `attach`), minus whatever `reconcile`
   *  has since been told it no longer holds. A `start-run` still sitting
   *  undelivered in `commands` — the stream was down when it was queued —
   *  is not in here yet: nothing has actually been asked to run it. */
  live: Set<string>;
}

interface RunBuffer {
  /** The run's most recent event frames, oldest first, capped at
   *  `RUN_FRAME_LIMIT`. */
  frames: RunEventFrame[];
  subscribers: Set<(frame: RunEventFrame) => void>;
  /** Set once a `completed` frame has been published for this run. Together
   *  with an empty `subscribers`, this is what makes the buffer eligible to
   *  eventually age out instead of being held for the rest of the process's
   *  life — see `retireIfDone`. */
  ended: boolean;
}

export interface RunRelay {
  /** Queues one command for a runtime, assigning it the next seq in that
   *  runtime's own sequence, and delivers it at once to whatever is
   *  currently attached — which is also the moment a `start-run` among them
   *  joins the runtime's `live` set; one enqueued with nobody attached does
   *  not, until a later `attach` replays it. */
  enqueue(runtimeId: string, command: RunCommand): void;
  /** Attaches the one live listener for a runtime's command stream: every
   *  command already queued is replayed to it immediately, in order —
   *  joining the runtime's `live` set as it goes, for any `start-run` among
   *  them that had not reached a subscriber before now — and every command
   *  enqueued afterward is delivered as it arrives. Returns a function that
   *  detaches it — a no-op once a later `attach` for the same runtime has
   *  already taken its place. */
  attach(runtimeId: string, send: (seq: number, c: RunCommand) => void): () => void;
  /** Reconciles what a runtime reports holding against what this relay
   *  believes it holds, replacing the belief with the report and returning
   *  the run ids that were believed live but are absent from it. */
  reconcile(runtimeId: string, liveRunIds: string[]): string[];
  /** Appends a run's event frames to its ring buffer and forwards them to
   *  every current subscriber. A `completed` frame retires the run from its
   *  runtime's live set, drops that run's now-unneeded commands from the
   *  runtime's queue, and — once no subscriber is left attached — makes the
   *  run's own buffer eligible to age out under `RETIRED_RUN_LIMIT`, not
   *  deleted on the spot: a late subscriber must still be able to catch up
   *  on a run that finished before it ever arrived. */
  publish(runId: string, frames: RunEventFrame[]): void;
  /** Subscribes to a run's event frames. When `cursor` is given, every
   *  buffered frame after it is replayed first; a subscriber joining with no
   *  cursor gets nothing until a frame is next published. Returns a function
   *  that unsubscribes — which, for a run that has already finished, makes
   *  its buffer eligible to age out once nothing else is still attached. */
  subscribe(runId: string, cursor: number | undefined, send: (f: RunEventFrame) => void): () => void;
  /** The run ids a runtime is currently believed to be holding. */
  liveFor(runtimeId: string): string[];
  /** The seq a caller synthesizing a frame this relay did not itself number
   *  should give it, continuing whatever sequence the run's buffer already
   *  holds — 1 for a run that has produced nothing yet. What reconciling a
   *  dropped run's own ending uses: nothing numbered it, since the machine
   *  that would have is the one that just went missing, and a seq that did
   *  not continue the run's own sequence would let a subscriber replaying
   *  from a later cursor skip straight past it. */
  nextSeqFor(runId: string): number;
}

export function createRunRelay(): RunRelay {
  const runtimes = new Map<string, RuntimeQueue>();
  const runs = new Map<string, RunBuffer>();
  /** Which runtime a still-live run belongs to, so a `completed` frame
   *  reaching `publish` — which is not told the runtime — can retire the run
   *  from that runtime's live set. Cleared once the run completes. */
  const runtimeOfRun = new Map<string, string>();
  /** Completed runs with no subscriber currently attached, oldest first —
   *  `Set` iteration order is insertion order, and re-adding an id already
   *  present moves it to the end, which is what lets a run that gets
   *  subscribed to and released again start its wait over rather than being
   *  evicted on however much of the original window happened to remain. */
  const unwatchedSinceEnd = new Set<string>();

  function queueFor(runtimeId: string): RuntimeQueue {
    let queue = runtimes.get(runtimeId);
    if (!queue) {
      queue = { seq: 0, commands: [], live: new Set() };
      runtimes.set(runtimeId, queue);
    }
    return queue;
  }

  function bufferFor(runId: string): RunBuffer {
    let buffer = runs.get(runId);
    if (!buffer) {
      buffer = { frames: [], subscribers: new Set(), ended: false };
      runs.set(runId, buffer);
    }
    return buffer;
  }

  /** Marks a run's buffer eligible for eviction once its turn has ended and
   *  nobody is left subscribed to it, and evicts the oldest such buffer once
   *  more than `RETIRED_RUN_LIMIT` are waiting — never the run just marked,
   *  which is always the newest. A buffer that still has a subscriber
   *  attached, or belongs to a run that has not ended, is never touched
   *  here: only a completed, currently-unwatched buffer ever ages out. */
  function retireIfDone(runId: string, buffer: RunBuffer): void {
    if (!buffer.ended || buffer.subscribers.size > 0) return;
    unwatchedSinceEnd.delete(runId);
    unwatchedSinceEnd.add(runId);
    if (unwatchedSinceEnd.size > RETIRED_RUN_LIMIT) {
      const oldest = unwatchedSinceEnd.values().next().value as string;
      unwatchedSinceEnd.delete(oldest);
      runs.delete(oldest);
    }
  }

  return {
    enqueue(runtimeId, command) {
      const queue = queueFor(runtimeId);
      queue.seq += 1;
      const seq = queue.seq;
      queue.commands.push({ seq, command });
      if (command.type === "start-run") runtimeOfRun.set(command.runId, runtimeId);
      // "Live" means a connected daemon has actually been handed this
      // command, not merely that the lab has queued it: a run enqueued
      // while the command stream is down (reconnecting, or never opened at
      // all) sits here undelivered, and no daemon anywhere has heard of it
      // yet. Marking it live regardless would let a machine's own honest
      // report of what it holds — sent the moment it does connect — read as
      // this run having gone missing, durably failing something nothing was
      // ever running in the first place.
      if (queue.subscriber) {
        if (command.type === "start-run") queue.live.add(command.runId);
        queue.subscriber(seq, command);
      }
    },

    attach(runtimeId, send) {
      const queue = queueFor(runtimeId);
      for (const { seq, command } of queue.commands) {
        if (command.type === "start-run") queue.live.add(command.runId);
        send(seq, command);
      }
      queue.subscriber = send;
      return () => {
        if (queue.subscriber === send) queue.subscriber = undefined;
      };
    },

    reconcile(runtimeId, liveRunIds) {
      const queue = queueFor(runtimeId);
      const reported = new Set(liveRunIds);
      const dropped = [...queue.live].filter((runId) => !reported.has(runId));
      queue.live = reported;
      return dropped;
    },

    publish(runId, frames) {
      if (frames.length === 0) return;
      const buffer = bufferFor(runId);
      for (const frame of frames) {
        buffer.frames.push(frame);
        if (frame.event.event === "completed") {
          buffer.ended = true;
          const runtimeId = runtimeOfRun.get(runId);
          if (runtimeId) {
            const queue = queueFor(runtimeId);
            queue.live.delete(runId);
            // The machine that just produced this frame is, by construction,
            // the one that already received and acted on every command this
            // run was ever queued — its own start-run among them, since that
            // is the only way a run reaches this lab's session in the first
            // place. Nobody's cursor can legitimately ask to replay a
            // finished run's commands again, so nothing is lost by dropping
            // them the moment the run they belong to is done.
            queue.commands = queue.commands.filter((entry) => entry.command.runId !== runId);
          }
          runtimeOfRun.delete(runId);
        }
      }
      if (buffer.frames.length > RUN_FRAME_LIMIT)
        buffer.frames.splice(0, buffer.frames.length - RUN_FRAME_LIMIT);
      for (const send of buffer.subscribers) for (const frame of frames) send(frame);
      retireIfDone(runId, buffer);
    },

    subscribe(runId, cursor, send) {
      const buffer = bufferFor(runId);
      // Attached, so no longer eligible for eviction until it is released
      // again — a buffer must never be evicted out from under a live
      // subscriber, however long it has been sitting unwatched before now.
      unwatchedSinceEnd.delete(runId);
      if (cursor !== undefined) for (const frame of buffer.frames) if (frame.seq > cursor) send(frame);
      buffer.subscribers.add(send);
      return () => {
        buffer.subscribers.delete(send);
        retireIfDone(runId, buffer);
      };
    },

    liveFor(runtimeId) {
      return [...queueFor(runtimeId).live];
    },

    nextSeqFor(runId) {
      const buffer = runs.get(runId);
      const last = buffer?.frames.at(-1)?.seq ?? 0;
      return last + 1;
    },
  };
}
