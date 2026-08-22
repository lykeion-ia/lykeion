import {
  ENVIRONMENT_SETUP_OUTCOME_LIMITS,
  boundedRedactedUtf8,
  type EnvironmentDefaultSuggestion,
  type EnvironmentSetupJob,
  type EnvironmentSetupStage,
  type EnvironmentSetupWaiter,
  type KernelEnvManager,
  type Language,
  type ResearchEnvironmentDefault,
  type TaskEnvironmentSetup,
} from "@lykeion/api";
import { nextSeq } from "./migrations";
import { environmentStore } from "./environments";
import type { Row, Store } from "./store";

export interface StoredEnvironmentSetupJob extends EnvironmentSetupJob {
  requestId: string;
  previousJobId?: string;
  round: number;
  resolvedFrom?: string[];
  reason?: string;
  sequence: number;
  terminalOutcomeFingerprint?: string;
}

export interface StoredEnvironmentSetupWaiter extends EnvironmentSetupWaiter {
  jobId?: string;
  studyId: string;
  taskId: string;
  sessionId: string;
  language: Language;
  environmentName: string;
  runtimeId: string;
  createdTs: number;
  updatedTs: number;
  sequence: number;
}

export interface RecordEnvironmentRequirementInput {
  studyId: string;
  taskId: string;
  sessionId: string;
  sourceTurnId: string;
  sourceRunId: string;
  language: Language;
  environmentName: string;
  runtimeId: string;
  createdTs: number;
}

export interface RequestEnvironmentSetupJobInput {
  studyId: string;
  taskId: string;
  runtimeId: string;
  environmentName: string;
  language: Language;
  manager: KernelEnvManager;
  lockRevision: number;
  declarationGenerationId: string;
  declarationCreatedTs: number;
  requestId: string;
  requestedBy: string;
  requestedTs: number;
  requestedPackages: string[];
  sourceRunId?: string;
  previousJobId?: string;
  round?: number;
  resolvedFrom?: string[];
  reason?: string;
}

export interface StoredEnvironmentSetupInterest {
  studyId: string;
  taskId: string;
  requestedBy: string;
  requestedTs: number;
  requestedPackages: string[];
  coverageRound: number;
}

export interface RequestPhysicalEnvironmentSetupJobInput {
  runtimeId: string;
  environmentName: string;
  language: Language;
  manager: KernelEnvManager;
  lockRevision: number;
  declarationGenerationId: string;
  declarationCreatedTs: number;
  requestId: string;
  requestedTs: number;
  previousJobId?: string;
  round?: number;
  resolvedFrom?: string[];
  reason?: string;
}

function jobFromRow(row: Row): StoredEnvironmentSetupJob {
  return {
    id: row.id as string,
    machineId: row.runtime_id as string,
    machineName: row.machine_name as string,
    environmentName: row.environment_name as string,
    language: row.language as Language,
    manager: row.manager as KernelEnvManager,
    lockRevision: row.lock_revision as number,
    ...(row.declaration_generation_id == null
      ? {}
      : { declarationGenerationId: row.declaration_generation_id as string }),
    ...(row.declaration_created_ts === null
      ? {}
      : { declarationCreatedTs: row.declaration_created_ts as number }),
    requestId: row.request_id as string,
    ...(row.previous_job_id === null
      ? {}
      : { previousJobId: row.previous_job_id as string }),
    round: row.round as number,
    ...(row.resolved_from === null
      ? {}
      : { resolvedFrom: JSON.parse(row.resolved_from as string) as string[] }),
    ...(row.reason === null ? {} : { reason: row.reason as string }),
    ...(typeof row.terminal_outcome_fingerprint === "string"
      ? { terminalOutcomeFingerprint: row.terminal_outcome_fingerprint }
      : {}),
    state: row.state as StoredEnvironmentSetupJob["state"],
    stage: row.stage as EnvironmentSetupStage,
    ...(row.error_summary === null ? {} : { errorSummary: row.error_summary as string }),
    log: JSON.parse(row.log as string) as string[],
    requestedTs: row.requested_ts as number,
    ...(row.started_ts === null ? {} : { startedTs: row.started_ts as number }),
    ...(row.finished_ts === null ? {} : { finishedTs: row.finished_ts as number }),
    updatedTs: row.updated_ts as number,
    sequence: row.seq as number,
  };
}

function publicJob(job: StoredEnvironmentSetupJob): EnvironmentSetupJob {
  return {
    id: job.id,
    machineId: job.machineId,
    machineName: job.machineName,
    environmentName: job.environmentName,
    language: job.language,
    manager: job.manager,
    lockRevision: job.lockRevision,
    ...(job.declarationGenerationId === undefined
      ? {}
      : { declarationGenerationId: job.declarationGenerationId }),
    ...(job.declarationCreatedTs === undefined
      ? {}
      : { declarationCreatedTs: job.declarationCreatedTs }),
    state: job.state,
    stage: job.stage,
    requestedTs: job.requestedTs,
    ...(job.startedTs === undefined ? {} : { startedTs: job.startedTs }),
    ...(job.finishedTs === undefined ? {} : { finishedTs: job.finishedTs }),
    updatedTs: job.updatedTs,
    ...(job.errorSummary === undefined ? {} : { errorSummary: job.errorSummary }),
    log: job.log,
  };
}

function jobById(store: Store, id: string): StoredEnvironmentSetupJob | undefined {
  const row = store.get(
    `SELECT j.*, r.name AS machine_name
       FROM kernel_env_setup_jobs j
       JOIN runtimes r ON r.id = j.runtime_id
      WHERE j.id = ?`,
    [id],
  );
  return row ? jobFromRow(row) : undefined;
}

function interestFromRow(row: Row): StoredEnvironmentSetupInterest {
  return {
    studyId: row.study_id as string,
    taskId: row.task_id as string,
    requestedBy: row.requested_by as string,
    requestedTs: row.requested_ts as number,
    requestedPackages: JSON.parse(row.requested_packages as string) as string[],
    coverageRound: row.coverage_round as number,
  };
}

