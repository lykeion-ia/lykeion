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
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
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
  /** One call to a tool published by a server this agent was told about on
   *  `session/new`, made the way an adapter makes one: the server is started
   *  as its own process and spoken the Model Context Protocol to over that
   *  process's stdio, and the call is reported to the client as a `tool_call`
   *  before it and a `tool_call_update` after it — which is what puts it in
   *  the Execution Log. A server this agent was told nothing about, or one
   *  that will not start, ends the call `failed` carrying what went wrong,
   *  because an agent that stayed silent about that would leave a test unable
   *  to tell a tool that answered nothing from one that was never reached. */
  | {
      callTool: string;
      server: string;
      toolCallId: string;
      arguments: Record<string, unknown>;
      title?: string;
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
/** The tool servers this client named on `session/new`. An adapter starts
 *  these itself, so what a `callTool` step can reach is exactly what the
 *  client offered and nothing this file decided. */
let offeredServers: Array<{ name?: string; command?: string; args?: string[] }> = [];
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
    stopToolServers();
    process.exit(0);
  };
  const delayMs = Number(process.env.LYKEION_STUB_EXIT_DELAY_MS ?? "0");
  if (Number.isFinite(delayMs) && delayMs > 0) setTimeout(exit, delayMs);
  else exit();
});

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** One tool server, as this agent holds it: the process it runs in and the
 *  protocol spoken over that process's stdio. */
interface ToolServer {
  child: ChildProcess;
  call(name: string, args: Record<string, unknown>): Promise<string>;
}

/** Every tool server this agent has started, by the name the client gave it.
 *  One process per server for the whole session, which is what an adapter
 *  does — a server started per call would hand every call a fresh one, and a
 *  tool server that holds anything between calls could never show it. */
const toolServers = new Map<string, ToolServer>();

/** How long one tool call is given to be answered. Long enough for a server
 *  that has to provision something before its first answer, and finite so a
 *  server that never answers ends the call rather than the turn. */
const TOOL_CALL_MS = 120_000;

function startToolServer(named: { command: string; args: string[] }): ToolServer {
  const child = spawn(named.command, named.args, { stdio: ["pipe", "pipe", "pipe"] });
  const answers = new Map<number, (result: unknown) => void>();
  const failures = new Map<number, (why: string) => void>();
  let carry = "";
  let stderr = "";
  let gone = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  // Only the tail is kept: a server that writes without stopping must not
  // spend the memory the agent holding it runs in.
  child.stderr?.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-8192)));
  /** Settles everything outstanding against a server that is no longer
   *  there. A command that could not be spawned at all emits `error` and
   *  never `exit`, so both endings have to arrive here — a call left waiting
   *  on a settlement nothing is coming to make is a turn that hangs. */
  const ended = (why: string): void => {
    gone = why;
    for (const fail of failures.values()) fail(`${gone}${stderr ? `: ${stderr}` : ""}`);
    answers.clear();
    failures.clear();
  };
  child.on("error", (err) => ended(`it could not be started: ${err.message}`));
  child.on("exit", (code, signal) =>
    ended(signal ? `it was stopped by ${signal}` : `it exited with status ${code}`),
  );
  child.stdout?.on("data", (chunk: string) => {
    carry += chunk;
    let newline = carry.indexOf("\n");
    while (newline !== -1) {
      const line = carry.slice(0, newline).trim();
      carry = carry.slice(newline + 1);
      // A line this end cannot read is dropped rather than thrown out of a
      // stream handler nothing is prepared to catch, which would take this
      // whole agent down over one malformed message.
      if (line.length > 0) {
        try {
          const message = JSON.parse(line) as {
            id?: number;
            result?: unknown;
            error?: { message?: string };
          };
          if (message.id !== undefined) {
            if (message.error) failures.get(message.id)?.(message.error.message ?? "refused");
            else answers.get(message.id)?.(message.result);
            answers.delete(message.id);
            failures.delete(message.id);
          }
        } catch {
          // Nothing to deliver it to.
        }
      }
      newline = carry.indexOf("\n");
    }
  });

  let nextCall = 1;
  const write = (message: unknown): void => {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method: string, params: unknown): Promise<unknown> => {
    if (gone) return Promise.reject(new Error(`this tool server is not running: ${gone}`));
    const id = nextCall++;
    const answered = new Promise<unknown>((resolve, reject) => {
      answers.set(id, resolve);
      failures.set(id, (why) => reject(new Error(why)));
    });
    write({ jsonrpc: "2.0", id, method, params });
    // Cleared however the call settles, not only when it expires. A timer
    // left running holds this process's event loop open for its whole
    // length, so an agent whose client has already gone would stand there
    // for the rest of it rather than ending with the session it belongs to.
    let expiry: NodeJS.Timeout | undefined;
    return Promise.race([
      answered,
      new Promise<never>((_, reject) => {
        expiry = setTimeout(
          () => reject(new Error(`${method} was never answered${stderr ? `: ${stderr}` : ""}`)),
          TOOL_CALL_MS,
        );
      }),
    ]).finally(() => clearTimeout(expiry));
  };

  const opened = (async () => {
    await request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "stub-acp-agent", version: "1" },
    });
    write({ jsonrpc: "2.0", method: "notifications/initialized" });
  })();

  return {
    child,
    async call(name, args) {
      await opened;
      const answer = (await request("tools/call", { name, arguments: args })) as {
        content?: Array<{ text?: string }>;
        isError?: boolean;
      };
      const said = (answer.content ?? []).map((part) => part.text ?? "").join("");
      if (answer.isError) throw new Error(said || "this tool call failed and said nothing");
      return said;
    },
  };
}

