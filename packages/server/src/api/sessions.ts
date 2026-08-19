import {
  LykeionError,
  MAX_TURNS_OUTSTANDING,
  type ActiveRunSnapshot,
  type LykeionApi,
} from "@lykeion/api";
import type { Deps } from "./index";
import type { Store } from "../store/store";
import { healthFor } from "../machine-health";
import {
  openSession,
  activeTurnForTask,
  openTurnCountForTask,
  activeRunSnapshotsForTask,
  liveSessionFor,
  recordTurn,
  listGrants,
  machineForTurn,
  machineOwnerForTurn,
  runSnapshot,
  newestTurnForTask,
  sessionForTurn,
  truncateTurn,
  turnsForTask,
} from "../store/sessions";
import type { RunCommand } from "../run-relay";

export type SessionsApi = Pick<
  LykeionApi,
  "startRun" | "resumeRuns" | "submitRunDecision" | "runHistory" | "revertTurn"
>;

export interface ResolvedMachine {
  machineId: string;
  ownerId: string;
  name: string;
  lastSeenTs: number;
  agent: string;
}

function turnIsActive(store: Store, runId: string): boolean {
  return store.get(`SELECT ended_ts FROM turns WHERE id = ?`, [runId])?.ended_ts === null;
}

/**
 * The machine a run against `agent` would land on. A machine the caller owns
 * is always preferred over one that merely has a lower-`seq` matching CLI
 * row — two members can each have `claude` on their own machine, and
 * resolving to a colleague's rather than the caller's own would refuse a run
 * that has a perfectly good machine sitting right there. Only when the
 * caller owns no matching machine does this fall through to whichever
 * matching machine's CLI row has gone longest without being re-reported:
 * `/daemon/report` deletes and reinserts a machine's own `runtime_clis` rows
 * with a fresh `seq` on every report, whether or not what it found actually
 * changed, so the ascending order here favours the machine that has checked
 * in least recently, not the one paired or reported first. That is enough
 * to let the ownership check that follows this call answer `forbidden` by
 * naming a real machine rather than nothing at all. Omitting `agent`
 * resolves the same way, over every available CLI rather than one named
 * CLI.
 */
export function resolveMachineForAgent(
  store: Store,
  agent: string | undefined,
  callerId: string,
): ResolvedMachine | undefined {
  const row = store.get(
    `SELECT r.id AS runtime_id, r.owner_id AS owner_id, r.name AS name,
            r.last_seen_ts AS last_seen_ts, c.cli_id AS cli_id
       FROM runtime_clis c
       JOIN runtimes r ON r.id = c.runtime_id
      WHERE c.available = 1 AND r.removed_ts IS NULL ${agent === undefined ? "" : "AND c.cli_id = ?"}
      ORDER BY (r.owner_id = ?) DESC, c.seq ASC
      LIMIT 1`,
    agent === undefined ? [callerId] : [agent, callerId],
  );
  if (!row) return undefined;
  return {
    machineId: row.runtime_id as string,
    ownerId: row.owner_id as string,
    name: row.name as string,
    lastSeenTs: row.last_seen_ts as number,
    agent: row.cli_id as string,
  };
}

