import { afterEach, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isProcessAlive, readControlFile, waitForExit } from "./control";
import { ensureTaskDir } from "./workspace";

/**
 * The daemon as a person runs it: built, started as its own process, and
 * asked to stop from outside. Nothing here reaches into the running
 * process — every claim is made about a real pid, a real port and a real
 * file, because the two failures this file exists to catch are both a
 * process that answered and then did not leave, which no test that runs
 * inside the process can honestly observe.
 */
const src = dirname(fileURLToPath(import.meta.url));

let daemonBundle = "";
let controlBundle = "";
let raceChild = "";
let claimWriter = "";
let releaseChild = "";

const dirs: string[] = [];
const running: ChildProcess[] = [];
const servers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-lifecycle-"));
  dirs.push(dir);
  daemonBundle = join(dir, "daemon.mjs");
  controlBundle = join(dir, "control.mjs");
  raceChild = join(dir, "race.mjs");
  claimWriter = join(dir, "claim-writer.mjs");
  releaseChild = join(dir, "released.mjs");
  await build({
    entryPoints: [join(src, "main.ts")],
    outfile: daemonBundle,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  await build({
    entryPoints: [join(src, "control.ts")],
    outfile: controlBundle,
    bundle: true,
    platform: "node",
    format: "esm",
  });
  // Every copy binds its control port first, the way `serve` does, then
  // spins until a wall-clock instant they were all given, so the claims are
  // attempted within microseconds of each other rather than in whatever
  // order the machine happened to start them. Each stays up for a moment
  // afterwards, because a daemon that took the directory and immediately
  // went quiet is not the thing being tested — the others have to be able
  // to find whoever won.
  writeFileSync(
    releaseChild,
    `import { startControlServer } from ${JSON.stringify(controlBundle)};
const server = await startControlServer({ token: "t", handlers: { status: () => ({}), stop: () => {} } });
process.stdout.write(server.port + "\\n");
setTimeout(() => server.release(), 300);
// Stands in for whatever else keeps a daemon alive after it has let go:
// something with an end to it, so that anything still running afterwards is
// a handle this process failed to give up.
setTimeout(() => {}, 2000);
`,
  );
  writeFileSync(
    claimWriter,
    `import { existsSync } from "node:fs";
import { acquireControl, removeControlFile } from ${JSON.stringify(controlBundle)};
const [dir, enough] = process.argv.slice(2);
// Until the reader says it has seen what it came for, rather than for a
// fixed stretch of wall clock. A machine that publishes claims slowly should
// make this take longer, not make it stop early.
while (!existsSync(enough)) {
  await acquireControl(dir, { pid: process.pid, port: 1, token: "a-token" });
  removeControlFile(dir);
}
`,
  );
  writeFileSync(
    raceChild,
    `import { acquireControl, startControlServer } from ${JSON.stringify(controlBundle)};
const [dir, at, hold] = process.argv.slice(2);
const token = "token-for-" + process.pid;
const server = await startControlServer({ token, handlers: { status: () => ({}), stop: () => {} } });
while (Date.now() < Number(at)) {}
try {
  await acquireControl(dir, { pid: process.pid, port: server.port, token });
  process.stdout.write("won\\n");
} catch {
  process.stdout.write("refused\\n");
}
await new Promise((resolve) => setTimeout(resolve, Number(hold)));
await server.close();
`,
  );
}, 60_000);

