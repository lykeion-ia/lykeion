import { afterEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireControl,
  callControl,
  ControlHeld,
  controlFilePath,
  inspectClaim,
  isProcessAlive,
  probeControl,
  readControlFile,
  removeControlFile,
  removeControlFileIf,
  startControlServer,
  waitForExit,
  type ControlFile,
  type ControlHandlers,
  type ControlServer,
} from "./control";
import { startPairing, type PairingSession } from "./pairing";

const TOKEN = "a-control-token-as-long-as-a-real-one-is-ok";

const dirs: string[] = [];
const servers: ControlServer[] = [];
const sessions: PairingSession[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const session of sessions.splice(0)) await session.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-control-"));
  dirs.push(dir);
  return dir;
}

/** A pid that named a real process and no longer does — a machine that was
 *  killed outright, or lost power, leaves exactly this behind. Spawned and
 *  waited on rather than invented, because a number picked out of the air
 *  could belong to something else on the machine running these. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", () => resolve(child.pid ?? 0));
  });
}

/** A port that was really bound and really given up, so a connection to it
 *  is refused the way one to a daemon that is gone would be. Asked for from
 *  the operating system rather than picked, which would risk landing on
 *  something else on the machine running these. */
async function portNobodyIsOn(): Promise<number> {
  const server = await startControlServer({
    token: TOKEN,
    handlers: {
      status: () => ({}),
      stop: () => {},
      setAdapterConsent: () => {},
      mintLink: () => ({ link: "http://127.0.0.1/?nonce=unused", kind: "pairing" }),
      pairWithCode: async () => ({ paired: true }),
    },
  });
  const { port } = server;
  await server.close();
  return port;
}

async function control(handlers: Partial<ControlHandlers> = {}): Promise<ControlFile> {
  const server = await startControlServer({
    token: TOKEN,
    handlers: {
      status: () => ({ running: true, version: "0.1.0" }),
      stop: () => {},
      setAdapterConsent: () => {},
      mintLink: () => ({ link: "http://127.0.0.1/?nonce=unused", kind: "pairing" }),
      pairWithCode: async () => ({ paired: true }),
      ...handlers,
    },
  });
  servers.push(server);
  return { pid: process.pid, port: server.port, token: TOKEN };
}

/** A control server backed by a real pairing session rather than stub
 *  handlers, for the tests that care what `status` and `/link` actually do
 *  to that session's nonce — `control()`'s handlers above answer with fixed
 *  objects and have no nonce to rotate. */
async function runningDaemon(): Promise<{ file: ControlFile; session: PairingSession }> {
  const session = await startPairing({ port: 0, dataDir: freshDir() });
  const server = await startControlServer({
    token: TOKEN,
    handlers: {
      status: () => ({ running: true, port: session.port }),
      stop: () => {},
      setAdapterConsent: () => {},
      mintLink: () => ({ link: session.rotateNonce(), kind: "pairing" }),
      pairWithCode: async () => ({ paired: true }),
    },
  });
  servers.push(server);
  sessions.push(session);
  return { file: { pid: process.pid, port: server.port, token: TOKEN }, session };
}

it("says a process that is running is running, and one that is gone is gone", async () => {
  expect(isProcessAlive(process.pid)).toBe(true);
  expect(isProcessAlive(await deadPid())).toBe(false);
});

it("refuses a pid that names a process group rather than a process", () => {
  expect(isProcessAlive(0)).toBe(false);
  expect(isProcessAlive(-1)).toBe(false);
});

it("claims a data directory and writes down how to reach the daemon holding it", async () => {
  const dir = freshDir();
  const file = await control();
  await acquireControl(dir, file);
  expect(readControlFile(dir)).toEqual(file);
});

it("keeps the claim readable by nobody but the account that made it", async () => {
  const dir = freshDir();
  await acquireControl(dir, await control());
  expect(statSync(controlFilePath(dir)).mode & 0o777).toBe(0o600);
});

it("refuses a second daemon on the same data directory, naming the one already there", async () => {
  const dir = freshDir();
  // A real daemon on the other side of the claim: a live pid and a control
  // port that answers the token the claim carries, which is what being
  // held actually means.
  const held = await control();
  await acquireControl(dir, held);

  let refusal: unknown;
  try {
    await acquireControl(dir, { pid: process.pid, port: held.port + 1, token: "another" });
  } catch (err) {
    refusal = err;
  }
  expect(refusal).toBeInstanceOf(ControlHeld);
  expect((refusal as ControlHeld).pid).toBe(held.pid);
  expect((refusal as Error).message).toContain(String(held.pid));
  // The one that lost changed nothing about the one that won.
  expect(readControlFile(dir)).toEqual(held);
});

