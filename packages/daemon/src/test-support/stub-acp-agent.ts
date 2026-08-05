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
  | { emit: "tool_call"; toolCallId: string; title: string; rawInput?: unknown }
  | { emit: "tool_call_update"; toolCallId: string; status: string; content?: string }
  | { emit: "plan"; entries: Array<{ content: string; status: string }> }
  | {
      ask: "permission";
      toolCallId: string;
      title: string;
      followUp?: boolean;
      followUpContent?: string;
    }
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

let sessionId = "";
let nextId = 1;
const pending = new Map<number, (result: unknown) => void>();
// Set once `session/cancel` arrives, so a `{ wait: "cancel" }` step reached
// only after cancellation was already notified does not hang waiting for a
// notification that already came.
let cancelled = false;
const cancelWaiters: Array<() => void> = [];

process.on("SIGTERM", () => {
  const marker = process.env.LYKEION_STUB_EXIT_MARKER;
  if (marker) appendFileSync(marker, `${process.pid}\n`);
  process.exit(0);
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
      const answer = (await ask("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: step.toolCallId, title: step.title },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
          { optionId: "reject-once", name: "Deny", kind: "reject_once" },
        ],
      })) as { outcome?: { outcome?: string; optionId?: string } };
      if (step.followUp !== false)
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: step.toolCallId,
              status: answer.outcome?.optionId === "reject-once" ? "failed" : "completed",
              ...(step.followUpContent === undefined
                ? {}
                : { content: [{ content: { text: step.followUpContent } }] }),
            },
          },
        });
      continue;
    }
    const update: Record<string, unknown> = { sessionUpdate: step.emit };
    if (step.emit === "agent_message_chunk" || step.emit === "agent_thought_chunk")
      update.content = { type: "text", text: step.text };
    if (step.emit === "tool_call") {
      update.toolCallId = step.toolCallId;
      update.title = step.title;
      update.rawInput = step.rawInput;
      update.status = "pending";
    }
    if (step.emit === "tool_call_update") {
      update.toolCallId = step.toolCallId;
      update.status = step.status;
      if (step.content !== undefined)
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
    send({ jsonrpc: "2.0", id: msg.id, result: { sessionId } });
    return;
  }
  if (msg.method === "session/prompt") {
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
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no such method: ${msg.method}` } });
});