afterEach(async () => {
  for (const child of running.splice(0)) {
    if (child.pid !== undefined && isProcessAlive(child.pid)) child.kill("SIGKILL");
  }
  for (const close of servers.splice(0)) await close();
  for (const dir of dirs.splice(1)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-daemon-run-"));
  dirs.push(dir);
  // The daemon keeps Task workspaces in a tree beside its data directory
  // rather than inside it, so a test that leaves one behind cleans up both.
  dirs.push(`${dir}-work`);
  return dir;
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [daemonBundle, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** A daemon left running in the foreground, with whatever it says kept for
 *  a failing test to show. */
function serve(
  dir: string,
  extra: string[] = [],
  env: Record<string, string> = {},
): { child: ChildProcess; output(): string } {
  let output = "";
  const child = spawn(process.execPath, [daemonBundle, "serve", "--no-browser", "--data-dir", dir, ...extra], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  running.push(child);
  return { child, output: () => output };
}

async function waitFor(what: string, predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A lab that no longer knows this machine, which is what a member removing
 *  it from the Runtimes screen leaves behind: the token is revoked, so every
 *  authenticated call it carries comes back 401. */
async function labThatRefuses(): Promise<{ base: string }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such machine" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  servers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${port}` };
}

/** A lab that accepts the connection and then says nothing at all — a
 *  suspended machine, a load balancer that lost its backend. */
async function silentLab(): Promise<{ base: string; connections(): number }> {
  const sockets: Socket[] = [];
  const server: Server = createServer(() => {});
  server.on("connection", (socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  servers.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base: `http://127.0.0.1:${port}`, connections: () => sockets.length };
}

/** A pid that named a real process and no longer does — what a daemon killed
 *  outright, or a machine that lost power, leaves behind in a claim. Spawned
 *  and waited on rather than invented, because a number picked out of the air
 *  could belong to something else on the machine running these. */
function deadPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", () => resolve(child.pid ?? 0));
  });
}

/** A port that was really bound and really given up, so a connection to it
 *  is refused the way one to a daemon that is gone would be. */
async function portNobodyIsOn(): Promise<number> {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A lab that answers every daemon call, and answers `/daemon/workspaces`
 *  with exactly the ids it was told to call gone. */
async function answeringLab(gone: {
  studyIds: string[];
  taskIds: string[];
}): Promise<{ base: string }> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/daemon/workspaces" ? gone : { ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  servers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { base: `http://127.0.0.1:${port}` };
}

function pairWith(dir: string, lab: string): void {
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      lab,
      token: "a-machine-token",
      runtimeId: "rt_1",
      machineName: "ana-macbook",
      labName: "Ana's Lab",
    }),
  );
}

it(
  "stops while a call to a lab that went silent is still out",
  async () => {
    const dir = freshDir();
    const lab = await silentLab();
    pairWith(dir, lab.base);

    const daemon = serve(dir);
    await waitFor("the daemon to claim the directory", () => readControlFile(dir) !== undefined);
    await waitFor("a call to reach the lab", () => lab.connections() > 0);

    const started = Date.now();
    const stopped = await run(["stop", "--data-dir", dir]);
    const took = Date.now() - started;

    expect(stopped.stdout.trim(), daemon.output()).toContain("Stopped the daemon on pid");
    expect(stopped.code).toBe(0);
    expect(await waitForExit(daemon.child.pid!, 1000)).toBe(true);
    // The runtime's own timeout on a request nobody answers is five
    // minutes. Anything in that neighbourhood means the call was waited
    // out rather than taken back.
    expect(took).toBeLessThan(8000);
  },
  60_000,
);

it(
  "leaves nothing claiming the directory once it is gone",
  async () => {
    const dir = freshDir();
    const lab = await silentLab();
    pairWith(dir, lab.base);

    const daemon = serve(dir);
    await waitFor("the daemon to claim the directory", () => readControlFile(dir) !== undefined);
    expect(readControlFile(dir)!.pid).toBe(daemon.child.pid);

    await run(["stop", "--data-dir", dir]);
    expect(isProcessAlive(daemon.child.pid!)).toBe(false);
    expect(readControlFile(dir)).toBeUndefined();

    // And the directory is usable again, which is the whole point of
    // letting the claim go.
    const second = serve(dir);
    await waitFor("the next daemon to claim it", () => readControlFile(dir)?.pid === second.child.pid);
  },
  60_000,
);

