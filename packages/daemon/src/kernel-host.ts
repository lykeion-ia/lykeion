/**
 * This machine's kernel host: one long-lived process, started here and
 * spoken to over its stdio.
 *
 * It is the first child this daemon keeps rather than drives to completion,
 * so its ending is specified rather than assumed. Every outstanding call is
 * settled when it exits — a promise nothing settles is indistinguishable
 * from a machine that has stopped answering — and a host that dies is not
 * restarted here: a caller asks for a kernel and gets a host, so restarting
 * belongs where that decision is already being made rather than in a timer
 * nobody asked for.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { isReply, type HostAsk, type HostMessage } from "./kernel-protocol";

/** How long a host that was asked to stop is given before it is killed. The
 *  same escalation an adapter gets, for the same reason: a process that has
 *  not gone after this long is not going. */
const SIGKILL_ESCALATION_MS = 1000;

/** How much of what the host wrote to stderr is kept, so a host that fails
 *  to start can say why without keeping every line it ever wrote. */
const STDERR_TAIL = 8192;

export interface KernelHost {
  call(method: string, params: unknown): Promise<unknown>;
  on(method: string, handler: (params: unknown) => void): void;
  /** What this daemon answers when the host asks it for something — the
   *  other direction of `call`. One handler per method, per host: `serve`
   *  is about this process pair and not about any one session, so whoever
   *  registers one owes it a guard against doing so again for the same
   *  host. */
  serve(method: string, handler: (params: unknown) => Promise<unknown>): void;
  stop(): Promise<void>;
  readonly running: boolean;
  stderrTail(): string;
}

