import { spawn } from "node:child_process";

/** How much of an adapter's stderr to keep. Enough to carry a stack or a
 *  usage message into a failure reason, bounded so a chatty adapter cannot
 *  grow this without limit. */
const STDERR_TAIL_BYTES = 4096;

/** The most a single buffered stdout line is allowed to grow while waiting
 *  for its terminating newline. Every ACP message is one JSON object on one
 *  line, and even a large tool-call result stays well inside this; a line
 *  that reaches it without ending is not going to end, and buffering it
 *  forever would let one wedged adapter grow this process without bound. */
const STDOUT_LINE_MAX_BYTES = 1_048_576;

/** How long close() gives a SIGTERM to work before it stops asking and
 *  sends SIGKILL instead. Long enough for an adapter that traps the signal
 *  to flush and leave on its own; short enough that closing a connection
 *  never waits on a process that has decided not to. */
const SIGKILL_ESCALATION_MS = 1000;

export interface AcpConnection {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  onRequest(method: string, handler: (params: unknown) => Promise<unknown>): void;
  onNotify(method: string, handler: (params: unknown) => void): void;
  /** The last 4 KiB the adapter wrote to stderr, for a failure reason. */
  stderrTail(): string;
  close(): Promise<void>;
}

interface Incoming {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * Speaks JSON-RPC 2.0 to a subprocess over stdio, one object per line. The
 * conversation runs both ways: an agent asks the client for permission as
 * often as the client asks the agent for work, so this is a peer rather than
 * a caller.
 *
 * Spawned with an argument array and never through a shell — a command name
 * out of a catalogue is still a string, and a shell would give it meaning it
 * should not have.
 */
export function connectAcp(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<AcpConnection> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const requestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();
  const notifyHandlers = new Map<string, (params: unknown) => void>();
  let stderr = "";
  let buffered = "";
  let exited: Error | undefined;
  // Set synchronously the moment close() is called, so a request racing it
  // in the same tick sees the connection is over immediately rather than
  // only once the child has actually finished exiting.
  let closed = false;

  // A stream that has already ended or been destroyed cannot take a write,
  // and the process on the other end of it is not going to read one either
  // way — silently dropping it here is what keeps a write from throwing
  // into a data handler nothing calling it is prepared to catch.
  const write = (message: unknown): void => {
    if (child.stdin.destroyed || child.stdin.writableEnded) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });

  child.stdout.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    if (buffered.length > STDOUT_LINE_MAX_BYTES) {
      die(`the agent adapter sent a line over ${STDOUT_LINE_MAX_BYTES} bytes without a newline`);
      buffered = "";
      return;
    }
    let cut = buffered.indexOf("\n");
    while (cut !== -1) {
      const line = buffered.slice(0, cut).trim();
      buffered = buffered.slice(cut + 1);
      cut = buffered.indexOf("\n");
      if (line) handle(line);
    }
  });

  // An adapter that dies takes every call still waiting on it with it.
  // Leaving them pending would hang the turn on a process that is gone.
  const die = (reason: string): void => {
    exited = new Error(reason);
    for (const { reject } of pending.values()) reject(exited);
    pending.clear();
  };
  child.on("error", (err) => die(`the agent adapter could not be started: ${err.message}`));
  // Unconditional: a dead adapter is unusable whether or not anything
  // happens to be in flight the instant it goes, since the very next call
  // would find it gone regardless.
  child.on("exit", (code, signal) => {
    die(`the agent adapter exited (${signal ?? `code ${code}`})`);
  });
  // Without a listener, an unhandled error on this stream is fatal to the
  // whole process rather than to the one connection it belongs to — a
  // broken pipe here must not take the daemon down with it.
  child.stdin.on("error", (err) => die(`writing to the agent adapter failed: ${err.message}`));

  function handle(line: string): void {
    let msg: Incoming;
    try {
      msg = JSON.parse(line) as Incoming;
    } catch {
      // A line that is not JSON is the adapter writing to the wrong stream,
      // not a message. It goes with the diagnostics rather than throwing
      // inside a data handler, where nothing could catch it.
      stderr = (stderr + line + "\n").slice(-STDERR_TAIL_BYTES);
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      const handler = requestHandlers.get(msg.method);
      if (!handler) {
        write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `no such method: ${msg.method}` } });
        return;
      }
      void handler(msg.params).then(
        (result) => write({ jsonrpc: "2.0", id: msg.id, result }),
        (err: unknown) =>
          write({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          }),
      );
      return;
    }
    if (msg.method !== undefined) {
      notifyHandlers.get(msg.method)?.(msg.params);
      return;
    }
    if (typeof msg.id === "number") {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    }
  }

  const connection: AcpConnection = {
    request(method, params) {
      if (exited) return Promise.reject(exited);
      if (closed) return Promise.reject(new Error("the connection is closed"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      write({ jsonrpc: "2.0", method, params });
    },
    onRequest(method, handler) {
      requestHandlers.set(method, handler);
    },
    onNotify(method, handler) {
      notifyHandlers.set(method, handler);
    },
    stderrTail() {
      return stderr;
    },
    close() {
      closed = true;
      return new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const escalate = setTimeout(() => child.kill("SIGKILL"), SIGKILL_ESCALATION_MS);
        escalate.unref?.();
        child.once("exit", () => {
          clearTimeout(escalate);
          resolve();
        });
        child.stdin.end();
        child.kill("SIGTERM");
      });
    },
  };
  return Promise.resolve(connection);
}