it(
  "removes the working directory of a Task the lab no longer has, on startup",
  async () => {
    const dir = freshDir();
    // The lab answers that one of the two Tasks it was asked about is gone.
    const lab = await answeringLab({ studyIds: [], taskIds: ["t_gone"] });
    pairWith(dir, lab.base);

    const gone = ensureTaskDir(`${dir}-work`, "s_old", "t_gone");
    const held = ensureTaskDir(`${dir}-work`, "s_old", "t_held");

    const daemon = serve(dir);
    await waitFor("the daemon to claim the directory", () => readControlFile(dir) !== undefined);
    await waitFor("the removed Task's directory to go", () => !existsSync(gone), 5000);

    expect(existsSync(held), daemon.output()).toBe(true);
  },
  15_000,
);

it(
  "is found by every command for as long as it is running",
  async () => {
    const dir = freshDir();
    const lab = await silentLab();
    pairWith(dir, lab.base);

    const daemon = serve(dir);
    await waitFor("the daemon to claim the directory", () => readControlFile(dir) !== undefined);

    const status = await run(["status", "--data-dir", dir]);
    expect(JSON.parse(status.stdout)).toMatchObject({
      running: true,
      pid: daemon.child.pid,
      paired: true,
      machine: "ana-macbook",
    });

    const second = await run(["serve", "--no-browser", "--data-dir", dir]);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain(`as pid ${daemon.child.pid}`);
    expect(readControlFile(dir)!.pid).toBe(daemon.child.pid);
  },
  60_000,
);

it(
  "hands a fresh link to every ask, and the one before it stops working",
  async () => {
    const dir = freshDir();
    const daemon = serve(dir, ["--lab", "http://127.0.0.1:1"]);
    await waitFor("the daemon to claim the directory", () => readControlFile(dir) !== undefined);

    const first = JSON.parse((await run(["status", "--data-dir", dir])).stdout) as Record<string, string>;
    const second = JSON.parse((await run(["status", "--data-dir", dir])).stdout) as Record<string, string>;

    expect(first.pairingLink, daemon.output()).toBeTruthy();
    expect(second.pairingLink).not.toBe(first.pairingLink);
    expect((await fetch(first.pairingLink!, { redirect: "manual" })).status).toBe(403);
    expect((await fetch(second.pairingLink!, { redirect: "manual" })).status).toBe(200);
  },
  60_000,
);

it(
  "is not shut out of a directory by a claim naming a pid that was handed out again",
  async () => {
    // What a machine that lost power comes back to. The pid in the claim is
    // alive, because pids are reused, but it belongs to something that has
    // never heard of this daemon. Every command has to see through that:
    // one that believes the pid alone leaves the directory unusable with no
    // way out from inside the product.
    const dir = freshDir();
    const lab = await silentLab();
    pairWith(dir, lab.base);
    const port = await portNobodyIsOn();
    writeFileSync(
      join(dir, "control.json"),
      JSON.stringify({ pid: process.pid, port, token: "from-before-the-reboot" }),
    );

    const status = await run(["status", "--data-dir", dir]);
    // Nothing is listening on that port, so this is absence rather than a
    // daemon keeping quiet — and the answer has to say which, since the two
    // call for opposite responses from whatever is reading it.
    expect(JSON.parse(status.stdout)).toMatchObject({
      running: false,
      silent: false,
      paired: true,
    });
    expect(status.code).toBe(0);

    const stopped = await run(["stop", "--data-dir", dir]);
    expect(stopped.stdout).toContain("No daemon is running");
    expect(stopped.code).toBe(0);
    expect(readControlFile(dir)).toBeUndefined();

    const daemon = serve(dir);
    await waitFor("the daemon to claim the directory", () => readControlFile(dir)?.pid === daemon.child.pid);
  },
  60_000,
);

it(
  "leaves nothing behind when it fails on the way up",
  async () => {
    // The pairing port already taken is enough to throw after the control
    // endpoint is bound and the directory is claimed. A process that stayed
    // up on that one handle would hold the claim, never pair, never
    // heartbeat, and answer `status` as a healthy daemon with no way to
    // pair it.
    const dir = freshDir();
    const taken = createServer(() => {});
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const address = taken.address();
    const port = typeof address === "object" && address ? address.port : 0;
    servers.push(() => new Promise<void>((resolve) => taken.close(() => resolve())));

    const failed = await run(["serve", "--no-browser", "--data-dir", dir, "--port", String(port)]);

    expect(failed.stderr).toContain("EADDRINUSE");
    expect(failed.code).toBe(1);
    expect(readControlFile(dir)).toBeUndefined();
  },
  60_000,
);

