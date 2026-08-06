import type {
  AgentOption,
  ExecutionLogEntry,
  PermissionRequest,
  Plan,
  RunDecision,
  RunEvent,
  ToolOutputPart,
} from "@lykeion/api";
import { isToolKind } from "@lykeion/api";
import { connectAcp, type AcpConnection } from "./acp";
import { boundaryOf, confine, covers, policyFor, type SandboxGrant } from "./sandbox";
import {
  confirmationOf,
  ordinaryWorkingMode,
  readAdvertised,
  type OptionSetter,
} from "./agent-options";

/**
 * How long a stopped turn is given, after `session/cancel` is sent, to
 * settle on its own before this session ends it regardless. An adapter that
 * confirms (or otherwise ends the turn) within it changes nothing about how
 * the turn lands — this only matters for one that does not. Set with real
 * headroom above how long a slow but working confirmation may reasonably
 * take, so a merely unhurried adapter is never reported as having ignored
 * the stop. The clock starts at the `session/cancel` notify itself, not at
 * whatever raised it — a little more generous than timing from a
 * researcher's own click, which is what a client-side clock would measure
 * instead.
 */
const DEFAULT_CANCEL_GRACE_MS = 45_000;

export type StandingGrant = SandboxGrant;

export interface LiveSession {
  /**
   * Starts one turn. Callers serialise turns themselves: wait for a turn's
   * `completed` event before starting the next one. That event does not
   * always mean the turn's own underlying ACP call has actually settled,
   * though — `cancel`'s grace period can end a turn early, unacknowledged,
   * while that call is still outstanding, which is exactly when a caller's
   * own queue is freed to call this again. Every turn is tagged with its own
   * epoch internally so a late settlement from a turn abandoned that way can
   * never be mistaken for an ending of the turn that superseded it. Its
   * ordinary output may still surface mislabelled on whichever turn is
   * current by then — nothing here can attribute a plain ACP update to one
   * turn over the other — but a permission request in that position is
   * refused outright rather than risked against a turn it has nothing to do
   * with.
   */
  prompt(text: string): void;
  decide(decision: RunDecision): void;
  /**
   * Stops the current turn: notifies the adapter over `session/cancel` and
   * settles every permission request still open, so no card is left waiting
   * on a decision the turn it belonged to will never reach. If the adapter
   * does not confirm within its own grace period (see
   * `DEFAULT_CANCEL_GRACE_MS`), the turn is ended here regardless, carrying
   * `unacknowledged: true` — the subprocess itself is left running; only the
   * turn this lab is waiting on is judged over.
   */
  cancel(): void;
  close(): Promise<void>;
  /** What this session is confined by. A caller holding a live session
   *  compares this against the boundary the next turn needs: a profile is
   *  fixed when the process is spawned, so a turn whose grants no longer
   *  match cannot be run in it. */
  readonly boundary: string;
  /** The last of what the adapter wrote to stderr — `AcpConnection`'s own
   *  tail, read through the connection this session holds. A failure reason
   *  already carries it when a turn ends `failed`; this is for a caller that
   *  needs it while nothing has failed yet, such as a diagnostic on a turn
   *  that has stopped producing anything at all. */
  stderrTail(): string;
}

/** One block of a tool call's output, as the adapter sends it. The fields
 *  are the union of every block type's own, because the type is only known
 *  after reading `type`. */
interface AcpContentBlock {
  type?: string;
  content?: { type?: string; text?: string };
  path?: string;
  oldText?: string | null;
  newText?: string;
  output?: string;
  uri?: string;
  name?: string;
}

interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  content?: AcpContentBlock[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What kind of call this is. An adapter that names no kind, and one naming a
 * kind this contract does not carry, both get `"other"` — a real member of
 * the set. An update that names none at all leaves the kind an earlier
 * update established, since only the announcement usually carries it.
 */
function kindOf(call: AcpToolCall, existing: ExecutionLogEntry | undefined): string {
  if (call.kind === undefined) return existing?.tool ?? "other";
  return isToolKind(call.kind) ? call.kind : "other";
}

/**
 * The arguments a call has been given so far. Later arguments merge over
 * earlier ones: an adapter announces a call before it knows what it is being
 * given, so an update carrying no keys states nothing about the arguments
 * and must not displace what an earlier one did carry.
 */
function mergeInput(existing: unknown, raw: unknown): unknown {
  if (raw === undefined || raw === null) return existing ?? {};
  if (!isRecord(raw)) return raw;
  if (Object.keys(raw).length === 0) return existing ?? {};
  return isRecord(existing) ? { ...existing, ...raw } : { ...raw };
}

/** One output block, as the part it is. A block whose type nothing draws is
 *  named by that type, so it is reported as present and unrecognised rather
 *  than dropped. */
function partOf(block: AcpContentBlock): ToolOutputPart {
  const type = block.type ?? (block.content !== undefined ? "content" : "");
  switch (type) {
    case "content": {
      const text = block.content?.text;
      if (typeof text === "string") return { type: "text", text };
      return { type: "other", blockType: block.content?.type ?? "content" };
    }
    case "diff":
      return {
        type: "diff",
        path: block.path ?? "",
        ...(typeof block.oldText === "string" ? { oldText: block.oldText } : {}),
        newText: block.newText ?? "",
      };
    case "terminal":
      return { type: "terminal", output: block.output ?? "" };
    case "resource_link":
      return {
        type: "resource",
        uri: block.uri ?? "",
        ...(block.name === undefined ? {} : { name: block.name }),
      };
    default:
      return { type: "other", blockType: type || "other" };
  }
}

/**
 * Everything a call produced, in arrival order and by type. An output that
 * is entirely text collapses to that text, its blocks concatenated — which
 * is what an output of text IS, and keeps the common case a plain string.
 * Anything else stays a list, so a diff, a terminal's output and a resource
 * reference each survive the trip as themselves.
 *
 * An empty block list therefore reads as the empty string: the call ran and
 * produced nothing, which is a different fact from an update that carried no
 * block list at all.
 */
function outputOf(blocks: AcpContentBlock[]): string | ToolOutputPart[] {
  const parts = blocks.map(partOf);
  return parts.every((part) => part.type === "text")
    ? parts.map((part) => (part as { text: string }).text).join("")
    : parts;
}

interface AcpUpdate {
  sessionUpdate: string;
  content?: { text?: string } | Array<{ content?: { text?: string } }>;
  entries?: Array<{ content: string; status: string }>;
}

/** What a permission request is asking to touch, read out of the title the
 *  adapter supplied. An adapter that names no path gets a card that names no
 *  path, which is honest — the researcher still sees the tool and the title. */
function pathFrom(title: string): string | undefined {
  const match = /(\/[^\s"']+|~\/[^\s"']+)/.exec(title);
  return match?.[1];
}

/** Recovers the path and mode a raised card asked about, from the access it
 *  carries — the same shape `decide` needs to know what to remember. An
 *  `execute` card names no path, so there is nothing standing to grant. */
function grantFrom(request: PermissionRequest): StandingGrant | undefined {
  if (request.access.kind === "write-path") return { path: request.access.target, mode: "write" };
  if (request.access.kind === "read-path") return { path: request.access.target, mode: "read" };
  return undefined;
}

export async function startSession(options: {
  /** The adapter to run. It is confined HERE rather than by the caller, so
   *  spawning one outside a boundary is not something a caller can express:
   *  there is no argument that asks for it and no path through this
   *  function that does it. */
  adapter: { command: string; args: string[] };
  /** The Task directory this session works in, and the one directory the
   *  boundary lets it write. */
  cwd: string;
  /** Where this machine keeps its own state. Denied to the agent: the
   *  machine token is the machine's identity. */
  dataDir: string;
  /** The platform whose backend confines this session. Production passes
   *  none and this machine's own platform is used. */
  platform?: string;
  grants: StandingGrant[];
  onEvent: (event: RunEvent) => void;
  onGrant: (grant: StandingGrant) => void;
  env?: NodeJS.ProcessEnv;
  /** Cancels ACP initialization and reaps the subprocess before this promise
   *  settles. Once initialization succeeds, lifecycle ownership transfers to
   *  the returned LiveSession and callers close it normally. */
  signal?: AbortSignal;
  /** Which of the agent's own advertised choices this turn asked for, by
   *  option value. Reused from `RunOptions.model`; an agent advertising no
   *  such value is left as it is rather than told something it never
   *  offered. */
  model?: string;
  /** Overrides `DEFAULT_CANCEL_GRACE_MS` — a test's own way to make a stop's
   *  grace period something shorter than real seconds. Production never
   *  passes this. */
  cancelGraceMs?: number;
}): Promise<LiveSession> {
  const { cwd, onEvent, onGrant } = options;
  const cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  // Established before anything is spawned, and nothing is spawned if it
  // cannot be: `policyFor` throws on a path that will not resolve and
  // `confine` throws on a platform with no backend, both before the first
  // line below that starts a process.
  const policy = policyFor({ workspace: cwd, grants: options.grants, dataDir: options.dataDir });
  const confined = confine(options.platform ?? process.platform, policy, options.adapter);
  const connection: AcpConnection = await connectAcp(confined.command, confined.args, {
    cwd,
    env: options.env,
  });
  let aborting: Promise<void> | undefined;
  const abortInitialization = () => {
    aborting ??= connection.close();
  };
  if (options.signal?.aborted) abortInitialization();
  else options.signal?.addEventListener("abort", abortInitialization, { once: true });

  // Session-scoped grants: what "this session" on a card means. Held here and
  // nowhere else, so they go when the session does.
  const sessionGrants: StandingGrant[] = [];
  // The canonical set the boundary was rendered from, so the question "did
  // the researcher allow this?" is asked of exactly what the kernel was
  // told — not of the paths as they were written.
  const standing = [...policy.grants];

  let text = "";
  let thinking = "";
  let lastVisibleUpdate: "text" | "thought" | "tool" | undefined;
  let plan: Plan | undefined;
  const steps = new Map<string, ExecutionLogEntry>();
  const publishedStepFingerprints = new Map<string, string>();
  const waiting = new Map<string, (optionId: string) => void>();
  // Every card raised while it is still open, so a later `decide` can recover
  // what it was asking about — a decision only carries the request id back.
  const cards = new Map<string, PermissionRequest>();
  let nextRequest = 1;

  const emitLive = (): void => {
    const live: { text?: string; thinking?: string } = {};
    if (text) live.text = text;
    if (thinking) live.thinking = thinking;
    onEvent({ event: "live", live });
  };

  const emitStep = (entry: ExecutionLogEntry): void => {
    steps.set(entry.toolUseId, entry);
    const fingerprint = JSON.stringify([
      entry.ts,
      entry.toolUseId,
      entry.tool,
      entry.title,
      entry.input,
      entry.decision,
      entry.result,
      entry.isError,
      entry.outsideWorkspace,
    ]);
    if (publishedStepFingerprints.get(entry.toolUseId) === fingerprint) return;
    publishedStepFingerprints.set(entry.toolUseId, fingerprint);
    onEvent({ event: "log-entry", entry });
  };

  // What this session said it lets a caller change, and which method a set
  // travels on. Read from what the session advertised, never from which CLI
  // it is.
  let advertised: { options: AgentOption[]; setter: OptionSetter } = {
    options: [],
    setter: "none",
  };
  // The id the agent assigned to this session in `session/new`'s response —
  // every later call names it, exactly as an adapter that checks it expects.
  let sessionId = "session";
  try {
    if (options.signal?.aborted) throw new Error("session initialization was cancelled");
    await connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const created = await connection.request("session/new", { cwd, mcpServers: [] });
    sessionId = (created as { sessionId?: string }).sessionId ?? sessionId;
    advertised = readAdvertised(created);
  } catch (err) {
    const tail = connection.stderrTail().trim();
    await (aborting ?? connection.close());
    throw new Error(tail || (err instanceof Error ? err.message : String(err)));
  } finally {
    options.signal?.removeEventListener("abort", abortInitialization);
  }
  if (options.signal?.aborted) {
    await (aborting ?? connection.close());
    throw new Error("session initialization was cancelled");
  }

  /** Tells this session to change one of its own advertised options, by the
   *  method the session's own advertisement chose. A refusal is not fatal:
   *  the boundary this run executes inside does not depend on the agent
   *  agreeing to anything. */
  const setOption = async (id: string, value: string): Promise<void> => {
    try {
      if (advertised.setter === "config") {
        const echoed = await connection.request("session/set_config_option", {
          sessionId,
          configId: id,
          value,
        });
        // What the option holds now is what came back, not what was asked
        // for: an agent that rejected the set echoes its real current value,
        // and recording the asked-for one instead would leave this session
        // describing itself as something it is not.
        const outcome = confirmationOf(echoed, id, value);
        advertised = {
          ...advertised,
          options: advertised.options.map((option) =>
            option.id === id ? { ...option, currentValue: outcome.value } : option,
          ),
        };
      } else if (advertised.setter === "model" && id === "model") {
        // This method answers with nothing at all, so the value is applied
        // and unconfirmed — recorded as asked for, and never as verified.
        await connection.request("session/set_model", { sessionId, modelId: value });
        advertised = {
          ...advertised,
          options: advertised.options.map((option) =>
            option.id === id ? { ...option, currentValue: value } : option,
          ),
        };
      }
    } catch {
      // Left as it was. What an agent may touch is settled by the kernel,
      // and what it runs on is the agent's own default.
    }
  };

  // The operating-system boundary is the outer bound. The agent's own mode
  // may narrow it and can never widen it, so this selects the ordinary
  // working mode and never the full-access one — an agent told it has full
  // access, inside a boundary that says otherwise, produces a turn full of
  // denials that look like breakage rather than policy.
  const mode = advertised.options.find((option) => option.category === "mode");
  if (mode) {
    const working = ordinaryWorkingMode(mode);
    if (working !== undefined) await setOption(mode.id, working);
  }
  // What the researcher picked beside the composer, if this agent offers it.
  if (options.model !== undefined) {
    const chosen = advertised.options.find((option) =>
      option.choices.some((choice) => choice.value === options.model),
    );
    if (chosen) await setOption(chosen.id, options.model);
  }

  connection.onNotify("session/update", (raw) => {
    // Not gated on `hasStaleOutstanding`. An abandoned turn's own ordinary
    // output arriving here cannot be told apart from the turn now current's
    // — ACP gives neither a per-call correlation id — so there is no way to
    // attribute it correctly. Between showing it anyway (mislabelled, but
    // visible, on whichever turn happens to be current) and dropping it,
    // dropping is worse: it would just as readily discard the CURRENT
    // turn's own legitimate output for as long as the abandoned call stays
    // outstanding, which an adapter that ignores `session/cancel` may never
    // resolve at all. `session/request_permission`, below, is held to the
    // opposite call: a wrongly-attributed permission answer has real
    // consequences a wrongly-attributed line of prose does not.
    const { update } = raw as { update: AcpUpdate };
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const chunk = (update.content as { text?: string })?.text ?? "";
        text += chunk;
        lastVisibleUpdate = "text";
        onEvent({ event: "assistant-text", text: chunk, partial: true });
        emitLive();
        return;
      }
      case "agent_thought_chunk": {
        const chunk = (update.content as { text?: string })?.text ?? "";
        thinking += chunk;
        lastVisibleUpdate = "thought";
        onEvent({ event: "assistant-thought", text: chunk, partial: true });
        emitLive();
        return;
      }
      case "plan": {
        plan = {
          steps: (update.entries ?? []).map((e) => ({
            title: e.content,
            done: e.status === "completed",
            status:
              e.status === "completed" ? "completed" : e.status === "in_progress" ? "in_progress" : "pending",
          })),
        };
        onEvent({ event: "plan-proposed", plan });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        lastVisibleUpdate = "tool";
        const call = update as unknown as AcpToolCall;
        const id = call.toolCallId;
        const existing = steps.get(id);
        const terminal = call.status === "completed" || call.status === "failed";
        const gated = existing?.decision !== undefined && existing.decision !== "pending";
        const entry: ExecutionLogEntry = {
          ts: existing?.ts ?? Math.floor(Date.now() / 1000),
          toolUseId: id,
          tool: kindOf(call, existing),
          input: mergeInput(existing?.input, call.rawInput),
          decision: gated ? existing.decision : terminal ? "ran" : "pending",
          isError:
            call.status === "failed" ||
            existing?.decision === "denied" ||
            existing?.decision === "cancelled",
        };
        if (call.title !== undefined) entry.title = call.title;
        else if (existing?.title !== undefined) entry.title = existing.title;
        const result = call.content === undefined ? undefined : outputOf(call.content);
        if (result !== undefined) entry.result = result;
        else if (existing?.result !== undefined) entry.result = existing.result;
        emitStep(entry);
        return;
      }
      default:
        return;
    }
  });

  connection.onRequest("session/request_permission", async (raw) => {
    const params = raw as { toolCall?: { toolCallId?: string; title?: string } };
    const title = params.toolCall?.title ?? "";
    const target = pathFrom(title);
    const mode: "read" | "write" = /write|edit|create|delete/i.test(title) ? "write" : "read";

    // Checked first, regardless of which turn this request could even be
    // attributed to: a standing grant is the researcher's own prior
    // consent, not a fact about the turn asking, so a request landing here
    // during the ambiguous window below is still honoured by one exactly
    // the way a live turn's own request would be.
    // Asked of the same canonical grant set the sandbox profile is
    // rendered from, so the question "did the researcher allow this?" and
    // the question "will the kernel permit this?" cannot come apart.
    const sessionGrant = target !== undefined && covers(sessionGrants, target, mode);
    const studyGrant = target !== undefined && covers(standing, target, mode);
    if (sessionGrant || studyGrant) {
      const card: PermissionRequest = {
        id: `pr_${nextRequest++}`,
        access: target
          ? mode === "write"
            ? { kind: "write-path", target }
            : { kind: "read-path", target }
          : { kind: "execute", target: title },
        tool: params.toolCall?.toolCallId ?? "tool",
        detail: title,
      };
      emitStep(recordDecision(card, sessionGrant ? "allowed-conversation" : "allowed-study"));
      return { outcome: { outcome: "selected", optionId: "allow-once" } };
    }

    // Unlike `session/update`'s notifications, a wrongly-attributed answer
    // here has real consequences — it could authorise something the
    // researcher never saw asked, or (above) block something they already
    // allowed. `settled` catches the request landing in the gap between a
    // turn's own grace-triggered ending and a successor's `prompt()` ever
    // starting, where there is no OTHER epoch yet for `hasStaleOutstanding`
    // to compare against; `hasStaleOutstanding` catches it once a successor
    // has. Refused rather than raised as a card nobody still watching this
    // turn could ever answer — visibly, so the refusal is a disclosed fact
    // rather than a silent one.
    if (settled || hasStaleOutstanding()) {
      const refusedId = params.toolCall?.toolCallId ?? "tool";
      const entry: ExecutionLogEntry = {
        ts: Math.floor(Date.now() / 1000),
        toolUseId: refusedId,
        tool: "other",
        ...(title !== "" ? { title } : {}),
        input: {},
        decision: "denied",
        isError: true,
        result: "auto-refused — this request could not be attributed to a live turn",
      };
      // Written into `steps`, not only emitted, the same way a researcher's
      // own denial is: an adapter that reports the refused call afterwards
      // sends a `tool_call_update` for this id, and the merge above reads
      // `steps` to decide what the call's decision was. Without the entry
      // there, that update finds nothing and falls through to `ran` — a
      // second row claiming the call executed, directly after the row
      // saying it was refused.
      emitStep(entry);
      return { outcome: { outcome: "selected", optionId: "reject-once" } };
    }

    const id = `pr_${nextRequest++}`;
    const request: PermissionRequest = {
      id,
      access: target
        ? mode === "write"
          ? { kind: "write-path", target }
          : { kind: "read-path", target }
        : { kind: "execute", target: title },
      tool: params.toolCall?.toolCallId ?? "tool",
      detail: title,
    };
    cards.set(id, request);
    onEvent({ event: "permission-card", request });
    onEvent({ event: "state", state: { state: "awaiting-permission", request, ...(plan ? { plan } : {}) } });

    const optionId = await new Promise<string>((resolve) => waiting.set(id, resolve));
    return { outcome: { outcome: "selected", optionId } };
  });

  /** Merges a decision about a permission-gated call into its execution-log
   *  entry, keyed by the ACP tool-call id the card carries in `tool`. The
   *  A later adapter update reads the same stored decision and cannot
   *  contradict it. */
  const recordDecision = (
    card: PermissionRequest,
    decision: "allowed-once" | "allowed-conversation" | "allowed-study" | "denied" | "cancelled",
    result?: string,
  ): ExecutionLogEntry => {
    const id = card.tool;
    const existing = steps.get(id);
    const entry: ExecutionLogEntry = {
      ts: existing?.ts ?? Math.floor(Date.now() / 1000),
      toolUseId: id,
      tool: existing?.tool ?? "other",
      input: existing?.input ?? {},
      decision,
      isError: decision === "denied" || decision === "cancelled",
    };
    const title = existing?.title ?? card.detail;
    if (title !== undefined) entry.title = title;
    if (result !== undefined) entry.result = result;
    else if (existing?.result !== undefined) entry.result = existing.result;
    steps.set(id, entry);
    return entry;
  };

  // A permission card is a transient execution gate. Once its decision is
  // recorded, publish the resumed state before releasing the ACP request so
  // a persisted recovery snapshot cannot keep offering an already-spent
  // decision after a reload.
  const leavePermissionGate = (): void => {
    onEvent({
      event: "state",
      state: plan ? { state: "executing", plan } : { state: "planning" },
    });
  };

  /** Settles every card still open when the turn ends underneath it. A card
   *  nobody answered is not consent, so the ACP request it is holding open
   *  is refused; and since the adapter that raised it may already be gone or
   *  going, there is no `tool_call_update` to wait on the way a plain denial
   *  can, so the step is written and reported here, as `cancelled` —
   *  abandoned at the gate, never run, no result — rather than left as a
   *  card with no resolution a consumer would otherwise have to guess at. */
  const abandonCards = (): void => {
    for (const [id, resolve] of waiting) {
      resolve("reject-once");
      const card = cards.get(id);
      if (card) emitStep(recordDecision(card, "cancelled"));
    }
    waiting.clear();
    cards.clear();
  };

  // Bumped once per `prompt()` call — the epoch the turn that call started
  // belongs to. A grace timeout can end a turn while its own `session/prompt`
  // call is still outstanding (see `cancelTurn`), and this lab's own queue
  // moves straight on to the next turn once that happens (deliberately —
  // this session is left running, not closed, so its conversation state
  // survives). The epoch is what lets a LATER arrival from that abandoned
  // call — its real settlement, or any `session/update`/permission request
  // still in flight under it — be recognised as belonging to a turn that is
  // already over, rather than mistaken for the turn that superseded it.
  let epoch = 0;
  // Every epoch whose own `session/prompt` call has been sent but has not
  // yet resolved or rejected — normally just the current one. More than one
  // entry means an EARLIER turn's call is still outstanding after this
  // session already moved on to a later epoch: the window in which neither
  // `finish` nor a `session/update`/permission notification can trust which
  // turn it belongs to. Cleared per epoch by the `.then()`/`.catch()` on
  // that epoch's own `session/prompt` call, whichever way it settles.
  const pendingRequests = new Set<number>();
  const hasStaleOutstanding = (): boolean => {
    for (const e of pendingRequests) if (e !== epoch) return true;
    return false;
  };
  // True once the current epoch's own ending has been decided — by a real
  // settlement or by this session's own grace timing out first, whichever
  // happens first (`finish` checks and sets this). Starts `true` — idle,
  // nothing to end — and is set `false` at the top of every `prompt()`.
  let settled = true;
  // The pending grace timer for the current turn's stop, if `cancelTurn` has
  // armed one and it has not fired or been cleared yet.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const clearGrace = (): void => {
    if (graceTimer === undefined) return;
    clearTimeout(graceTimer);
    graceTimer = undefined;
  };

  /** Ends the turn `forEpoch` names — a no-op if that epoch is not the
   *  current one (a later `prompt()` has since superseded it) or has
   *  already been settled (grace and a real settlement racing each other).
   *  Either guard alone would miss the other's failure mode: the epoch
   *  check alone would still let a grace timeout and a real settlement for
   *  the SAME still-current epoch double-emit; the `settled` check alone
   *  would still let a stale settlement from an abandoned epoch end
   *  whatever epoch is current now. */
  const finish = (
    forEpoch: number,
    state: "completed" | "failed" | "cancelled",
    reason?: string,
    unacknowledged?: true,
  ): void => {
    if (forEpoch !== epoch || settled) return;
    settled = true;
    clearGrace();
    abandonCards();
    for (const entry of steps.values()) {
      emitStep(
        state === "completed" && entry.decision === "pending"
          ? { ...entry, decision: "ran" }
          : entry,
      );
    }
    onEvent({
      event: "completed",
      state:
        state === "failed"
          ? { state: "failed", reason: reason ?? "the turn failed" }
          : state === "cancelled"
            ? { state: "cancelled", ...(unacknowledged ? { unacknowledged: true } : {}) }
            : { state: "completed" },
    });
  };

  /** Stops the current turn: told to the adapter over `session/cancel`, and
   *  every card still open settled as abandoned rather than left waiting on a
   *  decision the turn will never reach. The one body behind both a decision
   *  of `{ action: "cancel" }` and a direct `cancel()` call — the two ways a
   *  turn actually gets stopped over the wire. Also arms this turn's grace
   *  timer (unless one is already running, or the turn has already ended) —
   *  see `finish`'s own `unacknowledged` branch for what happens if it runs
   *  out before the adapter confirms. */
  const cancelTurn = (): void => {
    connection.notify("session/cancel", { sessionId });
    abandonCards();
    if (settled || graceTimer !== undefined) return;
    const forEpoch = epoch;
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      finish(forEpoch, "cancelled", undefined, true);
    }, cancelGraceMs);
    graceTimer.unref?.();
  };

  return {
    prompt(body) {
      const myEpoch = ++epoch;
      pendingRequests.add(myEpoch);
      text = "";
      thinking = "";
      lastVisibleUpdate = undefined;
      steps.clear();
      publishedStepFingerprints.clear();
      // No grace timer can still be pending here: `completed` — the
      // caller's own signal that it may call `prompt` again — is only ever
      // fired from inside `finish`, which always clears one first.
      settled = false;
      onEvent({ event: "state", state: { state: "planning" } });
      void connection
        .request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: body }],
        })
        .then(
          (result) => {
            pendingRequests.delete(myEpoch);
            const stopReason = (result as { stopReason?: string } | undefined)?.stopReason;
            if (
              myEpoch === epoch &&
              stopReason !== "cancelled" &&
              lastVisibleUpdate === "text"
            )
              onEvent({ event: "assistant-text-final" });
            finish(myEpoch, stopReason === "cancelled" ? "cancelled" : "completed");
          },
          (err: unknown) => {
            pendingRequests.delete(myEpoch);
            const tail = connection.stderrTail().trim();
            finish(myEpoch, "failed", tail || (err instanceof Error ? err.message : String(err)));
          },
        );
    },
    decide(decision) {
      if (decision.action === "cancel") {
        cancelTurn();
        return;
      }
      if (decision.action !== "permission") return;
      const resolve = waiting.get(decision.requestId);
      if (!resolve) return;
      waiting.delete(decision.requestId);
      const card = cards.get(decision.requestId);
      cards.delete(decision.requestId);

      if (decision.decision.decision === "deny") {
        if (card) emitStep(recordDecision(card, "denied"));
        leavePermissionGate();
        resolve("reject-once");
        return;
      }
      const scope = decision.decision.scope;
      if (scope === "global") {
        // Refused by name rather than quietly narrowed: a researcher told
        // "always" and given "this session" would believe the wrong thing.
        if (card)
          emitStep(
            recordDecision(
              card,
              "denied",
              "a grant for every Study needs the lab's grant store, which this lab does not have yet",
            ),
          );
        leavePermissionGate();
        resolve("reject-once");
        return;
      }
      const grant = card ? grantFrom(card) : undefined;
      if (grant && scope === "conversation") sessionGrants.push(grant);
      if (grant && scope === "study") onGrant(grant);
      if (card)
        emitStep(
          recordDecision(
            card,
            scope === "once"
              ? "allowed-once"
              : scope === "conversation"
                ? "allowed-conversation"
                : "allowed-study",
          ),
        );
      leavePermissionGate();
      resolve("allow-once");
    },
    cancel() {
      cancelTurn();
    },
    close() {
      abandonCards();
      return connection.close();
    },
    boundary: boundaryOf(policy),
    stderrTail() {
      return connection.stderrTail();
    },
  };
}