export function sessionsApi(deps: Deps): SessionsApi {
  const { store, actor, now, runs, reverts, changes } = deps;
  return {
    async startRun(input) {
      const resolved = resolveMachineForAgent(store, input.options.agent, actor.userId);
      if (!resolved)
        throw new LykeionError(
          "unsupported",
          `no machine in this lab offers ${
            input.options.agent ? `the agent "${input.options.agent}"` : "any agent"
          } — pair one and report it before starting a run.`,
        );
      if (resolved.ownerId !== actor.userId)
        throw new LykeionError(
          "forbidden",
          "only the member who paired a machine may spend it on a run",
        );

      const task = store.get(`SELECT study_id FROM tasks WHERE id = ?`, [input.taskId]);
      if (!task) throw new LykeionError("not-found", `no such task: ${input.taskId}`);
      if (task.study_id !== input.researchId)
        throw new LykeionError(
          "invalid",
          `task ${input.taskId} is not in a Research — file it into one before starting a run`,
        );

      if (healthFor(resolved.lastSeenTs, now()) === "offline")
        throw new LykeionError(
          "conflict",
          `${resolved.name} is offline — it has to be running and connected before a run can start on it`,
        );

      const { runId, sessionId } = store.tx(() => {
        // What the Task is already working in, if anything. A later turn joins
        // THAT session rather than opening one of its own, which is what makes
        // it wait its place: a session runs one turn at a time, so the queue is
        // the session's own and two agents never write this directory at once.
        const working = activeTurnForTask(store, input.taskId);
        if (working !== undefined && working.agent !== resolved.agent)
          throw new LykeionError(
            "conflict",
            `this Task is mid-conversation with ${working.agent} — stop that turn before switching agent, or the new one would start a second conversation over the same files`,
          );
        const outstanding = openTurnCountForTask(store, input.taskId);
        if (outstanding >= MAX_TURNS_OUTSTANDING)
          throw new LykeionError(
            "conflict",
            `task ${input.taskId} already has ${outstanding} turns waiting, which is as far ahead as this lab lets you type`,
          );
        const ts = now();
        const sessionId =
          working?.sessionId ??
          liveSessionFor(store, input.taskId, resolved.machineId, resolved.agent) ??
          openSession(store, {
            researchId: input.researchId,
            machineId: resolved.machineId,
            agent: resolved.agent,
            openedBy: actor.userId,
            openedTs: ts,
          });
        const runId = recordTurn(store, {
          sessionId,
          taskId: input.taskId,
          prompt: input.prompt,
          startedTs: ts,
        });
        // A new run deliberately reopens a Task that was already Done. This
        // makes it safe for finishTurn to preserve a newer Done written while
        // an older sibling was still live.
        store.run(
          `UPDATE tasks
              SET status = 'in-progress', updated_ts = ?
            WHERE id = ? AND status = 'done'`,
          [ts, input.taskId],
        );
        return { runId, sessionId };
      });

      const grants = listGrants(store, input.researchId, resolved.machineId);
      const command: RunCommand = {
        type: "start-run",
        runId,
        studyId: input.researchId,
        taskId: input.taskId,
        sessionId,
        agent: resolved.agent,
        prompt: input.prompt,
        ...(input.options.model === undefined ? {} : { model: input.options.model }),
        ...(grants.length > 0 ? { grants } : {}),
      };
      runs.enqueue(resolved.machineId, command);
      const subscriptions = new Set<() => void>();
      let closed = false;
      let terminal = false;

      const detach = () => {
        for (const unsubscribe of subscriptions) unsubscribe();
        subscriptions.clear();
      };

      return {
        runId,
        // Never reached by a caller across the wire: dispatch turns this
        // object to JSON, which keeps `runId` and drops every function on
        // it. What is left below is real, working behaviour for the one
        // kind of caller that can still reach it — a caller in this same
        // process, holding the object `startRun` actually returned, rather
        // than whatever survived a round trip through JSON.
        onEvent(cb) {
          if (closed) return () => {};
          const stored = runSnapshot(store, runId);
          if (!stored) throw new LykeionError("not-found", `no such run: ${runId}`);
          const {
            sessionId: _sessionId,
            machineId: _machineId,
            openedBy: _openedBy,
            ...snapshot
          } = stored;
          const pending: Array<Parameters<typeof cb>[0]> = [];
          let snapshotDelivered = false;
          let subscribed = true;
          let unsubscribe: (() => void) | undefined;
          const release = () => {
            if (!subscribed) return;
            subscribed = false;
            subscriptions.delete(release);
            unsubscribe?.();
          };
          // Own the observer before entering the relay: its buffered replay
          // is synchronous, and user callbacks may detach/close re-entrantly.
          subscriptions.add(release);
          try {
            unsubscribe = runs.subscribe(runId, snapshot.lastEventSeq, (frame) => {
              if (!subscribed || closed) return;
              if (frame.event.event === "completed") terminal = true;
              if (!snapshotDelivered) pending.push(frame.event);
              else cb(frame.event);
            });
            if (!subscribed) unsubscribe();
            cb({ event: "snapshot", snapshot });
            snapshotDelivered = true;
            for (const event of pending) {
              if (!subscribed || closed) break;
              cb(event);
            }
          } catch (error) {
            release();
            throw error;
          }
          return release;
        },
        submit(decision) {
          if (closed || terminal || !turnIsActive(store, runId)) return;
          runs.enqueue(resolved.machineId, { type: "decision", runId, decision });
        },
        detach,
        close() {
          if (closed) return;
          closed = true;
          detach();
          if (!terminal && turnIsActive(store, runId))
            runs.enqueue(resolved.machineId, { type: "cancel", runId });
        },
      };
    },

    async revertTurn(runId) {
      const turn = store.get(`SELECT task_id, session_id FROM turns WHERE id = ?`, [runId]);
      if (!turn) throw new LykeionError("not-found", `no such run: ${runId}`);
      const taskId = turn.task_id as string;
      // Only the newest turn. There is one snapshot per Task, and a turn
      // that has already been built on cannot be pulled out from under the
      // work that followed it.
      if (newestTurnForTask(store, taskId) !== runId)
        throw new LykeionError(
          "conflict",
          "only the newest turn of a Task can be discarded",
        );
      const session = sessionForTurn(store, runId);
      if (!session) throw new LykeionError("not-found", `no such run: ${runId}`);
      // Resolved from the caller rather than taken from the client: the turn
      // ran on their machine, in a directory only they can run in.
      const owner = machineOwnerForTurn(store, runId);
      if (owner !== actor.userId)
        throw new LykeionError(
          "forbidden",
          "only the member who started this run may discard it",
        );
      const snapshot = store.get(`SELECT snapshot_taken FROM turns WHERE id = ?`, [runId]);
      if (snapshot?.snapshot_taken !== 1)
        throw new LykeionError(
          "conflict",
          "there is no snapshot of this Task's files from before this turn, so nothing can be restored",
        );
      // A turn still running is stopped first, so the two never happen at
      // once: an agent going on working through a restore would write into
      // a directory being replaced underneath it.
      if (turnIsActive(store, runId))
        runs.enqueue(session.machineId, { type: "cancel", runId });

      const command: RunCommand = {
        type: "revert",
        runId,
        studyId: session.researchId,
        taskId,
        sessionId: turn.session_id as string,
      };
      runs.enqueue(session.machineId, command);
      // Restore first, truncate second. A machine that could not put the
      // files back leaves the turn in the record — never a truncated record
      // standing over files that were not restored — and its own account of
      // what went wrong is what the researcher reads.
      try {
        await reverts.await(runId);
      } catch (err) {
        throw new LykeionError(
          "conflict",
          err instanceof Error ? err.message : String(err),
        );
      }
      truncateTurn(store, runId);
      // Published, so a colleague with the Task open sees the turn go rather
      // than holding one the server no longer has.
      changes.record("task-updated", { taskId });
    },

    async runHistory(taskId) {
      // `"cancelled-unacknowledged"` is a store-internal encoding
      // (`../store/sessions.ts`'s `TurnStatus`) of the same fact the wire
      // contract carries as two fields — translated back here, the one
      // place a durable row becomes a `RunSummary`.
      return turnsForTask(store, taskId).map((turn) => ({
        runId: turn.id,
        command: turn.prompt,
        ts: turn.startedTs,
        ...(turn.status === "cancelled-unacknowledged"
          ? { status: "cancelled" as const, unacknowledged: true as const }
          : { status: turn.status as "ok" | "failed" | "cancelled" }),
      }));
    },

    async resumeRuns(taskId) {
      return activeRunSnapshotsForTask(store, taskId)
        .filter((stored) => machineOwnerForTurn(store, stored.runId) === actor.userId)
        .map((stored) => {
          const { sessionId: _sessionId, machineId, openedBy: _openedBy, ...publicSnapshot } = stored;
          const snapshot: ActiveRunSnapshot = publicSnapshot;
          const subscriptions = new Set<() => void>();
          let cursor = snapshot.lastEventSeq;
          let closed = false;
          let terminal = false;
          const detach = () => {
            for (const unsubscribe of subscriptions) unsubscribe();
            subscriptions.clear();
          };
          return {
            runId: snapshot.runId,
            snapshot,
            onEvent(cb) {
              if (closed) return () => {};
              let subscribed = true;
              let unsubscribe: (() => void) | undefined;
              const release = () => {
                if (!subscribed) return;
                subscribed = false;
                subscriptions.delete(release);
                unsubscribe?.();
              };
              // Relay replay is synchronous. Register this release before it
              // begins so detach/close from the first replayed frame owns the
              // subscription, then remove the inner observer once available.
              subscriptions.add(release);
              try {
                unsubscribe = runs.subscribe(
                  snapshot.runId,
                  cursor,
                  (frame) => {
                    if (!subscribed || closed) return;
                    cursor = Math.max(cursor, frame.seq);
                    if (frame.event.event === "completed") terminal = true;
                    cb(frame.event);
                  },
                );
              } catch (error) {
                release();
                throw error;
              }
              if (!subscribed) unsubscribe();
              return release;
            },
            submit(decision) {
              if (closed || terminal || !turnIsActive(store, snapshot.runId)) return;
              runs.enqueue(machineId, { type: "decision", runId: snapshot.runId, decision });
            },
            detach,
            close() {
              if (closed) return;
              closed = true;
              detach();
              if (!terminal && turnIsActive(store, snapshot.runId))
                runs.enqueue(machineId, { type: "cancel", runId: snapshot.runId });
            },
          };
        });
    },

    async submitRunDecision(runId, decision) {
      // One check, not two: an id nobody holds a turn for and an id whose
      // turn belongs to somebody else's machine answer identically. Run ids
      // are sequential and guessable — `run_<seq>` off one workspace-wide
      // counter — so a caller must never learn which of the two is true from
      // this response, the same reasoning `/runs/<id>/events` is held to.
      if (machineOwnerForTurn(store, runId) !== actor.userId)
        throw new LykeionError(
          "forbidden",
          `run ${runId} does not belong to a machine you own`,
        );
      if (!turnIsActive(store, runId)) return;
      // Refused by name here, on the way in, rather than narrowed to
      // something the researcher did not ask for: a "global" scope means
      // every Research this lab holds, and the grant store this lab keeps is
      // scoped to one Research at a time — there is no row it could write that
      // would honestly mean "every Research."
      if (
        decision.action === "permission" &&
        decision.decision.decision === "allow" &&
        decision.decision.scope === "global"
      )
        throw new LykeionError(
          "invalid",
          `a "global" grant would reach every Research in this lab — grant one Research at a time instead`,
        );
      runs.enqueue(machineForTurn(store, runId)!, { type: "decision", runId, decision });
    },
  };
}
