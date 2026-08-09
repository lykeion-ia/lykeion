import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { LykeionApi, RunEventFrame } from "@lykeion/api";
import { expectRejection } from "@lykeion/api/conformance";
import { readConfig } from "../config";
import { openStore } from "../store/sqlite";
import { migrate } from "../store/migrations";
import { createChannel } from "../channel";
import { createRunRelay, type RunCommand, type RunRelay } from "../run-relay";
import { createRevertRegistry } from "../run-revert";
import { createKernelListRegistry } from "../kernel-list-registry";
import { createPendingCells } from "../kernel-cells";
import { createRequestListener } from "../http";
import { apiFor, signUpOwner } from "../test-support/server-api";
import type { Store } from "../store/store";

const dirs: string[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A real listener wired to a real store and a real run relay, on a real
 *  loopback port, with a clock this file controls — the same harness
 *  `api/grants.test.ts` builds for the same reason: these tests need the raw
 *  store and relay directly, to see what a kernel method actually delivered
 *  and to resolve durable ids the wire contract does not hand back. */
function freshLabServer(): Promise<{
  base: string;
  store: Store;
  relay: RunRelay;
  advanceClock(seconds: number): void;
  close(): Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-kernels-"));
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
    kernelLists: createKernelListRegistry(), pendingCells: createPendingCells(),
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

/** Pairs and reports a machine offering `claude`, for whichever `LykeionApi`
 *  is handed to it. */
async function pairClaudeMachine(
  base: string,
  api: LykeionApi,
  machineName: string,
): Promise<{ runtimeId: string; token: string }> {
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
  const { token, runtimeId } = (await exchanged.json()) as { token: string; runtimeId: string };
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
  return { runtimeId, token };
}

interface KernelsLab {
  base: string;
  store: Store;
  relay: RunRelay;
  ownerApi: LykeionApi;
  memberApi: LykeionApi;
  ownerId: string;
  runtimeId: string;
  token: string;
  studyId: string;
  advanceClock(seconds: number): void;
  close(): Promise<void>;
}

/** A lab with an owner and a member, and a machine the owner has paired and
 *  reported as offering `claude` — what every kernel test below starts
 *  from, whether or not it goes on to run a cell on it. */
async function freshLab(): Promise<KernelsLab> {
  const server = await freshLabServer();
  servers.push(server);

  const ownerCookie = await signUpOwner(server.base);
  const ownerApi = apiFor(server.base, ownerCookie);
  const ownerId = (await ownerApi.currentUser()).id;

  const invite = await ownerApi.createInvite("member");
  const memberCookie = await redeemInvite(server.base, invite.code, "member@lab.example", "Member");
  const memberApi = apiFor(server.base, memberCookie);

  const { runtimeId, token } = await pairClaudeMachine(server.base, ownerApi, "ana-macbook");
  const study = await ownerApi.createStudy({ key: "KRN", title: "Kernels" });

  return {
    base: server.base,
    store: server.store,
    relay: server.relay,
    ownerApi,
    memberApi,
    ownerId,
    runtimeId,
    token,
    studyId: study.id,
    advanceClock: server.advanceClock,
    close: server.close,
  };
}

/** Runs a real turn on the lab's paired machine and posts one `cell` frame
 *  for it, the way that machine's own host would once it can. This is what
 *  gives `cells` and `sessions` — and through them, `kernelExecute`/
 *  `kernelInterrupt`/`kernelRestart`/`listRunningKernels`'s durable
 *  resolution — real rows to read rather than fabricated ones, the same
 *  durable path `store/sessions.ts`'s `"cell"` case in `recordRunFrames` is
 *  exercised through everywhere else in this package. Returns the kernel id
 *  the cell was recorded under, and the session it ran in. */
async function recordCellVia(
  lab: KernelsLab,
  params: { source: string; kernelId?: string },
): Promise<{ taskId: string; kernelId: string; runId: string; sessionId: string }> {
  const task = await lab.ownerApi.createTask({
    studyId: lab.studyId,
    stage: "background",
    title: "notebook fixture",
  });
  const { runId } = await lab.ownerApi.startRun({
    studyId: lab.studyId,
    taskId: task.id,
    prompt: "go",
    options: { planMode: false, agent: "claude" },
  });
  const kernelId = params.kernelId ?? `k_${randomBytes(8).toString("hex")}`;
  const res = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({
      runId,
      frames: [
        {
          seq: 1,
          event: {
            event: "cell",
            cell: {
              id: "cell_client",
              kernelId,
              name: "main",
              language: "python",
              environment: "python",
              executionCount: 1,
              source: params.source,
              origin: { surface: "agent", by: "claude" },
              ok: true,
              wallMs: 5,
              ts: Math.floor(Date.now() / 1000),
              outputs: [],
            },
          },
        } satisfies RunEventFrame,
      ],
    }),
  });
  if (!res.ok) throw new Error(`recordCellVia's postFrames answered ${res.status}`);
  const turn = lab.store.get(`SELECT session_id FROM turns WHERE id = ?`, [runId]);
  return { taskId: task.id, kernelId, runId, sessionId: turn!.session_id as string };
}