function waiterFromRow(row: Row): StoredEnvironmentSetupWaiter {
  return {
    id: row.id as string,
    ...(row.job_id === null ? {} : { jobId: row.job_id as string }),
    studyId: row.study_id as string,
    taskId: row.task_id as string,
    sessionId: row.session_id as string,
    sourceTurnId: row.source_turn_id as string,
    sourceRunId: row.source_run_id as string,
    language: row.language as Language,
    environmentName: row.environment_name as string,
    runtimeId: row.runtime_id as string,
    state: row.state as StoredEnvironmentSetupWaiter["state"],
    ...(row.continuation_turn_id === null
      ? {}
      : { continuationTurnId: row.continuation_turn_id as string }),
    ...(row.cancelled_reason === null
      ? {}
      : { cancelledReason: row.cancelled_reason as NonNullable<EnvironmentSetupWaiter["cancelledReason"]> }),
    createdTs: row.created_ts as number,
    updatedTs: row.updated_ts as number,
    sequence: row.seq as number,
  };
}

function suggestionFromRow(row: Row): EnvironmentDefaultSuggestion {
  return {
    id: row.id as string,
    language: row.language as Language,
    environmentName: row.environment_name as string,
    state: row.state as EnvironmentDefaultSuggestion["state"],
  };
}

