import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startKernelHost, type KernelHost } from "./kernel-host";
import {
  daemonProgramPaths,
  ensureKernelSocketDir,
  kernelBridgeFor,
  kernelConfinementFor,
  kernelSessionToken,
  kernelSocketPath,
} from "./kernels";
import { readBridgeArguments } from "./bridge";
import { confinementFor } from "./agent-home";
import { canonicalPath, confine, policyFor, programLocation } from "./sandbox";

/**
 * The whole path an agent's tool call takes, with nothing stubbed on it: this
 * machine's real kernel host, a real boundary rendered for a real Task
 * directory, the relay started the way an agent's own program starts one, and
 * a real interpreter on the far end.
 *
 * A test that only asserted the relay had been named to the agent would pass
 * against a relay that reaches nothing, which is the one failure this is here
 * to catch.
 */

const HOST = join(import.meta.dirname, "..", "..", "kernel-host");
const PACKAGE = join(import.meta.dirname, "..");

const hosts: KernelHost[] = [];
const relays: ChildProcess[] = [];
const dirs: string[] = [];

/** This machine's own program, built the way it is shipped. The relay is a
 *  word on that program's command line, so what is spawned below has to be
 *  the program itself rather than one of the files it is made of — a relay
 *  that works only when started some other way is not the relay an agent is
 *  told to run. */
let daemon = "";
let built = "";

beforeAll(() => {
  built = mkdtempSync(join(tmpdir(), "lyk-built-"));
  daemon = join(built, "main.js");
  const made = spawnSync(
    join(PACKAGE, "node_modules", ".bin", "esbuild"),
    [
      join(PACKAGE, "src", "main.ts"),
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--outfile=${daemon}`,
    ],
    { encoding: "utf8" },
  );
  if (made.status !== 0) throw new Error(`this program did not build: ${made.stderr}`);
}, 120_000);

afterAll(() => rmSync(built, { recursive: true, force: true }));

afterEach(async () => {
  for (const relay of relays.splice(0)) relay.kill("SIGKILL");
  for (const host of hosts.splice(0)) await host.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A Task directory, of the shape a real one has: somewhere on this machine
 *  a daemon can write. Its length says nothing about whether a socket can be
 *  bound — the socket is named beside neither this nor the workspace. */
function taskDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lyk-"));
  dirs.push(dir);
  return dir;
}

/** One agent's end of the relay: newline-delimited JSON-RPC on its stdio,
 *  which is what an agent's own program speaks to a tool server. */
function speaking(relay: ChildProcess) {
  const answers = new Map<number, (result: unknown) => void>();
  const failures = new Map<number, (why: string) => void>();
  let carry = "";
  let stderr = "";
  relay.stdout?.setEncoding("utf8");
  relay.stderr?.setEncoding("utf8");
  relay.stderr?.on("data", (chunk: string) => (stderr += chunk));
  relay.stdout?.on("data", (chunk: string) => {
    carry += chunk;
    let newline = carry.indexOf("\n");
    while (newline !== -1) {
      const line = carry.slice(0, newline).trim();
      carry = carry.slice(newline + 1);
      if (line.length > 0) {
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
      }
      newline = carry.indexOf("\n");
    }
  });
  let nextId = 1;
  const send = (message: unknown): void => {
    relay.stdin?.write(`${JSON.stringify(message)}\n`);
  };
  const ask = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    const answered = new Promise<unknown>((resolve, reject) => {
      answers.set(id, resolve);
      failures.set(id, (why) => reject(new Error(why)));
    });
    send({ jsonrpc: "2.0", id, method, params });
    return Promise.race([
      answered,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${method} was never answered; stderr: ${stderr}`)), 30_000),
      ),
    ]);
  };
  return {
    stderr: () => stderr,
    async open(): Promise<unknown> {
      const ready = await ask("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "a test standing in for an agent", version: "1" },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return ready;
    },
    call(name: string, args: Record<string, unknown>): Promise<{
      structuredContent?: { cell?: Record<string, unknown> };
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    }> {
      return ask("tools/call", { name, arguments: args }) as Promise<{
        structuredContent?: { cell?: Record<string, unknown> };
        content?: Array<{ type?: string; text?: string }>;
        isError?: boolean;
      }>;
    },
    tools(): Promise<{ tools: Array<{ name: string }> }> {
      return ask("tools/list", {}) as Promise<{ tools: Array<{ name: string }> }>;
    },
  };
}