/** Attaches to the runtime's command stream the way a real daemon's own
 *  `openCommands` loop does, and answers every kernel command with a canned,
 *  successful reply the way that daemon's `handleKernelExecute`/
 *  `handleKernelList` would — enough for a test that needs a live connection
 *  to exist, and a kernel command sent over it to reach a real reply,
 *  without simulating a whole daemon process. `kernels` is what every
 *  `kernel-list` ask on this connection is answered with; a `kernel-execute`
 *  is answered by posting the cell it names straight back, `ok`. Returns
 *  every command this stub actually received, and the relay's own detach
 *  function — calling it is what a real reconnect does to the connection it
 *  replaces. */
function attachStubDaemon(
  lab: KernelsLab,
  kernels: Array<Record<string, unknown>> = [],
): { taken: RunCommand[]; detach: () => void } {
  const taken: RunCommand[] = [];
  const post = (path: string, body: unknown): void => {
    // Fire-and-forget, matching the real daemon's own `handleKernelExecute`/
    // `handleKernelList` — neither awaits its POST back, and a test whose
    // server has already closed by the time this lands must not surface
    // that race as an unhandled rejection.
    fetch(`${lab.base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
      body: JSON.stringify(body),
    }).catch(() => {});
  };
  const detach = lab.relay.attach(lab.runtimeId, (_seq, command) => {
    taken.push(command);
    if (command.type === "kernel-list") post("/daemon/kernel/list", { requestId: command.runId, kernels });
    if (command.type === "kernel-execute")
      post("/daemon/cell", {
        cellId: command.cellId,
        sessionId: command.sessionId,
        taskId: command.taskId,
        kernelId: command.kernelId,
        name: command.name,
        language: command.language,
        environment: "python",
        executionCount: 1,
        source: command.code,
        origin: { surface: "repl", by: command.by },
        ok: true,
        wallMs: 5,
        ts: Math.floor(Date.now() / 1000),
        outputs: [],
      });
  });
  return { taken, detach };
}

/** Polls `check` until it holds or `timeoutMs` runs out — what a test
 *  reading a cell that arrived through a fire-and-forget POST, rather than
 *  through the call it made itself, has to do instead of awaiting anything
 *  directly. */
async function until(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the condition to hold");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it("gives a Task's notebook to any member of the lab", async () => {
  const lab = await freshLab();
  const { taskId } = await recordCellVia(lab, { source: "x = 1" });
  await expect(lab.memberApi.taskNotebook(taskId)).resolves.toHaveLength(1);
  const [cell] = await lab.memberApi.taskNotebook(taskId);
  expect(cell).toMatchObject({ source: "x = 1", language: "python" });
});

it("answers not-found for a Task nobody has filed", async () => {
  const lab = await freshLab();
  await expectRejection(lab.ownerApi.taskNotebook("t_bogus"), "not-found", /t_bogus/);
});

it("answers an empty notebook for a real Task nothing has run", async () => {
  const lab = await freshLab();
  const task = await lab.ownerApi.createTask({ studyId: lab.studyId, stage: "methods", title: "quiet" });
  await expect(lab.ownerApi.taskNotebook(task.id)).resolves.toEqual([]);
});

it("refuses to run a cell on a machine that is not yours", async () => {
  const lab = await freshLab();
  const { kernelId } = await recordCellVia(lab, { source: "x = 1" });
  await expectRejection(lab.memberApi.kernelExecute(kernelId, "1"), "forbidden", /./);
});

it("refuses to run a cell on a machine that is offline", async () => {
  const lab = await freshLab();
  const { kernelId } = await recordCellVia(lab, { source: "x = 1" });
  lab.advanceClock(301);
  await expectRejection(lab.ownerApi.kernelExecute(kernelId, "1"), "conflict", /offline/i);
});

it("refuses to execute on a kernel no machine in this lab is holding", async () => {
  const lab = await freshLab();
  await expectRejection(lab.ownerApi.kernelExecute("k_never_seen", "1"), "unsupported", /./);
});

it("restarts a kernel that is being reported but has never finished a cell", async () => {
  // A host mints a kernel's entry when the first cell is addressed to it and
  // before the process behind it is launched, so a kernel that could not
  // start, or died inside the cell that started it, is one every `kernel.list`
  // reports and no `cells` row names. That is exactly the kernel a researcher
  // reaches for Restart, and the durable record has nothing to resolve it by.
  const lab = await freshLab();
  const { sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  const stub = attachStubDaemon(lab, [
    {
      id: "k_crashed_on_its_first_cell",
      sessionId,
      taskId,
      name: "main",
      language: "python",
      state: "crashed",
      incarnation: 1,
      executionCount: 0,
      queueDepth: 0,
      environment: "python",
    },
  ]);

  await lab.ownerApi.kernelRestart("k_crashed_on_its_first_cell");
  expect(stub.taken.at(-1)).toMatchObject({
    type: "kernel-restart",
    kernelId: "k_crashed_on_its_first_cell",
  });
});

it("keeps a kernel nobody is reporting out of reach even while other machines answer", async () => {
  const lab = await freshLab();
  const { sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  attachStubDaemon(lab, [
    {
      id: "k_something_else",
      sessionId,
      taskId,
      name: "main",
      language: "python",
      state: "idle",
      incarnation: 1,
      executionCount: 0,
      queueDepth: 0,
      environment: "python",
    },
  ]);
  await expectRejection(lab.ownerApi.kernelRestart("k_nobody_holds"), "unsupported", /./);
});

it("refuses to run a cell when the runtime's command stream is not currently connected", async () => {
  // `healthFor` alone is too coarse a signal — a heartbeat can be fresh
  // while the SSE command stream it does not cover has already dropped.
  // Nothing here attaches to the relay at all, so this is that case.
  const lab = await freshLab();
  const { kernelId } = await recordCellVia(lab, { source: "x = 1" });
  await expectRejection(lab.ownerApi.kernelExecute(kernelId, "1"), "conflict", /connected/i);
});

it("hands the cell id back without waiting for the cell", async () => {
  const lab = await freshLab();
  const { kernelId } = await recordCellVia(lab, { source: "x = 1" });
  attachStubDaemon(lab);
  await expect(lab.ownerApi.kernelExecute(kernelId, "sleep(600)")).resolves.toMatchObject({
    cellId: expect.stringMatching(/^cell_/),
  });
});

it("enqueues a real command carrying the kernel's identity, the code, the minted cell id, and who is running it", async () => {
  const lab = await freshLab();
  const { kernelId, sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  const stub = attachStubDaemon(lab);
  const { cellId } = await lab.ownerApi.kernelExecute(kernelId, "2 + 2");
  expect(stub.taken.at(-1)).toMatchObject({
    type: "kernel-execute",
    kernelId,
    code: "2 + 2",
    cellId,
    sessionId,
    taskId,
    name: "main",
    language: "python",
    by: lab.ownerId,
  });
});

it("delivers the REPL's own cell to the Task's notebook, under the id kernelExecute promised", async () => {
  const lab = await freshLab();
  const { kernelId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  attachStubDaemon(lab);
  const { cellId } = await lab.ownerApi.kernelExecute(kernelId, "2 + 2");

  let cell: Awaited<ReturnType<LykeionApi["taskNotebook"]>>[number] | undefined;
  await until(async () => {
    cell = (await lab.ownerApi.taskNotebook(taskId)).find((c) => c.id === cellId);
    return cell !== undefined;
  });
  expect(cell).toMatchObject({
    id: cellId,
    kernelId,
    source: "2 + 2",
    origin: { surface: "repl", by: lab.ownerId },
    ok: true,
  });
});

it("interrupts a kernel by delivering a real command to its runtime", async () => {
  const lab = await freshLab();
  const { kernelId } = await recordCellVia(lab, { source: "x = 1" });
  const stub = attachStubDaemon(lab);
  await expect(lab.ownerApi.kernelInterrupt(kernelId)).resolves.toBeUndefined();
  expect(stub.taken.at(-1)).toMatchObject({ type: "kernel-interrupt", kernelId });
});

it("refuses to interrupt a kernel on a machine that is not yours", async () => {
  const lab = await freshLab();
  const { kernelId } = await recordCellVia(lab, { source: "x = 1" });
  await expectRejection(lab.memberApi.kernelInterrupt(kernelId), "forbidden", /./);
});

it("restarts a kernel by delivering a real command to its runtime", async () => {
  const lab = await freshLab();
  const { kernelId } = await recordCellVia(lab, { source: "x = 1" });
  const stub = attachStubDaemon(lab);
  await expect(lab.ownerApi.kernelRestart(kernelId)).resolves.toBeUndefined();
  expect(stub.taken.at(-1)).toMatchObject({ type: "kernel-restart", kernelId });
});

it("refuses to restart a kernel it has never seen", async () => {
  const lab = await freshLab();
  await expectRejection(lab.ownerApi.kernelRestart("k_never_seen"), "unsupported", /./);
});

it("does not replay a kernel command after the runtime reconnects", async () => {
  // A command enqueued the way `start-run` is sits in the relay's
  // per-runtime queue until the run it belongs to completes — which a kernel
  // command never does, because it belongs to no run at all. Enqueued that
  // way it would be replayed in full on every later `attach`, including the
  // same daemon's very next process after a restart, silently re-firing a
  // stale interrupt against whatever kernel now holds that id.
  const lab = await freshLab();
  const { kernelId } = await recordCellVia(lab, { source: "x = 1" });
  const first = attachStubDaemon(lab);
  await lab.ownerApi.kernelInterrupt(kernelId);
  expect(first.taken.some((c) => c.type === "kernel-interrupt")).toBe(true);
  first.detach();

  // A fresh connection, with no memory of what the first one carried —
  // exactly what this runtime's next daemon process opens with.
  const secondTaken: RunCommand[] = [];
  lab.relay.attach(lab.runtimeId, (_seq, c) => secondTaken.push(c));
  expect(secondTaken.some((c) => c.type === "kernel-interrupt")).toBe(false);
});

it("reports nothing for a runtime whose command stream is not connected, without waiting out the timeout", async () => {
  const lab = await freshLab();
  await recordCellVia(lab, { source: "x = 1" });
  const started = Date.now();
  await expect(lab.ownerApi.listRunningKernels()).resolves.toEqual([]);
  // Well under `KERNEL_LIST_TIMEOUT_MS` — proof this returned because
  // nothing was asked, not because an ask quietly timed out.
  expect(Date.now() - started).toBeLessThan(500);
});

it("reaches a paired machine's kernel.list and enriches it with the runtime and the Study its session belongs to", async () => {
  const lab = await freshLab();
  const { sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  attachStubDaemon(lab, [
    {
      id: "k_live",
      sessionId,
      taskId,
      name: "main",
      language: "python",
      state: "idle",
      incarnation: 1,
      executionCount: 3,
      queueDepth: 0,
      environment: "python",
    },
  ]);
  await expect(lab.ownerApi.listRunningKernels()).resolves.toEqual([
    {
      id: "k_live",
      sessionId,
      taskId,
      name: "main",
      language: "python",
      runtimeId: lab.runtimeId,
      studyId: lab.studyId,
      state: "idle",
      incarnation: 1,
      executionCount: 3,
      queueDepth: 0,
      environment: "python",
    },
  ]);
});

it("refuses a kernel-list reply from a machine the request was never sent to, and still accepts the real one", async () => {
  // `requestId` is minted off the same globally-sequential counter session
  // ids are, so it is exactly as guessable. A second paired machine — any
  // member's, not only a stranger's — could otherwise race the real runtime
  // to answer first,
  // stamping fabricated kernels with the *targeted* runtime and Study, or
  // permanently displacing the real answer since a settled request is
  // removed from the wait list on the first reply.
  const lab = await freshLab();
  // A real session, so the "real" reply below carries a kernel this lab
  // can actually enrich — a non-empty result the timeout path could never
  // produce, which is what makes the final assertion prove the real reply
  // was what settled `listing` rather than merely being consistent with a
  // quiet timeout.
  const { sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  const { token: strangerToken } = await pairClaudeMachine(lab.base, lab.memberApi, "bobs-desktop");

  const seen: RunCommand[] = [];
  lab.relay.attach(lab.runtimeId, (_seq, command) => seen.push(command));
  const listing = lab.ownerApi.listRunningKernels();
  await until(async () => seen.some((c) => c.type === "kernel-list"));
  const requestId = seen.find((c) => c.type === "kernel-list")!.runId;

  const forged = await fetch(`${lab.base}/daemon/kernel/list`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${strangerToken}` },
    body: JSON.stringify({
      requestId,
      kernels: [
        {
          id: "k_forged",
          sessionId: "sess_forged",
          taskId: "t_forged",
          name: "main",
          language: "python",
          state: "idle",
          incarnation: 1,
          executionCount: 0,
          queueDepth: 0,
          environment: "python",
        },
      ],
    }),
  });
  expect(forged.status).toBe(403);

  // The real runtime's own answer, for the exact same request, still lands
  // — refusing the forgery must not have consumed the wait.
  const real = await fetch(`${lab.base}/daemon/kernel/list`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({
      requestId,
      kernels: [
        {
          id: "k_real",
          sessionId,
          taskId,
          name: "main",
          language: "python",
          state: "idle",
          incarnation: 1,
          executionCount: 0,
          queueDepth: 0,
          environment: "python",
        },
      ],
    }),
  });
  expect(real.status).toBe(200);
  await expect(listing).resolves.toEqual([
    expect.objectContaining({ id: "k_real", runtimeId: lab.runtimeId, studyId: lab.studyId }),
  ]);
});

