import type {
  ExecutionLogEntry,
  PermissionRequest,
  Plan,
  RunDecision,
  RunEvent,
} from "@lykeion/api";
import { connectAcp, type AcpConnection } from "./acp";

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

export interface StandingGrant {
  path: string;
  mode: "read" | "write";
}

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
  /** The last of what the adapter wrote to stderr — `AcpConnection`'s own
   *  tail, read through the connection this session holds. A failure reason
   *  already carries it when a turn ends `failed`; this is for a caller that
   *  needs it while nothing has failed yet, such as a diagnostic on a turn
   *  that has stopped producing anything at all. */
  stderrTail(): string;
}

interface AcpToolCall {
  toolCallId: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  content?: Array<{ content?: { text?: string } }>;
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

function covers(grant: StandingGrant, path: string, mode: "read" | "write"): boolean {
  if (mode === "write" && grant.mode === "read") return false;
  return path === grant.path || path.startsWith(`${grant.path}/`);
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
  adapter: { command: string; args: string[] };
  cwd: string;
  grants: StandingGrant[];
  onEvent: (event: RunEvent) => void;
  onGrant: (grant: StandingGrant) => void;
  env?: NodeJS.ProcessEnv;
  /** Overrides `DEFAULT_CANCEL_GRACE_MS` — a test's own way to make a stop's
   *  grace period something shorter than real seconds. Production never
   *  passes this. */
  cancelGraceMs?: number;
}): Promise<LiveSession> {
  const { cwd, onEvent, onGrant } = options;
  const cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  const connection: AcpConnection = await connectAcp(options.adapter.command, options.adapter.args, {
    cwd,
    env: options.env,
  });

  // Session-scoped grants: what "this session" on a card means. Held here and
  // nowhere else, so they go when the session does.
  const sessionGrants: StandingGrant[] = [];
  const standing = [...options.grants];

  let text = "";
  let thinking = "";
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

  // The id the agent assigned to this session in `session/new`'s response —
  // every later call names it, exactly as an adapter that checks it expects.
  let sessionId = "session";
  try {
    await connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const created = await connection.request("session/new", { cwd, mcpServers: [] });
    sessionId = (created as { sessionId?: string }).sessionId ?? sessionId;
  } catch (err) {
    const tail = connection.stderrTail().trim();
    await connection.close();
    throw new Error(tail || (err instanceof Error ? err.message : String(err)));
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
        onEvent({ event: "assistant-text", text: chunk, partial: true });
        emitLive();
        return;
      }
      case "agent_thought_chunk": {
        thinking += (update.content as { text?: string })?.text ?? "";
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
        const call = update as unknown as AcpToolCall;
        const id = call.toolCallId;
        const existing = steps.get(id);
        const terminal = call.status === "completed" || call.status === "failed";
        const gated = existing?.decision !== undefined && existing.decision !== "pending";
        const entry: ExecutionLogEntry = {
          ts: existing?.ts ?? Math.floor(Date.now() / 1000),
          toolUseId: id,
          tool: existing?.tool ?? call.title ?? id,
          input: existing?.input ?? call.rawInput ?? {},
          decision: gated ? existing.decision : terminal ? "ran" : "pending",
          isError:
            call.status === "failed" ||
            existing?.decision === "denied" ||
            existing?.decision === "cancelled",
        };
        if (call.title !== undefined) entry.title = call.title;
        else if (existing?.title !== undefined) entry.title = existing.title;
        const result = call.content?.[0]?.content?.text;
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
    const sessionGrant = target && sessionGrants.some((g) => covers(g, target, mode));
    const studyGrant = target && standing.some((g) => covers(g, target, mode));
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
        tool: refusedId,
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
      tool: existing?.tool ?? id,
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
      resolve("allow-once");
    },
    cancel() {
      cancelTurn();
    },
    close() {
      abandonCards();
      return connection.close();
    },
    stderrTail() {
      return connection.stderrTail();
    },
  };
}