it("takes over a claim left behind by a process that is no longer running", async () => {
  const dir = freshDir();
  await acquireControl(dir, { pid: await deadPid(), port: 4321, token: "stale" });
  const file = await control();
  await acquireControl(dir, file);
  expect(readControlFile(dir)).toEqual(file);
});

it("takes over a claim whose pid is alive but is not this daemon", async () => {
  // What a reboot leaves behind. Pids are handed out again, low ones within
  // minutes, so a claim written before a machine lost power comes back
  // naming a live process that has never heard of this daemon. Believing
  // the pid alone would hold this directory shut for good.
  const dir = freshDir();
  const closedPort = await portNobodyIsOn();
  await acquireControl(dir, { pid: process.pid, port: closedPort, token: "from-before-the-reboot" });
  const file = await control();
  await acquireControl(dir, file);
  expect(readControlFile(dir)).toEqual(file);
});

it("is not shut out by a lock left behind by a daemon killed part-way through a takeover", async () => {
  // Taking a directory over happens behind a lock, so that two daemons
  // cannot both clear the same abandoned claim. A daemon killed while
  // holding that lock leaves it on disk, and a lock nobody can be talked out
  // of would be a directory no daemon ever starts on again — the same dead
  // end an unbreakable claim would be, one file along.
  const dir = freshDir();
  await acquireControl(dir, { pid: await deadPid(), port: await portNobodyIsOn(), token: "stale" });
  writeFileSync(join(dir, "control.reclaim"), JSON.stringify({ pid: await deadPid(), at: Date.now() }));

  const file = await control();
  await acquireControl(dir, file);
  expect(readControlFile(dir)).toEqual(file);
});

it("is not shut out by a lock naming a pid that has since been handed to something else", async () => {
  // The liveness check alone cannot see this one. A machine that lost power
  // mid-takeover comes back with a lock naming a pid that is alive and has
  // never heard of this daemon, so age decides it: a lock is held for a few
  // file operations, and one that has been there far longer than that is not
  // being held by anybody.
  const dir = freshDir();
  await acquireControl(dir, { pid: await deadPid(), port: await portNobodyIsOn(), token: "stale" });
  writeFileSync(
    join(dir, "control.reclaim"),
    JSON.stringify({ pid: process.pid, at: Date.now() - 60_000 }),
  );

  const file = await control();
  await acquireControl(dir, file);
  expect(readControlFile(dir)).toEqual(file);
});

it("leaves no lock behind after taking a directory over", async () => {
  const dir = freshDir();
  await acquireControl(dir, { pid: await deadPid(), port: await portNobodyIsOn(), token: "stale" });
  await acquireControl(dir, await control());
  expect(statSync(join(dir, "control.reclaim"), { throwIfNoEntry: false })).toBeUndefined();
});

it("knows a daemon that answers for its claim from one that has gone", async () => {
  const dir = freshDir();
  const file = await control();
  await acquireControl(dir, file);
  expect(await inspectClaim(dir)).toEqual({ file, state: "answering" });

  const abandoned = { ...file, port: await portNobodyIsOn() };
  writeFileSync(controlFilePath(dir), JSON.stringify(abandoned));
  expect(await inspectClaim(dir)).toEqual({ file: abandoned, state: "gone" });
});

