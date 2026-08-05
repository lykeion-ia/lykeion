import { LykeionError, type LykeionApi } from "@lykeion/api";
import type { Deps } from "./index";
import type { Store } from "../store/store";
import { healthFor } from "../runtime-health";
import {
  openSession,
  liveSessionFor,
  recordTurn,
  listGrants,
  runtimeForTurn,
  runtimeOwnerForTurn,
  turnsForTask,
} from "../store/sessions";
import type { RunCommand } from "../run-relay";

export type SessionsApi = Pick<LykeionApi, "startRun" | "submitRunDecision" | "runHistory">;

interface ResolvedRuntime {
  runtimeId: string;
  ownerId: string;
  name: string;
  lastSeenTs: number;
  agent: string;
}

/**
 * The runtime a run against `agent` would land on. A machine the caller owns
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
function resolveRuntimeForAgent(
  store: Store,
  agent: string | undefined,
  callerId: string,
): ResolvedRuntime | undefined {
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
    runtimeId: row.runtime_id as string,
    ownerId: row.owner_id as string,
    name: row.name as string,
    lastSeenTs: row.last_seen_ts as number,
    agent: row.cli_id as string,
  };
}

export function sessionsApi(deps: Deps): SessionsApi {
  const { store, actor, now, runs } = deps;
  return {
    async startRun(input) {
      const resolved = resolveRuntimeForAgent(store, input.options.agent, actor.userId);
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
      if (task.study_id !== input.studyId)
        throw new LykeionError(
          "invalid",
          `task ${input.taskId} is not in a Study — file it into one before starting a run`,
        );

      if (healthFor(resolved.lastSeenTs, now()) === "offline")
        throw new LykeionError(
          "conflict",
          `${resolved.name} is offline — it has to be running and connected before a run can start on it`,
        );

      const { runId, sessionId } = store.tx(() => {
        const ts = now();
        const sessionId =
          liveSessionFor(store, input.taskId, resolved.runtimeId, resolved.agent) ??
          openSession(store, {
            studyId: input.studyId,
            runtimeId: resolved.runtimeId,
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
        return { runId, sessionId };
      });

      const grants = listGrants(store, input.studyId, resolved.runtimeId);
      const command: RunCommand = {
        type: "start-run",
        runId,
        studyId: input.studyId,
        sessionId,
        agent: resolved.agent,
        prompt: input.prompt,
        ...(grants.length > 0 ? { grants } : {}),
      };
      runs.enqueue(resolved.runtimeId, command);

      return {
        runId,
        // Never reached by a caller across the wire: dispatch turns this
        // object to JSON, which keeps `runId` and drops every function on
        // it. What is left below is real, working behaviour for the one
        // kind of caller that can still reach it — a caller in this same
        // process, holding the object `startRun` actually returned, rather
        // than whatever survived a round trip through JSON.
        onEvent(cb) {
          return runs.subscribe(runId, undefined, (frame) => cb(frame.event));
        },
        submit(decision) {
          runs.enqueue(resolved.runtimeId, { type: "decision", runId, decision });
        },
        close() {
          runs.enqueue(resolved.runtimeId, { type: "cancel", runId });
        },
      };
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

    async submitRunDecision(runId, decision) {
      // One check, not two: an id nobody holds a turn for and an id whose
      // turn belongs to somebody else's machine answer identically. Run ids
      // are sequential and guessable — `run_<seq>` off one workspace-wide
      // counter — so a caller must never learn which of the two is true from
      // this response, the same reasoning `/runs/<id>/events` is held to.
      if (runtimeOwnerForTurn(store, runId) !== actor.userId)
        throw new LykeionError(
          "forbidden",
          `run ${runId} does not belong to a machine you own`,
        );
      // Refused by name here, on the way in, rather than narrowed to
      // something the researcher did not ask for: a "global" scope means
      // every Study this lab holds, and the grant store this lab keeps is
      // scoped to one Study at a time — there is no row it could write that
      // would honestly mean "every Study."
      if (
        decision.action === "permission" &&
        decision.decision.decision === "allow" &&
        decision.decision.scope === "global"
      )
        throw new LykeionError(
          "invalid",
          `a "global" grant would reach every Study in this lab — grant one Study at a time instead`,
        );
      runs.enqueue(runtimeForTurn(store, runId)!, { type: "decision", runId, decision });
    },
  };
}
