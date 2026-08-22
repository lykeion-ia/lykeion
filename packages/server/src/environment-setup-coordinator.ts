import {
  LykeionError,
  type KernelEnvStatus,
  type EnvironmentSetupStage,
  type RequestKernelEnvironmentSetupInput,
  type RequestKernelEnvironmentSetupResult,
} from "@lykeion/api";
import {
  environmentLockfileFingerprint,
  environmentPackageFingerprint,
} from "@lykeion/api/environment-setup-evidence";
import type { Actor } from "./auth";
import type { ChangeRecorder } from "./api/changes";
import { planFor, sameRequest } from "./api/environments";
import { healthFor } from "./machine-health";
import type { RunCommand, RunRelay } from "./run-relay";
import { environmentSetupStore } from "./store/environment-setups";
import type { RecordEnvironmentRequirementInput, StoredEnvironmentSetupWaiter } from "./store/environment-setups";
import { environmentStore } from "./store/environments";
import { nextSeq } from "./store/migrations";
import { finishTurn, listGrants, recordTurn } from "./store/sessions";
import type { Store } from "./store/store";
import {
  completedPackagesForEnvironmentSetupFingerprint,
  fingerprintEnvironmentSetupOutcome,
  type EnvSetupResult,
} from "./environment-setup-outcome";

export interface EnvironmentSetupCoordinator {
  attachWaiter(
    input: RecordEnvironmentRequirementInput,
    record: ChangeRecorder["record"],
  ): { waiterId: string };
  cancelPendingForTask(taskId: string): {
    cancellations: Array<{ machineId: string; runId: string }>;
  };
  /**
   * Everything one deleted environment leaves unresolvable: every waiter still
   * `waiting` or `queued` on that name, the continuation turn a `queued` one
   * owns, and the Research defaults and outstanding questions naming it.
   *
   * Here rather than in `kernelEnvDelete`, and paired with a real cancellation
   * the way `cancelPendingForTask` is, because cancelling a `queued` waiter is
   * half an operation on its own: that waiter owns a durable continuation turn
   * and a run already handed to a machine, and marking the row cancelled
   * without finishing the turn and recalling the run leaves both of them going
   * with nothing left to settle them. The caller dispatches the returned
   * cancellations once its own transaction has committed, so no machine is
   * told to stop a run that a rolled-back delete would have left running.
   */
  cancelForEnvironment(name: string): {
    cancellations: Array<{ machineId: string; runId: string }>;
  };
  /**
   * The same operation for a Task being deleted, and it exists for the same
   * reason `cancelForEnvironment` does.
   *
   * `task_env_setup_waiters.task_id` cascades, so the waiter row goes with the
   * Task on its own — but `turns.task_id` carries no foreign key, so a `queued`
   * waiter's continuation TURN does not, and its `start-run` is already on a
   * machine. A delete that relied on the cascade alone left an agent running a
   * turn for a Task that no longer exists, with no waiter left in this lab that
   * could ever settle it and nothing sent to recall it. Called BEFORE the row
   * is deleted, since the cascade is what takes the waiters this reads.
   */
  cancelForDeletedTask(taskId: string): {
    cancellations: Array<{ machineId: string; runId: string }>;
  };
  /**
   * The same operation one level up the tree, for a Research being deleted.
   *
   * Tasks cascade off `studies`, and waiters cascade off both `studies` and
   * `tasks` — so every row goes on its own and nothing here is about rows.
   * It is about the same turn `cancelForDeletedTask` exists for: a `queued`
   * waiter's continuation is a durable turn whose `start-run` is already on a
   * machine, `turns` and `sessions` carry no foreign key to `studies`, and an
   * agent left running one goes on writing into the workspace of a Research
   * this lab no longer has. Called BEFORE the `DELETE FROM studies`, since
   * the cascade is what takes the waiters this reads.
   */
  cancelForDeletedResearch(studyId: string): {
    cancellations: Array<{ machineId: string; runId: string }>;
  };
  /**
   * The same operation for a TURN being discarded by revert, and the one of
   * these that removes rows rather than cancelling them.
   *
   * A waiter names the turn that recorded the requirement, and a `queued` one
   * also names the continuation minted to answer it. Both references are
   * foreign keys onto `turns(id)` with no `ON DELETE`, so a waiter left
   * standing does not merely go stale — it makes `truncateTurn`'s
   * `DELETE FROM turns` fail outright, over files a machine has already put
   * back. Called from INSIDE that delete's transaction, before the turn row
   * goes; the recall is the caller's to dispatch once it has committed.
   */
  cancelForRevertedTurn(turnId: string): {
    cancellations: Array<{ machineId: string; runId: string }>;
  };
  request(
    input: RequestKernelEnvironmentSetupInput,
    actor: Actor,
    record: ChangeRecorder["record"],
  ): RequestKernelEnvironmentSetupResult;
  retry(
    waiterId: string,
    actor: Actor,
    record: ChangeRecorder["record"],
  ): RequestKernelEnvironmentSetupResult;
  progress(
    machineId: string,
    requestId: string,
    stage: EnvironmentSetupStage,
    line: string,
    record: ChangeRecorder["record"],
  ): { accepted: boolean; changed: boolean };
  settle(
    machineId: string,
    requestId: string,
    result: EnvSetupResult,
    record: ChangeRecorder["record"],
    terminalOutcomeFingerprint?: string,
  ): boolean;
  reconcileMachine(
    machineId: string,
    statuses: KernelEnvStatus[] | undefined,
    record: ChangeRecorder["record"],
  ): void;
  recover(record: ChangeRecorder["record"]): void;
  bindResolvedLock(
    machineId: string,
    requestId: string,
    name: string,
    declarationGenerationId: string,
    lockfile: string,
    record: ChangeRecorder["record"],
  ): number | undefined;
  /**
   * One machine rebuilding its own copy of an environment a declaration has
   * grown past — the ask `/daemon/kernel-env/packages` makes after an agent's
   * `manage_packages` append.
   *
   * Records a Task INTEREST and never a waiter, and the difference is the
   * whole point of this method existing beside `request`. An interest is what
   * `uncoveredInterests` reads to chase coverage: a caller that joins a build
   * planned before its own packages existed is carried onto a follow-up round
   * when that build settles without them, up to the fourth round. A waiter is
   * what mints a CONTINUATION, and `manage_packages` runs mid-turn — a
   * continuation for a turn that is still running would be a second active run
   * on one Task.
   *
   * `taskId` is absent only for a session holding no turns at all, which the
   * one caller cannot reach — an agent asking to add packages is running in a
   * turn. Kept as a shape rather than a precondition because this method is
   * reachable by any later caller, and the honest fallback is a physical job:
   * the packages are declared, so the build is still asked for, and only the
   * coverage follow-up is forgone.
   *
   * Returns `undefined` where no build could be asked for at all, which is a
   * declaration deleted underneath the call or a pinned revision whose text
   * this lab does not hold. The caller must not claim a build is running on
   * the strength of a call that answered this.
   */
  requestRebuild(
    input: {
      machineId: string;
      environmentName: string;
      requestedPackages: string[];
      requestedBy: string;
      taskId?: string;
      reason?: string;
    },
    record: ChangeRecorder["record"],
  ): { jobId: string } | undefined;
}

