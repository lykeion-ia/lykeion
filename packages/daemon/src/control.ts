import { randomBytes } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import {
  Agent,
  createServer,
  request,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { endAndFlush } from "./pairing";
import { secretsMatch } from "./secrets";

const CONTROL_FILE = "control.json";

/** Held for the few milliseconds it takes to look at an abandoned claim,
 *  clear it and publish another in its place. Named beside the claim it
 *  guards, in the directory being claimed, because that directory is exactly
 *  the thing two daemons can be fighting over. */
const RECLAIM_LOCK_FILE = "control.reclaim";

/** How long a start waits for whoever is reclaiming the directory to finish.
 *  Holding this lock is a handful of file operations and at most one probe
 *  of a port nobody is on, so a wait anywhere near this long means something
 *  has gone wrong rather than that the queue is busy. */
const RECLAIM_WAIT_MS = 15_000;

/** How old a lock has to be before it is broken whatever pid it names. The
 *  liveness check below cannot see everything: a machine that lost power
 *  mid-reclaim comes back with a lock naming a pid that has since been handed
 *  to something unrelated, and believing that pid would leave the directory
 *  unusable with no way out from inside the product. Far longer than any real
 *  hold, so a lock that is merely in use is never broken by age. */
const RECLAIM_STALE_MS = 5000;

/** How often a start waiting on the lock looks again. */
const RECLAIM_POLL_MS = 10;

const BEARER_PREFIX = "Bearer ";

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  // Every control call is one question from a command that is about to
  // end. Saying so lets the socket close on its own the moment the answer
  // is out, rather than sitting in a keep-alive pool that both sides then
  // have to be torn away from.
  connection: "close",
};

/** How long a control call waits for an answer. A daemon on loopback either
 *  answers in microseconds or is wedged; waiting minutes on the second case
 *  only hides it. */
const CALL_TIMEOUT_MS = 5000;

/** How long the question "are you there?" waits. Shorter than a real call,
 *  because running out of patience on this one is safe: an answer that does
 *  not arrive means the claim is left alone, so the only thing a short wait
 *  can cost is a command saying "not answering" a few seconds sooner. */
const PROBE_TIMEOUT_MS = 1000;

/** How often a wait for a process to end looks again. */
const POLL_INTERVAL_MS = 50;

/**
 * What a running daemon publishes about how to reach it: which process it
 * is, which loopback port answers for it, and the secret that port requires.
 *
 * The token is what makes the port safe to have open at all. Loopback is
 * reachable by every account on the machine, and a shared lab workstation
 * has several — without a secret, any of them could stop this daemon or ask
 * it to mint a pairing link into their own browser. With one, doing either
 * takes reading this file, which is the same bar as reading the bearer
 * token sitting next to it.
 */
export interface ControlFile {
  pid: number;
  port: number;
  token: string;
}

export function controlFilePath(dir: string): string {
  return join(dir, CONTROL_FILE);
}

/** A file's whole contents, or `undefined` when there is nothing there to
 *  read. Used for the two files here whose exact bytes are the thing being
 *  compared, rather than anything parsed out of them. */
function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * What a control file's contents say, or `undefined` when they are not a
 * claim. Not the JSON this writes answers the same way an empty file does,
 * because both leave a caller with the same nothing: no pid to ask after and
 * no port to call. Refusing to start on a garbled file instead would leave a
 * daemon that cannot run and cannot be stopped, with a hand edit as the only
 * way out — and unlike the state file next to it, nothing here is
 * irreplaceable, since a daemon writes the whole of it again every time it
 * starts.
 */
function parseControlFile(raw: string): ControlFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  const file = parsed as Partial<ControlFile> | null;
  if (
    !file ||
    typeof file.pid !== "number" ||
    typeof file.port !== "number" ||
    typeof file.token !== "string"
  )
    return undefined;
  return { pid: file.pid, port: file.port, token: file.token };
}

/** What the control file says, or `undefined` when there is nothing usable
 *  there — missing, unreadable, or not a claim. */
export function readControlFile(dir: string): ControlFile | undefined {
  const raw = readTextFile(controlFilePath(dir));
  return raw === undefined ? undefined : parseControlFile(raw);
}