it("drops a kernel report whose timestamp is not a whole number of epoch seconds", async () => {
  // Every `*Ts` field is a whole number of epoch seconds — a report that
  // violates that is refused whole, the same as one naming a field of the
  // wrong type entirely, rather than let a fractional or string value
  // through to `RunningKernel`.
  const lab = await freshLab();
  const { sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  attachStubDaemon(lab, [
    {
      id: "k_bad_ts",
      sessionId,
      taskId,
      name: "main",
      language: "python",
      state: "idle",
      incarnation: 1,
      executionCount: 0,
      queueDepth: 0,
      environment: "python",
      startedTs: 1.5,
    },
  ]);
  await expect(lab.ownerApi.listRunningKernels()).resolves.toEqual([]);
});

it("drops a kernel report naming a session this lab never opened", async () => {
  const lab = await freshLab();
  attachStubDaemon(lab, [
    {
      id: "k_orphan",
      sessionId: "sess_nonexistent",
      taskId: "t_nonexistent",
      name: "main",
      language: "python",
      state: "idle",
      incarnation: 1,
      executionCount: 0,
      queueDepth: 0,
      environment: "python",
    },
  ]);
  await expect(lab.ownerApi.listRunningKernels()).resolves.toEqual([]);
});

it("drops a kernel report naming a session that belongs to a different runtime than the one reporting it, but keeps that runtime's own honest report in the same reply", async () => {
  // No requestId guessing needed for this one: a machine answers its own,
  // legitimately-addressed kernel-list ask with a report naming a session
  // it does not hold — a real session, opened on a different machine
  // entirely. A host only ever reports kernels for sessions opened on its
  // own machine, so
  // an honest report can never produce this; only a forged one can.
  const lab = await freshLab();
  const { sessionId: sessionOnA, taskId: taskOnA } = await recordCellVia(lab, { source: "x = 1" });

  const { runtimeId: runtimeB, token: tokenB } = await pairClaudeMachine(lab.base, lab.memberApi, "bobs-desktop");
  const taskOnB = await lab.memberApi.createTask({
    studyId: lab.studyId,
    stage: "background",
    title: "runtime B's own task",
  });
  const { runId: runOnB } = await lab.memberApi.startRun({
    studyId: lab.studyId,
    taskId: taskOnB.id,
    prompt: "go",
    options: { planMode: false, agent: "claude" },
  });
  const turnOnB = lab.store.get(`SELECT session_id FROM turns WHERE id = ?`, [runOnB]);
  const sessionOnB = turnOnB!.session_id as string;

  const seen: RunCommand[] = [];
  lab.relay.attach(runtimeB, (_seq, command) => seen.push(command));
  const listing = lab.ownerApi.listRunningKernels();
  await until(async () => seen.some((c) => c.type === "kernel-list"));
  const requestId = seen.find((c) => c.type === "kernel-list")!.runId;

  await fetch(`${lab.base}/daemon/kernel/list`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokenB}` },
    body: JSON.stringify({
      requestId,
      kernels: [
        {
          id: "k_honest",
          sessionId: sessionOnB,
          taskId: taskOnB.id,
          name: "main",
          language: "python",
          state: "idle",
          incarnation: 1,
          executionCount: 0,
          queueDepth: 0,
          environment: "python",
        },
        {
          id: "k_forged",
          sessionId: sessionOnA,
          taskId: taskOnA,
          name: "main",
          language: "python",
          state: "idle",
          incarnation: 1,
          executionCount: 0,
          queueDepth: 0,
          environment: "python",
        },
      ],
    }),
  });

  const kernels = await listing;
  expect(kernels.map((k) => k.id)).toEqual(["k_honest"]);
});

it("drops a kernel report whose taskId names a Task the session never ran a turn for, even inside the session's own Study", async () => {
  // A Task in the *same* Study as the session's real one is deliberately
  // used here rather than a different Study: the binding is to the turn
  // that actually opened this session for a Task, not to Study membership,
  // so a taskId nothing here ever recorded a turn for is refused whether or
  // not it happens to share a Study with the real one.
  const lab = await freshLab();
  const { sessionId } = await recordCellVia(lab, { source: "x = 1" });
  const untouchedTask = await lab.ownerApi.createTask({
    studyId: lab.studyId,
    stage: "background",
    title: "not this session's Task",
  });

  attachStubDaemon(lab, [
    {
      id: "k_misrouted",
      sessionId,
      taskId: untouchedTask.id,
      name: "main",
      language: "python",
      state: "idle",
      incarnation: 1,
      executionCount: 0,
      queueDepth: 0,
      environment: "python",
    },
  ]);
  await expect(lab.ownerApi.listRunningKernels()).resolves.toEqual([]);
});

it("keeps listing a Task's kernels after the Task is re-filed into a different Study", async () => {
  // `sessions.study_id` is fixed at the moment a session opens and never
  // moves with a later re-filing — binding a report's `taskId` to that
  // Study, rather than to the turn that actually opened the session for
  // it, would silently drop every live kernel of a Task the moment a
  // researcher moved it.
  const lab = await freshLab();
  const { sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  const destinationStudy = await lab.ownerApi.createStudy({ key: "MOV", title: "Moved" });
  await lab.ownerApi.updateTask(taskId, { studyId: destinationStudy.id });

  attachStubDaemon(lab, [
    {
      id: "k_survives_the_move",
      sessionId,
      taskId,
      name: "main",
      language: "python",
      state: "idle",
      incarnation: 1,
      executionCount: 0,
      queueDepth: 0,
      environment: "python",
    },
  ]);
  const kernels = await lab.ownerApi.listRunningKernels();
  expect(kernels.map((k) => k.id)).toEqual(["k_survives_the_move"]);
});

it("refuses a cell report from a machine that does not own the session it names", async () => {
  // A session id is sequential and guessable, the same discipline
  // `/daemon/run/events` and `/daemon/run/grant` are already held to: a
  // machine's own valid bearer token proves only that some paired machine
  // is calling, not that it is the one this session actually belongs to.
  const lab = await freshLab();
  const { sessionId, taskId, kernelId } = await recordCellVia(lab, { source: "x = 1" });
  const { token: strangerToken } = await pairClaudeMachine(lab.base, lab.memberApi, "bobs-desktop");
  const res = await fetch(`${lab.base}/daemon/cell`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${strangerToken}` },
    body: JSON.stringify({
      cellId: "cell_forged",
      sessionId,
      taskId,
      kernelId,
      name: "main",
      language: "python",
      environment: "python",
      executionCount: 1,
      source: "os.system('rm -rf /')",
      origin: { surface: "repl", by: "u_stranger" },
      ok: true,
      wallMs: 1,
      ts: Math.floor(Date.now() / 1000),
      outputs: [],
    }),
  });
  expect(res.status).toBe(403);
  await expect(lab.ownerApi.taskNotebook(taskId)).resolves.toHaveLength(1);
});