function toolServerNamed(name: string): ToolServer {
  const held = toolServers.get(name);
  if (held) return held;
  const named = offeredServers.find((server) => server.name === name);
  if (!named || typeof named.command !== "string")
    throw new Error(`this agent was told about no tool server named ${name}`);
  const started = startToolServer({ command: named.command, args: named.args ?? [] });
  toolServers.set(name, started);
  return started;
}

/** Ends every tool server this agent started. An adapter's servers are its
 *  own children and go when it does; left standing, they would outlive the
 *  session that named them. */
function stopToolServers(): void {
  for (const server of toolServers.values()) server.child.kill("SIGKILL");
  toolServers.clear();
}

/** One tool call, from telling the client about it through telling the client
 *  how it went — the shape a real adapter reports a tool call in, and the
 *  only reason the Execution Log has an entry for one at all. */
async function callTool(step: Extract<Directive, { callTool: string }>): Promise<void> {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: step.toolCallId,
        ...(step.title === undefined ? {} : { title: step.title }),
        rawInput: step.arguments,
        status: "pending",
      },
    },
  });
  let status = "completed";
  let said: string;
  try {
    said = await toolServerNamed(step.server).call(step.callTool, step.arguments);
  } catch (err) {
    status = "failed";
    said = err instanceof Error ? err.message : String(err);
  }
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: step.toolCallId,
        status,
        content: [{ type: "content", content: { type: "text", text: said } }],
      },
    },
  });
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
    if ("callTool" in step) {
      await callTool(step);
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

// The client's end going is this agent's end going too, and a tool server it
// started is its own child: nothing else on the machine holds one, so one
// left standing here is one nothing will ever stop.
createInterface({ input: process.stdin }).on("close", stopToolServers).on("line", (line) => {
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
    offeredServers =
      (msg.params as { mcpServers?: Array<{ name?: string; command?: string; args?: string[] }> })
        ?.mcpServers ?? [];
    const marker = process.env.LYKEION_STUB_SESSION_NEW_MARKER;
    if (marker) appendFileSync(marker, `${process.pid}\n`);
    // What the client actually sent, kept where a test can read it. A session
    // is opened once, so this is written rather than appended: what is wanted
    // is the object, not a log of them.
    const params = process.env.LYKEION_STUB_SESSION_NEW_PARAMS;
    if (params) writeFileSync(params, JSON.stringify(msg.params ?? null));
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