export function removeControlFile(dir: string): void {
  rmSync(controlFilePath(dir), { force: true });
}

/** Removes a file only while it still says exactly what it said when it was
 *  read. The same care `removeControlFileIf` takes, over bytes rather than a
 *  parsed claim: a file that has changed since is somebody else's, and
 *  deleting it would be deleting a hold that is being relied on. */
function removeFileIfUnchanged(path: string, expected: string): void {
  if (readTextFile(path) !== expected) return;
  rmSync(path, { force: true });
}

/**
 * Removes the claim only while it is still the one `expected` describes.
 * A daemon that has finished with a directory can be racing a daemon that
 * has just taken it over, and "delete the control file" from the one on its
 * way out would then delete the newcomer's claim rather than its own,
 * leaving a running daemon that nothing can find and a directory anybody
 * can start a second daemon on.
 */
export function removeControlFileIf(dir: string, expected: ControlFile): void {
  const held = readControlFile(dir);
  if (!held || held.pid !== expected.pid || held.port !== expected.port || held.token !== expected.token)
    return;
  removeControlFile(dir);
}

/**
 * Whether a process with this pid exists. Signal 0 asks the kernel that
 * question without delivering anything. `EPERM` is an answer of yes: the
 * process is there, it just belongs to another account. A pid of zero or
 * below names a process group, or nothing at all, and never one process —
 * `process.kill` would signal the whole group — so it is refused before it
 * gets that far.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * What asking after a claim found.
 *
 * `answering` and `silent` are both reasons to keep away, and the difference
 * between them is only what to tell a person. `gone` is the single case in
 * which a claim may be taken over, and it is deliberately the narrow one:
 * getting it wrong the other way puts two daemons on one machine identity,
 * which is the thing this whole file exists to prevent.
 */
export type ClaimState = "answering" | "silent" | "gone";

export interface Claim {
  file: ControlFile;
  state: ClaimState;
}

/** What a person is told when the directory they asked for is taken by a
 *  daemon that is answering for itself. One sentence, wherever it is noticed
 *  from, so a daemon refused before it starts and one refused as it starts
 *  say the same thing. */
export function heldMessage(dir: string, pid: number): string {
  return `another daemon is already serving ${dir} as pid ${pid} — stop that one with "lykeion-daemon stop"`;
}

/** And when it is taken by one that is there but not talking. A person needs
 *  to know that is what happened, because the way out is not `stop`. */
export function silentMessage(dir: string, pid: number, port: number): string {
  return (
    `pid ${pid} is holding ${dir} and is not answering on port ${port} — it may be paused or stuck, ` +
    `so this is leaving it alone rather than starting a second daemon on the same machine`
  );
}

/** Raised when a data directory already belongs to a process that has not
 *  been shown to be finished with it. Carries the pid so a caller can say
 *  which one, rather than leaving a person to find it. */
export class ControlHeld extends Error {
  pid: number;
  port: number;
  state: ClaimState;

  constructor(dir: string, file: ControlFile, state: ClaimState) {
    super(
      state === "answering"
        ? heldMessage(dir, file.pid)
        : silentMessage(dir, file.pid, file.port),
    );
    this.pid = file.pid;
    this.port = file.port;
    this.state = state;
  }
}

/**
 * Publishes the claim if and only if nothing is there, answering whether it
 * won. Written under a temporary name and then linked into place: the link
 * fails outright when the target exists, so only one of any number of
 * simultaneous daemons is told yes, and the claim it publishes is complete
 * from the instant it is visible.
 *
 * Creating the file and then filling it in — which is what one exclusive
 * write is, underneath — is not the same thing. It leaves a window in which
 * the claim exists and says nothing, and a daemon that reads it in that
 * window sees a file it cannot parse, concludes the claim was abandoned, and
 * takes the directory from a daemon that is running perfectly well. The
 * window is small and it is not theoretical: a reader spinning against a
 * creator observes an empty claim in the single-figure percents of its
 * reads.
 *
 * A filesystem that cannot link fails the claim rather than falling back to
 * the weaker write. Publishing atomically is the property this rests on, and
 * something that quietly stops providing it is worse than something that
 * says it cannot.
 *
 * The mode is set again after writing for the reason the state file's is: a
 * file already on disk keeps the permissions it has, and only an explicit
 * `chmod` says otherwise.
 */
