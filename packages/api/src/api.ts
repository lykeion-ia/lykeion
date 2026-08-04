/**
 * The data layer the UI programs against.
 *
 * Screens depend on this interface and nothing else, which is what keeps the
 * UI independent of where its data actually comes from. `InMemoryApi` in
 * `./memory` is the implementation that ships with it.
 */

import type {
  Assignee,
  CoreInfo,
  Priority,
  Stage,
  Study,
  StudyDetail,
  Subtask,
  Task,
  TaskStatus,
} from "./types";
import type {
  Conversation,
  ConversationDetail,
  ConversationSummary,
  Message,
  NewConversation,
} from "./conversation";
import type {
  DelegateSubagentInput,
  RunHandle,
  RunSummary,
  StartRunInput,
  TaskDetail,
} from "./run";
import type { Finding } from "./review";
import type { ArtifactBlob } from "./artifact";
import type {
  Runtime,
  KernelEnvStatus,
  Language,
  NotebookCell,
  NotebookStatus,
} from "./runtime";
import type { AgentCli } from "./agent-cli";
import type {
  Agent,
  CatalogEntry,
  Connector,
  McpTool,
  Skill,
  SkillEntry,
  Workflow,
} from "./customization";
import type { ResearchGroup } from "./research-group";
import type { Invite, Member, Role, User } from "./account";
import type { Usage } from "./usage";
import type { WorkspaceSettings } from "./settings";

/** Fields accepted when creating a Study. */
export interface NewStudy {
  title: string;
  key: string;
  description?: string;
  /** Context injected into every agent's system prompt for this Study. */
  agentContext?: string;
}

/** Fields accepted when creating a Task. */
export interface NewTask {
  /** Omit to capture an unfiled Task — one that belongs to no Study yet. */
  studyId?: string;
  stage: Stage;
  title: string;
  description?: string;
  priority?: Priority;
  /** Who to put it on. Omit for an unassigned Task. */
  assignees?: Assignee[];
}

/** Fields accepted when creating a Research Group. */
export interface NewResearchGroup {
  name: string;
  description?: string;
  leadAgent?: string;
  memberAgents?: string[];
}

/** Fields accepted when approving a machine to pair with the lab. */
export interface PairMachineInput {
  /** What to call the machine. Need not be unique — a member may
   *  reasonably have two machines called "laptop"; the id distinguishes them. */
  name: string;
  platform: string;
  daemonVersion: string;
  /** `base64url(sha256(verifier))`, checked when the code is exchanged. */
  challenge: string;
  /** Where the approving browser should send the code. Loopback only. */
  redirect: string;
}

/**
 * Patch applied to a Study (absent fields unchanged). `key` is not editable: it
 * is the Study's stable short identifier and is baked into its on-disk
 * directory name at creation.
 */
export interface StudyPatch {
  /** Must not be blank — the core rejects it. */
  title?: string;
  /**
   * What the Study is about, for whoever reads the list. An empty string
   * clears it.
   */
  description?: string;
  /**
   * Context injected into every agent's system prompt for this Study. An empty
   * string clears it.
   */
  agentContext?: string;
  /**
   * Pin the Study to the top of the list, or unpin it. `false` clears the flag
   * rather than storing one — see {@link Study.pinned}.
   */
  pinned?: boolean;
}

/**
 * Patch applied to a Task. For collection fields, passing an array replaces the
 * whole collection (an empty array clears it); omitting leaves it unchanged.
 * `targetDate: null` clears the due date.
 */
export interface TaskPatch {
  title?: string;
  description?: string;
  /**
   * File an unfiled Task into a Study, or move it between Studies. There is no
   * un-filing: a Task that has a Study keeps one.
   */
  studyId?: string;
  stage?: Stage;
  status?: TaskStatus;
  priority?: Priority;
  assignees?: Assignee[];
  targetDate?: string | null;
  labels?: string[];
  links?: string[];
  subtasks?: Subtask[];
  /** Pinned to the top of the Study's Task list. Presentation only. */
  pinned?: boolean;
}

/** The workbench data API. All methods are async — the real impl is IPC. */
export interface LykeionApi {
  coreInfo(): Promise<CoreInfo>;