it(
  "can be paired again after the lab says it does not know this machine",
  async () => {
    // A member removes their machine from the lab. The token is revoked,
    // the daemon is told so and leaves — and what it leaves behind decides
    // whether that machine can ever come back. A stored pairing the lab has
    // disowned makes every later start announce a lab it has no access to
    // and offer no way to pair with another.
    const dir = freshDir();
    const lab = await labThatRefuses();
    pairWith(dir, lab.base);

    const removed = serve(dir);
    let code: number | undefined;
    removed.child.once("close", (answer) => (code = answer ?? -1));
    await waitFor("the daemon to be refused and leave", () => code !== undefined, 30_000);
    expect(removed.output()).toContain("no longer recognizes this machine");
    expect(code).toBe(1);
    expect(existsSync(join(dir, "state.json"))).toBe(false);
    // Kept where a person can read it, which is the whole difference between
    // setting a pairing aside and deleting it.
    expect(existsSync(join(dir, "state.revoked.json"))).toBe(true);

    // Nothing claims to be paired to a lab that has said otherwise.
    const status = await run(["status", "--data-dir", dir]);
    expect(JSON.parse(status.stdout)).toMatchObject({ running: false, paired: false, lab: null });

    // And the next start is a pairing one, which is what the lab's own
    // removal screen promises: a machine that comes back by pairing again.
    const again = serve(dir);
    await waitFor("a pairing link", () => again.output().includes("nonce="), 30_000);
    expect(again.output()).not.toContain("Paired as");

    const paired = await run(["status", "--data-dir", dir]);
    expect(JSON.parse(paired.stdout)).toMatchObject({ running: true, paired: false });
    expect(JSON.parse(paired.stdout).pairingLink).toContain("nonce=");
  },
  90_000,
);

it(
  "answers for itself without starting a machine when asked what it is",
  async () => {
    // Serving is what any of these becomes if the argument list is read
    // loosely: two ports bound, the data directory claimed, a live pairing
    // nonce printed, and a process running until somebody notices. Somebody
    // typing --help has not asked for a new machine identity, and neither
    // has somebody who mistyped a flag.
    const dir = freshDir();

    const helped = await run(["--help", "--data-dir", dir]);
    expect(helped.code).toBe(0);
    expect(helped.stdout).toContain("Usage:");
    expect(helped.stdout).not.toContain("nonce=");

    const shortHelp = await run(["-h", "--data-dir", dir]);
    expect(shortHelp.stdout).toBe(helped.stdout);

    const versioned = await run(["--version", "--data-dir", dir]);
    expect(versioned.code).toBe(0);
    expect(versioned.stdout.trim()).toBe("0.1.0");

    const typo = await run(["--lba", "https://lab.example.edu", "--data-dir", dir]);
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain("--lba is not something this program takes");
    expect(typo.stdout).not.toContain("nonce=");

    const valueless = await run(["stop", "--data-dir"]);
    expect(valueless.code).toBe(1);
    expect(valueless.stderr).toContain("--data-dir needs a value");

    // Not one of them claimed the directory, minted an identity, or left
    // anything behind in it.
    expect(readControlFile(dir)).toBeUndefined();
    expect(existsSync(join(dir, "state.json"))).toBe(false);
  },
  60_000,
);

