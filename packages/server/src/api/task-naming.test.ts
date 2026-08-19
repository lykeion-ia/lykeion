import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { titleFromPrompt, type LykeionApi } from "@lykeion/api";
import { readConfig } from "../config";
import { openStore } from "../store/sqlite";
import { migrate } from "../store/migrations";
import { createChannel } from "../channel";
import { createRunRelay, type RunCommand, type RunRelay } from "../run-relay";
import { createRevertRegistry } from "../run-revert";
import { createKernelListRegistry } from "../kernel-list-registry";
import { createTitleRegistry } from "../title-registry";
import { createPendingCells } from "../kernel-cells";
import { createEnvSetupRegistry } from "../env-setup-registry";
import { createRequestListener } from "../http";
import { apiFor, signUpOwner } from "../test-support/server-api";
import type { Store } from "../store/store";

/**
 * Naming end to end: a real listener, a real relay, and a fake machine on the
 * other end of the command stream that answers `/daemon/task/title` however
 * the test tells it to.
 *
 * Driven through HTTP rather than against `taskNamingApi` directly because
 * half of what is being checked lives on the wire — the command really being
 * delivered, and the answer really being bound to the machine that was asked.
 */

const dirs: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A prompt long enough to be worth summarizing — the naming path declines a
 *  short one, on purpose, and every test here is about what happens after
 *  that gate. */
const LONG_PROMPT =
  "Use the live Python kernel. Run one cell that sets values = list(range(30)) and prints every value on its own line.";

function freshLabServer(): Promise<{
  base: string;
  store: Store;
  relay: RunRelay;
  advanceClock(seconds: number): void;
  close(): Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-naming-"));
  dirs.push(dir);
  const uiDir = join(dir, "ui");
  mkdirSync(uiDir);
  const indexHtml = "<!doctype html><head></head><body></body>";
  writeFileSync(join(uiDir, "index.html"), indexHtml);

  const store = openStore(join(dir, "workspace.db"));
  migrate(store);
  const channel = createChannel(store, 1000);
  const relay = createRunRelay();
  const openStreams = new Set<() => void>();
  const config = { ...readConfig({}), host: "127.0.0.1", port: 0, dataDir: dir, uiDir };
  let clock = Math.floor(Date.now() / 1000);

  const listener = createRequestListener({
    store,
    config,
    secure: false,
    indexHtml,
    channel,
    openStreams,
    runs: relay,
    reverts: createRevertRegistry(),
    kernelLists: createKernelListRegistry(),
    titles: createTitleRegistry(),
    pendingCells: createPendingCells(), envSetups: createEnvSetupRegistry(),
    now: () => clock,
  });
  const server = createHttpServer(listener);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}`,
        store,
        relay,
        advanceClock(seconds: number) {
          clock += seconds;
        },
        close: () =>
          new Promise<void>((res) => {
            for (const end of openStreams) end();
            server.close(() => {
              store.close();
              res();
            });
          }),
      });
    });
  });
}

function secretPair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function redeemInvite(base: string, code: string, email: string, displayName: string): Promise<string> {
  const res = await fetch(`${base}/auth/redeem-invite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, email, displayName, password: "a good long password" }),
  });
  if (!res.ok) throw new Error(`redeem-invite answered ${res.status}`);
  return res.headers.get("set-cookie")!.split(";")[0];
}