it("does not call a process gone just because it did not answer", async () => {
  // The case that decides whether this is safe. A daemon that is alive but
  // not scheduled — a laptop resuming from suspend, a process under a
  // debugger, a machine deep in swap — accepts the connection and says
  // nothing. Reading that as absence hands its directory to a second daemon
  // while the first is still heartbeating as the same machine.
  const silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const address = silent.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const sockets: Socket[] = [];
  silent.on("connection", (socket) => sockets.push(socket));

  try {
    const state = await probeControl({ pid: process.pid, port, token: TOKEN });
    expect(state).toBe("silent");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
}, 20_000);

it("refuses to take a directory from a process that is there but not answering", async () => {
  const dir = freshDir();
  const silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const address = silent.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const sockets: Socket[] = [];
  silent.on("connection", (socket) => sockets.push(socket));
  writeFileSync(controlFilePath(dir), JSON.stringify({ pid: process.pid, port, token: "theirs" }));

  try {
    let refusal: unknown;
    await acquireControl(dir, await control()).catch((err: unknown) => (refusal = err));
    expect(refusal).toBeInstanceOf(ControlHeld);
    expect((refusal as ControlHeld).state).toBe("silent");
    expect((refusal as Error).message).toContain("may be paused or stuck");
    expect(readControlFile(dir)!.token).toBe("theirs");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
}, 20_000);

it("keeps answering for itself after it has let go of the event loop", async () => {
  // A daemon on its way out that has not managed to exit yet still has to
  // be findable. Going quiet at the moment of release would make it look
  // exactly like a pid that was reused, and the next start would take the
  // directory out from under a process still running on it.
  const dir = freshDir();
  const file = await control();
  await acquireControl(dir, file);
  servers[servers.length - 1]!.release();
  expect(await inspectClaim(dir)).toEqual({ file, state: "answering" });
});

it("ends the connections it is holding when it lets go of the event loop", async () => {
  // Release keeps the endpoint answering, which is the point of it — but a
  // socket somebody already had open is a handle of its own, and leaving it
  // attached would keep this process alive on a client that may never speak
  // again.
  const file = await control();
  const server = servers.pop()!;
  const socket = connect(file.port, "127.0.0.1");
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write("POST /status HTTP/1.1\r\nHost: 127.0.0.1\r\n");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const ended = new Promise<"ended">((resolve) => socket.once("close", () => resolve("ended")));
  server.release();
  const outcome = await Promise.race([
    ended,
    new Promise<"still attached">((resolve) => setTimeout(() => resolve("still attached"), 2000)),
  ]);
  socket.destroy();
  await server.close();
  expect(outcome).toBe("ended");
});

it("takes over a claim that cannot be read as one at all", async () => {
  const dir = freshDir();
  writeFileSync(controlFilePath(dir), "{ this is not json");
  expect(readControlFile(dir)).toBeUndefined();
  const file = await control();
  await acquireControl(dir, file);
  expect(readControlFile(dir)!.pid).toBe(file.pid);
});

it("removes a claim only while it is still the one it was handed", async () => {
  const dir = freshDir();
  const mine = await control();
  await acquireControl(dir, mine);
  const somebodyElse = { ...mine, pid: mine.pid + 1, token: "theirs" };

  removeControlFileIf(dir, somebodyElse);
  expect(readControlFile(dir)).toEqual(mine);
  removeControlFileIf(dir, mine);
  expect(readControlFile(dir)).toBeUndefined();
});

it("reads nothing from a data directory no daemon has claimed", () => {
  const dir = freshDir();
  expect(readControlFile(dir)).toBeUndefined();
  removeControlFile(dir);
  expect(readControlFile(dir)).toBeUndefined();
});

it("answers status to a call carrying the token", async () => {
  const file = await control({ status: () => ({ running: true, paired: false }) });
  const answer = await callControl(file, "/status");
  expect(answer.status).toBe(200);
  expect(answer.body).toEqual({ running: true, paired: false });
});

it("answers status without minting a link, so polling costs nothing", async () => {
  const daemon = await runningDaemon();
  const before = daemon.session.nonce;
  const first = await callControl(daemon.file, "/status");
  const second = await callControl(daemon.file, "/status");
  expect(daemon.session.nonce).toBe(before);
  expect((first.body as Record<string, unknown>).pairingLink).toBeUndefined();
  expect((second.body as Record<string, unknown>).port).toBe(daemon.session.port);
});

it("mints a fresh link only when one is asked for by name", async () => {
  const daemon = await runningDaemon();
  const before = daemon.session.nonce;
  const answer = await callControl(daemon.file, "/link");
  expect(daemon.session.nonce).not.toBe(before);
  expect((answer.body as { link: string }).link).toContain(daemon.session.nonce);
});

it("passes on why there is no link rather than answering as a broken server", async () => {
  // A daemon that has not opened its page yet, which is every daemon for the
  // stretch between claiming its directory and finishing its startup. The
  // handler used to throw here, and a throw inside this server is caught by
  // the same catch every genuine bug lands in: a 500 saying "the control
  // server failed", with the one sentence that explained anything thrown
  // away. 503 is the honest code — it is this daemon, and it will have one.
  const file = await control({
    mintLink: () => ({ unavailable: "this daemon is still starting up and has no page to open yet" }),
  });
  const answer = await callControl(file, "/link");
  expect(answer.status).toBe(503);
  expect(answer.body).toEqual({
    error: "this daemon is still starting up and has no page to open yet",
  });
});

it("carries an adapter acceptance, and a withdrawal, through to the handler", async () => {
  // The pairing page asks the question; this is the only way the answer gets
  // back to the daemon that has to act on it.
  const calls: Array<[string, string, boolean]> = [];
  const file = await control({
    setAdapterConsent: (agent, command, accepted) => calls.push([agent, command, accepted]),
  });
  expect((await callControl(file, "/adapters/accept?agent=claude&command=claude-agent-acp")).status).toBe(200);
  expect((await callControl(file, "/adapters/revoke?agent=claude&command=claude-agent-acp")).status).toBe(200);
  expect(calls).toEqual([
    ["claude", "claude-agent-acp", true],
    ["claude", "claude-agent-acp", false],
  ]);
});

it("refuses a consent call that names only half of what it needs", async () => {
  // A key written from half a request is one no probe will ever look up, so
  // the button would appear to work and change nothing at all.
  const calls: unknown[] = [];
  const file = await control({ setAdapterConsent: (...args) => calls.push(args) });
  expect((await callControl(file, "/adapters/accept?agent=claude")).status).toBe(400);
  expect((await callControl(file, "/adapters/accept?command=claude-agent-acp")).status).toBe(400);
  expect((await callControl(file, "/adapters/accept")).status).toBe(400);
  expect(calls).toEqual([]);
});

it("refuses a control call carrying no token at all", async () => {
  const file = await control();
  const res = await fetch(`http://127.0.0.1:${file.port}/status`, { method: "POST" });
  expect(res.status).toBe(401);
});

it("refuses a control call carrying another daemon's token", async () => {
  const file = await control();
  // The same length as the real one, so what refuses this is the comparison
  // itself rather than the length check standing in front of it.
  const forged = `b${TOKEN.slice(1)}`;
  expect(forged).toHaveLength(TOKEN.length);
  const answer = await callControl({ ...file, token: forged }, "/status");
  expect(answer.status).toBe(401);
});

it("refuses a control call carrying a token of a different length", async () => {
  const file = await control();
  const answer = await callControl({ ...file, token: `${TOKEN}extra` }, "/status");
  expect(answer.status).toBe(401);
});

it("tells an unauthorized caller nothing about what it is talking to", async () => {
  const file = await control();
  const res = await fetch(`http://127.0.0.1:${file.port}/stop`, { method: "GET" });
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({ error: "that call did not carry this daemon's control token" });
});

it("refuses a control route it does not have", async () => {
  const file = await control();
  expect((await callControl(file, "/restart")).status).toBe(404);
});

it("answers a stop, and hands over to the shutdown it asked for", async () => {
  let handOver!: () => void;
  // Awaited rather than read as a flag: a stop that answered and then never
  // told the daemon to shut down leaves this test waiting, which is what
  // the daemon itself would do.
  const handedOver = new Promise<void>((resolve) => {
    handOver = resolve;
  });
  const file = await control({ stop: () => handOver() });
  const answer = await callControl(file, "/stop");
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({ stopping: true, pid: process.pid });
  await handedOver;
});

it("ends a connection that is mid-request rather than waiting it out", async () => {
  const file = await control();
  // Out of the list the teardown closes: this test is about what closing
  // does, so it does the closing itself.
  const server = servers.pop()!;
  const socket = connect(file.port, "127.0.0.1");
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  // A request begun and never finished. The server is holding something it
  // considers in flight, which no amount of waiting resolves — any account
  // on this machine can open one of these, and a daemon told to stop must
  // not be held open by it.
  socket.write("POST /status HTTP/1.1\r\nHost: 127.0.0.1\r\n");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const outcome = await Promise.race([
    server.close().then(() => "closed" as const),
    new Promise<"still holding on">((resolve) => setTimeout(() => resolve("still holding on"), 2000)),
  ]);
  socket.destroy();
  expect(outcome).toBe("closed");
});

it("waits for a process to actually be gone", async () => {
  expect(await waitForExit(await deadPid(), 1000)).toBe(true);
});

it("gives up waiting on a process that stays", async () => {
  const started = Date.now();
  expect(await waitForExit(process.pid, 200)).toBe(false);
  expect(Date.now() - started).toBeGreaterThanOrEqual(190);
});

// ---------------------------------------------------------------------------
// The code, handed to a daemon that is already running.
// ---------------------------------------------------------------------------

it("hands a code to the daemon and answers what became of it", async () => {
  const carried: string[] = [];
  const file = await control({
    pairWithCode: async (code) => {
      carried.push(code);
      return { paired: true };
    },
  });

  const answer = await callControl(file, "/pair?code=one-time-code");

  expect(answer.status).toBe(200);
  expect(answer.body).toEqual({ paired: true });
  expect(carried).toEqual(["one-time-code"]);
});

it("gives back the daemon's own reason when a code will not redeem", async () => {
  // The lab is the only party that knows why — expired, already spent, for a
  // different machine — and a command that printed its own guess instead
  // would send somebody to check the wrong thing.
  const file = await control({
    pairWithCode: async () => ({ paired: false, error: "that code has expired" }),
  });

  const answer = await callControl(file, "/pair?code=stale");

  expect(answer.status).toBe(400);
  expect(answer.body).toEqual({ error: "that code has expired" });
});

it("refuses a pair call carrying no code at all", async () => {
  const file = await control({ pairWithCode: async () => ({ paired: true }) });
  expect((await callControl(file, "/pair")).status).toBe(400);
});