  /** Studies, newest first. Archived ones are excluded unless asked for. */
  listStudies(options?: { includeArchived?: boolean }): Promise<Study[]>;
  getStudy(studyId: string): Promise<StudyDetail>;
  createStudy(input: NewStudy): Promise<Study>;
  /** Rename a Study (title only; the `key` badge never changes). */
  updateStudy(studyId: string, patch: StudyPatch): Promise<Study>;
  /**
   * Tidy the Study list without losing anything. `getStudy` still resolves.
   * Archiving a Study that is already archived is not an error: it stays
   * archived. Only an unknown id rejects.
   */
  archiveStudy(studyId: string): Promise<Study>;
  /**
   * Put an archived Study back in the list. Restoring a Study that was never
   * archived is not an error: it stays listed. Only an unknown id rejects.
   */
  restoreStudy(studyId: string): Promise<Study>;
  /**
   * Delete a Study: it leaves the registry and no longer lists or opens,
   * taking every Task and every Task's transcript with it. This is final —
   * nothing about it is recoverable from inside the workbench, and no
   * surface may offer recovery. Archive is the reversible operation.
   */
  deleteStudy(studyId: string): Promise<void>;

  /**
   * Every Task in the Lab, across Studies — mine and everyone else's — plus
   * the unfiled ones that belong to no Study. Done Tasks are excluded unless
   * asked for.
   *
   * Ordered by task number ascending, for the reason `myWork` is: numbers are
   * the run a reader scans a Study's tasks by, so two Studies' work interleaves
   * by number rather than by whichever Study happens to be stored first.
   * Unfiled Tasks number on their own run, so they sort after the filed ones
   * instead of interleaving two unrelated sequences.
   *
   * Deliberately not ordered by recency: a core that stamps a batch of Tasks
   * with one clock reading could not honour that, and every caller that wants
   * recency has `updatedTs` to sort on.
   */
  listTasks(options?: { includeDone?: boolean }): Promise<Task[]>;
  createTask(input: NewTask): Promise<Task>;
  updateTask(taskId: string, patch: TaskPatch): Promise<Task>;
  /** Permanently delete a Task (tombstoned in the core's event log). */
  deleteTask(taskId: string): Promise<void>;
  /**
   * One Task with its full transcript, turns ascending by ts. Takes no
   * `studyId`: task ids are unique across the workspace, and an unfiled Task
   * has no Study to name.
   */
  getTask(taskId: string): Promise<TaskDetail>;

  /**
   * The Conversations the current member is in — threads about a Task, held
   * with colleagues and agents — most recent activity first. This is what the
   * Inbox lists.
   *
   * Summaries, not full threads: a list that carried every message of every
   * thread would read the whole workspace's talk to draw twenty rows.
   */
  listConversations(): Promise<ConversationSummary[]>;
  /** One Conversation with its full message history, oldest first. */
  getConversation(conversationId: string): Promise<ConversationDetail>;
  /**
   * Open a thread about a Task. The opening `body` is posted as its first
   * message, and the caller is added to `participants` whether or not they
   * named themselves — nobody opens a thread they are not in.
   */
  createConversation(input: NewConversation): Promise<Conversation>;
  /** Say something, as the current member. Returns the stored message. */
  postMessage(conversationId: string, body: string): Promise<Message>;
  /**
   * Zero the current member's unread count for a thread. Idempotent: marking
   * an already-read Conversation read is not an error. Only an unknown id
   * rejects.
   */
  markConversationRead(conversationId: string): Promise<void>;
  /**
   * Tasks assigned to the current member, across studies, excluding the ones
   * already done. Ordered by task number ascending — the same run of numbers
   * a reader scans a Study's tasks by, so two studies' work interleaves by
   * number rather than by whichever study happens to be stored first.
   */
  myWork(): Promise<Task[]>;

  /** Compute runtimes registered with the core (empty on a fresh install). */
  listRuntimes(): Promise<Runtime[]>;

  /**
   * Approve a machine, on behalf of the member calling. Returns a one-time
   * code, good for five minutes, that the machine exchanges for its token.
   * Refuses a `redirect` that is not loopback: a crafted link must fail to
   * mint a code at all rather than rely on a screen declining to follow it.
   */
  pairMachine(input: PairMachineInput): Promise<{ code: string }>;