function createExclusive(path: string, body: string): boolean {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temp, body, { mode: 0o600 });
    chmodSync(temp, 0o600);
    try {
      linkSync(temp, path);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      // Anything else means the link itself is unavailable, not that somebody
      // else got there first. Said in those terms, because the raw errno
      // reaching a terminal names a system call the person never asked for
      // and leaves them to work out what it cost them.
      throw new Error(
        `${path} could not be claimed: this filesystem does not support the ` +
          `atomic publish the claim depends on (${code ?? "unknown error"})`,
      );
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * What became of the daemon a control file names. Two questions, because a
 * pid on its own answers neither honestly: the process has to exist, and the
 * control port has to answer this file's own token.
 *
 * A pid alone is a claim that never expires. Pids are reused — low ones
 * within minutes of a reboot — so a machine that lost power mid-run comes
 * back with a control file naming a pid that now belongs to something else
 * entirely. Believing that pid holds the directory shut forever, with no way
 * out from inside the product.
 *
 * Failing to reach the port is not the opposite proof, and treating it as
 * one trades that for something worse. A daemon that is perfectly alive but
 * not scheduled — a laptop resuming from suspend, a process under a
 * debugger, a machine deep in swap — cannot answer either, and taking its
 * directory away puts a second daemon on the same machine identity. So only
 * one failure counts as proof of absence: `ECONNREFUSED`, which is the
 * kernel saying nothing is listening on that port at all. A timeout, a
 * reset, or anything else means something is there, and the answer is to
 * leave it alone and say so.
 */
export async function probeControl(file: ControlFile): Promise<ClaimState> {
  if (!isProcessAlive(file.pid)) return "gone";
  try {
    const answer = await callControl(file, "/ping", PROBE_TIMEOUT_MS);
    if (answer.status === 200) return "answering";
    // It answered, and refused this claim's own token: whatever holds that
    // port, it did not write this file.
    return answer.status === 401 ? "gone" : "silent";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ECONNREFUSED" ? "gone" : "silent";
  }
}

/** The claim on a directory and what asking after it found, or `undefined`
 *  when nobody has claimed it. */
export async function inspectClaim(dir: string): Promise<Claim | undefined> {
  const file = readControlFile(dir);
  if (!file) return undefined;
  return { file, state: await probeControl(file) };
}

/** Who is part-way through taking a directory over, and since when. */
interface ReclaimLock {
  pid: number;
  at: number;
}

function parseReclaimLock(raw: string): ReclaimLock | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  const lock = parsed as Partial<ReclaimLock> | null;
  if (!lock || typeof lock.pid !== "number" || typeof lock.at !== "number") return undefined;
  return { pid: lock.pid, at: lock.at };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `reclaim` with nobody else reclaiming the same directory, and lets go
 * of the lock however it ends.
 *
 * Taking a directory over means removing a claim, and removing a claim is
 * the one thing here that cannot be made safe on its own: reading a file and
 * then deleting it is two operations, and a claim published between them is
 * deleted by a daemon that never looked at it. That is how two daemons end
 * up both holding one machine identity, each certain it is the only one, with
 * whichever of them lost running where `stop` and `status` cannot find it —
 * they only ever see the published claim.
 *
 * So the removal is done one at a time, behind a lock published the same way
 * a claim is: written under a temporary name and linked into place, which
 * fails outright when the target exists, so exactly one of any number of
 * simultaneous starts is told yes.
 *
 * A lock that nobody stands behind is broken rather than honoured, on the
 * same reasoning that lets an abandoned claim be taken over — otherwise a
 * daemon killed in the middle of a reclaim would leave a directory no daemon
 * could ever start on again. Two rules for that, because either alone leaves
 * a way to brick it: the pid it names is not running, or it has been there
 * far longer than a reclaim takes.
 */
async function withReclaimLock<T>(dir: string, reclaim: () => Promise<T>): Promise<T> {
  const path = join(dir, RECLAIM_LOCK_FILE);
  const mine = JSON.stringify({
    pid: process.pid,
    at: Date.now(),
    nonce: randomBytes(6).toString("hex"),
  });
  const deadline = Date.now() + RECLAIM_WAIT_MS;
  for (;;) {
    if (createExclusive(path, mine)) {
      try {
        return await reclaim();
      } finally {
        // Only while it is still this process's own. A lock broken for age
        // while it was held belongs to whoever took it next, and this
        // process letting go of that one would hand a third the directory.
        removeFileIfUnchanged(path, mine);
      }
    }
    if (Date.now() >= deadline)
      throw new Error(
        `${dir} could not be claimed: another daemon has been taking it over for ` +
          `longer than ${RECLAIM_WAIT_MS}ms and nothing here has been changed`,
      );
    const raw = readTextFile(path);
    if (raw !== undefined) {
      const holder = parseReclaimLock(raw);
      if (!holder || !isProcessAlive(holder.pid) || Date.now() - holder.at > RECLAIM_STALE_MS)
        removeFileIfUnchanged(path, raw);
    }
    await sleep(RECLAIM_POLL_MS);
  }
}

/**
 * Claims a data directory for this process, or refuses because somebody
 * else has it. One directory holds one machine identity — one bearer token,
 * one runtime record at the lab — and two daemons on it would heartbeat as
 * the same machine and each overwrite what the other reported.
 *
 * A claim that no daemon stands behind is taken over rather than honoured.
 * A machine that lost power, or a daemon killed outright, has no chance to
 * clean up after itself, and a claim nobody can be talked out of would mean
 * that machine never runs a daemon again without somebody knowing to delete
 * a file.
 */
export async function acquireControl(dir: string, file: ControlFile): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const path = controlFilePath(dir);
  const body = JSON.stringify(file);
  // Nothing there at all is the ordinary case, and it needs no lock: the
  // link either lands or it does not, and the daemon it lost to is holding a
  // claim that was complete from the instant it appeared.
  if (createExclusive(path, body)) return;

  const held = await inspectClaim(dir);
  if (held && held.state !== "gone") throw new ControlHeld(dir, held.file, held.state);

  await withReclaimLock(dir, async () => {
    // Read again, under the lock. What was inspected a moment ago was
    // inspected while another start could have been half-way through taking
    // the same directory over, and this is the reading that gets acted on.
    const raw = readTextFile(path);
    if (raw !== undefined) {
      const stale = parseControlFile(raw);
      // Bytes that are not a claim at all get no say in who has the
      // directory, but they are still in the way of publishing one.
      if (stale) {
        const state = await probeControl(stale);
        if (state !== "gone") throw new ControlHeld(dir, stale, state);
      }
      removeFileIfUnchanged(path, raw);
    }
    if (createExclusive(path, body)) return;
    // A start that found the directory empty takes it without ever coming
    // through here, so losing at this point is a real outcome rather than an
    // impossible one. The one that lost reports the live winner, which is the
    // same answer it would have given had it arrived a moment later.
    throw new ControlHeld(dir, readControlFile(dir) ?? { pid: 0, port: 0, token: "" }, "answering");
  });
}