export interface KernelEnvironmentIdentity {
  environmentName: string;
  language: KernelEnvStatus["language"];
  manager: KernelEnvStatus["manager"];
  lockRevision: number;
  declarationGenerationId: string;
  lockfileFingerprint: string;
  packageFingerprint: string;
  setupRequestId?: string;
}

/** One authoritative answer to whether a machine's cached status covers an
 * exact declaration/job generation. A same-name status from another manager,
 * language, or lock revision is not readiness for this identity. */
export function kernelEnvironmentStatusAnswers(
  identity: KernelEnvironmentIdentity,
  status: KernelEnvStatus,
): boolean {
  return (
    status.state === "ready" &&
    status.name === identity.environmentName &&
    status.language === identity.language &&
    status.manager === identity.manager &&
    status.lockRevision !== undefined &&
    status.lockRevision === identity.lockRevision &&
    status.declarationGenerationId !== undefined &&
    status.declarationGenerationId === identity.declarationGenerationId &&
    status.lockfileFingerprint === identity.lockfileFingerprint &&
    status.packageFingerprint === identity.packageFingerprint &&
    (identity.setupRequestId === undefined || status.setupRequestId === identity.setupRequestId)
  );
}

function exactDeclarationGeneration(
  declaration: { name: string; declarationGenerationId?: string },
): string {
  if (declaration.declarationGenerationId === undefined)
    throw new LykeionError(
      "conflict",
      `${declaration.name}'s current declaration has no authoritative opaque generation`,
    );
  return declaration.declarationGenerationId;
}

function taskResearch(store: Store, taskId: string): string {
  const row = store.get(`SELECT study_id FROM tasks WHERE id = ?`, [taskId]);
  if (!row) throw new LykeionError("not-found", `no such task: ${taskId}`);
  if (row.study_id === null)
    throw new LykeionError(
      "conflict",
      `Task ${taskId} must belong to a Research before it can request an environment setup`,
    );
  return row.study_id as string;
}

function ownedMachine(
  store: Store,
  machineId: string,
  actor: Actor,
  now: number,
): { machineId: string; name: string } {
  const row = store.get(
    `SELECT owner_id, name, last_seen_ts FROM runtimes
      WHERE id = ? AND removed_ts IS NULL`,
    [machineId],
  );
  if (!row) throw new LykeionError("not-found", `no such machine: ${machineId}`);
  if (row.owner_id !== actor.userId)
    throw new LykeionError(
      "forbidden",
      "only the member who paired a machine may set up environments on it",
    );
  if (healthFor(row.last_seen_ts as number, now) === "offline")
    throw new LykeionError(
      "conflict",
      `${row.name as string} is offline — it has to be running before an environment can be set up on it`,
    );
  return { machineId, name: row.name as string };
}