export function environmentSetupStore(store: Store) {
  const recordRequirement = (
    input: RecordEnvironmentRequirementInput,
  ): StoredEnvironmentSetupWaiter => {
    return store.tx(() => {
      const existing = store.get(
        `SELECT * FROM task_env_setup_waiters
          WHERE source_turn_id = ? AND source_run_id = ? AND study_id = ? AND task_id = ?
            AND session_id = ? AND language = ? AND environment_name = ? AND runtime_id = ?`,
        [
          input.sourceTurnId,
          input.sourceRunId,
          input.studyId,
          input.taskId,
          input.sessionId,
          input.language,
          input.environmentName,
          input.runtimeId,
        ],
      );
      if (existing) return waiterFromRow(existing);

      const seq = nextSeq(store);
      store.run(
        `INSERT INTO task_env_setup_waiters
             (id, job_id, study_id, task_id, session_id, source_turn_id, source_run_id,
              language, environment_name, runtime_id, state, created_ts, updated_ts, seq)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?)`,
        [
          `wait_${seq}`,
          input.studyId,
          input.taskId,
          input.sessionId,
          input.sourceTurnId,
          input.sourceRunId,
          input.language,
          input.environmentName,
          input.runtimeId,
          input.createdTs,
          input.createdTs,
          seq,
        ],
      );
      return waiterFromRow(
        store.get(`SELECT * FROM task_env_setup_waiters WHERE id = ?`, [`wait_${seq}`])!,
      );
    });
  };

  const waitingForJob = (jobId: string): StoredEnvironmentSetupWaiter[] => {
    return store
      .all(
        `SELECT * FROM task_env_setup_waiters
            WHERE job_id = ? AND state = 'waiting'
            ORDER BY seq ASC`,
        [jobId],
      )
      .map(waiterFromRow);
  };

  const attachRequirements = (
    jobId: string,
    taskId: string,
    environmentName: string,
    runtimeId: string,
    sourceRunId: string,
    now: number,
  ): StoredEnvironmentSetupWaiter[] =>
    store.tx(() => {
      const job = store.get(
        `SELECT j.language
           FROM kernel_env_setup_jobs j
           JOIN kernel_env_setup_interests i ON i.job_id = j.id AND i.task_id = ?
          WHERE j.id = ? AND j.environment_name = ? AND j.runtime_id = ?`,
        [taskId, jobId, environmentName, runtimeId],
      );
      if (!job) return [];
      const ids = store.all(
        `SELECT waiter.id
           FROM task_env_setup_waiters waiter
           LEFT JOIN kernel_env_setup_jobs source ON source.id = waiter.job_id
          WHERE waiter.state = 'waiting' AND waiter.task_id = ?
            AND waiter.source_run_id = ? AND waiter.language = ?
            AND waiter.environment_name = ? AND waiter.runtime_id = ?
            AND (waiter.job_id IS NULL OR source.state = 'ready')
          ORDER BY waiter.seq ASC LIMIT 1`,
        [taskId, sourceRunId, job.language, environmentName, runtimeId],
      ).map(({ id }) => id as string);
      for (const id of ids) {
        store.run(
          `UPDATE task_env_setup_waiters SET job_id = ?, updated_ts = ?
            WHERE id = ? AND state = 'waiting'`,
          [jobId, now, id],
        );
      }
      return ids.map(
        (id) => waiterFromRow(store.get(`SELECT * FROM task_env_setup_waiters WHERE id = ?`, [id])!),
      );
    });

  const requestPhysicalJob = (
    input: RequestPhysicalEnvironmentSetupJobInput,
  ): { job: StoredEnvironmentSetupJob; created: boolean } => {
    let created = false;
    const coverageFollowUp = input.previousJobId !== undefined || input.round !== undefined;
    if (coverageFollowUp) {
      const previous = input.previousJobId === undefined
        ? undefined
        : store.get(
            `SELECT runtime_id, environment_name, state, round
               FROM kernel_env_setup_jobs WHERE id = ?`,
            [input.previousJobId],
          );
      if (
        input.previousJobId === undefined ||
        input.round === undefined ||
        !previous ||
        previous.state !== "ready" ||
        previous.runtime_id !== input.runtimeId ||
        previous.environment_name !== input.environmentName ||
        input.round !== (previous.round as number) + 1 ||
        input.round > 4
      ) {
        throw new Error("an environment coverage follow-up must continue the exact ready round");
      }
    }
    let row = store.get(
      `SELECT id FROM kernel_env_setup_jobs WHERE request_id = ?`,
      [input.requestId],
    );
    if (!row) {
      row = store.get(
        `SELECT id, state, declaration_generation_id FROM kernel_env_setup_jobs
          WHERE runtime_id = ? AND environment_name = ?
            AND state IN ('requested', 'building')`,
        [input.runtimeId, input.environmentName],
      );
      if (row && row.declaration_generation_id !== input.declarationGenerationId) {
        if (row.declaration_generation_id == null)
          throw new Error(
            `${input.environmentName} has an active legacy setup whose daemon-start evidence ` +
              `cannot be reconstructed; its exact old request must settle before the current ` +
              `declaration generation can start`,
          );
        if (row.state === "building")
          throw new Error(
            `${input.environmentName} is still building under another declaration generation; ` +
              `the exact old daemon request must settle before the current generation can start`,
          );
        store.run(
          `UPDATE kernel_env_setup_jobs
              SET state = 'failed', error_summary = ?, finished_ts = ?, updated_ts = ?
            WHERE id = ? AND state = 'requested'`,
          [
            `This unstarted setup targeted a stale or non-authoritative declaration generation; ` +
              `its Task interests and waiters were preserved for an explicit retry.`,
            input.requestedTs,
            input.requestedTs,
            row.id,
          ],
        );
        row = undefined;
      }
    }
    let jobId: string;
    if (row) {
      jobId = row.id as string;
    } else {
      created = true;
      const seq = nextSeq(store);
      jobId = `envjob_${seq}`;
      store.run(
        `INSERT INTO kernel_env_setup_jobs
           (id, runtime_id, environment_name, language, manager, lock_revision,
            declaration_generation_id, declaration_created_ts,
            request_id, previous_job_id, round, resolved_from, reason, state, stage,
            requested_ts, updated_ts, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', 'waiting-for-machine', ?, ?, ?)`,
        [
          jobId,
          input.runtimeId,
          input.environmentName,
          input.language,
          input.manager,
          input.lockRevision,
          input.declarationGenerationId,
          input.declarationCreatedTs,
          input.requestId,
          input.previousJobId ?? null,
          input.round ?? 1,
          input.resolvedFrom === undefined ? null : JSON.stringify(input.resolvedFrom),
          input.reason ?? null,
          input.requestedTs,
          input.requestedTs,
          seq,
        ],
      );
    }
    return { job: jobById(store, jobId)!, created };
  };

  const requestJob = (
    input: RequestEnvironmentSetupJobInput,
  ): { job: StoredEnvironmentSetupJob; waiter?: StoredEnvironmentSetupWaiter; created: boolean } =>
    store.tx(() => {
      const physical = requestPhysicalJob(input);
      const jobId = physical.job.id;
      const prior = store.get(
        `SELECT requested_packages FROM kernel_env_setup_interests
          WHERE job_id = ? AND task_id = ?`,
        [jobId, input.taskId],
      );
      const priorPackages = prior === undefined
        ? []
        : JSON.parse(prior.requested_packages as string) as string[];
      const packages = prior === undefined
        ? [...new Set(input.requestedPackages)]
        : [
            ...priorPackages,
            ...input.requestedPackages.filter((entry) => !priorPackages.includes(entry)),
          ];
      store.run(
        `INSERT INTO kernel_env_setup_interests
           (job_id, study_id, task_id, requested_by, requested_ts, requested_packages, coverage_round)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(job_id, task_id) DO UPDATE SET
           requested_packages = excluded.requested_packages,
           coverage_round = 1`,
        [
          jobId,
          input.studyId,
          input.taskId,
          input.requestedBy,
          input.requestedTs,
          JSON.stringify(packages),
        ],
      );
      const waiter = input.sourceRunId === undefined
        ? undefined
        : attachRequirements(
            jobId,
            input.taskId,
            input.environmentName,
            input.runtimeId,
            input.sourceRunId,
            input.requestedTs,
          )[0];
      return {
        job: jobById(store, jobId)!,
        created: physical.created,
        ...(waiter === undefined ? {} : { waiter }),
      };
    });

  const forTask = (taskId: string): TaskEnvironmentSetup[] =>
    store
      .all(
        `SELECT j.*, r.name AS machine_name,
                w.id AS waiter_id, w.job_id AS waiter_job_id, w.study_id AS waiter_study_id,
                w.task_id AS waiter_task_id, w.session_id AS waiter_session_id,
                w.source_turn_id AS waiter_source_turn_id, w.source_run_id AS waiter_source_run_id,
                w.language AS waiter_language, w.environment_name AS waiter_environment_name,
                w.runtime_id AS waiter_runtime_id, w.state AS waiter_state,
                w.continuation_turn_id AS waiter_continuation_turn_id,
                w.cancelled_reason AS waiter_cancelled_reason, w.created_ts AS waiter_created_ts,
                w.updated_ts AS waiter_updated_ts, w.seq AS waiter_seq,
                d.id AS suggestion_id, d.language AS suggestion_language,
                d.environment_name AS suggestion_environment_name,
                d.state AS suggestion_state
           FROM kernel_env_setup_interests i
           JOIN kernel_env_setup_jobs j ON j.id = i.job_id
           JOIN runtimes r ON r.id = j.runtime_id
           LEFT JOIN task_env_setup_waiters w ON w.job_id = j.id AND w.task_id = i.task_id
           LEFT JOIN environment_default_suggestions d
             ON d.job_id = j.id AND d.task_id = i.task_id
          WHERE i.task_id = ?
          ORDER BY j.seq ASC, w.seq ASC`,
        [taskId],
      )
      .map((row) => {
        const projection: TaskEnvironmentSetup = { job: publicJob(jobFromRow(row)) };
        if (row.waiter_id !== null) {
          projection.waiter = waiterFromRow({
            id: row.waiter_id,
            job_id: row.waiter_job_id,
            study_id: row.waiter_study_id,
            task_id: row.waiter_task_id,
            session_id: row.waiter_session_id,
            source_turn_id: row.waiter_source_turn_id,
            source_run_id: row.waiter_source_run_id,
            language: row.waiter_language,
            environment_name: row.waiter_environment_name,
            runtime_id: row.waiter_runtime_id,
            state: row.waiter_state,
            continuation_turn_id: row.waiter_continuation_turn_id,
            cancelled_reason: row.waiter_cancelled_reason,
            created_ts: row.waiter_created_ts,
            updated_ts: row.waiter_updated_ts,
            seq: row.waiter_seq,
          });
        }
        if (row.suggestion_id !== null) {
          projection.suggestion = suggestionFromRow({
            id: row.suggestion_id,
            language: row.suggestion_language,
            environment_name: row.suggestion_environment_name,
            state: row.suggestion_state,
          });
        }
        return projection;
      });

  const jobByRequest = (requestId: string): StoredEnvironmentSetupJob | undefined => {
    const row = store.get(
      `SELECT j.*, r.name AS machine_name
         FROM kernel_env_setup_jobs j
         JOIN runtimes r ON r.id = j.runtime_id
        WHERE j.request_id = ?`,
      [requestId],
    );
    return row ? jobFromRow(row) : undefined;
  };

  const markProgress = (
    requestId: string,
    stage: EnvironmentSetupStage,
    line: string,
    now: number,
  ): { accepted: boolean; changed: boolean } =>
    store.tx(() => {
      const row = store.get(
        `SELECT id, stage, log FROM kernel_env_setup_jobs
          WHERE request_id = ? AND state IN ('requested', 'building')`,
        [requestId],
      );
      if (!row) return { accepted: false, changed: false };
      const order: Record<EnvironmentSetupStage, number> = {
        "waiting-for-machine": 0,
        resolving: 1,
        installing: 2,
        finalizing: 3,
      };
      if (order[stage] < order[row.stage as EnvironmentSetupStage])
        return { accepted: true, changed: false };
      const existing = JSON.parse(row.log as string) as string[];
      const bounded = boundedRedactedUtf8(
        line,
        ENVIRONMENT_SETUP_OUTCOME_LIMITS.errorBytes,
      );
      if (row.stage === stage && existing.at(-1) === bounded)
        return { accepted: true, changed: false };
      const lines = [...existing, bounded].slice(-200);
      while (lines.length > 0 && Buffer.byteLength(JSON.stringify(lines), "utf8") > 65_536) {
        lines.shift();
      }
      store.run(
        `UPDATE kernel_env_setup_jobs
            SET state = 'building', stage = ?, log = ?,
                started_ts = COALESCE(started_ts, ?), updated_ts = ?
          WHERE id = ? AND state IN ('requested', 'building')`,
        [stage, JSON.stringify(lines), now, now, row.id],
      );
      return { accepted: true, changed: true };
    });

  const markTerminal = (
    requestId: string,
    state: "ready" | "failed",
    summary: string | undefined,
    now: number,
    terminalOutcomeFingerprint?: string,
  ): StoredEnvironmentSetupJob | undefined =>
    store.tx(() => {
      if (
        terminalOutcomeFingerprint !== undefined &&
        !/^[a-f0-9]{64}$/.test(terminalOutcomeFingerprint)
      )
        throw new Error("terminal environment setup fingerprint must be a sha256 digest");
      const updated = store.get(
        `UPDATE kernel_env_setup_jobs
            SET state = ?, error_summary = ?, finished_ts = ?, updated_ts = ?
                ${terminalOutcomeFingerprint === undefined
                  ? ""
                  : ", terminal_outcome_fingerprint = ?"}
          WHERE request_id = ? AND state IN ('requested', 'building')
          RETURNING id`,
        [
          state,
          summary ?? null,
          now,
          now,
          ...(terminalOutcomeFingerprint === undefined ? [] : [terminalOutcomeFingerprint]),
          requestId,
        ],
      );
      return updated ? jobById(store, updated.id as string) : undefined;
    });

  const queueWaiter = (
    waiterId: string,
    continuationTurnId: string,
    now = Date.now(),
  ): boolean =>
    store.get(
      `UPDATE task_env_setup_waiters
          SET state = 'queued', continuation_turn_id = ?, updated_ts = ?
        WHERE id = ? AND state = 'waiting' AND continuation_turn_id IS NULL
        RETURNING id`,
      [continuationTurnId, now, waiterId],
    ) !== undefined;

  const markWaiterResumed = (continuationTurnId: string, now: number): boolean =>
    store.get(
      `UPDATE task_env_setup_waiters SET state = 'resumed', updated_ts = ?
        WHERE continuation_turn_id = ? AND state = 'queued'
        RETURNING id`,
      [now, continuationTurnId],
    ) !== undefined;

  const cancelQueuedWaiterForContinuation = (
    continuationTurnId: string,
    reason: NonNullable<EnvironmentSetupWaiter["cancelledReason"]>,
    now: number,
  ): StoredEnvironmentSetupWaiter | undefined => {
    const updated = store.get(
      `UPDATE task_env_setup_waiters
          SET state = 'cancelled', cancelled_reason = ?, updated_ts = ?
        WHERE continuation_turn_id = ? AND state = 'queued'
        RETURNING *`,
      [reason, now, continuationTurnId],
    );
    return updated ? waiterFromRow(updated) : undefined;
  };

  const cancelPendingForTask = (
    taskId: string,
    reason: NonNullable<EnvironmentSetupWaiter["cancelledReason"]>,
    now: number,
  ): StoredEnvironmentSetupWaiter[] =>
    store.tx(() => {
      const ids = store
        .all(
          `SELECT id FROM task_env_setup_waiters
            WHERE task_id = ? AND state IN ('waiting', 'queued')
            ORDER BY seq ASC`,
          [taskId],
        )
        .map(({ id }) => id as string);
      for (const id of ids) {
        store.run(
          `UPDATE task_env_setup_waiters
              SET state = 'cancelled', cancelled_reason = ?, updated_ts = ?
            WHERE id = ? AND state IN ('waiting', 'queued')`,
          [reason, now, id],
        );
      }
      return ids.map(
        (id) => waiterFromRow(store.get(`SELECT * FROM task_env_setup_waiters WHERE id = ?`, [id])!),
      );
    });

  const cancelWaiter = (
    waiterId: string,
    reason: NonNullable<EnvironmentSetupWaiter["cancelledReason"]>,
    now: number,
  ): StoredEnvironmentSetupWaiter | undefined => {
    const updated = store.get(
      `UPDATE task_env_setup_waiters
          SET state = 'cancelled', cancelled_reason = ?, updated_ts = ?
        WHERE id = ? AND state IN ('waiting', 'queued')
        RETURNING *`,
      [reason, now, waiterId],
    );
    return updated ? waiterFromRow(updated) : undefined;
  };

  const reattachWaiter = (
    waiterId: string,
    jobId: string,
    now: number,
  ): StoredEnvironmentSetupWaiter | undefined =>
    store.tx(() => {
      const updated = store.get(
        `UPDATE task_env_setup_waiters AS waiter SET job_id = ?, updated_ts = ?
          WHERE waiter.id = ? AND waiter.state = 'waiting' AND waiter.job_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM kernel_env_setup_jobs source
               WHERE source.id = waiter.job_id AND source.state = 'failed'
            )
            AND EXISTS (
              SELECT 1
                FROM kernel_env_setup_jobs replacement
                JOIN kernel_env_setup_interests interest
                  ON interest.job_id = replacement.id AND interest.task_id = waiter.task_id
               WHERE replacement.id = ?
                 AND replacement.state IN ('requested', 'building')
                 AND replacement.runtime_id = waiter.runtime_id
                 AND replacement.environment_name = waiter.environment_name
                 AND replacement.language = waiter.language
            )
          RETURNING *`,
        [jobId, now, waiterId, jobId],
      );
      return updated ? waiterFromRow(updated) : undefined;
    });

  const uncoveredInterests = (
    jobId: string,
    completedPackages: string[],
  ): StoredEnvironmentSetupInterest[] => {
    const job = store.get(
      `SELECT state FROM kernel_env_setup_jobs WHERE id = ?`,
      [jobId],
    );
    if (job?.state !== "ready") return [];
    const completed = new Set(completedPackages);
    return store
      .all(
        `SELECT study_id, task_id, requested_by, requested_ts, requested_packages, coverage_round
           FROM kernel_env_setup_interests
          WHERE job_id = ? ORDER BY requested_ts ASC, task_id ASC`,
        [jobId],
      )
      .map(interestFromRow)
      .filter((interest) =>
        interest.requestedPackages.some((entry) => !completed.has(entry)),
      );
  };

  const carryForwardUncovered = (
    sourceJobId: string,
    targetJobId: string,
    completedPackages: string[],
    now: number,
  ): { interests: StoredEnvironmentSetupInterest[]; waiters: StoredEnvironmentSetupWaiter[] } =>
    store.tx(() => {
      const source = store.get(
        `SELECT runtime_id, environment_name, state
           FROM kernel_env_setup_jobs WHERE id = ?`,
        [sourceJobId],
      );
      const target = store.get(
        `SELECT runtime_id, environment_name, state
           FROM kernel_env_setup_jobs WHERE id = ?`,
        [targetJobId],
      );
      if (
        !source ||
        !target ||
        sourceJobId === targetJobId ||
        source.state !== "ready" ||
        (target.state !== "requested" && target.state !== "building") ||
        source.runtime_id !== target.runtime_id ||
        source.environment_name !== target.environment_name
      ) {
        return { interests: [], waiters: [] };
      }

      const interests = uncoveredInterests(sourceJobId, completedPackages)
        .filter(({ coverageRound }) => coverageRound < 4);
      const waiters: StoredEnvironmentSetupWaiter[] = [];
      for (const interest of interests) {
        const existing = store.get(
          `SELECT requested_packages, coverage_round FROM kernel_env_setup_interests
            WHERE job_id = ? AND task_id = ?`,
          [targetJobId, interest.taskId],
        );
        const existingPackages = existing === undefined
          ? []
          : JSON.parse(existing.requested_packages as string) as string[];
        const targetPackages = existing === undefined
          ? interest.requestedPackages
          : [
              ...existingPackages,
              ...interest.requestedPackages.filter((entry) => !existingPackages.includes(entry)),
            ];
        const targetRound = existing === undefined
          ? interest.coverageRound + 1
          : Math.min(existing.coverage_round as number, interest.coverageRound + 1);
        store.run(
          `INSERT INTO kernel_env_setup_interests
             (job_id, study_id, task_id, requested_by, requested_ts, requested_packages, coverage_round)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id, task_id) DO UPDATE SET
             requested_packages = excluded.requested_packages,
             coverage_round = excluded.coverage_round`,
          [
            targetJobId,
            interest.studyId,
            interest.taskId,
            interest.requestedBy,
            interest.requestedTs,
            JSON.stringify(targetPackages),
            targetRound,
          ],
        );
        const movedIds = store
          .all(
            `UPDATE task_env_setup_waiters
                SET job_id = ?, updated_ts = ?
              WHERE job_id = ? AND task_id = ? AND state = 'waiting'
              RETURNING id`,
            [targetJobId, now, sourceJobId, interest.taskId],
          )
          .map(({ id }) => id as string);
        for (const id of movedIds) {
          waiters.push(
            waiterFromRow(store.get(`SELECT * FROM task_env_setup_waiters WHERE id = ?`, [id])!),
          );
        }
        store.run(
          `DELETE FROM kernel_env_setup_interests WHERE job_id = ? AND task_id = ?`,
          [sourceJobId, interest.taskId],
        );
      }
      return { interests, waiters };
    });

  const bindResolvedLock = (
    machineId: string,
    requestId: string,
    name: string,
    declarationGenerationId: string,
    lockfile: string,
    now: number,
  ): number | undefined =>
    store.tx(() => {
      const job = store.get(
        `SELECT id, resolved_from, declaration_generation_id FROM kernel_env_setup_jobs
          WHERE request_id = ? AND runtime_id = ? AND environment_name = ?
            AND state IN ('requested', 'building')`,
        [requestId, machineId, name],
      );
      if (
        !job ||
        job.resolved_from === null ||
        job.declaration_generation_id !== declarationGenerationId
      )
        return undefined;
      const declaration = store.get(
        `SELECT declaration_generation_id FROM kernel_envs WHERE name = ?`,
        [name],
      );
      if (
        !declaration ||
        declaration.declaration_generation_id !== declarationGenerationId
      )
        return undefined;
      const resolvedFrom = JSON.parse(job.resolved_from as string) as string[];
      const alreadyBound = store.get(
        `SELECT lockfile, requested_packages FROM kernel_env_locks
          WHERE name = ? AND revision = (
            SELECT lock_revision FROM kernel_env_setup_jobs WHERE id = ?
          )`,
        [name, job.id],
      );
      if (alreadyBound?.requested_packages === JSON.stringify(resolvedFrom)) {
        if (alreadyBound.lockfile !== lockfile) return undefined;
        return store.get(
          `SELECT lock_revision FROM kernel_env_setup_jobs WHERE id = ?`,
          [job.id],
        )!.lock_revision as number;
      }
      const revision = environmentStore(store).writeLock(name, lockfile, now, resolvedFrom);
      store.run(
        `UPDATE kernel_env_setup_jobs
            SET lock_revision = ?, resolved_from = ?, updated_ts = ?
          WHERE id = ? AND state IN ('requested', 'building')`,
        [revision, JSON.stringify(resolvedFrom), now, job.id],
      );
      return revision;
    });

  const completeReadyWithFollowup = (
    requestId: string,
    completedPackages: string[],
    targetInput: RequestPhysicalEnvironmentSetupJobInput | undefined,
    now: number,
    terminalOutcomeFingerprint?: string,
  ): {
    ready?: StoredEnvironmentSetupJob;
    target?: StoredEnvironmentSetupJob;
    created: boolean;
    moved: StoredEnvironmentSetupInterest[];
    capped: StoredEnvironmentSetupInterest[];
  } => store.tx(() => {
    if (
      terminalOutcomeFingerprint !== undefined &&
      !/^[a-f0-9]{64}$/.test(terminalOutcomeFingerprint)
    )
      throw new Error("terminal environment setup fingerprint must be a sha256 digest");
    const sourceRow = store.get(
      `UPDATE kernel_env_setup_jobs
          SET state = 'ready', error_summary = NULL, finished_ts = ?, updated_ts = ?
              ${terminalOutcomeFingerprint === undefined
                ? ""
                : ", terminal_outcome_fingerprint = ?"}
        WHERE request_id = ? AND state IN ('requested', 'building')
        RETURNING id, runtime_id, environment_name, round`,
      [
        now,
        now,
        ...(terminalOutcomeFingerprint === undefined ? [] : [terminalOutcomeFingerprint]),
        requestId,
      ],
    );
    if (!sourceRow)
      return { created: false, moved: [], capped: [] };
    const ready = jobById(store, sourceRow.id as string)!;
    const uncovered = uncoveredInterests(ready.id, completedPackages);
    const eligible = uncovered.filter(({ coverageRound }) => coverageRound < 4);
    const capped = uncovered.filter(({ coverageRound }) => coverageRound >= 4);
    if (eligible.length === 0 || !targetInput)
      return { ready, created: false, moved: [], capped };
    if (
      targetInput.runtimeId !== ready.machineId ||
      targetInput.environmentName !== ready.environmentName
    ) return { ready, created: false, moved: [], capped: uncovered };

    const active = store.get(
      `SELECT id, lock_revision, declaration_generation_id, declaration_created_ts, resolved_from
         FROM kernel_env_setup_jobs
        WHERE runtime_id = ? AND environment_name = ?
          AND state IN ('requested', 'building')`,
      [ready.machineId, ready.environmentName],
    );
    const resolvedJson = targetInput.resolvedFrom === undefined
      ? null
      : JSON.stringify(targetInput.resolvedFrom);
    let target: StoredEnvironmentSetupJob;
    let created = false;
    if (active) {
      if (
        active.lock_revision !== targetInput.lockRevision ||
        active.declaration_generation_id !== targetInput.declarationGenerationId ||
        active.resolved_from !== resolvedJson
      )
        return { ready, created: false, moved: [], capped: uncovered };
      target = jobById(store, active.id as string)!;
    } else {
      const seq = nextSeq(store);
      const id = `envjob_${seq}`;
      store.run(
        `INSERT INTO kernel_env_setup_jobs
           (id, runtime_id, environment_name, language, manager, lock_revision,
            declaration_generation_id, declaration_created_ts,
            request_id, previous_job_id, round, resolved_from, reason, state, stage,
            requested_ts, updated_ts, seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested', 'waiting-for-machine', ?, ?, ?)`,
        [
          id,
          targetInput.runtimeId,
          targetInput.environmentName,
          targetInput.language,
          targetInput.manager,
          targetInput.lockRevision,
          targetInput.declarationGenerationId,
          targetInput.declarationCreatedTs,
          targetInput.requestId,
          ready.id,
          Math.min(ready.round + 1, 4),
          resolvedJson,
          targetInput.reason ?? null,
          targetInput.requestedTs,
          targetInput.requestedTs,
          seq,
        ],
      );
      target = jobById(store, id)!;
      created = true;
    }
    const transferred = carryForwardUncovered(ready.id, target.id, completedPackages, now);
    return { ready, target, created, moved: transferred.interests, capped };
  });

  /**
   * Gives a still-running job the sentence it was started without, and only
   * that: a job that already carries one keeps it.
   *
   * For the caller that JOINS a build rather than starting one. A Setup press
   * carries no reason — the researcher is looking at the button they pressed —
   * so a job it started has NULL here; an agent's `manage_packages` add that
   * joins that job does have a sentence, and without this it would be dropped.
   * The reason a job carries is what `completeReadyWithFollowup` copies onto
   * the coverage round, and that round is the one whose rebuild restarts
   * kernels for the packages the add asked for. Left NULL, those kernels are
   * restarted announcing nothing.
   *
   * Never overwrites, because the job's existing sentence describes the build
   * that is actually running, and the command carrying it has already been
   * dispatched. The first sentence wins; a later one only fills a silence.
   */
  const nameReasonIfUnsaid = (jobId: string, reason: string, now: number): void => {
    store.run(
      `UPDATE kernel_env_setup_jobs
          SET reason = ?, updated_ts = ?
        WHERE id = ? AND reason IS NULL AND state IN ('requested', 'building')`,
      [reason, now, jobId],
    );
  };

  const appendDiagnostic = (requestId: string, line: string, now: number): boolean =>
    store.tx(() => {
      const row = store.get(
        `SELECT id, log FROM kernel_env_setup_jobs
          WHERE request_id = ? AND state IN ('requested', 'building')`,
        [requestId],
      );
      if (!row) return false;
      const bounded = boundedRedactedUtf8(
        line,
        ENVIRONMENT_SETUP_OUTCOME_LIMITS.errorBytes,
      );
      const existing = JSON.parse(row.log as string) as string[];
      if (existing.at(-1) === bounded) return true;
      const lines = [...existing, bounded].slice(-200);
      while (lines.length > 0 && Buffer.byteLength(JSON.stringify(lines), "utf8") > 65_536)
        lines.shift();
      store.run(`UPDATE kernel_env_setup_jobs SET log = ?, updated_ts = ? WHERE id = ?`, [
        JSON.stringify(lines), now, row.id,
      ]);
      return true;
    });

  const createSuggestionsForReadyJob = (
    jobId: string,
    now: number,
  ): EnvironmentDefaultSuggestion[] =>
    store.tx(() => {
      // Joined to the declaration, not merely read off the job. A job carries
      // the name it was requested for and goes on carrying it after the lab
      // deletes that declaration — so without this join a build that finishes
      // after a delete offers the Research a default naming an environment
      // nothing in this lab has, and accepting it writes a default no cell
      // could ever resolve. The delete path sweeps the defaults and questions
      // that exist when it runs (`forgetEnvironmentDefaults`); this is what
      // stops a new one being written afterwards.
      const job = store.get(
        `SELECT j.language, j.environment_name
           FROM kernel_env_setup_jobs j
           JOIN kernel_envs e ON e.name = j.environment_name
          WHERE j.id = ? AND j.state = 'ready'`,
        [jobId],
      );
      if (!job) return [];
      const interests = store.all(
        `SELECT study_id, task_id FROM kernel_env_setup_interests
          WHERE job_id = ? ORDER BY requested_ts ASC, task_id ASC`,
        [jobId],
      );
      const visited = new Set<string>();
      for (const interest of interests) {
        const studyId = interest.study_id as string;
        if (visited.has(studyId)) continue;
        visited.add(studyId);
        const hasDefault = store.get(
          `SELECT 1 AS found FROM research_environment_defaults
            WHERE study_id = ? AND language = ?`,
          [studyId, job.language],
        );
        const existing = store.get(
          `SELECT 1 AS found FROM environment_default_suggestions
            WHERE (study_id = ? AND language = ? AND state = 'pending')
               OR (job_id = ? AND study_id = ? AND language = ?)`,
          [studyId, job.language, jobId, studyId, job.language],
        );
        if (hasDefault || existing) continue;
        const seq = nextSeq(store);
        store.run(
          `INSERT INTO environment_default_suggestions
             (id, job_id, study_id, task_id, language, environment_name,
              state, created_ts, seq)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          [
            `suggest_${seq}`,
            jobId,
            studyId,
            interest.task_id,
            job.language,
            job.environment_name,
            now,
            seq,
          ],
        );
      }
      return store
        .all(
          `SELECT id, language, environment_name, state
             FROM environment_default_suggestions
            WHERE job_id = ? ORDER BY seq ASC`,
          [jobId],
        )
        .map(suggestionFromRow);
    });

  const answerSuggestion = (
    id: string,
    actorId: string,
    useByDefault: boolean,
    now: number,
  ): boolean =>
    store.tx(() => {
      const suggestion = store.get(
        `SELECT study_id, language, environment_name
           FROM environment_default_suggestions
          WHERE id = ? AND state = 'pending'`,
        [id],
      );
      if (!suggestion) return false;
      const updated = store.get(
        `UPDATE environment_default_suggestions
            SET state = ?, answered_ts = ?, answered_by = ?
          WHERE id = ? AND state = 'pending'
          RETURNING id`,
        [useByDefault ? "accepted" : "declined", now, actorId, id],
      );
      if (!updated) return false;
      if (useByDefault) {
        store.run(
          `INSERT INTO research_environment_defaults
           (study_id, language, environment_name, set_by, set_ts)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(study_id, language) DO UPDATE SET
           environment_name = excluded.environment_name,
           set_by = excluded.set_by,
           set_ts = excluded.set_ts`,
          [
            suggestion.study_id,
            suggestion.language,
            suggestion.environment_name,
            actorId,
            now,
          ],
        );
      }
      return true;
    });

  const defaultsForResearch = (researchId: string): ResearchEnvironmentDefault[] =>
    store
      .all(
        `SELECT language, environment_name, set_by, set_ts
           FROM research_environment_defaults
          WHERE study_id = ? ORDER BY language ASC`,
        [researchId],
      )
      .map((row) => ({
        language: row.language as Language,
        environmentName: row.environment_name as string,
        setBy: row.set_by as string,
        setTs: row.set_ts as number,
      }));

  const environmentGrantsForSession = (sessionId: string): string[] =>
    store
      .all(
        `SELECT target FROM session_permission_grants
          WHERE session_id = ? AND capability = 'environment-mutation'
          ORDER BY granted_ts ASC, target ASC`,
        [sessionId],
      )
      .map(({ target }) => target as string);

  const rememberEnvironmentGrant = (
    sessionId: string,
    target: string,
    actorId: string,
    now: number,
  ): void => {
    store.run(
      `INSERT OR IGNORE INTO session_permission_grants
         (session_id, capability, target, granted_by, granted_ts)
       VALUES (?, 'environment-mutation', ?, ?, ?)`,
      [sessionId, target, actorId, now],
    );
  };

  /** Everything this lab recorded about one environment being somewhere a
   *  cell lands by default: the confirmed defaults naming it, and the
   *  questions still outstanding about whether it should be one.
   *
   *  Its own operation, separate from the waiter cancellation that
   *  `cancelForEnvironment` wraps around it, because the two are different
   *  decisions with different costs. Forgetting a default is complete in
   *  this table: nothing else in the lab holds one, and a default naming an environment the lab no longer
   *  declares could never resolve. Cancelling a waiter is not — a `queued`
   *  waiter owns a durable continuation turn and a run already dispatched to
   *  a machine, and marking it cancelled here without finishing that turn and
   *  recalling that run leaves both of them going. A caller that wants only
   *  the first must be able to ask for only the first. */
  const forgetEnvironmentDefaults = (name: string): void => {
    store.tx(() => {
      store.run(`DELETE FROM research_environment_defaults WHERE environment_name = ?`, [name]);
      // Pending alone. An accepted or declined suggestion is a record of what
      // somebody was asked and what they said, and deleting an environment
      // does not un-ask it.
      store.run(
        `DELETE FROM environment_default_suggestions
          WHERE environment_name = ? AND state = 'pending'`,
        [name],
      );
    });
  };

  /** Returns exactly the waiters this call cancelled, so the coordinator
   *  above can finish the continuation turn each `queued` one owns and recall
   *  the run already dispatched for it. A caller handed nothing back could
   *  only guess which of them had one. */
  const cancelForEnvironment = (
    name: string,
    now: number,
  ): StoredEnvironmentSetupWaiter[] =>
    store.tx(() => {
      const cancelled = store
        .all(
          `UPDATE task_env_setup_waiters
              SET state = 'cancelled', cancelled_reason = 'environment-deleted', updated_ts = ?
            WHERE environment_name = ? AND state IN ('waiting', 'queued')
            RETURNING *`,
          [now, name],
        )
        .map(waiterFromRow);
      forgetEnvironmentDefaults(name);
      return cancelled;
    });

  /** Every waiter that names one turn — as the source that recorded the
   *  requirement, or as the continuation minted to answer it — removed, and
   *  handed back the way `cancelForEnvironment` hands its own back, so the
   *  coordinator above can finish any continuation turn still live and recall
   *  the run already dispatched for it.
   *
   *  Removed rather than cancelled, and that is the whole of why this exists
   *  beside the cancels. `source_turn_id` and `continuation_turn_id` both
   *  reference `turns(id)` with no `ON DELETE`, and `PRAGMA foreign_keys` is
   *  on — so a waiter left standing, in ANY state, is what stops the turn it
   *  names from being deleted at all. Nothing else deletes a waiter row: every
   *  other path transitions `state`, `cancelled` and `resumed` included.
   *  Nulling is not available either — `source_turn_id` is `NOT NULL`, and a
   *  `queued` waiter with no continuation is a shape nothing in this lab can
   *  settle. Discarding the turn that asked is exactly what reverting it
   *  means, so the requirement recorded against it goes with it rather than
   *  outliving the turn nobody can read any more. */
  const removeForTurn = (turnId: string): StoredEnvironmentSetupWaiter[] =>
    store.tx(() => {
      const doomed = store
        .all(
          `SELECT * FROM task_env_setup_waiters
            WHERE source_turn_id = ? OR continuation_turn_id = ?
            ORDER BY seq ASC`,
          [turnId, turnId],
        )
        .map(waiterFromRow);
      store.run(
        `DELETE FROM task_env_setup_waiters
          WHERE source_turn_id = ? OR continuation_turn_id = ?`,
        [turnId, turnId],
      );
      return doomed;
    });

  return {
    recordRequirement,
    attachRequirements,
    requestJob,
    requestPhysicalJob(input: RequestPhysicalEnvironmentSetupJobInput) {
      return store.tx(() => requestPhysicalJob(input));
    },
    job(jobId: string) {
      return jobById(store, jobId);
    },
    nonterminalJobs() {
      return store
        .all(
          `SELECT j.*, r.name AS machine_name
             FROM kernel_env_setup_jobs j
             JOIN runtimes r ON r.id = j.runtime_id
            WHERE j.state IN ('requested', 'building')
            ORDER BY j.seq ASC`,
        )
        .map(jobFromRow);
    },
    readyJobIdsWithWaitingWaiters() {
      return store
        .all(
          `SELECT DISTINCT j.id
             FROM kernel_env_setup_jobs j
             JOIN task_env_setup_waiters w ON w.job_id = j.id
            WHERE j.state = 'ready' AND w.state = 'waiting'
            ORDER BY j.seq ASC`,
        )
        .map(({ id }) => id as string);
    },
    queuedWaiters() {
      return store
        .all(
          `SELECT * FROM task_env_setup_waiters
            WHERE state = 'queued' AND continuation_turn_id IS NOT NULL
            ORDER BY seq ASC`,
        )
        .map(waiterFromRow);
    },
    waiter(waiterId: string) {
      const row = store.get(`SELECT * FROM task_env_setup_waiters WHERE id = ?`, [waiterId]);
      return row ? waiterFromRow(row) : undefined;
    },
    forTask,
    jobByRequest,
    markProgress,
    markReady(requestId: string, now: number, terminalOutcomeFingerprint?: string) {
      return markTerminal(requestId, "ready", undefined, now, terminalOutcomeFingerprint);
    },
    markFailed(
      requestId: string,
      summary: string,
      now: number,
      terminalOutcomeFingerprint?: string,
    ) {
      return markTerminal(
        requestId,
        "failed",
        boundedRedactedUtf8(summary, ENVIRONMENT_SETUP_OUTCOME_LIMITS.errorBytes),
        now,
        terminalOutcomeFingerprint,
      );
    },
    waitingForJob,
    queueWaiter,
    markWaiterResumed,
    cancelQueuedWaiterForContinuation,
    cancelPendingForTask,
    cancelWaiter,
    reattachWaiter,
    uncoveredInterests,
    carryForwardUncovered,
    bindResolvedLock,
    completeReadyWithFollowup,
    nameReasonIfUnsaid,
    appendDiagnostic,
    cancelForEnvironment,
    removeForTurn,
    forgetEnvironmentDefaults,
    createSuggestionsForReadyJob,
    answerSuggestion,
    defaultsForResearch,
    environmentGrantsForSession,
    rememberEnvironmentGrant,
  };
}