it(
  "never publishes a claim that says nothing",
  async () => {
    // The window that a create-then-write leaves open, measured rather than
    // argued about: a reader spinning against a daemon publishing claims as
    // fast as it can. An empty claim is not a curiosity — `acquireControl`
    // reads one as abandoned and takes the directory from whoever is
    // publishing it.
    const dir = freshDir();
    const enough = join(dir, "enough");
    const writer = spawn(process.execPath, [claimWriter, dir, enough], { stdio: "ignore" });
    const closed = new Promise<void>((resolve) => writer.once("close", () => resolve()));

    // Counted out rather than timed: the reader stops when it has watched
    // two thousand claims, however long that takes, and the deadline is only
    // there so a writer that never publishes anything fails rather than
    // hangs. A busy machine should make this slower, not make it fail.
    const path = join(dir, "control.json");
    const target = 2000;
    const deadline = Date.now() + 30_000;
    let seen = 0;
    let empty = 0;
    while (seen < target && Date.now() < deadline) {
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat === undefined) continue;
      seen += 1;
      if (stat.size === 0) empty += 1;
    }
    writeFileSync(enough, "");
    await closed;

    // The reader really did watch a claim that was really there, so nothing
    // below passes by having looked at an empty directory.
    expect(seen).toBe(target);
    expect(empty).toBe(0);
  },
  60_000,
);

it(
  "can still leave after somebody connects to the endpoint it released",
  async () => {
    // Release keeps the endpoint answering, and every answer costs a fresh
    // socket. A socket is a handle, and a handle nobody closes is a process
    // that never leaves — one caller connecting and saying nothing would
    // pin a daemon here for good.
    const child = spawn(process.execPath, [releaseChild], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number>((resolve) => child.once("close", (code) => resolve(code ?? -1)));
    const port = await new Promise<number>((resolve) => {
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
        if (out.includes("\n")) resolve(Number(out.trim()));
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 600));

    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    const outcome = await Promise.race([
      exited.then((code) => `exited ${code}`),
      new Promise<string>((resolve) => setTimeout(() => resolve("held open"), 8000)),
    ]);
    socket.destroy();
    if (outcome === "held open") child.kill("SIGKILL");
    expect(outcome).toBe("exited 0");
  },
  60_000,
);

it(
  "leaves a daemon alone while it is stopped rather than not there",
  async () => {
    // A healthy paired daemon that cannot answer, which is what a laptop
    // resuming from suspend or a process under a debugger looks like from
    // outside. Every command has to keep away from it: reading silence as
    // absence is how a second daemon ends up heartbeating as this machine.
    const dir = freshDir();
    const lab = await silentLab();
    pairWith(dir, lab.base);
    const daemon = serve(dir);
    await waitFor("the daemon to claim the directory", () => readControlFile(dir) !== undefined);
    const claim = readControlFile(dir)!;

    process.kill(daemon.child.pid!, "SIGSTOP");
    try {
      const stopped = await run(["stop", "--data-dir", dir]);
      expect(stopped.stderr).toContain("may be paused or stuck");
      expect(stopped.code).toBe(1);
      expect(readControlFile(dir)).toEqual(claim);

      const second = await run(["serve", "--no-browser", "--data-dir", dir]);
      expect(second.stderr).toContain("may be paused or stuck");
      expect(second.code).toBe(1);
      expect(readControlFile(dir)).toEqual(claim);

      // `silent` is what separates this from nothing running at all, and it
      // has to be in the answer itself rather than only in the prose beside
      // it: a program reading this decides whether to start a daemon, and
      // `running: false` alone would tell it to start one on top of this.
      const status = await run(["status", "--data-dir", dir]);
      expect(JSON.parse(status.stdout)).toMatchObject({ running: false, silent: true });
      expect(status.stderr).toContain("did not answer");
    } finally {
      process.kill(daemon.child.pid!, "SIGCONT");
    }

    // And once it can answer again it stops the way it always did.
    const stopped = await run(["stop", "--data-dir", dir]);
    expect(stopped.stdout).toContain("Stopped the daemon on pid");
    expect(readControlFile(dir)).toBeUndefined();
  },
  60_000,
);

it(
  "never spawns its kernel host merely from pairing and serving",
  async () => {
    const dir = freshDir();
    const lab = await answeringLab({ studyIds: [], taskIds: [] });
    pairWith(dir, lab.base);

    // No `uv` on this PATH — the command this machine's kernel host launch
    // resolves to. A daemon that started one merely by pairing would fail
    // to spawn it and say so; one that starts a host only once something on
    // it asks for a kernel never attempts it at all, and says nothing about
    // it either way.
    const daemon = serve(dir, [], { PATH: dirname(process.execPath) });
    await waitFor("the daemon to claim the directory", () => readControlFile(dir) !== undefined);
    await waitFor("the daemon to finish pairing and reach serving", () => daemon.output().includes("Paired as"));
    // A spawn destined to fail resolves in single-digit milliseconds; this
    // is far longer than an eager attempt would need to fail and say so.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(daemon.output()).not.toMatch(/kernel host/i);

    const stopped = await run(["stop", "--data-dir", dir]);
    expect(stopped.stdout, daemon.output()).toContain("Stopped the daemon on pid");
  },
  15_000,
);

it(
  "is not held back by a catalogue command that ignores being cancelled",
  async () => {
    // The probe runs thirteen local commands and gives each three seconds.
    // One of them refusing the signal that cancels it must not become the
    // thing a stop waits on — and must not keep the process alive past its
    // own shutdown, which is the state in which a daemon holds a claim
    // nobody can act on.
    const dir = freshDir();
    const lab = await silentLab();
    pairWith(dir, lab.base);

    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "claude"),
      `#!/usr/bin/env node
process.on("SIGTERM", () => {});
setTimeout(() => process.stdout.write("9.9.9\\n"), 5000);
`,
      { mode: 0o755 },
    );

    // The stub's own shebang needs to find node, and the catalogue is
    // searched in order, so the stub still shadows any real one installed
    // beside it.
    const daemon = serve(dir, [], { PATH: `${binDir}:${dirname(process.execPath)}` });
    await waitFor("the daemon to claim the directory", () => readControlFile(dir) !== undefined);
    const claim = readControlFile(dir)!;

    const started = Date.now();
    const stopped = await run(["stop", "--data-dir", dir]);
    expect(stopped.stdout, daemon.output()).toContain("Stopped the daemon on pid");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(isProcessAlive(claim.pid)).toBe(false);
    expect(readControlFile(dir)).toBeUndefined();
  },
  60_000,
);

