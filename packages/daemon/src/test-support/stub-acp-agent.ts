/**
 * An agent that speaks ACP on stdio and does exactly what it is told, so a
 * test can assert what the client makes of each update kind without a model,
 * a network or a credential in the way.
 *
 * Its script arrives as JSON in LYKEION_STUB_SCRIPT: a list of directives
 * played in order when a prompt arrives. LYKEION_STUB_SCRIPT may instead be a
 * list of such lists — one per `session/prompt` call, in order, so a test can
 * give a second turn on the same session different behaviour from the first
 * (the last one plays again for any call past the end of the list).
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

type Directive =
  | { emit: "agent_message_chunk"; text: string }
  | { emit: "agent_thought_chunk"; text: string }
  | {
      emit: "tool_call";
      toolCallId: string;
      title?: string;
      kind?: string;
      rawInput?: unknown;
    }
  /** `content` is the shorthand for one text block. `blocks` carries the
   *  update's content array verbatim, so a script can send a diff, a
   *  terminal, a resource link, several blocks at once, or an empty array —
   *  the shapes the shorthand cannot express. An update naming neither
   *  carries no content array at all. */
  | {
      emit: "tool_call_update";
      toolCallId: string;
      status: string;
      content?: string;
      blocks?: unknown[];
      rawInput?: unknown;
    }
  | { emit: "plan"; entries: Array<{ content: string; status: string }> }
  | {
      ask: "permission";
      toolCallId: string;
      title: string;
      followUp?: boolean;
      followUpContent?: string;
      /** Overrides what this agent offers to answer with. An empty array is
       *  an agent offering nothing answerable, which a client has to say out
       *  loud rather than guess its way past. */
      options?: Array<{ optionId: string; name: string; kind: string }>;
      /** Holds this request back this many milliseconds before sending it.
       *  Inside an `askAll`, what staggers a batch so one request lands while
       *  a sibling is already in front of the researcher — an agent does not
       *  decide everything it needs at once, and a client that only ever sees
       *  a batch arrive in one tick is never asked what a late arrival does to
       *  a question already on screen. */
      delayMs?: number;
    }
  /** Several permission requests in flight AT ONCE — every one sent before any
   *  answer is awaited, the way a real adapter issues a batch of independent
   *  tool calls in a single assistant turn. The `ask` step above cannot express
   *  this: it awaits its own answer before the script advances, so a script
   *  built from it can only ever put ONE request in front of the client at a
   *  time. That limit is why a client bug specific to concurrent requests could
   *  not be reached from this stub at all. */
  | { askAll: Array<Omit<Extract<Directive, { ask: "permission" }>, "ask">> }
  /** Pauses the script for up to `timeoutMs`, or until `session/cancel`
   *  arrives, whichever comes first — the one way a script can put the stub
   *  into the same mid-turn state a real adapter is in when a researcher
   *  stops it, so a test can exercise `session/cancel` actually landing a
   *  turn `cancelled` rather than only ever scripting `{ endTurn: "cancelled"
   *  }` directly. A script that reaches this step after cancellation already
   *  arrived — an `ask` step just above it, answered by the client abandoning
   *  it rather than by a decision — treats that the same as catching the
   *  notification here: either way ends the turn `cancelled` on the spot.
   *  Timing out instead falls through to whatever the script does next, so
   *  the one script can also play out its ordinary ending when nothing ever
   *  cancels it. */
  | { wait: "cancel"; timeoutMs: number }
  /** Pauses the script for exactly `timeoutMs`, ignoring `session/cancel`
   *  entirely — an agent occupied with something regardless of whether a
   *  stop was requested, the one way a script can put the stub into the
   *  state a test needs to exercise a grace period actually running out. */
  | { sleep: number }
  | { endTurn: "end_turn" | "cancelled" | "refusal" }
  | { exit: number };

