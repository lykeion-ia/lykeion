import { randomUUID } from "node:crypto";
import type { Language, RunDecision, RunEventFrame, TaskTurn } from "@lykeion/api";
import type { StandingGrant } from "./store/sessions";

/**
 * One instruction the lab hands a machine over its command stream: start a
 * turn, answer something a running turn asked, stop one, reach a kernel
 * directly, or summarize a Task's opening message into a name for it. Every
 * kind shares this one shape because they travel the same stream in the same
 * envelope — only `runId` is ever guaranteed present. A command that belongs
 * to no turn carries a `runId` of its own choosing — `kernelExecute` uses the
 * cell id it just minted, `kernelInterrupt`/`kernelStop`/`kernelRestart` use
 * the kernel id, and `kernel-list` and `name-task` each use a request id
 * nothing else in this relay reuses — rather than leaving the field empty.
 *
 * Every kernel command travels over `deliverNow`, never `enqueue`: it is
 * never queued for a later connection at all, so `publish`'s pruning by
 * `runId` — which only ever removes a `start-run`'s own commands once that
 * run completes — has nothing to do for one, and never needs to.
 */
export interface RunCommand {
  type:
    | "start-run"
    | "decision"
    | "cancel"
    | "revert"
    | "kernel-execute"
    | "kernel-interrupt"
    | "kernel-stop"
    | "kernel-restart"
    | "kernel-list"
    | "name-task"
    | "kernel-env-setup"
    | "kernel-env-reclaim";
  runId: string;
  /**
   * The Research a command belongs to, under the name the daemon reads it by.
   * It stays `studyId` for the reason `studies` is still the table name: the
   * daemon keys its on-disk workspaces off this value —
   * `<workDir>/studies/study-<id>/tasks/task-<id>` — so renaming the field
   * would orphan the working directory of every task in every existing lab.
   * The rename stops at the wire here exactly as it stops at the SQL.
   */
  studyId?: string;
  taskId?: string;
  sessionId?: string;
  agent?: string;
  prompt?: string;
  /** Which of the agent's own advertised choices this turn asked for. */
  model?: string;
  grants?: StandingGrant[];
  /**
   * Which environment an unaddressed cell of each language runs in, as this
   * Research has confirmed. Structured, and never folded into `prompt`: a
   * default interpolated into the researcher's own words would be
   * indistinguishable from something they typed — unremovable, re-read by the
   * agent every turn, and still there after the default changed. It reaches
   * the kernel host as `kernel.configure_session`'s own `defaults`, which is
   * where a cell that names no environment is actually resolved.
   *
   * Omitted where the Research has confirmed none, and omitted means exactly
   * what an empty list would — unlike `declared` on the kernel wire, there is
   * no third "nobody asked" state to keep apart here, because the lab reads
   * this from its own table and always has an answer. The machine's own floor
   * is what decides for a language nothing is named for.
   */
  environmentDefaults?: Array<{
    language: "python" | "r";
    environmentName: string;
  }>;
  /** Which environments this durable session already has standing permission
   *  to change, so a rebuild the researcher already allowed is not asked
   *  about again on the next turn of the same conversation. Names alone: what
   *  a grant permits is one capability, and the target is the whole of what
   *  varies. */
  environmentGrants?: string[];
  /** Why this turn exists, when it is not a researcher's own. Carried as the
   *  same shape the durable turn holds — never re-derived on the machine,
   *  which cannot know which waiter a system turn continues. */
  continuation?: TaskTurn["continuation"];
  decision?: RunDecision;
  /** Which kernel a `kernel-execute`, `kernel-interrupt`, `kernel-stop` or
   *  `kernel-restart` command addresses. */
  kernelId?: string;
  /** What the researcher who asked for a `kernel-stop` said to the cell it
   *  is about to end. Absent when they said nothing; the machine then ends
   *  the kernel with no sentence to hand back. */
  feedback?: string;
  /** The source a `kernel-execute` command asks a kernel to run. */
  code?: string;
  /** The id `kernelExecute` minted for the cell it is asking a kernel to
   *  run, before that cell exists. */
  cellId?: string;
  /** The kernel context name a `kernel-execute` command runs in — the axis
   *  `KernelIdentity.name` names, e.g. `"main"`. */
  name?: string;
  /** The kernel language a `kernel-execute` command runs in. */
  language?: Language;
  /** The member a `kernel-execute` command's cell is recorded as run by —
   *  `CellOrigin.by` for the `"repl"` surface, since the researcher who
   *  asked for it is this command's own caller, not anyone the kernel host
   *  could ever be told. Carried by `kernel-stop` for the same reason: the
   *  member who ended a kernel is named to whatever cell was in it. */
  by?: string;
  /** Which provisioner a `kernel-env-setup` command builds with — the
   *  declaration's own `manager`, derived from its language rather than
   *  chosen (`python` is always `"uv"`, `r` is always `"conda"`). `language`
   *  above carries the declaration's language the same way. */
  manager?: "uv" | "conda";
  /** What a `kernel-env-setup` command asks the machine to RESOLVE — the
   *  declaration's own `packages` — present only when there is nothing to
   *  replay yet (the declaration's `lockRevision` is `0`). Absent whenever
   *  `lockfile` is present: a machine handed a lockfile materializes from
   *  it and never resolves (D4). */
  packages?: string[];
  /** Exact requested set the bound lock covers, present for resolve and replay. */
  requestedPackages?: string[];
  /** The lockfile a `kernel-env-setup` command asks the machine to
   *  MATERIALIZE from, replayed from this lab's own store rather than
   *  resolved again — D4's whole point. Absent only on the very first
   *  setup of a declaration (`lockRevision` still `0`), which is what tells
   *  the machine to resolve instead. */
  lockfile?: string;
  /** Which revision `lockfile` is, carried alongside it so the machine can
   *  stamp its own completion marker with the revision it actually built
   *  from (`materializeEnvironment`'s `lockRevision`). Absent exactly when
   *  `lockfile` is: the machine that resolves learns its own revision from
   *  `/daemon/kernel-env/lock`'s reply instead, since nothing here can name
   *  it before that resolve has even run. */
  lockRevision?: number;
  /** Exact declaration generation this setup command materializes. */
  declarationGenerationId?: string;
  /** Legacy evidence only; never authoritative for readiness. */
  declarationCreatedTs?: number;
  /** Why a `kernel-env-setup` is happening, in words — "scanpy was added to
   *  python". The machine carries it into the ending of every kernel the
   *  rebuild displaces, so a namespace that vanishes says what took it.
   *
   *  Absent for a plain Setup click, which is a rebuild nobody needs a
   *  sentence for: the researcher is looking at the button they pressed.
   *  Its absence does NOT make the restart optional — `uv venv --clear`
   *  removes the interpreter whoever asked for the build — so what it
   *  decides is only what the ending says. The daemon's own copy of this
   *  field (`packages/daemon/src/lab.ts`) says the same thing; two comments
   *  on one wire field disagreeing is drift this branch has already paid
   *  for. */
  reason?: string;
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

interface MachineQueue {
  /** The seq assigned to the last command enqueued for this machine. */
  seq: number;
  /** Every command still-live-relevant to this machine, in order — what a
   *  fresh `attach` replays before it starts forwarding commands live. A
   *  finished run's commands are removed the moment its `completed` frame
   *  is published: the machine that produced that frame already saw them,
   *  and nobody else's cursor can legitimately ask for them again. */
  commands: { seq: number; command: RunCommand }[];
  /** The one live listener a machine's command stream currently has, if any
   *  connection is open. A later `attach` for the same machine replaces it:
   *  a daemon holds exactly one connection to this stream at a time. */
  subscriber?: (seq: number, command: RunCommand) => void;
  /** Run ids this machine is believed to be holding — every `start-run` that
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
  /** Identifies this one relay process. A daemon that reconnects to a new
   *  generation must discard its old command cursor because command
   *  sequences are process-local and restart from one. */
  readonly generation: string;
  /** Queues one command for a machine, assigning it the next seq in that
   *  machine's own sequence, and delivers it at once to whatever is
   *  currently attached — which is also the moment a `start-run` among them
   *  joins the machine's `live` set; one enqueued with nobody attached does
   *  not, until a later `attach` replays it. */
  enqueue(machineId: string, command: RunCommand): void;
  /** Delivers a command to a machine's command stream immediately, and only
   *  if a connection is attached to receive it right now — never queued for
   *  whatever connects next. Returns whether it was actually delivered.
   *  What a kernel command uses instead of `enqueue`: it addresses one live
   *  kernel over one live connection, and `enqueue`'s queueing exists for
   *  the opposite case — a `start-run` that must survive a reconnect and be
   *  replayed, because a turn started once must still run exactly once. A
   *  queued `kernel-restart` replayed on a later `attach` would act on
   *  whatever kernel currently holds that id then, which may not be the one
   *  a researcher was looking at when they asked for it — including the
   *  same daemon's very next process, on its first reconnect after this one
   *  restarted it. */
  deliverNow(machineId: string, command: RunCommand): boolean;
  /** Removes a durable non-turn command once its own result has been
   *  committed, so a daemon process that reconnects later cannot rebuild an
   *  already-terminal environment merely because no run frame existed to
   *  prune the command through `publish`. */
  retireCommand(machineId: string, runId: string): void;
  /** Attaches the one live listener for a machine's command stream: every
   *  command already queued is replayed to it immediately, in order —
   *  joining the machine's `live` set as it goes, for any `start-run` among
   *  them that had not reached a subscriber before now — and every command
   *  enqueued afterward is delivered as it arrives. Returns a function that
   *  detaches it — a no-op once a later `attach` for the same machine has
   *  already taken its place. */
  attach(machineId: string, send: (seq: number, c: RunCommand) => void): () => void;
  /** Reconciles what a machine reports holding against both this relay's
   *  process-local belief and durable active rows. A queued `start-run` that
   *  has not reached a command stream yet is excluded from the comparison:
   *  the reporting daemon cannot have lost work it was never handed. */
  reconcile(
    machineId: string,
    liveRunIds: string[],
    durableRunIds?: string[],
    acknowledgedCommandSeq?: number,
  ): string[];
  /** Appends a run's event frames to its ring buffer and forwards them to
   *  every current subscriber. A `completed` frame retires the run from its
   *  machine's live set, drops that run's now-unneeded commands from the
   *  machine's queue, and — once no subscriber is left attached — makes the
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
  /** Marks a buffer terminal when durability, rather than this relay process,
   *  supplied the ending (for example a settled snapshot after restart).
   *  This keeps an empty buffer created by that reader eligible for the same
   *  bounded retirement policy as one ended by `publish`. */
  markEnded(runId: string): void;
  /** The run ids a machine is currently believed to be holding. */
  liveFor(machineId: string): string[];
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
  const generation = randomUUID();
  const machines = new Map<string, MachineQueue>();
  const runs = new Map<string, RunBuffer>();
  /** Which machine a still-live run belongs to, so a `completed` frame
   *  reaching `publish` — which is not told the machine — can retire the run
   *  from that machine's live set. Cleared once the run completes. */
  const machineOfRun = new Map<string, string>();
  /** Completed runs with no subscriber currently attached, oldest first —
   *  `Set` iteration order is insertion order, and re-adding an id already
   *  present moves it to the end, which is what lets a run that gets
   *  subscribed to and released again start its wait over rather than being
   *  evicted on however much of the original window happened to remain. */
  const unwatchedSinceEnd = new Set<string>();