it(
  "lets exactly one of a crowd of daemons starting at once have the directory",
  async () => {
    // The crowd starts against a directory somebody left claimed, which is
    // the only shape in which starting removes a claim rather than only
    // publishing one: a claim on disk, and nothing behind it. Racing on an
    // empty directory exercises the publish alone, and the publish was never
    // the part that could hand two daemons the same machine identity.
    //
    // Every round after the first inherits that shape for free — the winner
    // exits without clearing up, so what the next crowd finds is a claim
    // naming a process that is gone. Several rounds because the window is
    // narrow: it wants the crowd to arrive within about the time it takes to
    // write a file and link it into place, so one round finding nothing
    // proves considerably less than several do.
    const dir = freshDir();
    writeFileSync(
      join(dir, "control.json"),
      JSON.stringify({ pid: await deadPid(), port: await portNobodyIsOn(), token: "from-before-the-crash" }),
    );

    for (let round = 1; round <= 10; round += 1) {
      const at = Date.now() + 400;
      const outcomes = await Promise.all(
        Array.from({ length: 6 }, () =>
          new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, [raceChild, dir, String(at), "700"], {
              stdio: ["ignore", "pipe", "pipe"],
            });
            let out = "";
            child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
            child.once("error", reject);
            child.once("close", () => resolve(out.trim()));
          }),
        ),
      );

      const won = outcomes.filter((outcome) => outcome === "won");
      // Named, because a failure here is a count and the count alone does not
      // say which run of the ten produced it.
      expect(won, `round ${round} of 10: ${outcomes.join(",")}`).toHaveLength(1);
      expect(outcomes.filter((outcome) => outcome === "refused")).toHaveLength(5);
    }
  },
  120_000,
);
