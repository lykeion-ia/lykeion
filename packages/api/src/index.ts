/**
 * The typed data contract the UI programs against.
 *
 * `LykeionApi` is the interface every screen depends on; `Commands` names the
 * operations it exposes. The in-memory implementation in `./memory` satisfies
 * the contract in full, which is what makes the UI runnable on its own.
 */

export * from "./types";
export * from "./errors";
export * from "./api";
export * from "./task-title";
export * from "./conversation";
export * from "./run";
export * from "./review";
export * from "./customization";
export * from "./method-skills";
export * from "./artifact";
export * from "./machine";
export * from "./agent-cli";
export * from "./group";
export * from "./account";
export * from "./usage";
export * from "./settings";
export * from "./http";
export * from "./provenance";
export * from "./environment-setup";
export * from "./environment-setup-outcome";
// Also its own entry point, `@lykeion/api/routes`, so that the daemon can read
// the register without pulling in the rest of this package to get it.
export * from "./routes";
// Same arrangement, for the same reason: the daemon mints these blobs and the
// UI reads them, and an encoder and a decoder in two packages drift.
export * from "./pair-code";
export {
  createInMemoryApi,
  createInMemoryLab,
  curatedCatalog,
  defaultSeed,
  emptySeed,
  fixtureArtifacts,
  type InMemoryApiOptions,
  type InMemoryLab,
  type Seed,
} from "./memory";

/** Registered core commands, by UI-facing name. */
export const Commands = {
  coreInfo: "core_info",
  listResearches: "list_researches",
  getResearch: "get_research",
  createResearch: "create_research",
  updateResearch: "update_research",
  archiveResearch: "archive_research",
  restoreResearch: "restore_research",
  deleteResearch: "delete_research",
  listTasks: "list_tasks",
  createTask: "create_task",
  updateTask: "update_task",
  deleteTask: "delete_task",
  getTask: "get_task",
  nameTask: "name_task",
  listConversations: "list_conversations",
  getConversation: "get_conversation",
  createConversation: "create_conversation",
  postMessage: "post_message",
  markConversationRead: "mark_conversation_read",
  myWork: "my_work",
  startRun: "start_run",
  resumeRuns: "resume_runs",
  delegateSubagent: "delegate_subagent",
  submitRunDecision: "submit_run_decision",
  revertTurn: "revert_turn",
  reviewFindings: "review_findings",
  resolveFinding: "resolve_finding",
  listSkills: "list_skills",
  createSkill: "create_skill",
  setSkillEnabled: "set_skill_enabled",
  listAgents: "list_agents",
  upsertAgent: "upsert_agent",
  listConnectors: "list_connectors",
  addConnector: "add_connector",
  setConnectorEnabled: "set_connector_enabled",
  setConnectorSkipApprovals: "set_connector_skip_approvals",
  connectorCatalog: "connector_catalog",
  listConnectorTools: "list_connector_tools",
  readArtifact: "read_artifact",
  listMachines: "list_machines",
  pairMachine: "pair_machine",
  removeMachine: "remove_machine",
  kernelEnvList: "kernel_env_list",
  requestKernelEnvironmentSetup: "request_kernel_environment_setup",
  taskEnvironmentSetups: "task_environment_setups",
  retryKernelEnvironmentSetup: "retry_kernel_environment_setup",
  answerEnvironmentDefaultSuggestion: "answer_environment_default_suggestion",
  kernelEnvReclaim: "kernel_env_reclaim",
  kernelEnvCreate: "kernel_env_create",
  kernelEnvDelete: "kernel_env_delete",
  listRunningKernels: "list_running_kernels",
  computeSnapshot: "compute_snapshot",
  taskNotebook: "task_notebook",
  cellProvenance: "cell_provenance",
  cellsForToolUse: "cells_for_tool_use",
  kernelExecute: "kernel_execute",
  kernelInterrupt: "kernel_interrupt",
  kernelStop: "kernel_stop",
  kernelRestart: "kernel_restart",
  listAgentClis: "list_agent_clis",
  runHistory: "run_history",
  listGroups: "list_groups",
  createGroup: "create_group",
  currentUser: "current_user",
  setAvatar: "set_avatar",
  listMembers: "list_members",
  createInvite: "create_invite",
  listInvites: "list_invites",
  revokeInvite: "revoke_invite",
  removeMember: "remove_member",
  usage: "usage",
  getSettings: "get_settings",
  setTheme: "set_theme",
} as const;

/** The event channel carrying `{ runId, event: RunEvent }` payloads. */
export { MAX_TURNS_OUTSTANDING } from "./run";

export const RUN_EVENT_CHANNEL = "lykeion://run-event";

export type CommandName = (typeof Commands)[keyof typeof Commands];