  /** Unpair a machine and revoke its token. The owning member only. */
  removeRuntime(runtimeId: string): Promise<void>;

  /**
   * Provisioning status of Lykeion's own managed Python environment. `absent`
   * on a fresh install (nothing is faked); a real implementation would report
   * the actual on-disk state. Surfaced on the Runtimes screen.
   */
  kernelEnvStatus(): Promise<KernelEnvStatus>;

  /**
   * Every managed Python environment under `runtime/envs` (empty on a fresh
   * install — nothing is faked). Surfaced on the Runtimes screen alongside
   * the single-env `kernelEnvStatus`.
   */
  kernelEnvList(): Promise<KernelEnvStatus[]>;

  /**
   * Provision the named managed environment (uv venv + the scientific base
   * for `"python"`; the R toolchain for `"r"`). `name` defaults to
   * `"python"` when omitted. Long-running on first install; progress lines
   * stream on `KERNEL_SETUP_CHANNEL`. Resolves to the final status.
   * `onProgress`, when given, receives each output line directly; the
   * in-memory implementation calls it straight away rather than routing it
   * through the channel.
   */
  kernelEnvSetup(
    name?: string,
    onProgress?: (line: string) => void,
  ): Promise<KernelEnvStatus>;

  /**
   * The Study kernel's live status for the Notebook strip. Never launches a
   * kernel — a status read must not spin an interpreter up. `language`
   * defaults to `"python"` when omitted.
   */
  kernelStatus(studyId: string, language?: Language): Promise<NotebookStatus>;

  /**
   * The Study notebook document — every kernel cell (agent `run_python` +
   * researcher REPL) in execution order, for the Notebook code view. Not
   * language-scoped: each cell already carries its own `language`.
   */
  kernelDocument(studyId: string): Promise<NotebookCell[]>;

  /**
   * Run one REPL cell on the Study's shared kernel and return the executed
   * cell. Blocks until the cell completes; `kernelInterrupt` still lands.
   * `language` defaults to `"python"` when omitted.
   */
  kernelExecute(
    studyId: string,
    code: string,
    language?: Language,
  ): Promise<NotebookCell>;

  /**
   * Interrupt the Study kernel's running cell (SIGINT). A no-op when idle.
   * `language` defaults to `"python"` when omitted.
   */
  kernelInterrupt(studyId: string, language?: Language): Promise<void>;

  /**
   * Restart the Study kernel into a fresh namespace (the counter resets to 0;
   * every variable — the agent's included — is gone). Returns the new
   * status. `language` defaults to `"python"` when omitted.
   */
  kernelRestart(studyId: string, language?: Language): Promise<NotebookStatus>;

  /**
   * Coding-agent CLIs detected on this machine — the ACP backends a run can be
   * routed to. Empty when none are installed. Never seeded.
   */
  listAgentClis(): Promise<AgentCli[]>;

  /**
   * Past runs on a Task — one entry per turn in its chat. Empty until run
   * history is persisted and surfaced.
   */
  runHistory(taskId: string): Promise<RunSummary[]>;

  /**
   * Start an agent turn on a Task. Returns a live handle: subscribe with
   * `onEvent` to watch plan → approve → execute and the provenance fill in,
   * answer plan/permission prompts with `submit`.
   */
  startRun(input: StartRunInput): Promise<RunHandle>;

  /**
   * Delegate a scoped sub-task to a subagent (an Agent persona) as an isolated
   * child run. Returns a live `RunHandle` streaming the child's events; the
   * completed run yields a `SubagentResult`. A subagent turn nests inside its
   * parent Task's transcript; it is not a Task of its own.
   */
  delegateSubagent(input: DelegateSubagentInput): Promise<RunHandle>;

  /**
   * Read a saved artifact's bytes as a typed blob for the viewers. Text
   * arrives UTF-8, binary as base64; the UI dispatches on `contentType`.
   */
  readArtifact(studyId: string, path: string): Promise<ArtifactBlob>;