/** Everything below this line needs a real boundary and a real `uv`, both of
 *  which this machine only has on macOS. */
const onDarwin = process.platform === "darwin" ? it : it.skip;

async function reachingAKernel() {
  const workspace = taskDir();
  const dataDir = taskDir();
  const host = startKernelHost({
    command: "uv",
    args: ["run", "--project", HOST, "lykeion-kernel-host"],
  });
  hosts.push(host);
  const hello = (await host.call("host.hello", {})) as {
    environment: string;
    reads: string[];
  };
  const { prefix } = kernelConfinementFor({
    platform: "darwin",
    workspace,
    dataDir,
    grants: [],
    reads: hello.reads,
  });
  ensureKernelSocketDir();
  const token = kernelSessionToken();
  // Awaited, and the relay is started only afterwards. A cell arriving before
  // this landed would be refused for a boundary nobody had supplied.
  await host.call("kernel.configure_session", {
    session_id: "se_1",
    task_id: "tk_1",
    workspace,
    environment: hello.environment,
    prefix,
    socket: kernelSocketPath(workspace),
    token,
  });
  const relay = spawn(
    process.execPath,
    [
      daemon,
      "bridge",
      "--socket",
      kernelSocketPath(workspace),
      "--session",
      "se_1",
      "--task",
      "tk_1",
      "--name",
      "main",
      "--agent",
      "claude",
      "--token",
      token,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  relays.push(relay);
  const agent = speaking(relay);
  await agent.open();
  return { agent, workspace, host, token };
}

onDarwin("carries a variable from one of an agent's tool calls to the next", async () => {
  const { agent } = await reachingAKernel();

  const first = await agent.call("run_python", { code: "x = 41" });
  const second = await agent.call("run_python", { code: "print(x + 1)" });

  const said = (second.content ?? []).map((part) => part.text ?? "").join("");
  expect(said).toContain("42");
  // One namespace, so one kernel — and the agent never said which.
  expect(first.structuredContent?.cell?.kernelId).toBe(second.structuredContent?.cell?.kernelId);
}, 120_000);

onDarwin("writes a cell that says which Task ran it and who ran it", async () => {
  const { agent } = await reachingAKernel();

  const cell = (await agent.call("run_python", { code: "1" })).structuredContent?.cell;

  expect(cell?.name).toBe("main");
  expect(cell?.origin).toEqual({ surface: "agent", by: "claude" });
  expect(cell?.language).toBe("python");
}, 120_000);

onDarwin("publishes exactly the two tools, and neither of them names a kernel", async () => {
  const { agent } = await reachingAKernel();

  const published = await agent.tools();

  expect(published.tools.map((tool) => tool.name).sort()).toEqual(["run_python", "run_shell"]);
}, 120_000);

onDarwin("runs a cell inside the Task's own directory and nowhere else", async () => {
  const { agent, workspace } = await reachingAKernel();
  writeFileSync(join(workspace, "counts.csv"), "eleven rows\n");
  const outside = taskDir();
  writeFileSync(join(outside, "secret.txt"), "ANOTHER TASKS WORK\n");

  const mine = await agent.call("run_shell", { command: "cat counts.csv" });
  const theirs = await agent.call("run_shell", { command: `cat ${outside}/secret.txt` });

  const read = (answer: { content?: Array<{ text?: string }> }): string =>
    (answer.content ?? []).map((part) => part.text ?? "").join("");
  expect(read(mine)).toContain("eleven rows");
  expect(read(theirs)).not.toContain("ANOTHER TASKS WORK");
}, 120_000);

it("carries this process's own program as what a boundary has to let through", () => {
  // What `daemonProgramPaths()` answers with in a running daemon is where
  // that daemon's own bundle is. Asserted against this process because that
  // is the claim: whatever is running, its own location is what it names.
  expect(daemonProgramPaths()).toContain(canonicalPath(process.argv[1] ?? ""));
});

onDarwin("starts inside the boundary an agent that spawns it is confined by", async () => {
  const workspace = taskDir();
  const dataDir = taskDir();
  // The agent's own boundary, built exactly as a session builds one. The
  // daemon's own location is in it because the agent's CLI is what starts the
  // relay, and it starts it in here — named for the program built above,
  // which is what `daemonProgramPaths()` answers with in a real daemon.
  const policy = policyFor({
    workspace,
    grants: [],
    dataDir,
    readable: programLocation({ command: process.execPath, args: [daemon] }),
    ...confinementFor("claude", workspace),
  });
  const relaying = `${process.execPath} ${daemon} bridge --socket ${join(workspace, "nowhere.sock")} --session se_1 --task tk_1 --name main --agent claude --token t`;
  const confined = confine("darwin", policy, { command: "/bin/sh", args: ["-c", relaying] });

  const ran = spawnSync(confined.command, confined.args, { encoding: "utf8" });

  // It started, reached for the socket, and said what it found. A relay the
  // boundary would not let start says something else entirely, and says it
  // before it has read one of its own arguments.
  expect(ran.stderr).toContain("could not be reached");
  expect(ran.status).toBe(1);
}, 60_000);

onDarwin("says so rather than standing there when there is no socket to reach", async () => {
  const workspace = taskDir();
  const token = kernelSessionToken();
  const relay = spawn(
    process.execPath,
    [
      daemon,
      "bridge",
      "--socket",
      kernelSocketPath(workspace),
      "--session",
      "se_1",
      "--task",
      "tk_1",
      "--name",
      "main",
      "--agent",
      "claude",
      "--token",
      token,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  relays.push(relay);
  let stderr = "";
  relay.stderr?.setEncoding("utf8");
  relay.stderr?.on("data", (chunk: string) => (stderr += chunk));

  const status = await new Promise<number | null>((resolve) => relay.on("exit", resolve));

  expect(status).not.toBe(0);
  expect(stderr).toContain("could not be reached");
}, 60_000);

it("refuses a relay that was not told which kernel it is for", () => {
  expect(() => readBridgeArguments(["--socket", "/w/sockets/k.sock"])).toThrow(/--session/);
  expect(() => readBridgeArguments([])).toThrow(/--socket/);
  expect(() => readBridgeArguments(["--socket"])).toThrow(/needs a value/);
  expect(() => readBridgeArguments(["--kernel", "mine"])).toThrow(/not something this relay takes/);
});

it("is named to an agent with its own arguments already saying which kernel it is for", () => {
  const server = kernelBridgeFor({
    workspace: "/w",
    sessionId: "se_1",
    taskId: "tk_1",
    agent: "claude",
    token: "a-word-only-this-session-has",
  });

  expect(server.name).toBe("lykeion");
  expect(server.command).toBe(process.execPath);
  // What this machine writes and what the relay reads are one contract, so
  // they are asserted against each other rather than each against a copy of
  // the other: a flag renamed on either side fails right here.
  expect(readBridgeArguments(server.args.slice(server.args.indexOf("bridge") + 1))).toEqual({
    socket: kernelSocketPath("/w"),
    session: "se_1",
    task: "tk_1",
    name: "main",
    agent: "claude",
    token: "a-word-only-this-session-has",
  });
});

it("mints a word no two sessions share", () => {
  expect(kernelSessionToken()).not.toBe(kernelSessionToken());
  expect(kernelSessionToken().length).toBeGreaterThan(20);
});

it("reads the arguments this machine writes for it", () => {
  expect(
    readBridgeArguments([
      "--socket=/w/sockets/k.sock",
      "--session",
      "se_1",
      "--task",
      "tk_1",
      "--name",
      "main",
      "--agent",
      "claude",
      "--token=a-word-only-this-session-has",
    ]),
  ).toEqual({
    socket: "/w/sockets/k.sock",
    session: "se_1",
    task: "tk_1",
    name: "main",
    agent: "claude",
    token: "a-word-only-this-session-has",
  });
});

onDarwin("is refused by the host when it holds a word that session was not given", async () => {
  const { workspace } = await reachingAKernel();
  const relay = spawn(
    process.execPath,
    [
      daemon,
      "bridge",
      "--socket",
      kernelSocketPath(workspace),
      "--session",
      "se_1",
      "--task",
      "tk_1",
      "--name",
      "main",
      "--agent",
      "claude",
      "--token",
      "a word this relay made up",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  relays.push(relay);
  let stderr = "";
  relay.stderr?.setEncoding("utf8");
  relay.stderr?.on("data", (chunk: string) => (stderr += chunk));

  const status = await new Promise<number | null>((resolve) => relay.on("exit", resolve));

  expect(status).not.toBe(0);
  expect(stderr).toContain("was not the one given se_1's kernels");
}, 120_000);