export function startKernelHost(options: {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onExit?: (reason: string) => void;
}): KernelHost {
  const child: ChildProcess = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const outstanding = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Array<(params: unknown) => void>>();
  // What this daemon answers the host's own asks with. Keyed by method, one
  // handler each: a second registration for a method replaces the first
  // rather than stacking, because two answers to one ask is two replies
  // carrying the same id, and the second names an ask the host has already
  // settled.
  const served = new Map<string, (params: unknown) => Promise<unknown>>();
  let nextId = 1;
  let alive = true;
  // Set synchronously the moment stop() is called, so a call() racing it in
  // the same tick sees the host is going before it ever reaches a write —
  // alive alone is not enough, since it only turns false once exit lands,
  // which is a whole event-loop turn after stdin has already been ended.
  let closed = false;
  let stderr = "";
  // The resolver of a stop() in flight, so die() can settle it directly. A
  // spawn that never started never emits exit — only error, then close — so
  // a stop() waiting on exit alone would wait forever for an event that is
  // not coming.
  let stopResolve: (() => void) | undefined;
  // Whether the OS has actually confirmed this process exists. A signal sent
  // before that is confirmed is a signal aimed at a pid that may never be
  // assigned — killing an outcome not yet known waits on the same
  // confirmation stop() would otherwise have no way to ask for.
  let spawned = false;
  child.on("spawn", () => {
    spawned = true;
  });
  // A JSON object can arrive across two chunks. A reader that treated one
  // chunk as one line would drop whichever message the boundary fell inside,
  // and under load that is the busiest kernel's output.
  let carry = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    carry += chunk;
    let newline = carry.indexOf("\n");
    while (newline !== -1) {
      const line = carry.slice(0, newline).trim();
      carry = carry.slice(newline + 1);
      if (line.length > 0) deliver(line);
      newline = carry.indexOf("\n");
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL);
  });

  function deliver(line: string): void {
    let message: HostMessage;
    try {
      message = JSON.parse(line) as HostMessage;
    } catch {
      // A host writing a line this end cannot read has a defect. Dropping it
      // keeps every other kernel on this machine answering.
      return;
    }
    if (isReply(message)) {
      const pending = outstanding.get(message.id);
      if (!pending) return;
      outstanding.delete(message.id);
      if ("error" in message) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if ("method" in message) {
      // Something the host wants FROM this daemon: the method it wants
      // served, AND an id of its own minting saying it is waiting for the
      // answer. Both, not the id alone — the reply is written back into the
      // HOST's ask id space, so a line carrying an id and no method, answered
      // here, would put `no method named undefined` under an id that may
      // belong to an ask the host really is waiting on and settle it with
      // nonsense. That line is dropped below instead: dropping risks a wait,
      // and a wait is what the host's own `settle_all` already ends, while
      // answering risks corrupting a live ask.
      if ("id" in message) {
        answer(message);
        return;
      }
      // A notification nothing is listening for is dropped, not an error: a
      // host is free to announce more than this machine currently consumes.
      for (const handler of listeners.get(message.method) ?? []) handler(message.params);
      return;
    }
    // No outcome, no method: not an answer, not an ask, not an announcement.
    // Dropped the way a line that will not parse is, and for the same reason
    // — a host writing one has a defect, and this end going on answering
    // every other kernel on the machine is worth more than saying so.
  }

  /**
   * Runs whatever this daemon serves for one of the host's asks, and writes
   * back exactly one reply.
   *
   * A method nothing here serves is answered too, never dropped: the host is
   * blocked on this reply, and a promise nothing settles is indistinguishable
   * from a machine that has stopped answering. It is the same rule `host.py`
   * already applies to a method IT does not know.
   */
  function answer(ask: HostAsk): void {
    const handler = served.get(ask.method);
    if (handler === undefined) {
      send({
        id: ask.id,
        error: { message: `this machine's daemon serves no method named ${ask.method}` },
      });
      return;
    }
    // Wrapped rather than called bare, so a handler that throws
    // synchronously settles exactly where one that rejects does. Called
    // bare, that throw would leave this data handler — which nothing is
    // prepared to catch — and take the host's reply with it.
    void (async () => handler(ask.params))().then(
      (result) => send({ id: ask.id, result }),
      (err: unknown) =>
        send({
          id: ask.id,
          error: { message: err instanceof Error ? err.message : String(err) },
        }),
    );
  }

  /**
   * One line to the host's stdin, or the death of a host whose input stream
   * is already gone.
   *
   * A stream that has already ended or been destroyed cannot take a write,
   * and the process on the other end of it is not going to read one either
   * way — attempting it is what a data handler nothing is prepared to catch
   * would throw out of. But a stream reaches this state on a clean close as
   * often as on a failed write, and a clean close fires no `error` and no
   * `exit` on its own: skipping the write without going through `die` here
   * would leave every call still outstanding waiting on a settlement nothing
   * left is going to produce.
   *
   * Both directions go through here, which is why it is a function rather
   * than a guard inside `call`: a reply to one of the host's own asks is
   * written from inside the data handler, exactly where a throw has nobody
   * to catch it.
   */
  function send(message: unknown): void {
    if (child.stdin?.destroyed || child.stdin?.writableEnded) {
      die("its input stream is gone");
      return;
    }
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  function die(reason: string): void {
    if (!alive) return;
    alive = false;
    // Every call is settled. A promise nothing settles is indistinguishable
    // from a machine that has stopped answering, and the caller waiting on it
    // has no way to tell those apart or to give up.
    const failure = new Error(`kernel host exited (${reason})${stderr ? `: ${stderr}` : ""}`);
    for (const pending of outstanding.values()) pending.reject(failure);
    outstanding.clear();
    options.onExit?.(reason);
    // A stop() already waiting on this host is answered here rather than
    // left to the exit listener it registered itself: for a spawn that
    // never started, this is the only settlement coming.
    stopResolve?.();
    stopResolve = undefined;
  }

  // A command this machine cannot spawn at all — a name absent from PATH,
  // most often — surfaces here rather than through `exit`, and an
  // EventEmitter given no listener for its own `error` event throws that
  // error into the process that created it. Without this, a host that never
  // started would take the daemon down with it instead of leaving behind a
  // call that says so.
  child.on("error", (err) => die(`could not be started: ${err.message}`));
  child.on("exit", (code, signal) => {
    die(signal ? `signal ${signal}` : `code ${code}`);
  });
  // Without a listener, an unhandled error on this stream is fatal to the
  // whole process rather than to the one call it belongs to — a host that
  // closed its own end of the pipe, or died in the gap before `exit` above
  // has run, must not take the daemon down with it for a call that cannot be
  // delivered anyway.
  child.stdin?.on("error", (err) => die(`writing to it failed: ${err.message}`));

  return {
    get running() {
      return alive;
    },
    stderrTail: () => stderr,
    call(method, params) {
      if (!alive) return Promise.reject(new Error("kernel host exited"));
      if (closed) return Promise.reject(new Error("this machine is stopping its kernel host"));
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        // Registered before the write, so a stream already gone settles this
        // call through `die` rather than leaving it outstanding forever.
        outstanding.set(id, { resolve, reject });
        send({ id, method, params });
      });
    },
    on(method, handler) {
      listeners.set(method, [...(listeners.get(method) ?? []), handler]);
    },
    serve(method, handler) {
      served.set(method, handler);
    },
    stop() {
      closed = true;
      // Real process state, not `alive`: a write failure marks this host
      // dead for the calls it can no longer answer, but the process behind
      // it can still be standing — and a stop that trusted `alive` here
      // would return without ever sending it a signal, the exact way a
      // daemon that exits itself abandons a kernel host still running.
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        stopResolve = resolve;
        const terminate = (): void => {
          const kill = setTimeout(() => child.kill("SIGKILL"), SIGKILL_ESCALATION_MS);
          child.once("exit", () => {
            clearTimeout(kill);
            resolve();
          });
          child.stdin?.end();
          child.kill("SIGTERM");
        };
        // A spawn that has not yet been confirmed either succeeds — spawn
        // fires, and this runs then — or fails — error fires, die() runs,
        // and resolves this stop() directly without this function ever
        // being reached at all.
        if (spawned) terminate();
        else child.once("spawn", terminate);
      });
    },
  };
}