/** One `/daemon/cell` body, of the shape a real daemon posts, with whatever
 *  a test wants to say differently. */
function cellReport(
  base: { cellId: string; sessionId: string; taskId: string; kernelId: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...base,
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 1,
    source: "2 + 2",
    origin: { surface: "repl", by: "u_whoever" },
    ok: true,
    wallMs: 5,
    ts: Math.floor(Date.now() / 1000),
    outputs: [],
    ...overrides,
  };
}

function postCell(lab: KernelsLab, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${lab.base}/daemon/cell`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify(body),
  });
}

/** A live command stream that takes what it is sent and answers none of it,
 *  so the test itself decides what gets reported back and what it claims. */
function attachSilentDaemon(lab: KernelsLab): { taken: RunCommand[] } {
  const taken: RunCommand[] = [];
  lab.relay.attach(lab.runtimeId, (_seq, command) => taken.push(command));
  return { taken };
}

it("refuses a cell report under an id this lab never asked this machine for", async () => {
  // The machine owns the session and the Task's turn is real; the id is the
  // forgery. Every other field on this body is one a machine legitimately
  // reports, so an id nothing here minted is the whole of what separates a
  // cell this lab asked for from a row a machine wrote into a notebook every
  // member of the lab reads.
  const lab = await freshLab();
  const { sessionId, taskId, kernelId } = await recordCellVia(lab, { source: "x = 1" });
  const before = (await lab.ownerApi.taskNotebook(taskId)).length;
  const res = await postCell(
    lab,
    cellReport({ cellId: "cell_nobody_asked_for", sessionId, taskId, kernelId }),
  );
  expect(res.status).toBe(403);
  await expect(lab.ownerApi.taskNotebook(taskId)).resolves.toHaveLength(before);
});

it("records the member this lab minted the cell for, whatever the machine says ran it", async () => {
  const lab = await freshLab();
  const { kernelId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  // A live connection that takes the command and answers nothing, so this
  // test posts the report itself and decides what it claims.
  const stub = attachSilentDaemon(lab);
  const { cellId } = await lab.ownerApi.kernelExecute(kernelId, "2 + 2");
  const sent = stub.taken.at(-1)!;
  const res = await postCell(
    lab,
    cellReport(
      { cellId, sessionId: sent.sessionId!, taskId: sent.taskId!, kernelId },
      // Both claims are refused: a cell the agent wrote travels its run's own
      // event stream, and who ran this one is something this lab knew before
      // it ever asked.
      { origin: { surface: "agent", by: "u_somebody_else" } },
    ),
  );
  expect(res.status).toBe(200);
  const cell = (await lab.ownerApi.taskNotebook(taskId)).find((c) => c.id === cellId);
  expect(cell).toMatchObject({ origin: { surface: "repl", by: lab.ownerId } });
});

it("refuses a second report of a cell it has already recorded", async () => {
  const lab = await freshLab();
  const { kernelId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  const stub = attachSilentDaemon(lab);
  const { cellId } = await lab.ownerApi.kernelExecute(kernelId, "2 + 2");
  const sent = stub.taken.at(-1)!;
  const body = cellReport({ cellId, sessionId: sent.sessionId!, taskId: sent.taskId!, kernelId });
  expect((await postCell(lab, body)).status).toBe(200);
  // Under a PRIMARY KEY the second insert throws; answered as a refusal
  // rather than as this lab falling over.
  expect((await postCell(lab, body)).status).toBe(403);
  expect((await lab.ownerApi.taskNotebook(taskId)).filter((c) => c.id === cellId)).toHaveLength(1);
});

it("refuses a cell whose counters are not whole numbers or whose outputs are not messages", async () => {
  const lab = await freshLab();
  const { kernelId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  const stub = attachSilentDaemon(lab);
  const bad: Array<Record<string, unknown>> = [
    { ts: 1.5 },
    { wallMs: 0.25 },
    { executionCount: 2.5 },
    { outputs: ["not a message"] },
    { outputs: [{ kind: "stream", name: "stdout" }] },
    { outputs: [{ kind: "a kind nothing renders", data: null }] },
  ];
  for (const overrides of bad) {
    const { cellId } = await lab.ownerApi.kernelExecute(kernelId, "2 + 2");
    const sent = stub.taken.at(-1)!;
    const res = await postCell(
      lab,
      cellReport({ cellId, sessionId: sent.sessionId!, taskId: sent.taskId!, kernelId }, overrides),
    );
    expect(res.status).toBe(400);
  }
  await expect(lab.ownerApi.taskNotebook(taskId)).resolves.toHaveLength(1);
});

it("refuses a cell report whose taskId names a Task the session never ran a turn for", async () => {
  // The machine legitimately owns the session this time — the forgery is
  // narrower: the same session, but a Task nothing here ever recorded a
  // turn for. Without this, any paired machine could write a cell into any
  // Task's notebook in any Study, attributed to a session that never ran
  // there at all.
  const lab = await freshLab();
  const { sessionId } = await recordCellVia(lab, { source: "x = 1" });
  const untouchedTask = await lab.ownerApi.createTask({
    studyId: lab.studyId,
    stage: "background",
    title: "not this session's Task",
  });
  const res = await fetch(`${lab.base}/daemon/cell`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({
      cellId: "cell_misrouted",
      sessionId,
      taskId: untouchedTask.id,
      kernelId: "k_x",
      name: "main",
      language: "python",
      environment: "python",
      executionCount: 1,
      source: "os.system('evil')",
      origin: { surface: "repl", by: "u_stranger" },
      ok: true,
      wallMs: 1,
      ts: Math.floor(Date.now() / 1000),
      outputs: [],
    }),
  });
  expect(res.status).toBe(403);
  await expect(lab.ownerApi.taskNotebook(untouchedTask.id)).resolves.toEqual([]);
});
