import type { KernelEnvManager, Language } from "./machine";

export type EnvironmentSetupStage =
  | "waiting-for-machine"
  | "resolving"
  | "installing"
  | "finalizing";

export type EnvironmentSetupJobState = "requested" | "building" | "ready" | "failed";
export type EnvironmentSetupWaiterState = "waiting" | "queued" | "resumed" | "cancelled";

export interface ResearchEnvironmentDefault {
  language: Language;
  environmentName: string;
  setBy: string;
  setTs: number;
}

export interface EnvironmentSetupJob {
  id: string;
  machineId: string;
  machineName: string;
  environmentName: string;
  language: Language;
  manager: KernelEnvManager;
  lockRevision: number;
  /** Exact declaration generation this durable build targets. Absent only
   *  on pre-migration historical rows that cannot prove that identity. */
  declarationGenerationId?: string;
  /** Legacy evidence only; never authoritative for readiness. */
  declarationCreatedTs?: number;
  state: EnvironmentSetupJobState;
  stage: EnvironmentSetupStage;
  requestedTs: number;
  startedTs?: number;
  finishedTs?: number;
  updatedTs: number;
  errorSummary?: string;
  log: string[];
}

export interface EnvironmentSetupWaiter {
  id: string;
  sourceRunId: string;
  sourceTurnId: string;
  state: EnvironmentSetupWaiterState;
  continuationTurnId?: string;
  cancelledReason?:
    | "superseded-by-user-turn"
    | "task-deleted"
    | "environment-deleted"
    | "continuation-ended-before-start";
}

export interface EnvironmentDefaultSuggestion {
  id: string;
  language: Language;
  environmentName: string;
  state: "pending" | "accepted" | "declined";
}

export interface TaskEnvironmentSetup {
  job: EnvironmentSetupJob;
  waiter?: EnvironmentSetupWaiter;
  suggestion?: EnvironmentDefaultSuggestion;
}

export interface RequestKernelEnvironmentSetupInput {
  taskId: string;
  machineId: string;
  environmentName: string;
  sourceRunId?: string;
}

export interface RequestKernelEnvironmentSetupResult {
  jobId: string;
  waiterId?: string;
}