  function queueFor(machineId: string): MachineQueue {
    let queue = machines.get(machineId);
    if (!queue) {
      queue = { seq: 0, commands: [], live: new Set() };
      machines.set(machineId, queue);
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
    generation,
    enqueue(machineId, command) {
      const queue = queueFor(machineId);
      queue.seq += 1;
      const seq = queue.seq;
      queue.commands.push({ seq, command });
      if (command.type === "start-run") machineOfRun.set(command.runId, machineId);
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

    deliverNow(machineId, command) {
      const queue = queueFor(machineId);
      if (!queue.subscriber) return false;
      queue.seq += 1;
      queue.subscriber(queue.seq, command);
      return true;
    },

    retireCommand(machineId, runId) {
      const queue = machines.get(machineId);
      if (!queue) return;
      queue.commands = queue.commands.filter((entry) => entry.command.runId !== runId);
    },

    attach(machineId, send) {
      const queue = queueFor(machineId);
      for (const { seq, command } of queue.commands) {
        if (command.type === "start-run") queue.live.add(command.runId);
        send(seq, command);
      }
      queue.subscriber = send;
      return () => {
        if (queue.subscriber === send) queue.subscriber = undefined;
      };
    },

    reconcile(
      machineId,
      liveRunIds,
      durableRunIds = [],
      acknowledgedCommandSeq = Number.POSITIVE_INFINITY,
    ) {
      const queue = queueFor(machineId);
      const reported = new Set(liveRunIds);
      const unacknowledgedStarts = new Set(
        queue.commands
          .filter(
            ({ seq, command }) =>
              command.type === "start-run" &&
              (!queue.live.has(command.runId) || seq > acknowledgedCommandSeq),
          )
          .map(({ command }) => command.runId),
      );
      const expected = new Set([...queue.live, ...durableRunIds]);
      const dropped = [...expected].filter(
        (runId) => !reported.has(runId) && !unacknowledgedStarts.has(runId),
      );
      // A rebuilt relay learns active runs from the daemon rather than from
      // locally enqueued start commands. Restore the same reverse binding a
      // start command would have established so a later terminal frame can
      // retire the live id and every resumed decision/cancel for that run.
      for (const runId of expected) machineOfRun.set(runId, machineId);
      for (const runId of reported) machineOfRun.set(runId, machineId);
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
          const machineId = machineOfRun.get(runId);
          if (machineId) {
            const queue = queueFor(machineId);
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
          machineOfRun.delete(runId);
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

    markEnded(runId) {
      const buffer = bufferFor(runId);
      buffer.ended = true;
      retireIfDone(runId, buffer);
    },

    liveFor(machineId) {
      return [...queueFor(machineId).live];
    },

    nextSeqFor(runId) {
      const buffer = runs.get(runId);
      const last = buffer?.frames.at(-1)?.seq ?? 0;
      return last + 1;
    },
  };
}