  /** The Reviewer's persisted findings for a Task, severity-ordered. */
  reviewFindings(studyId: string, taskId: string): Promise<Finding[]>;
  /** Mark one finding resolved; returns the updated finding list. */
  resolveFinding(
    studyId: string,
    taskId: string,
    findingId: string,
  ): Promise<Finding[]>;

  // ---- customization engine ----

  /** Every Skill in the Lab (enabled and disabled), name-sorted. */
  listSkills(): Promise<SkillEntry[]>;
  /** Create a new (enabled) Skill. */
  createSkill(skill: Skill): Promise<void>;
  /** Enable or disable a Skill by name. */
  setSkillEnabled(name: string, enabled: boolean): Promise<void>;

  /** Every Agent persona in the Lab, name-sorted. */
  listAgents(): Promise<Agent[]>;
  /** Create or replace an Agent (keyed by name). */
  upsertAgent(agent: Agent): Promise<void>;

  /** Every Workflow template in the Lab, id-sorted. */
  listWorkflows(): Promise<Workflow[]>;
  /** Create or replace a Workflow (keyed by id). */
  upsertWorkflow(workflow: Workflow): Promise<void>;
  /**
   * "Run" a Workflow: expand its prompt template with `values` and return the
   * filled prompt. A missing required placeholder (with no default) rejects.
   */
  runWorkflow(id: string, values: Record<string, string>): Promise<string>;

  /** Every attached Connector in the Lab, name-sorted. */
  listConnectors(): Promise<Connector[]>;
  /** Attach a Connector (an MCP server config). */
  addConnector(connector: Connector): Promise<void>;
  /** Enable or disable a Connector by name. */
  setConnectorEnabled(name: string, enabled: boolean): Promise<void>;
  /** Set a Connector's skip-approvals flag by name. */
  setConnectorSkipApprovals(name: string, skip: boolean): Promise<void>;
  /** The built-in curated catalog of scientific-database connectors. */
  connectorCatalog(): Promise<CatalogEntry[]>;
  /**
   * Discover a named Connector's tools via MCP `tools/list` (stdio only for
   * now). Discovery only — never calls a tool.
   */
  listConnectorTools(name: string): Promise<McpTool[]>;

  // ---- research groups ----

  /** Every Research Group, newest first (empty on a fresh install). */
  listResearchGroups(): Promise<ResearchGroup[]>;
  /** Create a Research Group; returns the created group. */
  createResearchGroup(input: NewResearchGroup): Promise<ResearchGroup>;

  // ---- account ----

  /** The signed-in user's identity: the `User` for whichever lab member is
   *  currently signed in. */
  currentUser(): Promise<User>;
  /**
   * Set the signed-in member's profile picture, or clear it with `null`.
   *
   * `dataUrl` must satisfy `assertAvatarDataUrl`. Personal the way `setTheme`
   * is — nobody sets anyone else's — but unlike the theme it is part of the
   * identity the rest of the lab sees, so it lands on the `User` every roster
   * and every avatar already reads rather than in a private settings bag.
   */
  setAvatar(dataUrl: string | null): Promise<void>;
  /** Every member, offboarded ones included, joined-date ascending. */
  listMembers(): Promise<Member[]>;
  /** Mint a redeemable invite. Owner only. */
  createInvite(role: Role): Promise<Invite>;
  /** Every minted invite that has not been revoked. Owner only. */
  listInvites(): Promise<Invite[]>;
  /** Withdraw an unredeemed invite. Owner only. */
  revokeInvite(code: string): Promise<void>;
  /**
   * Offboard a member: they can no longer sign in, and everything they
   * authored stays attributable to them. Owner only.
   */
  removeMember(userId: string): Promise<void>;

  // ---- usage & settings ----

  /** Workspace usage analytics (empty on a fresh install). */
  usage(): Promise<Usage>;
  /** Workspace settings — neutral defaults, no illustrative account details.
   *  Every field but `theme` is decorative; `theme` is really written by
   *  `setTheme` and read back here. */
  getSettings(): Promise<WorkspaceSettings>;
  /** Persist the active color theme id — one of the ids the theme picker
   *  offers. Personal to the signed-in member, not the lab's. */
  setTheme(theme: string): Promise<void>;
}