const parsedScript = JSON.parse(process.env.LYKEION_STUB_SCRIPT ?? "[]") as Directive[] | Directive[][];
// A flat list is one script for every prompt; a list of lists is one script
// per prompt in order (first element decides which — a script directive is
// always a plain object, never an array).
const scripts: Directive[][] = Array.isArray(parsedScript[0])
  ? (parsedScript as Directive[][])
  : [parsedScript as Directive[]];
let promptCount = 0;

/** What this agent advertises on `session/new`: `configOptions`, `models`,
 *  `modes`, or nothing at all. */
const advertised = JSON.parse(process.env.LYKEION_STUB_ADVERTISES ?? "{}") as {
  configOptions?: Array<Record<string, unknown> & { id: string }>;
  models?: unknown;
  modes?: unknown;
};
/** Every set this agent was asked for, recorded so a test can assert what
 *  travelled rather than what was intended. */
const setCalls: Array<{ method: string; id: string; value: string }> = [];
const marker = process.env.LYKEION_STUB_SET_MARKER;

let sessionId = "";
let nextId = 1;
const pending = new Map<number, (result: unknown) => void>();
// Set once `session/cancel` arrives, so a `{ wait: "cancel" }` step reached
// only after cancellation was already notified does not hang waiting for a
// notification that already came.
let cancelled = false;
const cancelWaiters: Array<() => void> = [];

process.on("SIGTERM", () => {
  const exit = () => {
    const marker = process.env.LYKEION_STUB_EXIT_MARKER;
    if (marker) appendFileSync(marker, `${process.pid}\n`);
    process.exit(0);
  };
  const delayMs = Number(process.env.LYKEION_STUB_EXIT_DELAY_MS ?? "0");
  if (Number.isFinite(delayMs) && delayMs > 0) setTimeout(exit, delayMs);
  else exit();
});

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function ask(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

/** One permission request, from asking through reporting what the answer did
 *  to the call. Shared by the `ask` step and every entry of an `askAll` step,
 *  so a batched request is the same request in every respect except that
 *  nothing awaited it before its siblings were sent. */
async function askPermission(
  step: Omit<Extract<Directive, { ask: "permission" }>, "ask">,
): Promise<void> {
  if (step.delayMs !== undefined)
    await new Promise<void>((resolve) => setTimeout(resolve, step.delayMs));
  const answer = (await ask("session/request_permission", {
    sessionId,
    toolCall: { toolCallId: step.toolCallId, title: step.title },
    // Deliberately arbitrary ids. An agent names its own options and no
    // two name them alike, so a client that answers with an id it made
    // up rather than one of these is answering nothing — which is what
    // these ids exist to catch. Anything recognisable here would let a
    // hardcoded guess pass this suite and fail every real agent.
    options: step.options ?? [
      { optionId: "opt-7f1", name: "Allow once", kind: "allow_once" },
      { optionId: "opt-7f2", name: "Allow always", kind: "allow_always" },
      { optionId: "opt-7f3", name: "Deny", kind: "reject_once" },
    ],
  })) as { outcome?: { outcome?: string; optionId?: string } };
  if (step.followUp === false) return;
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: step.toolCallId,
        // Only an id this agent actually offered counts as an answer.
        // One it never offered is not a denial and not an allowance —
        // it is a call that was never decided, and reporting it as
        // completed would hide exactly the defect this catches.
        status:
          answer.outcome?.optionId === "opt-7f1" || answer.outcome?.optionId === "opt-7f2"
            ? "completed"
            : "failed",
        ...(step.followUpContent === undefined
          ? {}
          : { content: [{ content: { text: step.followUpContent } }] }),
      },
    },
  });
}