/** What the control server does when a call gets through: `status` builds
 *  the answer, `stop` begins shutting the daemon down. `stop` is called
 *  after its response has already gone out, so it is free to close the very
 *  server that answered. */
export interface ControlHandlers {
  status(): Record<string, unknown>;
  stop(): void;
}

export interface ControlServer {
  port: number;
  /**
   * Stops holding the process open without going deaf. Every connection is
   * ended and the listener is unreferenced, so the event loop can drain —
   * but the port keeps answering for as long as this process happens to
   * live. That difference is what tells a daemon still on its way out from
   * a pid that was reused by something unrelated: the first still answers
   * its own token, the second refuses the connection. Closing outright
   * would make a daemon that is slow to leave indistinguishable from one
   * that is gone, and the answer to that question decides whether another
   * daemon is allowed to start on the same machine identity.
   */
  release(): void;
  close(): Promise<void>;
}

function presentedToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith(BEARER_PREFIX) ? header.slice(BEARER_PREFIX.length) : "";
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * Starts the loopback endpoint a `status` or `stop` command talks to. The
 * port is whatever the machine has free — nobody has to configure it and
 * nothing has to be kept clear for it, because the only way to find it is
 * the control file, which is also the only way to get the token that makes
 * it answer.
 *
 * The token is checked before the method and the path, so a caller without
 * it learns nothing about what this port serves beyond that something is
 * listening.
 */
