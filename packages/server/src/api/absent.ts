import { LykeionError, type LykeionApi } from "@lykeion/api";
import type { Deps } from "./index";


/** What every kernel and run method answers with until a machine is
 *  actually connected to a machine — the one failure no request to this
 *  server, on its own, can ever work around. Exported for the one family
 *  that has to choose between this reason and a truer one: `kernelsApi`
 *  gives a kernel command this refusal only after looking at the machines
 *  table and finding nothing online. */
export const NO_MACHINE =
  "no machine is connected to this lab — install the Lykeion daemon on the machine you want to run on.";

/**
 * Every method `LykeionApi` declares that nothing yet writes to or reads
 * from durable storage. `coreInfo`, `currentUser` and `listMembers` are
 * excluded on purpose: something else in the composition root already
 * answers them, and folding them in here would let this file quietly grow a
 * second, stale answer for one of them. Every Research and Task method is
 * excluded for the same reason — `researchesApi` and `tasksApi` own those, with
 * `nameTask` belonging to `taskNamingApi`, and
 * so are the invite, offboarding and settings methods — `accountApi` and
 * `settingsApi` own those — and so are the customization-engine and
 * group methods, which `configSurfaceApi` owns, and so are pairing
 * and the machine list, which `machinesApi` owns, and so are `startRun`,
 * `submitRunDecision` and `runHistory`, which `sessionsApi` owns, and so are
 * the kernel and notebook methods, which `kernelsApi` owns, and so are the
 * environment-declaration methods, which `environmentsApi` owns. The
 * conversation methods are the ones in that neighbourhood answered here:
 * nothing yet stores a thread or a message.
 *
 * A list method has nothing to list, so it answers honestly with `[]`
 * rather than inventing content. A method addressed by an id has nothing to
 * find, so it answers `not-found`, naming the id it was asked for. A
 * method that would create
 * or persist something has no writer behind it yet, so it answers
 * `unsupported`, naming what is missing.
 */
export function absentApi(
  _deps: Deps,
): Omit<
  LykeionApi,
  | "coreInfo" | "currentUser" | "setAvatar" | "listMembers"
  | "listResearches" | "getResearch" | "createResearch" | "updateResearch"
  | "archiveResearch" | "restoreResearch" | "deleteResearch"
  | "listTasks" | "createTask" | "updateTask" | "deleteTask" | "getTask" | "myWork"
  | "nameTask"
  | "createInvite" | "listInvites" | "revokeInvite" | "removeMember"
  | "getSettings" | "setTheme"
  | "listSkills" | "createSkill" | "setSkillEnabled"
  | "listAgents" | "upsertAgent"
  | "listConnectors" | "addConnector" | "setConnectorEnabled" | "setConnectorSkipApprovals"
  | "connectorCatalog" | "listConnectorTools"
  | "listGroups" | "createGroup"
  | "listMachines" | "listAgentClis" | "pairMachine" | "removeMachine"
  | "startRun" | "submitRunDecision" | "runHistory" | "revertTurn"
  | "listRunningKernels" | "computeSnapshot" | "taskNotebook" | "cellProvenance" | "cellsForToolUse" | "kernelExecute" | "kernelInterrupt" | "kernelStop" | "kernelRestart"
  | "kernelEnvReclaim" | "kernelEnvCreate" | "kernelEnvDelete"
> {
  return {
    async listConversations() {
      return [];
    },
    async getConversation(conversationId: string) {
      throw new LykeionError(
        "not-found",
        `no such conversation: ${conversationId}`,
      );
    },
    async createConversation() {
      throw new LykeionError(
        "unsupported",
        "this lab cannot hold conversations yet — no message store is connected to it.",
      );
    },
    async postMessage() {
      throw new LykeionError(
        "unsupported",
        "this lab cannot hold conversations yet — no message store is connected to it.",
      );
    },
    async markConversationRead() {
      throw new LykeionError(
        "unsupported",
        "this lab cannot hold conversations yet — no message store is connected to it.",
      );
    },

    async kernelEnvList() {
      return [];
    },
    async requestKernelEnvironmentSetup() {
      throw new LykeionError(
        "unsupported",
        "this lab cannot provision software",
      );
    },
    async taskEnvironmentSetups() {
      return [];
    },
    async retryKernelEnvironmentSetup() {
      throw new LykeionError(
        "unsupported",
        "this lab cannot provision software",
      );
    },
    async answerEnvironmentDefaultSuggestion(suggestionId) {
      throw new LykeionError(
        "not-found",
        `no such environment default suggestion: ${suggestionId}`,
      );
    },

    async delegateSubagent(_input) {
      throw new LykeionError("unsupported", NO_MACHINE);
    },
    async resumeRuns(_taskId) {
      return [];
    },
    async readArtifact(_researchId, _path) {
      throw new LykeionError(
        "unsupported",
        "no machine is connected to this lab — install the Lykeion daemon on the machine that ran this research, so its artifacts can be read.",
      );
    },

    async reviewFindings(_researchId, _taskId) {
      return [];
    },
    async resolveFinding(_researchId, _taskId, findingId) {
      throw new LykeionError("not-found", `no such finding: ${findingId}`);
    },

    // ---- usage ----

    async usage() {
      return { series: [], agents: [], users: [] };
    },
  };
}