async function play(script: Directive[]): Promise<string> {
  // Reset per prompt: `cancelled` marks this turn as stopped, not this
  // process, so a script driving more than one prompt through one stub must
  // not have its second turn find a `wait` step already cancelled by
  // whatever the first turn's `session/cancel` left behind.
  cancelled = false;
  cancelWaiters.length = 0;
  let stopReason = "end_turn";
  for (const step of script) {
    if ("exit" in step) process.exit(step.exit);
    if ("endTurn" in step) {
      stopReason = step.endTurn;
      break;
    }
    if ("wait" in step) {
      if (!cancelled) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, step.timeoutMs);
          cancelWaiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      if (cancelled) {
        stopReason = "cancelled";
        break;
      }
      continue;
    }
    if ("sleep" in step) {
      await new Promise<void>((resolve) => setTimeout(resolve, step.sleep));
      continue;
    }
    if ("ask" in step) {
      await askPermission(step);
      continue;
    }
    if ("askAll" in step) {
      // Every request sent before ANY answer is awaited — the whole point of
      // this step. Mapping first and awaiting the array afterwards is what
      // keeps them concurrent; a `for` loop with an `await` inside would
      // quietly turn this back into the sequential `ask` above.
      await Promise.all(step.askAll.map((one) => askPermission(one)));
      continue;
    }
    const update: Record<string, unknown> = { sessionUpdate: step.emit };
    if (step.emit === "agent_message_chunk" || step.emit === "agent_thought_chunk")
      update.content = { type: "text", text: step.text };
    if (step.emit === "tool_call") {
      update.toolCallId = step.toolCallId;
      if (step.title !== undefined) update.title = step.title;
      if (step.kind !== undefined) update.kind = step.kind;
      update.rawInput = step.rawInput;
      update.status = "pending";
    }
    if (step.emit === "tool_call_update") {
      update.toolCallId = step.toolCallId;
      update.status = step.status;
      if (step.rawInput !== undefined) update.rawInput = step.rawInput;
      if (step.blocks !== undefined) update.content = step.blocks;
      else if (step.content !== undefined)
        update.content = [{ type: "content", content: { type: "text", text: step.content } }];
    }
    if (step.emit === "plan") update.entries = step.entries;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }
  return stopReason;
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line) as { id?: number; method?: string; params?: unknown; result?: unknown };
  if (msg.method === undefined && msg.id !== undefined) {
    pending.get(msg.id)?.(msg.result);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    return;
  }
  if (msg.method === "session/new") {
    sessionId = "stub-session";
    const marker = process.env.LYKEION_STUB_SESSION_NEW_MARKER;
    if (marker) appendFileSync(marker, `${process.pid}\n`);
    const reply = () =>
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId, ...advertised } });
    const delayMs = Number(process.env.LYKEION_STUB_SESSION_NEW_DELAY_MS ?? "0");
    if (Number.isFinite(delayMs) && delayMs > 0) setTimeout(reply, delayMs);
    else reply();
    return;
  }
  if (msg.method === "session/prompt") {
    const marker = process.env.LYKEION_STUB_PROMPT_MARKER;
    if (marker) appendFileSync(marker, `${process.pid}\n`);
    const script = scripts[Math.min(promptCount, scripts.length - 1)];
    promptCount += 1;
    void play(script).then((stopReason) => send({ jsonrpc: "2.0", id: msg.id, result: { stopReason } }));
    return;
  }
  if (msg.method === "session/cancel") {
    cancelled = true;
    for (const resolve of cancelWaiters.splice(0)) resolve();
    return;
  }
  if (msg.method === "session/set_config_option") {
    const { configId, value } = msg.params as { configId?: string; value?: string };
    setCalls.push({ method: msg.method, id: configId ?? "", value: value ?? "" });
    if (marker) appendFileSync(marker, `${msg.method} ${configId} ${value}\n`);
    // The echoed state a caller confirms a set from.
    const options = (advertised.configOptions ?? []).map((option) =>
      option.id === configId ? { ...option, currentValue: value } : option,
    );
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: options } });
    return;
  }
  if (msg.method === "session/set_model") {
    const { modelId } = msg.params as { modelId?: string };
    setCalls.push({ method: msg.method, id: "model", value: modelId ?? "" });
    if (marker) appendFileSync(marker, `${msg.method} model ${modelId}\n`);
    // No confirmation payload at all, which a caller must not read as one.
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no such method: ${msg.method}` } });
});
