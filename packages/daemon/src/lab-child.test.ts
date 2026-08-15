import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { labIsHere, recordLabHere, startLabChild } from "./lab-child";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lyk-lab-child-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A stand-in for `@lykeion/server`, run for real rather than mocked: the
 *  thing under test is a child process and the port it announces, and a
 *  fake that never binds anything would prove neither. Written into the same
 *  temporary directory the child is given, so one cleanup takes both away. */
async function fakeLab(source: string): Promise<string[]> {
  const path = join(dir, "lab.mjs");
  await writeFile(path, source);
  return ["node", path];
}

/** Announces itself on exactly the line the real lab announces itself on,
 *  and answers with the two environment values it was started with, so that
 *  a reachable port and a correctly configured child are one assertion. */
const ANNOUNCING = `
import { createServer } from "node:http";
const server = createServer((_request, response) => {
  response.end(\`\${process.env.LYKEION_PORT}|\${process.env.LYKEION_DATA_DIR}\`);
});
server.listen(Number(process.env.LYKEION_PORT), process.env.LYKEION_HOST, () => {
  console.log(\`Lykeion workspace server on http://\${process.env.LYKEION_HOST}:\${server.address().port}\`);
});
`;

/** Binds a port and then says nothing at all — the lab that is running but
 *  never announces itself. It records the port it took so the test can ask
 *  afterwards whether the child was taken down with the failed start. */
const SILENT = `
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const server = createServer((_request, response) => response.end("ok"));
server.listen(0, "127.0.0.1", () => {
  writeFileSync(join(process.env.LYKEION_DATA_DIR, "port"), String(server.address().port));
});
`;

/** Whether anything at all answers on a loopback port right now. */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Whether nothing is left listening on a port — how this file asks whether
 *  a child process is really gone, since a process holding a port is the
 *  only trace of it that matters here.
 *
 *  Given a moment rather than asked once, because a socket is torn down by
 *  the kernel a few milliseconds behind the process that held it, and the
 *  question worth asking is whether anything was left behind rather than
 *  whether the last packet has drained. Two seconds tells a lab that is on
 *  its way out from one that is still running, which is the whole of what
 *  these tests need to know. */
async function refuses(port: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    if (!(await answers(port))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A port nothing is listening on right now, for the one case that cannot
 *  use an ephemeral one: the lab told to bind a particular port. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Waits for the silent lab to record the port it took. */
async function recordedPort(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return Number(await readFile(join(dir, "port"), "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("the silent lab never recorded a port");
}

it("starts a lab on its own port and answers on it", async () => {
  const lab = await startLabChild(dir, await fakeLab(ANNOUNCING));
  try {
    expect(lab.port).toBeGreaterThan(0);
    const answer = await fetch(`http://127.0.0.1:${lab.port}/`);
    // The child was asked for port 0 and given this test's data directory:
    // an ephemeral port is the whole point, since 1421 belongs to the front
    // door and the lab is only ever reached through it.
    expect(await answer.text()).toBe(`0|${dir}`);
  } finally {
    await lab.stop();
  }
  await lab.finished;
  expect(await refuses(lab.port)).toBe(true);
});

it("ends the lab itself, not only the wrapper the command reaches it through", async () => {
  const lab = await fakeLab(ANNOUNCING);
  // What the default command does: the lab is started by something else, so
  // the process this daemon spawns is not the process holding the port. A
  // shell waiting on a background job takes a signal and goes without
  // passing it on, which is the failure the real `pnpm` wrapper had — the
  // lab kept its port and its database with nothing left supervising it.
  const wrapped = ["sh", "-c", `${lab.join(" ")} & wait`];
  const child = await startLabChild(dir, wrapped);
  await child.stop();
  expect(await refuses(child.port)).toBe(true);
});

it("binds the port it is given, for the topology with no front door in front of it", async () => {
  const wanted = await freePort();
  const lab = await startLabChild(dir, await fakeLab(ANNOUNCING), { port: wanted });
  try {
    expect(lab.port).toBe(wanted);
  } finally {
    await lab.stop();
  }
});

it("lets stop be asked twice without complaining", async () => {
  const lab = await startLabChild(dir, await fakeLab(ANNOUNCING));
  await lab.stop();
  await lab.stop();
  expect(await refuses(lab.port)).toBe(true);
});

it("refuses when the lab dies before it says where it is listening", async () => {
  await expect(startLabChild(dir, ["node", "-e", "process.exit(3)"])).rejects.toThrow(
    /exited with code 3 before it said where it was listening/,
  );
});

it("gives up on a lab that never says where it is, and takes it down with it", async () => {
  const start = startLabChild(dir, await fakeLab(SILENT), { startupTimeoutMs: 1_000 });
  await expect(start).rejects.toThrow(/did not say where it was listening/);
  expect(await refuses(await recordedPort())).toBe(true);
});

it("holds its sweep on the way out for as long as there is a lab to sweep", async () => {
  // The daemon can end without being asked to, and what ends the lab then is
  // the `exit` listener this registers. It is released only once the lab has
  // really gone: letting go of it while a lab was still standing — which
  // this did, until a review caught it — would leave the case it exists for
  // with no net at all.
  const before = process.listenerCount("exit");
  const lab = await startLabChild(dir, await fakeLab(ANNOUNCING));
  expect(process.listenerCount("exit")).toBe(before + 1);
  await lab.stop();
  expect(process.listenerCount("exit")).toBe(before);
});

it("says a lab lives here only once a data directory records that it does", () => {
  expect(labIsHere(dir)).toBe(false);
  recordLabHere(dir);
  expect(labIsHere(dir)).toBe(true);
});
