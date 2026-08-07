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
export * from "./conversation";
export * from "./run";
export * from "./review";
export * from "./customization";
export * from "./method-skills";
export * from "./workflow-catalogue";
export * from "./workflow-catalogue";
export * from "./artifact";
export * from "./runtime";
export * from "./agent-cli";
export * from "./research-group";
export * from "./account";
export * from "./usage";
export * from "./settings";
export * from "./http";
export {
  createInMemoryApi,
  createInMemoryLab,
  curatedCatalog,
  defaultSeed,
  emptySeed,
  fixtureArtifacts,
  type InMemoryApiOptions,
  type InMemoryLab,
} from "./memory";

/** Registered core commands, by UI-facing name. */
export const Commands = {
  coreInfo: "core_info",
  listStudies: "list_studies",
  getStudy: "get_study",
  createStudy: "create_study",
  updateStudy: "update_study",
  archiveStudy: "archive_study",
  restoreStudy: "restore_study",
  deleteStudy: "delete_study",
  listTasks: "list_tasks",
  createTask: "create_task",
  updateTask: "update_task",
  deleteTask: "delete_task",
  getTask: "get_task",
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
  listWorkflows: "list_workflows",
  upsertWorkflow: "upsert_workflow",
  runWorkflow: "run_workflow",
  listConnectors: "list_connectors",
  addConnector: "add_connector",
  setConnectorEnabled: "set_connector_enabled",
  setConnectorSkipApprovals: "set_connector_skip_approvals",
  connectorCatalog: "connector_catalog",
  listConnectorTools: "list_connector_tools",
  readArtifact: "read_artifact",
  listRuntimes: "list_runtimes",
  pairMachine: "pair_machine",
  removeRuntime: "remove_runtime",
  kernelEnvStatus: "kernel_env_status",
  kernelEnvList: "kernel_env_list",
  kernelEnvSetup: "kernel_env_setup",
  kernelStatus: "kernel_status",
  kernelDocument: "kernel_document",
  kernelExecute: "kernel_execute",
  kernelInterrupt: "kernel_interrupt",
  kernelRestart: "kernel_restart",
  listAgentClis: "list_agent_clis",
  runHistory: "run_history",
  listResearchGroups: "list_research_groups",
  createResearchGroup: "create_research_group",
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

/** The event channel carrying managed-env provisioning progress: one
 * `uv` output line (a string) per payload, for the Setup UI. */
export const KERNEL_SETUP_CHANNEL = "lykeion://kernel-setup";

export type CommandName = (typeof Commands)[keyof typeof Commands];