async function pairClaudeMachine(
  base: string,
  api: LykeionApi,
  machineName: string,
): Promise<{ machineId: string; token: string }> {
  const { verifier, challenge } = secretPair();
  const { code } = await api.pairMachine({
    name: machineName,
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    challenge,
    redirect: "http://127.0.0.1:7420/paired",
  });
  const exchanged = await fetch(`${base}/daemon/pair/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
  });
  const { token, runtimeId: machineId } = (await exchanged.json()) as {
    token: string;
    /** The key this response actually carries. The daemon parses it, so it
     *  is the one name the runtimes → machines rename had to leave alone. */
    runtimeId: string;
  };
  await fetch(`${base}/daemon/report`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      platform: "macos-aarch64",
      daemonVersion: "0.1.0",
      capabilities: [],
      clis: [{ id: "claude", name: "Claude Code", command: "claude", version: "2.1.220", available: true }],
    }),
  });
  return { machineId, token };
}

interface NamingLab {
  base: string;
  store: Store;
  relay: RunRelay;
  ownerApi: LykeionApi;
  memberApi: LykeionApi;
  machineId: string;
  token: string;
  researchId: string;
  advanceClock(seconds: number): void;
}

async function freshLab(): Promise<NamingLab> {
  const server = await freshLabServer();
  servers.push(server);

  const ownerCookie = await signUpOwner(server.base);
  const ownerApi = apiFor(server.base, ownerCookie);

  const invite = await ownerApi.createInvite("member");
  const memberCookie = await redeemInvite(server.base, invite.code, "member@lab.example", "Member");
  const memberApi = apiFor(server.base, memberCookie);

  const { machineId, token } = await pairClaudeMachine(server.base, ownerApi, "ana-macbook");
  const research = await ownerApi.createResearch({ key: "NAM", title: "Naming" });

  return {
    base: server.base,
    store: server.store,
    relay: server.relay,
    ownerApi,
    memberApi,
    machineId,
    token,
    researchId: research.id,
    advanceClock: server.advanceClock,
  };
}

/**
 * A machine on the other end of the command stream that answers every
 * `name-task` it is handed with `answer(command)` — a title, or `null` for a
 * machine that tried and got nowhere. Returns the commands it saw, so a test
 * can assert one was never sent at all.
 */
function attachNamingDaemon(
  lab: NamingLab,
  answer: (command: RunCommand) => string | null,
): { taken: RunCommand[] } {
  const taken: RunCommand[] = [];
  lab.relay.attach(lab.machineId, (_seq, command) => {
    taken.push(command);
    if (command.type !== "name-task") return;
    void fetch(`${lab.base}/daemon/task/title`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
      body: JSON.stringify({ requestId: command.runId, title: answer(command) }),
    }).catch(() => {});
  });
  return { taken };
}

async function taskNamedByPrompt(lab: NamingLab, prompt: string): Promise<string> {
  const task = await lab.ownerApi.createTask({
    researchId: lab.researchId,
    stage: "background",
    title: titleFromPrompt(prompt),
  });
  return task.id;
}

it("renames a Task to what the machine it asked summarized", async () => {
  const lab = await freshLab();
  attachNamingDaemon(lab, () => "Python kernel range check");
  const taskId = await taskNamedByPrompt(lab, LONG_PROMPT);

  await expect(lab.ownerApi.nameTask({ taskId, prompt: LONG_PROMPT })).resolves.toBe(
    "Python kernel range check",
  );
  expect((await lab.ownerApi.getTask(taskId)).task.title).toBe("Python kernel range check");
});

it("sends the message and the resolved agent to the machine, and nothing about the workspace", async () => {
  // What the summarizer is shown is the whole of what a researcher typed —
  // never a research id, a path, or anything else it might go looking at.
  const lab = await freshLab();
  const { taken } = attachNamingDaemon(lab, () => "Named");
  const taskId = await taskNamedByPrompt(lab, LONG_PROMPT);

  await lab.ownerApi.nameTask({ taskId, prompt: LONG_PROMPT, agent: "claude" });

  const asked = taken.find((c) => c.type === "name-task")!;
  expect(asked.prompt).toBe(LONG_PROMPT);
  expect(asked.agent).toBe("claude");
  expect(asked.taskId).toBe(taskId);
  expect(asked.studyId).toBeUndefined();
});

it("cleans up what the machine said before it becomes a name", async () => {
  const lab = await freshLab();
  attachNamingDaemon(lab, () => '**Title:** "Python kernel range check."\n\nHope that helps!');
  const taskId = await taskNamedByPrompt(lab, LONG_PROMPT);

  await expect(lab.ownerApi.nameTask({ taskId, prompt: LONG_PROMPT })).resolves.toBe(
    "Python kernel range check",
  );
});

it("keeps the Task's own name when the machine answers with prose instead of a title", async () => {
  const lab = await freshLab();
  attachNamingDaemon(
    lab,
    () =>
      "I'd be happy to help name this task! Based on your description it sounds like you want to run a Python cell, so here are a few options you might consider.",
  );
  const taskId = await taskNamedByPrompt(lab, LONG_PROMPT);

  await expect(lab.ownerApi.nameTask({ taskId, prompt: LONG_PROMPT })).resolves.toBeNull();
  expect((await lab.ownerApi.getTask(taskId)).task.title).toBe(titleFromPrompt(LONG_PROMPT));
});

it("keeps the Task's own name when the machine says it got nowhere", async () => {
  const lab = await freshLab();
  attachNamingDaemon(lab, () => null);
  const taskId = await taskNamedByPrompt(lab, LONG_PROMPT);

  await expect(lab.ownerApi.nameTask({ taskId, prompt: LONG_PROMPT })).resolves.toBeNull();
  expect((await lab.ownerApi.getTask(taskId)).task.title).toBe(titleFromPrompt(LONG_PROMPT));
});

it("never asks at all for a message already short enough to be a title", async () => {
  const lab = await freshLab();
  const { taken } = attachNamingDaemon(lab, () => "Should never be asked");
  const short = "Fix the axis labels";
  const taskId = await taskNamedByPrompt(lab, short);

  await expect(lab.ownerApi.nameTask({ taskId, prompt: short })).resolves.toBeNull();
  expect(taken.some((c) => c.type === "name-task")).toBe(false);
});

it("never asks about a Task somebody has already named themselves", async () => {
  const lab = await freshLab();
  const { taken } = attachNamingDaemon(lab, () => "Should never be asked");
  const task = await lab.ownerApi.createTask({
    researchId: lab.researchId,
    stage: "background",
    title: "A name I chose myself",
  });

  await expect(lab.ownerApi.nameTask({ taskId: task.id, prompt: LONG_PROMPT })).resolves.toBeNull();
  expect(taken.some((c) => c.type === "name-task")).toBe(false);
  expect((await lab.ownerApi.getTask(task.id)).task.title).toBe("A name I chose myself");
});

it("drops a summary that lands after the researcher has renamed the chat", async () => {
  // The race the whole guard exists for: the ask is in flight, the person
  // types a name of their own, and the machine answers a moment later. What
  // they typed wins.
  const lab = await freshLab();
  const taskId = await taskNamedByPrompt(lab, LONG_PROMPT);

  lab.relay.attach(lab.machineId, (_seq, command) => {
    if (command.type !== "name-task") return;
    void (async () => {
      await lab.ownerApi.updateTask(taskId, { title: "Mine, thanks" });
      await fetch(`${lab.base}/daemon/task/title`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
        body: JSON.stringify({ requestId: command.runId, title: "Python kernel range check" }),
      });
    })();
  });

  await expect(lab.ownerApi.nameTask({ taskId, prompt: LONG_PROMPT })).resolves.toBeNull();
  expect((await lab.ownerApi.getTask(taskId)).task.title).toBe("Mine, thanks");
});

it("answers null, without waiting, when no machine is connected to ask", async () => {
  const lab = await freshLab();
  const taskId = await taskNamedByPrompt(lab, LONG_PROMPT);

  const started = Date.now();
  await expect(lab.ownerApi.nameTask({ taskId, prompt: LONG_PROMPT })).resolves.toBeNull();
  expect(Date.now() - started).toBeLessThan(2000);
});

it("answers null for a machine that has gone quiet, rather than asking one that is not there", async () => {
  const lab = await freshLab();
  const { taken } = attachNamingDaemon(lab, () => "Should never be asked");
  const taskId = await taskNamedByPrompt(lab, LONG_PROMPT);
  lab.advanceClock(600);

  await expect(lab.ownerApi.nameTask({ taskId, prompt: LONG_PROMPT })).resolves.toBeNull();
  expect(taken.some((c) => c.type === "name-task")).toBe(false);
});

it("does not spend a colleague's machine on naming", async () => {
  // `startRun` refuses this outright. Naming answers `null` instead — the
  // work still happens either way, and a Task that keeps its prompt-derived
  // name has lost nothing worth an error.
  const lab = await freshLab();
  const { taken } = attachNamingDaemon(lab, () => "Should never be asked");
  const research = await lab.memberApi.createResearch({ key: "MEM", title: "Member's" });
  const task = await lab.memberApi.createTask({
    researchId: research.id,
    stage: "background",
    title: titleFromPrompt(LONG_PROMPT),
  });

  await expect(lab.memberApi.nameTask({ taskId: task.id, prompt: LONG_PROMPT })).resolves.toBeNull();
  expect(taken.some((c) => c.type === "name-task")).toBe(false);
});

it("refuses a title reported under a request this lab never asked that machine for", async () => {
  const lab = await freshLab();
  const forged = await fetch(`${lab.base}/daemon/task/title`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({ requestId: "ntreq_9999", title: "Invented" }),
  });
  expect(forged.status).toBe(403);
});

it("refuses another machine's answer to a request that is genuinely in flight", async () => {
  const lab = await freshLab();
  const { token: strangerToken } = await pairClaudeMachine(lab.base, lab.ownerApi, "second-machine");
  const taskId = await taskNamedByPrompt(lab, LONG_PROMPT);

  let forgedStatus = 0;
  lab.relay.attach(lab.machineId, (_seq, command) => {
    if (command.type !== "name-task") return;
    void (async () => {
      const forged = await fetch(`${lab.base}/daemon/task/title`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${strangerToken}` },
        body: JSON.stringify({ requestId: command.runId, title: "Not mine to name" }),
      });
      forgedStatus = forged.status;
      await fetch(`${lab.base}/daemon/task/title`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
        body: JSON.stringify({ requestId: command.runId, title: "Python kernel range check" }),
      });
    })();
  });

  await expect(lab.ownerApi.nameTask({ taskId, prompt: LONG_PROMPT })).resolves.toBe(
    "Python kernel range check",
  );
  expect(forgedStatus).toBe(403);
});

it("refuses a reported title too large to be one", async () => {
  const lab = await freshLab();
  const res = await fetch(`${lab.base}/daemon/task/title`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({ requestId: "ntreq_1", title: "x".repeat(5000) }),
  });
  expect(res.status).toBe(400);
});

it("says which Task it could not find", async () => {
  const lab = await freshLab();
  await expect(lab.ownerApi.nameTask({ taskId: "t_nope", prompt: LONG_PROMPT })).rejects.toMatchObject(
    { code: "not-found" },
  );
});