export async function startControlServer(options: {
  token: string;
  handlers: ControlHandlers;
}): Promise<ControlServer> {
  /** Set by `release`. Every connection accepted from then on is a fresh
   *  handle of its own, and a handle nobody ever closes is a process that
   *  never leaves — a caller that connects and then says nothing would keep
   *  a daemon on its way out alive for good. Unreferencing them keeps the
   *  endpoint answering without ever being the reason this process is still
   *  here. */
  let released = false;

  const server = createServer((req, res) => {
    void (async () => {
      const presented = presentedToken(req);
      if (!presented || !secretsMatch(presented, options.token))
        return sendJson(res, 401, { error: "that call did not carry this daemon's control token" });

      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (req.method !== "POST") return sendJson(res, 405, { error: "control calls are POST" });

      // Answers for the daemon's existence and changes nothing. `status`
      // cannot serve as that question: asking an unpaired daemon for its
      // status mints a pairing link and retires the last one, so a caller
      // merely checking whether anybody is home would invalidate the link a
      // researcher is holding.
      if (path === "/ping") return sendJson(res, 200, { ok: true, pid: process.pid });

      if (path === "/status") return sendJson(res, 200, options.handlers.status());

      if (path === "/stop") {
        // Answered in full before anything is torn down. What `stop` does
        // next ends this very connection, and a caller that never heard
        // back has no way to tell a daemon that is stopping from one that
        // never got the message.
        await endAndFlush(res, 200, JSON_HEADERS, JSON.stringify({ stopping: true, pid: process.pid }));
        options.handlers.stop();
        return;
      }

      return sendJson(res, 404, { error: "no such control route" });
    })().catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { error: "the control server failed" });
      console.error("[control] unhandled", err);
    });
  });

  server.on("connection", (socket) => {
    if (released) socket.unref();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  return {
    port,

    release: () => {
      released = true;
      // The connections, not just the listener. Every open socket is its own
      // handle and holds the event loop by itself, so unreferencing the
      // server without ending them would leave the process alive on
      // whichever client happened to still be attached.
      server.closeAllConnections();
      server.unref();
    },

    close: () =>
      new Promise<void>((resolve) => {
        // Both, and in this order. `close()` stops new connections and
        // waits out the ones it holds; a client that is connected but has
        // not asked anything yet is one of those, and nothing about it ever
        // resolves on its own. Ending every connection outright is what
        // lets this process actually reach the end of its event loop.
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export interface ControlAnswer {
  status: number;
  body: unknown;
}

/**
 * Asks a running daemon something, over the port and with the token its
 * control file names. Its own agent, with keep-alive off: this is one call
 * from a command that is about to exit, and a pooled socket held open after
 * the answer arrives would keep that command's own process running for as
 * long as the pool wanted it.
 */
export function callControl(
  file: ControlFile,
  path: string,
  timeoutMs: number = CALL_TIMEOUT_MS,
): Promise<ControlAnswer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: file.port,
        path,
        method: "POST",
        agent: new Agent({ keepAlive: false }),
        headers: { authorization: `${BEARER_PREFIX}${file.token}`, "content-length": "0" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let body: unknown;
          try {
            body = raw ? (JSON.parse(raw) as unknown) : {};
          } catch {
            body = { error: raw };
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`the daemon on port ${file.port} did not answer within ${timeoutMs}ms`));
    });
    req.once("error", reject);
    req.end();
  });
}

/**
 * Waits for a process to actually be gone, answering whether it went.
 * Having asked a daemon to stop is not the same as it having stopped, and
 * a command that says "stopped" on the strength of a 200 would be reporting
 * a request, not an outcome.
 */
export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isProcessAlive(pid)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