/**
 * One waiter this lab has no exact continuation for — it could not be moved
 * to `queued`, or the durable turn just written for it does not answer the
 * waiter field for field.
 *
 * Its own type so that skipping it is a decision about THIS waiter and never
 * about anything else that might throw in the same block. A bare `catch` there
 * would also swallow the store failing mid-continuation, which has to roll the
 * whole settle back.
 */
class UnroutableWaiter extends Error {}

export function createEnvironmentSetupCoordinator(parts: {
  store: Store;
  runs: RunRelay;
  now?: () => number;
}): EnvironmentSetupCoordinator {
  const { store, runs } = parts;
  const now = parts.now ?? (() => Math.floor(Date.now() / 1000));
  const setups = environmentSetupStore(store);
  const envs = environmentStore(store);

  const dispatch = (machineId: string, command: RunCommand): void => {
    // Durable setup commands use the reconnecting queue. A transiently
    // disconnected command stream must not turn a committed requested job
    // back into an RPC failure; recovery and daemon-side request-id
    // deduplication make replay safe.
    runs.enqueue(machineId, command);
  };

  const continuationPrompt = (environmentName: string): string =>
    `The environment ${environmentName} is ready on this machine. Continue the work blocked in the source turn. Do not ask the researcher to repeat the request, and do not repeat completed work.`;

  const newestUserTurn = (taskId: string): string | undefined =>
    store.get(
      `SELECT id FROM turns WHERE task_id = ? AND origin = 'user' ORDER BY seq DESC LIMIT 1`,
      [taskId],
    )?.id as string | undefined;

  const commandForContinuation = (
    waiter: StoredEnvironmentSetupWaiter,
  ): { machineId: string; command: RunCommand } | undefined => {
    if (waiter.continuationTurnId === undefined) return undefined;
    const row = store.get(
      `SELECT t.task_id, t.session_id, t.prompt, t.origin, t.continuation,
              s.study_id, s.runtime_id, s.agent
         FROM turns t JOIN sessions s ON s.id = t.session_id
        WHERE t.id = ?`,
      [waiter.continuationTurnId],
    );
    if (!row || row.origin !== "system" || row.continuation === null) return undefined;
    let continuation: {
      kind?: unknown;
      waiterId?: unknown;
      sourceTurnId?: unknown;
      environmentName?: unknown;
      machineId?: unknown;
    };
    try {
      continuation = JSON.parse(row.continuation as string) as typeof continuation;
    } catch {
      return undefined;
    }
    if (
      continuation.kind !== "environment-setup" ||
      continuation.waiterId !== waiter.id ||
      continuation.sourceTurnId !== waiter.sourceTurnId ||
      continuation.environmentName !== waiter.environmentName ||
      continuation.machineId !== waiter.runtimeId ||
      row.task_id !== waiter.taskId ||
      row.session_id !== waiter.sessionId ||
      row.runtime_id !== continuation.machineId
    ) return undefined;
    const grants = listGrants(store, row.study_id as string, continuation.machineId);
    // The same structured context a researcher's own turn carries
    // (`sessionsApi.startRun`). A continuation is a turn on the same Task in
    // the same session, so a machine that got the defaults for one and not
    // the other would resolve an unaddressed cell differently depending on
    // who started the turn — which is the one thing a soft default must never
    // depend on.
    const environmentDefaults = setups
      .defaultsForResearch(row.study_id as string)
      .map(({ language, environmentName }) => ({ language, environmentName }));
    const environmentGrants = setups.environmentGrantsForSession(row.session_id as string);
    return {
      machineId: continuation.machineId,
      command: {
        type: "start-run",
        runId: waiter.continuationTurnId,
        studyId: row.study_id as string,
        taskId: row.task_id as string,
        sessionId: row.session_id as string,
        agent: row.agent as string,
        prompt: row.prompt as string,
        // Written from the waiter, and equal to what the durable turn
        // carries: every field below has just been checked against that
        // turn's own recorded continuation, field by field, and a mismatch
        // on any of them returns `undefined` above rather than reaching
        // here. So what the machine is told a turn continues cannot differ
        // from what this lab durably recorded — the two agreeing is a
        // checked precondition of building this at all, rather than a
        // property of whichever one this literal was assembled out of.
        continuation: {
          kind: "environment-setup",
          waiterId: waiter.id,
          sourceTurnId: waiter.sourceTurnId,
          environmentName: waiter.environmentName,
          machineId: continuation.machineId,
        },
        ...(grants.length === 0 ? {} : { grants }),
        ...(environmentDefaults.length === 0 ? {} : { environmentDefaults }),
        ...(environmentGrants.length === 0 ? {} : { environmentGrants }),
      },
    };
  };

  type ContinuationDispatch = NonNullable<ReturnType<typeof commandForContinuation>> & {
    waiterId: string;
    runId: string;
  };

  const dispatchContinuation = (dispatchable: ContinuationDispatch): void => {
    if (!dispatchable) return;
    try {
      dispatch(dispatchable.machineId, dispatchable.command);
    } catch {
      // The queued turn and waiter are already committed. Recovery repeats
      // this exact run id, which the daemon deduplicates after first start.
    }
  };

  /** Mutates every covered waiter under the caller's transaction and returns
   * only the commands that become safe to dispatch once that transaction has
   * committed. */
  const queueReadyWaiters = (
    jobId: string,
    excludedTaskIds: ReadonlySet<string>,
  ): ContinuationDispatch[] => {
    const dispatches: ContinuationDispatch[] = [];
    for (const candidate of setups.waitingForJob(jobId)) {
      if (excludedTaskIds.has(candidate.taskId)) continue;
      const waiter = setups.waiter(candidate.id);
      if (!waiter || waiter.state !== "waiting") continue;
      if (newestUserTurn(waiter.taskId) !== waiter.sourceTurnId) {
        setups.cancelWaiter(waiter.id, "superseded-by-user-turn", now());
        continue;
      }
      // One savepoint per waiter, so a waiter this lab cannot route discards
      // its OWN turn and queueing and nothing else. These two conditions used
      // to throw outright, which rolled the CALLER's transaction back — and
      // the caller here is `settle`, so one unroutable waiter took with it the
      // terminal record of a build that had physically finished, on this
      // attempt and on every recovery that retried it. The build is worth far
      // more than the defence. This waiter is left exactly as it was —
      // `waiting` on a job that is now ready, a state recovery already knows
      // how to pick up — and every other waiter on the build resumes.
      //
      // ONLY those two conditions. Anything else thrown in here is the store
      // failing, not a waiter being unroutable, and it is rethrown so the
      // whole settle rolls back the way it always did: a half-written
      // continuation is not something to carry on past.
      let dispatchable: ContinuationDispatch;
      try {
        dispatchable = store.tx(() => {
          const continuationTurnId = recordTurn(store, {
            sessionId: waiter.sessionId,
            taskId: waiter.taskId,
            prompt: continuationPrompt(waiter.environmentName),
            startedTs: now(),
            origin: "system",
            continuation: {
              kind: "environment-setup",
              waiterId: waiter.id,
              sourceTurnId: waiter.sourceTurnId,
              environmentName: waiter.environmentName,
              machineId: waiter.runtimeId,
            },
          });
          if (!setups.queueWaiter(waiter.id, continuationTurnId, now()))
            throw new UnroutableWaiter(`environment waiter ${waiter.id} could not be queued`);
          const queued = setups.waiter(waiter.id)!;
          const command = commandForContinuation(queued);
          if (!command)
            throw new UnroutableWaiter(
              `environment waiter ${waiter.id} has no exact continuation command`,
            );
          return { ...command, waiterId: queued.id, runId: continuationTurnId };
        });
      } catch (error) {
        if (!(error instanceof UnroutableWaiter)) throw error;
        continue;
      }
      dispatches.push(dispatchable);
    }
    return dispatches;
  };

  /**
   * Ends the still-live continuation turn each of these just-cancelled
   * waiters owns, and names the run its machine has to be told to stop.
   *
   * Must run inside the caller's transaction: a waiter marked cancelled and a
   * continuation turn still open are two halves of one fact, and a crash
   * between them would leave a turn running that nothing will ever settle.
   * The commands themselves are the caller's to dispatch AFTER that
   * transaction commits.
   */
  const endContinuationsOf = (
    waiters: readonly StoredEnvironmentSetupWaiter[],
    cancelledAt: number,
  ): Array<{ machineId: string; runId: string }> => {
    const queued: Array<{ machineId: string; runId: string }> = [];
    for (const waiter of waiters) {
      if (waiter.continuationTurnId === undefined) continue;
      const row = store.get(
        `SELECT s.runtime_id, t.ended_ts
           FROM turns t JOIN sessions s ON s.id = t.session_id
          WHERE t.id = ?`,
        [waiter.continuationTurnId],
      );
      if (!row || row.ended_ts !== null) continue;
      finishTurn(store, waiter.continuationTurnId, {
        endedTs: cancelledAt,
        status: "cancelled",
      });
      queued.push({
        machineId: row.runtime_id as string,
        runId: waiter.continuationTurnId,
      });
    }
    return queued;
  };

  const completedPackagesFor = (
    job: NonNullable<ReturnType<typeof setups.job>>,
  ): string[] =>
    job.resolvedFrom ?? envs.readLockRequest(job.environmentName, job.lockRevision) ?? [];

  const commandFor = (
    job: NonNullable<ReturnType<typeof setups.job>>,
    plan: ReturnType<typeof planFor>,
  ): RunCommand => {
    if (job.declarationGenerationId === undefined)
      throw new Error(
        `${job.environmentName}'s durable setup job has no authoritative declaration generation`,
      );
    const base = {
      type: "kernel-env-setup" as const,
      runId: job.requestId,
      name: job.environmentName,
      language: job.language,
      manager: job.manager,
      requestedPackages: completedPackagesFor(job),
      declarationGenerationId: job.declarationGenerationId,
      ...(job.declarationCreatedTs === undefined
        ? {}
        : { declarationCreatedTs: job.declarationCreatedTs }),
      ...(job.reason === undefined ? {} : { reason: job.reason }),
    };
    return plan.resolve
      ? { ...base, packages: plan.packages }
      : { ...base, lockfile: plan.lockfile, lockRevision: plan.lockRevision };
  };

  const planForStoredJob = (
    job: NonNullable<ReturnType<typeof setups.job>>,
  ): ReturnType<typeof planFor> => {
    if (job.resolvedFrom !== undefined) {
      const bound = envs.readLockRequest(job.environmentName, job.lockRevision);
      const lockfile = envs.readLock(job.environmentName, job.lockRevision);
      if (bound !== undefined && lockfile !== undefined && sameRequest(bound, job.resolvedFrom))
        return { resolve: false, lockfile, lockRevision: job.lockRevision };
      return { resolve: true, packages: job.resolvedFrom };
    }
    const lockfile = envs.readLock(job.environmentName, job.lockRevision);
    if (lockfile === undefined)
      throw new LykeionError(
        "conflict",
        `${job.environmentName}'s lockfile for revision ${job.lockRevision} is missing from this lab's own store`,
      );
    return { resolve: false, lockfile, lockRevision: job.lockRevision };
  };

  const statusAnswers = (
    job: NonNullable<ReturnType<typeof setups.job>>,
    status: KernelEnvStatus,
  ): boolean => {
    if (job.declarationGenerationId === undefined) return false;
    const lockfile = envs.readLock(job.environmentName, job.lockRevision);
    if (lockfile === undefined) return false;
    return kernelEnvironmentStatusAnswers(
      {
        environmentName: job.environmentName,
        language: job.language,
        manager: job.manager,
        lockRevision: job.lockRevision,
        declarationGenerationId: job.declarationGenerationId,
        lockfileFingerprint: environmentLockfileFingerprint(lockfile),
        packageFingerprint: environmentPackageFingerprint(completedPackagesFor(job)),
        setupRequestId: job.requestId,
      },
      status,
    );
  };

  return {
    attachWaiter(input, record) {
      const waiter = setups.recordRequirement(input);
      record("environment-setup-required", {
        waiterId: waiter.id,
        taskId: waiter.taskId,
        sourceRunId: waiter.sourceRunId,
      });
      return { waiterId: waiter.id };
    },

    cancelPendingForTask(taskId) {
      const cancelledAt = now();
      const queued = store.tx(() =>
        endContinuationsOf(
          setups.cancelPendingForTask(taskId, "superseded-by-user-turn", cancelledAt),
          cancelledAt,
        ),
      );
      return { cancellations: queued };
    },

    cancelForEnvironment(name) {
      const cancelledAt = now();
      const queued = store.tx(() =>
        endContinuationsOf(setups.cancelForEnvironment(name, cancelledAt), cancelledAt),
      );
      return { cancellations: queued };
    },

    cancelForDeletedTask(taskId) {
      const cancelledAt = now();
      const queued = store.tx(() =>
        endContinuationsOf(
          setups.cancelPendingForTask(taskId, "task-deleted", cancelledAt),
          cancelledAt,
        ),
      );
      return { cancellations: queued };
    },

    cancelForDeletedResearch(studyId) {
      const cancelledAt = now();
      const queued = store.tx(() => {
        const cancellations: Array<{ machineId: string; runId: string }> = [];
        // Per Task rather than by `study_id` in one statement, so this is the
        // same operation `cancelForDeletedTask` performs — every Task in this
        // Research is being deleted, which is what the cascade does and what
        // the reason each waiter is stamped with says.
        for (const row of store.all(
          `SELECT id FROM tasks WHERE study_id = ? ORDER BY seq ASC`,
          [studyId],
        ))
          cancellations.push(
            ...endContinuationsOf(
              setups.cancelPendingForTask(row.id as string, "task-deleted", cancelledAt),
              cancelledAt,
            ),
          );
        return cancellations;
      });
      return { cancellations: queued };
    },

    cancelForRevertedTurn(turnId) {
      const cancelledAt = now();
      const queued = store.tx(() =>
        endContinuationsOf(
          // Every removed waiter EXCEPT through the continuation being
          // discarded itself: that turn is about to be deleted by the same
          // transaction, and `revertTurn` has already recalled it if it was
          // still running. Ending a turn on its way out and telling its
          // machine twice would be two writes for nothing.
          setups
            .removeForTurn(turnId)
            .filter((waiter) => waiter.continuationTurnId !== turnId),
          cancelledAt,
        ),
      );
      return { cancellations: queued };
    },

    request(input, actor, record) {
      const requestedTs = now();
      const studyId = taskResearch(store, input.taskId);
      const machine = ownedMachine(store, input.machineId, actor, requestedTs);
      const declaration = envs.get(input.environmentName);
      if (!declaration)
        throw new LykeionError(
          "not-found",
          `no such environment: ${input.environmentName}`,
        );
      if (input.sourceRunId !== undefined) {
        const source = store.get(
          `SELECT t.task_id, s.opened_by
             FROM turns t JOIN sessions s ON s.id = t.session_id
            WHERE t.id = ?`,
          [input.sourceRunId],
        );
        if (!source)
          throw new LykeionError("not-found", `no such source run: ${input.sourceRunId}`);
        if (source.task_id !== input.taskId)
          throw new LykeionError(
            "forbidden",
            `source run ${input.sourceRunId} does not belong to Task ${input.taskId}`,
          );
        if (source.opened_by !== actor.userId)
          throw new LykeionError("forbidden", "that source run belongs to another member");
      }
      const plan = planFor(store, declaration.name);
      const requestId = `envsetup_${nextSeq(store)}`;
      const requested = setups.requestJob({
        studyId,
        taskId: input.taskId,
        runtimeId: machine.machineId,
        environmentName: declaration.name,
        language: declaration.language,
        manager: declaration.manager,
        lockRevision: declaration.lockRevision,
        declarationGenerationId: exactDeclarationGeneration(declaration),
        declarationCreatedTs: declaration.createdTs,
        requestId,
        requestedBy: actor.userId,
        requestedTs,
        requestedPackages: declaration.packages,
        ...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
        ...(plan.resolve ? { resolvedFrom: plan.packages } : {}),
      });
      if (requested.created) {
        dispatch(machine.machineId, commandFor(requested.job, plan));
      }
      record("environment-setup-requested", { jobId: requested.job.id, taskId: input.taskId });
      return {
        jobId: requested.job.id,
        ...(requested.waiter === undefined ? {} : { waiterId: requested.waiter.id }),
      };
    },

    retry(waiterId, actor, record) {
      const waiter = setups.waiter(waiterId);
      if (!waiter || waiter.state !== "waiting" || waiter.jobId === undefined)
        throw new LykeionError("conflict", "only a failed waiting environment requirement can be retried");
      const source = setups.job(waiter.jobId);
      if (!source || source.state !== "failed")
        throw new LykeionError("conflict", "only a failed environment setup can be retried");
      const opened = store.get(`SELECT opened_by FROM sessions WHERE id = ?`, [waiter.sessionId]);
      if (!opened || opened.opened_by !== actor.userId)
        throw new LykeionError("forbidden", "that environment requirement belongs to another member");
      const machine = ownedMachine(store, waiter.runtimeId, actor, now());
      const declaration = envs.get(waiter.environmentName);
      if (!declaration)
        throw new LykeionError("not-found", `no such environment: ${waiter.environmentName}`);
      if (declaration.language !== waiter.language)
        throw new LykeionError("conflict", "that environment requirement no longer matches its declaration");
      const plan = planFor(store, declaration.name);
      // Creating the replacement job and moving the waiter onto it are one
      // fact, so they are one transaction. Apart, a failure between them left
      // a created, undispatched `requested` job holding the
      // `(runtime, environment)` singleton — and a later `request()` would
      // join that job rather than create one, so nothing would ever be sent
      // to a machine for it.
      const replacement = store.tx(() => {
        const requestId = `envsetup_${nextSeq(store)}`;
        const created = setups.requestJob({
          studyId: waiter.studyId,
          taskId: waiter.taskId,
          runtimeId: waiter.runtimeId,
          environmentName: waiter.environmentName,
          language: waiter.language,
          manager: declaration.manager,
          lockRevision: declaration.lockRevision,
          declarationGenerationId: exactDeclarationGeneration(declaration),
          declarationCreatedTs: declaration.createdTs,
          requestId,
          requestedBy: actor.userId,
          requestedTs: now(),
          requestedPackages: declaration.packages,
          ...(plan.resolve ? { resolvedFrom: plan.packages } : {}),
          ...(source.reason === undefined ? {} : { reason: source.reason }),
        });
        const reattached = setups.reattachWaiter(waiterId, created.job.id, now());
        if (!reattached)
          throw new LykeionError("conflict", "that environment requirement cannot be retried now");
        return created;
      });
      // Outside it, like every other dispatch on this branch: a machine told
      // to build for a job a rolled-back retry never created is a command
      // this lab cannot take back.
      if (replacement.created)
        dispatch(machine.machineId, commandFor(replacement.job, plan));
      record("environment-setup-requested", {
        jobId: replacement.job.id,
        retriedWaiterId: waiterId,
      });
      return { jobId: replacement.job.id, waiterId };
    },

    progress(machineId, requestId, stage, line, record) {
      const job = setups.jobByRequest(requestId);
      if (!job || job.machineId !== machineId) return { accepted: false, changed: false };
      const progress = setups.markProgress(requestId, stage, line, now());
      if (progress.changed) record("environment-setup-progress", { jobId: job.id });
      return progress;
    },

    settle(machineId, requestId, result, record, suppliedTerminalOutcomeFingerprint) {
      const job = setups.jobByRequest(requestId);
      if (!job || job.machineId !== machineId || (job.state !== "requested" && job.state !== "building"))
        return false;
      let terminalOutcomeFingerprint: string | undefined;
      if (job.declarationGenerationId !== undefined) {
        try {
          terminalOutcomeFingerprint = fingerprintEnvironmentSetupOutcome({
            requestId,
            name: job.environmentName,
            declarationGenerationId: job.declarationGenerationId,
            result,
          }, result.ok
            ? completedPackagesForEnvironmentSetupFingerprint(store, job)
            : undefined).fingerprint;
        } catch {
          return false;
        }
      }
      if (
        suppliedTerminalOutcomeFingerprint !== undefined &&
        suppliedTerminalOutcomeFingerprint !== terminalOutcomeFingerprint
      ) return false;
      if (!result.ok) {
        if (result.name !== job.environmentName) return false;
        const failed = setups.markFailed(
          requestId,
          result.error,
          now(),
          terminalOutcomeFingerprint,
        );
        if (!failed) return false;
        runs.retireCommand(machineId, requestId);
        record("environment-setup-failed", { jobId: failed.id });
        return true;
      }
      const currentDeclaration = envs.get(job.environmentName);
      if (
        job.declarationGenerationId === undefined ||
        currentDeclaration?.declarationGenerationId !== job.declarationGenerationId
      ) {
        const error =
          `${job.environmentName}'s exact daemon request settled after its declaration ` +
          `generation became stale or non-authoritative; the result cannot make the current ` +
          `declaration ready`;
        const failed = setups.markFailed(requestId, error, now(), terminalOutcomeFingerprint);
        if (!failed) return false;
        runs.retireCommand(machineId, requestId);
        record("environment-setup-failed", { jobId: failed.id });
        return true;
      }
      if (!statusAnswers(job, result.status)) return false;
      const plan = store.tx(() => {
        const current = setups.jobByRequest(requestId);
        if (
          !current ||
          current.machineId !== machineId ||
          (current.state !== "requested" && current.state !== "building") ||
          !statusAnswers(current, result.status)
        ) return undefined;
        const completedPackages = completedPackagesFor(current);
        const declaration = envs.get(current.environmentName);
        let targetPlan: ReturnType<typeof planFor> | undefined;
        if (declaration !== undefined) {
          try {
            targetPlan = planFor(store, declaration.name);
          } catch {
            // The completed physical attempt is still authoritative. A broken
            // current declaration/lock can prevent a follow-up plan, but it
            // must not turn a reported ready build back into an active one.
          }
        }
        const targetRequestId =
          declaration === undefined || targetPlan === undefined
            ? undefined
            : `envsetup_${nextSeq(store)}`;
        const transition = setups.completeReadyWithFollowup(
          requestId,
          completedPackages,
          declaration === undefined || targetPlan === undefined || targetRequestId === undefined
            ? undefined
            : {
                runtimeId: current.machineId,
                environmentName: declaration.name,
                language: declaration.language,
                manager: declaration.manager,
                lockRevision: declaration.lockRevision,
                declarationGenerationId: exactDeclarationGeneration(declaration),
                declarationCreatedTs: declaration.createdTs,
                requestId: targetRequestId,
                requestedTs: now(),
                ...(targetPlan.resolve ? { resolvedFrom: targetPlan.packages } : {}),
                ...(current.reason === undefined ? {} : { reason: current.reason }),
              },
          now(),
          terminalOutcomeFingerprint,
        );
        if (!transition.ready) return undefined;
        const continuations = queueReadyWaiters(
          transition.ready.id,
          new Set(transition.capped.map(({ taskId }) => taskId)),
        );
        // The soft default's one offer, made where the build finished and
        // inside the same transaction that settled it. A suggestion written
        // after this commits would be lost at exactly the crash boundary the
        // continuation contract survives: the Task resumes in the environment
        // it waited for, and nothing ever asks whether the Research wants to
        // keep working there. `createSuggestionsForReadyJob` re-reads the
        // job's own `state = 'ready'` in SQL, so the precondition is the
        // store's rather than a second copy of it here, and it creates
        // nothing for a Research that already has a default or an outstanding
        // question for that language.
        setups.createSuggestionsForReadyJob(transition.ready.id, now());
        return { transition, targetPlan, continuations };
      });
      if (!plan) return false;
      const { transition, targetPlan, continuations } = plan;
      const ready = transition.ready!;
      runs.retireCommand(machineId, requestId);
      if (transition.created && transition.target && targetPlan) {
        dispatch(machineId, commandFor(transition.target, targetPlan));
        record("environment-setup-requested", {
          jobId: transition.target.id,
          previousJobId: ready.id,
        });
      }
      record("environment-setup-ready", {
        jobId: ready.id,
        uncovered: transition.capped.length,
      });
      for (const continuation of continuations) {
        dispatchContinuation(continuation);
        record("environment-setup-continuation-queued", {
          waiterId: continuation.waiterId,
          runId: continuation.runId,
        });
      }
      return true;
    },

    reconcileMachine(machineId, statuses, record) {
      if (statuses === undefined) return;
      for (const job of setups.nonterminalJobs()) {
        if (job.machineId !== machineId) continue;
        const status = statuses.find((candidate) => statusAnswers(job, candidate));
        if (!status) continue;
        this.settle(machineId, job.requestId, { ok: true, status }, record);
      }
    },

    recover(record) {
      for (const job of setups.nonterminalJobs()) {
        if (job.state !== "requested") continue;
        try {
          const declaration = envs.get(job.environmentName);
          if (!declaration)
            throw new Error(`environment ${job.environmentName} was deleted before recovery`);
          if (
            job.declarationGenerationId === undefined ||
            declaration.declarationGenerationId !== job.declarationGenerationId
          )
            throw new Error(
              `environment ${job.environmentName}'s declaration generation no longer ` +
                `matches this exact durable request`,
            );
          dispatch(job.machineId, commandFor(job, planForStoredJob(job)));
          record("environment-setup-recovered", { jobId: job.id });
        } catch (error) {
          const diagnostic = `Recovery skipped: ${error instanceof Error ? error.message : String(error)}`;
          setups.appendDiagnostic(job.requestId, diagnostic, now());
          record("environment-setup-progress", { jobId: job.id });
        }
      }
      const readyJobIds = setups.readyJobIdsWithWaitingWaiters();
      const newlyQueued = new Set<string>();
      for (const jobId of readyJobIds) {
        const continuations = store.tx(() => {
          const ready = setups.job(jobId);
          if (!ready || ready.state !== "ready") return [];
          const uncovered = setups.uncoveredInterests(jobId, completedPackagesFor(ready));
          return queueReadyWaiters(
            jobId,
            new Set(uncovered.map(({ taskId }) => taskId)),
          );
        });
        for (const continuation of continuations) {
          newlyQueued.add(continuation.waiterId);
          dispatchContinuation(continuation);
          record("environment-setup-continuation-recovered", {
            waiterId: continuation.waiterId,
            runId: continuation.runId,
          });
        }
      }
      const queuedDispatches = store.tx(() => {
        const dispatches: ContinuationDispatch[] = [];
        for (const waiter of setups.queuedWaiters()) {
          if (newlyQueued.has(waiter.id)) continue;
          if (newestUserTurn(waiter.taskId) !== waiter.sourceTurnId) {
            const cancelled = setups.cancelWaiter(waiter.id, "superseded-by-user-turn", now());
            if (cancelled?.continuationTurnId !== undefined) {
              const row = store.get(`SELECT ended_ts FROM turns WHERE id = ?`, [cancelled.continuationTurnId]);
              if (row?.ended_ts === null)
                finishTurn(store, cancelled.continuationTurnId, { endedTs: now(), status: "cancelled" });
            }
            continue;
          }
          const dispatchable = commandForContinuation(waiter);
          if (dispatchable && waiter.continuationTurnId !== undefined)
            dispatches.push({
              ...dispatchable,
              waiterId: waiter.id,
              runId: waiter.continuationTurnId,
            });
        }
        return dispatches;
      });
      for (const continuation of queuedDispatches) {
        dispatchContinuation(continuation);
        record("environment-setup-continuation-recovered", {
          waiterId: continuation.waiterId,
          runId: continuation.runId,
        });
      }
    },

    bindResolvedLock(machineId, requestId, name, declarationGenerationId, lockfile, record) {
      const revision = setups.bindResolvedLock(
        machineId,
        requestId,
        name,
        declarationGenerationId,
        lockfile,
        now(),
      );
      if (revision !== undefined)
        record("environment-lock-written", { name });
      return revision;
    },

    requestRebuild(input, record) {
      const declaration = envs.get(input.environmentName);
      if (!declaration) return undefined;
      let plan: ReturnType<typeof planFor>;
      try {
        plan = planFor(store, declaration.name);
      } catch {
        // A declaration deleted underneath this call, or a pinned revision
        // this lab no longer holds the text of. Neither is a build that can
        // be planned, and neither is this route's to report on.
        return undefined;
      }
      const requestedTs = now();
      const physical = {
        runtimeId: input.machineId,
        environmentName: declaration.name,
        language: declaration.language,
        manager: declaration.manager,
        lockRevision: declaration.lockRevision,
        declarationGenerationId: exactDeclarationGeneration(declaration),
        declarationCreatedTs: declaration.createdTs,
        requestId: `envsetup_${nextSeq(store)}`,
        requestedTs,
        ...(plan.resolve ? { resolvedFrom: plan.packages } : {}),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      };
      const requested = input.taskId === undefined
        ? setups.requestPhysicalJob(physical)
        : setups.requestJob({
            ...physical,
            studyId: taskResearch(store, input.taskId),
            taskId: input.taskId,
            requestedBy: input.requestedBy,
            requestedPackages: input.requestedPackages,
          });
      if (requested.created) {
        dispatch(input.machineId, commandFor(requested.job, plan));
      } else if (input.reason !== undefined) {
        // Joined a build that is already running. Its command is dispatched
        // and unchanged, but the coverage round this add earns is minted from
        // this job's reason — so a job started without one (a Setup press
        // carries none) takes this add's sentence rather than restarting the
        // researcher's kernels announcing nothing.
        setups.nameReasonIfUnsaid(requested.job.id, input.reason, requestedTs);
      }
      // Not recorded for a pure join: no interest filed and no command sent.
      // A change-log row and a channel event for a job this call did not
      // change is this lab reporting work it did not do. (`input.reason` does
      // not widen this — the route always supplies one, and naming a silence
      // may itself be a no-op.)
      if (requested.created || input.taskId !== undefined)
        record("environment-setup-requested", {
          jobId: requested.job.id,
          ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        });
      return { jobId: requested.job.id };
    },
  };
}
