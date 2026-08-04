import { LykeionError, type ErrorCode } from "./errors";
import type { LykeionApi } from "./api";

/** One change the workspace has recorded, as it arrives on the channel. */
export interface ChangeEvent {
  seq: number;
  kind: string;
  payload: unknown;
}

/**
 * Everything the client needs from the world beneath it: a way to call one
 * method, and a way to watch for changes. Split out so the same client runs
 * over a browser `fetch`, and over whatever a future caller has instead.
 */
export interface Transport {
  request(method: string, args: unknown[]): Promise<unknown>;
  /**
   * Subscribe from just after `cursor`. `onResync` fires when the server
   * cannot replay from there and the caller must re-read everything.
   * Returns an unsubscribe function.
   */
  openEvents(
    cursor: number | undefined,
    onEvent: (event: ChangeEvent) => void,
    onResync: () => void,
  ): () => void;
}

export function createHttpApi(transport: Transport): LykeionApi {
  const call = <K extends keyof LykeionApi>(name: K): LykeionApi[K] =>
    ((...args: unknown[]) => transport.request(name, args)) as LykeionApi[K];

  return {
    coreInfo: call("coreInfo"),
    listStudies: call("listStudies"),
    getStudy: call("getStudy"),
    createStudy: call("createStudy"),
    updateStudy: call("updateStudy"),
    archiveStudy: call("archiveStudy"),
    restoreStudy: call("restoreStudy"),
    deleteStudy: call("deleteStudy"),
    listTasks: call("listTasks"),
    createTask: call("createTask"),
    updateTask: call("updateTask"),
    deleteTask: call("deleteTask"),
    getTask: call("getTask"),
    listConversations: call("listConversations"),
    getConversation: call("getConversation"),
    createConversation: call("createConversation"),
    postMessage: call("postMessage"),
    markConversationRead: call("markConversationRead"),
    myWork: call("myWork"),
    listRuntimes: call("listRuntimes"),
    pairMachine: call("pairMachine"),
    removeRuntime: call("removeRuntime"),
    kernelEnvStatus: call("kernelEnvStatus"),
    kernelEnvList: call("kernelEnvList"),
    kernelEnvSetup: call("kernelEnvSetup"),
    kernelStatus: call("kernelStatus"),
    kernelDocument: call("kernelDocument"),
    kernelExecute: call("kernelExecute"),
    kernelInterrupt: call("kernelInterrupt"),
    kernelRestart: call("kernelRestart"),
    listAgentClis: call("listAgentClis"),
    runHistory: call("runHistory"),
    startRun: call("startRun"),
    delegateSubagent: call("delegateSubagent"),
    readArtifact: call("readArtifact"),
    reviewFindings: call("reviewFindings"),
    resolveFinding: call("resolveFinding"),
    listSkills: call("listSkills"),
    createSkill: call("createSkill"),
    setSkillEnabled: call("setSkillEnabled"),
    listAgents: call("listAgents"),
    upsertAgent: call("upsertAgent"),
    listWorkflows: call("listWorkflows"),
    upsertWorkflow: call("upsertWorkflow"),
    runWorkflow: call("runWorkflow"),
    listConnectors: call("listConnectors"),
    addConnector: call("addConnector"),
    setConnectorEnabled: call("setConnectorEnabled"),
    setConnectorSkipApprovals: call("setConnectorSkipApprovals"),
    connectorCatalog: call("connectorCatalog"),
    listConnectorTools: call("listConnectorTools"),
    listResearchGroups: call("listResearchGroups"),
    createResearchGroup: call("createResearchGroup"),
    currentUser: call("currentUser"),
    setAvatar: call("setAvatar"),
    listMembers: call("listMembers"),
    createInvite: call("createInvite"),
    listInvites: call("listInvites"),
    revokeInvite: call("revokeInvite"),
    removeMember: call("removeMember"),
    usage: call("usage"),
    getSettings: call("getSettings"),
    setTheme: call("setTheme"),
  };
}

export interface FetchTransportOptions {
  /** Same origin in every real deployment; overridable for tests. */
  baseUrl?: string;
  /** Called once when the server says nobody is signed in. */
  onUnauthenticated?: () => void;
}

interface Envelope {
  ok: boolean;
  value?: unknown;
  error?: { code: ErrorCode; message: string };
}

export function createFetchTransport(options: FetchTransportOptions = {}): Transport {
  const base = options.baseUrl ?? "";
  let announced = false;

  return {
    async request(method, args) {
      const res = await fetch(`${base}/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ args }),
      });
      if (res.status === 401) {
        // Once per session: every in-flight call fails together when a
        // session lapses, and one sign-in prompt is the honest response to
        // that, not eight.
        if (!announced) {
          announced = true;
          options.onUnauthenticated?.();
        }
        throw new LykeionError("unauthenticated", "not signed in");
      }
      if (!res.ok) throw new Error(`the workspace server answered ${res.status} for ${method}`);
      // Reached only by an answer the server produced after resolving the
      // caller, which is what proves the session is currently valid and
      // makes a later lapse a new event worth its own announcement. The
      // failure statuses above prove nothing of the kind — a gateway's 502
      // during a restart, or a rejection the server makes before it ever
      // looks at the cookie, says only that this call did not work. Clearing
      // the latch on one of those would let a single lapse announce again
      // and again, and since each announcement prompts the page to re-read,
      // that is a loop with no end.
      announced = false;
      const body = (await res.json()) as Envelope;
      if (body.ok) return body.value;
      const error = body.error ?? { code: "invalid" as ErrorCode, message: "the workspace server refused the call" };
      throw new LykeionError(error.code, error.message);
    },

    openEvents(cursor, onEvent, onResync) {
      const url = cursor === undefined ? `${base}/events` : `${base}/events?cursor=${cursor}`;
      // No `withCredentials`: the page and the server share an origin by
      // design, where the cookie is sent anyway, and the flag's only effect
      // is to send it cross-origin as well.
      const source = new EventSource(url);
      source.addEventListener("change", (e) => {
        onEvent(JSON.parse((e as MessageEvent).data as string) as ChangeEvent);
      });
      source.addEventListener("resync", () => onResync());
      source.addEventListener("error", () => {
        // `error` stands for two different things and only one of them is
        // an answer. A connection that drops leaves the source CONNECTING,
        // and the browser retries by itself — a server being restarted looks
        // exactly like that, and turning anybody out over it would make an
        // ordinary interruption end their visit.
        //
        // CLOSED is the browser giving up, which it does when the reconnect
        // is answered rather than refused at the socket — the stream is
        // gone because the session behind it is. Announcing here is what
        // makes somebody removed mid-visit find out at once. Without it the
        // page keeps their lab on screen until they happen to ask it for
        // something, which may be a long time and is their own click.
        if (source.readyState !== EventSource.CLOSED) return;
        if (announced) return;
        announced = true;
        options.onUnauthenticated?.();
      });
      // `close()` sets CLOSED without raising `error`, so tearing the stream
      // down on purpose does not read as one that was taken away.
      return () => source.close();
    },
  };
}
