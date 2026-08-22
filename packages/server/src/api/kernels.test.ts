import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { KernelEnvStatus, LykeionApi, RunEventFrame } from "@lykeion/api";
import { expectRejection } from "@lykeion/api/conformance";
import { readConfig } from "../config";
import { openStore } from "../store/sqlite";
import { migrate } from "../store/migrations";
import { createChannel } from "../channel";
import { createRunRelay, type RunCommand, type RunRelay } from "../run-relay";
import { createRevertRegistry } from "../run-revert";
import { createKernelListRegistry } from "../kernel-list-registry";
import { createTitleRegistry } from "../title-registry";
import { createPendingCells } from "../kernel-cells";
import { createRequestListener } from "../http";
import { createEnvironmentSetupCoordinator } from "../environment-setup-coordinator";
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
    kernelLists: createKernelListRegistry(), titles: createTitleRegistry(), pendingCells: createPendingCells(),
    coordinator: createEnvironmentSetupCoordinator({ store, runs: relay, now: () => clock }),
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

/** Reports the two figures Task 2 adds to `/daemon/report` — a machine's own
 *  RAM and core count — for whichever paired machine `token` names. Its own
 *  call rather than folded into `pairClaudeMachine`: most tests in this file
 *  do not care how big a machine is, and a report that always claimed a
 *  size would leave nothing standing in for the daemon that has never sent
 *  one. */
async function reportMachineFacts(
  base: string,
  token: string,
  totalMemoryBytes: number,
  cores: number,
): Promise<void> {
  await fetch(`${base}/daemon/report`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      platform: "macos-aarch64",
      daemonVersion: "0.1.0",
      capabilities: [],
      clis: [{ id: "claude", name: "Claude Code", command: "claude", version: "2.1.220", available: true }],
      totalMemoryBytes,
      cores,
    }),
  });
}

interface KernelsLab {
  base: string;
  store: Store;
  relay: RunRelay;
  ownerApi: LykeionApi;
  memberApi: LykeionApi;
  ownerId: string;
  machineId: string;
  token: string;
  researchId: string;
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

  const { machineId, token } = await pairClaudeMachine(server.base, ownerApi, "ana-macbook");
  const research = await ownerApi.createResearch({ key: "KRN", title: "Kernels" });

  return {
    base: server.base,
    store: server.store,
    relay: server.relay,
    ownerApi,
    memberApi,
    ownerId,
    machineId,
    token,
    researchId: research.id,
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
    researchId: lab.researchId,
    stage: "background",
    title: "notebook fixture",
  });
  const { runId } = await lab.ownerApi.startRun({
    researchId: lab.researchId,
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
            // A daemon posts the record of how the cell ran on the same
            // frame, which is what this route is handed in production.
            provenance: {
              version: "lykeion.provenance.v1",
              identity: {
                taskId: task.id,
                sessionId: "se_1",
                kernelId,
                cellId: "cell_client",
              },
              input: {
                code: params.source,
                codeState: {
                  lineage: { incarnation: 0, index: 0, digest: "d0" },
                  git: { status: "unavailable", reason: "not_applicable" },
                },
              },
              environment: {
                host: {
                  platform: "darwin",
                  arch: "arm64",
                  runtimes: { status: "unavailable", reason: "not_captured" },
                },
                kernel: {
                  id: kernelId,
                  language: "python",
                  incarnation: 0,
                  processId: 2,
                  processStartedAt: 100,
                },
              },
              outputs: { status: "succeeded", items: [] },
              timestamps: { createdAt: 100, startedAt: 101, completedAt: 102 },
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

/** Posts a `log-entry` frame naming `toolUseId` and a `cell` frame recording
 *  a cell against that same call, in one request — the Execution Log entry
 *  `cellsForToolUse` resolves a Task through, and the cell and envelope
 *  `taskNotebook` and `cellProvenance` read back out, both filed the way a
 *  real daemon files them: on the same turn, joined by the same id.
 *
 *  `withStep: false` posts only the `cell` frame, carrying a `toolUseId`
 *  no Execution Log entry ever named — a cell that arrived some way other
 *  than the ordinary agent turn, which is what a `toolUseId` naming no
 *  step actually looks like on a real notebook, as opposed to one nothing
 *  ever used at all. */
async function recordCellWithStep(
  lab: KernelsLab,
  params: { cellId: string; toolUseId: string; digest: string; withStep?: boolean },
): Promise<{ taskId: string; runId: string }> {
  const task = await lab.ownerApi.createTask({
    researchId: lab.researchId,
    stage: "background",
    title: "step fixture",
  });
  const { runId } = await lab.ownerApi.startRun({
    researchId: lab.researchId,
    taskId: task.id,
    prompt: "go",
    options: { planMode: false, agent: "claude" },
  });
  const kernelId = `k_${randomBytes(8).toString("hex")}`;
  const ts = Math.floor(Date.now() / 1000);
  const withStep = params.withStep ?? true;
  const stepFrame: RunEventFrame = {
    seq: 1,
    event: {
      event: "log-entry",
      entry: {
        ts,
        toolUseId: params.toolUseId,
        tool: "execute",
        input: { code: "x = 1" },
        decision: "ran",
        result: "ok",
        isError: false,
      },
    },
  };
  const cellFrame: RunEventFrame = {
    seq: withStep ? 2 : 1,
    event: {
      event: "cell",
      cell: {
        id: params.cellId,
        kernelId,
        name: "main",
        language: "python",
        environment: "python",
        executionCount: 1,
        source: "x = 1",
        origin: { surface: "agent", by: "claude" },
        ok: true,
        wallMs: 5,
        ts,
        outputs: [],
        toolUseId: params.toolUseId,
      },
      provenance: {
        version: "lykeion.provenance.v1",
        identity: {
          taskId: task.id,
          sessionId: "se_1",
          kernelId,
          cellId: params.cellId,
        },
        input: {
          code: "x = 1",
          codeState: {
            lineage: { incarnation: 0, index: 0, digest: params.digest },
            git: { status: "unavailable", reason: "not_applicable" },
          },
        },
        environment: {
          host: {
            platform: "darwin",
            arch: "arm64",
            runtimes: { status: "unavailable", reason: "not_captured" },
          },
          kernel: {
            id: kernelId,
            language: "python",
            incarnation: 0,
            processId: 2,
            processStartedAt: 100,
          },
        },
        outputs: { status: "succeeded", items: [] },
        timestamps: { createdAt: 100, startedAt: 101, completedAt: 102 },
      },
    },
  };
  const res = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({
      runId,
      frames: withStep ? [stepFrame, cellFrame] : [cellFrame],
    }),
  });
  if (!res.ok) throw new Error(`recordCellWithStep's postFrames answered ${res.status}`);
  return { taskId: task.id, runId };
}

/** Attaches to the machine's command stream the way a real daemon's own
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
  const detach = lab.relay.attach(lab.machineId, (_seq, command) => {
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
  const task = await lab.ownerApi.createTask({ researchId: lab.researchId, stage: "methods", title: "quiet" });
  await expect(lab.ownerApi.taskNotebook(task.id)).resolves.toEqual([]);
});

it("attaches the code state a header renders to a notebook cell carrying a record", async () => {
  const lab = await freshLab();
  const digest = "ab".repeat(32);
  const { taskId } = await recordCellWithStep(lab, {
    cellId: "cell_state_1",
    toolUseId: "toolu_state_1",
    digest,
  });
  const [cell] = await lab.ownerApi.taskNotebook(taskId);
  expect(cell.codeState).toEqual({ lineage: digest.slice(0, 8), index: 0 });
});

it("gives the full record of how a cell ran to whoever names the cell's own id", async () => {
  const lab = await freshLab();
  const digest = "cd".repeat(32);
  // The wire's own `cellId` names the envelope's `identity.cellId`, never
  // the row this lab records the cell under — that id is this lab's own,
  // read back off the notebook, the same as every other reader of it.
  const { taskId } = await recordCellWithStep(lab, {
    cellId: "cell_prov_1",
    toolUseId: "toolu_prov_1",
    digest,
  });
  const [cell] = await lab.ownerApi.taskNotebook(taskId);
  const record = await lab.ownerApi.cellProvenance(cell.id);
  expect(record?.identity.cellId).toBe("cell_prov_1");
  expect(record?.input.codeState.lineage.digest).toBe(digest);
});

it("finds the cells one tool call produced, through the step it logged", async () => {
  const lab = await freshLab();
  const digest = "ef".repeat(32);
  const { taskId } = await recordCellWithStep(lab, {
    cellId: "cell_join_1",
    toolUseId: "toolu_join_1",
    digest,
  });
  const [cell] = await lab.ownerApi.taskNotebook(taskId);
  const cells = await lab.ownerApi.cellsForToolUse("toolu_join_1");
  expect(cells.map((c) => c.id)).toEqual([cell.id]);
});

it("answers empty for a tool call id naming no step, even where a cell elsewhere carries it", async () => {
  const lab = await freshLab();
  // A cell can carry a `toolUseId` this lab never logged an Execution Log
  // entry for. With no step to resolve a Task through, the honest answer
  // is empty — never a query run without one.
  await recordCellWithStep(lab, {
    cellId: "cell_orphan_1",
    toolUseId: "toolu_orphan",
    digest: "01".repeat(32),
    withStep: false,
  });
  await expect(lab.ownerApi.cellsForToolUse("toolu_orphan")).resolves.toEqual([]);
  await expect(lab.ownerApi.cellsForToolUse("toolu_never_seen")).resolves.toEqual([]);
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

it("refuses to run a cell when the machine's command stream is not currently connected", async () => {
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

it("interrupts a kernel by delivering a real command to its machine", async () => {
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

it("stops a kernel by delivering what the researcher said to its machine", async () => {
  const lab = await freshLab();
  const { kernelId } = await recordCellVia(lab, { source: "x = 1" });
  const stub = attachStubDaemon(lab);
  await expect(
    lab.ownerApi.kernelStop(kernelId, "redo this using less memory"),
  ).resolves.toBeUndefined();
  expect(stub.taken.at(-1)).toMatchObject({
    type: "kernel-stop",
    kernelId,
    feedback: "redo this using less memory",
    // Named here, where the researcher asking is known, and never read off
    // whatever the machine claims — the same rule `kernelExecute` follows for
    // the member a cell is recorded as run by.
    by: lab.ownerId,
  });
});

it("refuses to stop a kernel on a machine that is not yours", async () => {
  const lab = await freshLab();
  const { kernelId } = await recordCellVia(lab, { source: "x = 1" });
  await expectRejection(lab.memberApi.kernelStop(kernelId, "stop that"), "forbidden", /./);
});

it("restarts a kernel by delivering a real command to its machine", async () => {
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

it("does not replay a kernel command after the machine reconnects", async () => {
  // A command enqueued the way `start-run` is sits in the relay's
  // per-machine queue until the run it belongs to completes — which a kernel
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
  // exactly what this machine's next daemon process opens with.
  const secondTaken: RunCommand[] = [];
  lab.relay.attach(lab.machineId, (_seq, c) => secondTaken.push(c));
  expect(secondTaken.some((c) => c.type === "kernel-interrupt")).toBe(false);
});

it("reports nothing for a machine whose command stream is not connected, without waiting out the timeout", async () => {
  const lab = await freshLab();
  await recordCellVia(lab, { source: "x = 1" });
  const started = Date.now();
  await expect(lab.ownerApi.listRunningKernels()).resolves.toEqual([]);
  // Well under `KERNEL_LIST_TIMEOUT_MS` — proof this returned because
  // nothing was asked, not because an ask quietly timed out.
  expect(Date.now() - started).toBeLessThan(500);
});

it("reaches a paired machine's kernel.list and enriches it with the machine and the Research its session belongs to", async () => {
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
      machineId: lab.machineId,
      researchId: lab.researchId,
      state: "idle",
      incarnation: 1,
      executionCount: 3,
      queueDepth: 0,
      environment: "python",
    },
  ]);
});

it("passes a kernel's processId and resources through when the host reported them, and leaves both keys absent when it did not", async () => {
  // Task 1's own gap: nothing exercised `toRunningKernel`'s conditional
  // spreads for these two fields. Presence is what is asserted, not
  // `undefined` — an absent key and a key holding `undefined` are different
  // things on the wire, and only the first is what an old host or a
  // process-less kernel actually sends.
  const lab = await freshLab();
  const { sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  attachStubDaemon(lab, [
    {
      id: "k_measured",
      sessionId,
      taskId,
      name: "main",
      language: "python",
      state: "running",
      incarnation: 1,
      executionCount: 0,
      queueDepth: 0,
      environment: "python",
      processId: 4242,
      resources: { memoryBytes: 1024, cpuPercent: 1.5 },
    },
    {
      id: "k_unmeasured",
      sessionId,
      taskId,
      name: "worker",
      language: "python",
      state: "idle",
      incarnation: 1,
      executionCount: 0,
      queueDepth: 0,
      environment: "python",
    },
  ]);

  const kernels = await lab.ownerApi.listRunningKernels();

  const measured = kernels.find((k) => k.id === "k_measured")!;
  expect(measured.processId).toBe(4242);
  expect(measured.resources).toEqual({ memoryBytes: 1024, cpuPercent: 1.5 });

  const unmeasured = kernels.find((k) => k.id === "k_unmeasured")!;
  expect("processId" in unmeasured).toBe(false);
  expect("resources" in unmeasured).toBe(false);
});

it("passes on who ended a kernel and what they said, and names nobody for one nobody ended", async () => {
  // Presence again, for the same reason: a crashed kernel and a stopped one
  // are different facts, and a `stoppedBy` key holding `undefined` on the
  // crashed one would be this lab claiming to know a name it does not have.
  const lab = await freshLab();
  const { sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  attachStubDaemon(lab, [
    {
      id: "k_stopped",
      sessionId,
      taskId,
      name: "main",
      language: "python",
      state: "stopped",
      incarnation: 1,
      executionCount: 9,
      queueDepth: 0,
      environment: "python",
      stoppedBy: "u_ana",
      stopReason: "redo this using less memory",
    },
    {
      id: "k_crashed",
      sessionId,
      taskId,
      name: "worker",
      language: "python",
      state: "crashed",
      incarnation: 1,
      executionCount: 2,
      queueDepth: 0,
      environment: "python",
    },
  ]);

  const kernels = await lab.ownerApi.listRunningKernels();

  const stopped = kernels.find((k) => k.id === "k_stopped")!;
  expect(stopped.stoppedBy).toBe("u_ana");
  expect(stopped.stopReason).toBe("redo this using less memory");

  const crashed = kernels.find((k) => k.id === "k_crashed")!;
  expect("stoppedBy" in crashed).toBe(false);
  expect("stopReason" in crashed).toBe(false);
});

it("recognizes a reclaimed kernel as a valid state and passes its reclaimedTs through", async () => {
  // `toRunningKernel` refuses any state absent from `KERNEL_STATES` — a
  // machine reporting `reclaimed` and finding it dropped here would have the
  // row this whole policy exists to show never reach the lab at all.
  const lab = await freshLab();
  const { sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  attachStubDaemon(lab, [
    {
      id: "k_reclaimed",
      sessionId,
      taskId,
      name: "main",
      language: "python",
      state: "reclaimed",
      incarnation: 1,
      executionCount: 4,
      queueDepth: 0,
      environment: "python",
      reclaimedTs: 1_700_000_500,
    },
  ]);

  const kernels = await lab.ownerApi.listRunningKernels();

  const reclaimed = kernels.find((k) => k.id === "k_reclaimed");
  expect(reclaimed?.state).toBe("reclaimed");
  expect(reclaimed?.reclaimedTs).toBe(1_700_000_500);
});

it("drops a raw report whose reclaimedTs is not an epoch-seconds integer or absent", async () => {
  // `isRawKernelReport` (`http.ts`) is the one gate a body that crossed a
  // process this store did not write passes through before `settle` ever
  // sees it — `startedTs`/`lastActivityTs` are guarded there the same way,
  // and a `reclaimedTs` left unguarded would let a string like `"soon"`
  // reach a field `RunningKernel` declares `number`.
  const lab = await freshLab();
  const { sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  attachStubDaemon(lab, [
    {
      id: "k_malformed",
      sessionId,
      taskId,
      name: "main",
      language: "python",
      state: "reclaimed",
      incarnation: 1,
      executionCount: 4,
      queueDepth: 0,
      environment: "python",
      reclaimedTs: "soon",
    },
    {
      id: "k_valid",
      sessionId,
      taskId,
      name: "worker",
      language: "python",
      state: "reclaimed",
      incarnation: 1,
      executionCount: 1,
      queueDepth: 0,
      environment: "python",
      reclaimedTs: 1_700_000_600,
    },
  ]);

  const kernels = await lab.ownerApi.listRunningKernels();

  // The whole report is refused, not merely the one bad field — the same
  // discipline `isRawKernelReport`'s other guarded fields already hold to.
  expect(kernels.find((k) => k.id === "k_malformed")).toBeUndefined();
  const valid = kernels.find((k) => k.id === "k_valid");
  expect(valid?.reclaimedTs).toBe(1_700_000_600);
});

it("sums a machine's kernels against what that machine has", async () => {
  const lab = await freshLab();
  await reportMachineFacts(lab.base, lab.token, 8 * 1024 * 1024 * 1024, 8);
  const { sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  // Two kernels on one machine, 1 MB and 3 MB.
  attachStubDaemon(lab, [
    {
      id: "k_1",
      sessionId,
      taskId,
      name: "main",
      language: "python",
      state: "idle",
      incarnation: 1,
      executionCount: 0,
      queueDepth: 0,
      environment: "python",
      resources: { memoryBytes: 1 * 1024 * 1024 },
    },
    {
      id: "k_2",
      sessionId,
      taskId,
      name: "worker",
      language: "python",
      state: "idle",
      incarnation: 1,
      executionCount: 0,
      queueDepth: 0,
      environment: "python",
      resources: { memoryBytes: 3 * 1024 * 1024 },
    },
  ]);

  const snapshot = await lab.ownerApi.computeSnapshot();
  const machine = snapshot.find((m) => m.machineId === lab.machineId)!;
  expect(machine.memoryBytes).toBe(4 * 1024 * 1024);
  expect(machine.totalMemoryBytes).toBe(8 * 1024 * 1024 * 1024);
  expect(machine.kernelCount).toBe(2);
});

it("aligns two kernels' series from the newest reading rather than the oldest", async () => {
  // The rings share a clock but not a start: a kernel that has been up longer
  // holds readings from before the other existed, and pairing them from the
  // front would add a reading to a moment it was not taken in. An off-by-one
  // here is invisible in the output — it is a plausible sparkline either way —
  // so the arithmetic is asserted directly, on figures no two slots share.
  const lab = await freshLab();
  const { sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  const common = {
    sessionId,
    taskId,
    language: "python",
    state: "idle",
    incarnation: 1,
    executionCount: 0,
    queueDepth: 0,
    environment: "python",
  };
  attachStubDaemon(lab, [
    {
      ...common,
      id: "k_long_lived",
      name: "main",
      // Eight ticks, oldest first, every figure distinct from every other.
      series: [1, 2, 4, 8, 16, 32, 64, 128].map((memoryBytes, i) => ({
        memoryBytes,
        cpuPercent: i,
      })),
    },
    {
      ...common,
      id: "k_just_started",
      name: "worker",
      // Two ticks: this kernel did not exist for the first six above.
      series: [
        { memoryBytes: 1000, cpuPercent: 100 },
        { memoryBytes: 2000, cpuPercent: 200 },
      ],
    },
  ]);

  const snapshot = await lab.ownerApi.computeSnapshot();
  const machine = snapshot.find((m) => m.machineId === lab.machineId)!;

  // The shorter of the two. Eight slots would be six of them describing one
  // kernel and calling the figure the machine's.
  expect(machine.series).toHaveLength(2);
  // Newest against newest: the long-lived kernel's last two readings, not its
  // first two, paired with the young one's only two.
  expect(machine.series).toEqual([
    { memoryBytes: 64 + 1000, cpuPercent: 6 + 100 },
    { memoryBytes: 128 + 2000, cpuPercent: 7 + 200 },
  ]);
});

it("says nothing at all about a machine that is not answering", async () => {
  const lab = await freshLab();
  const offlineMachineId = lab.machineId;
  // A machine that does not answer the fan-out reports no kernels, which is
  // indistinguishable from answering "none" — so an offline machine must
  // carry no counts either, or the screen reads it as idle.
  //
  // Its size is reported first, and on purpose: the lab still knows how big
  // this machine is, from the last time it said so. That fact surviving into
  // the snapshot is what put "— of 8.0 GB" on an unreachable machine's row —
  // a live machine measured at nothing, which is the one reading this
  // whole em-dash rule exists to prevent. Nothing at all, or the absence
  // says something it does not mean.
  await reportMachineFacts(lab.base, lab.token, 8 * 1024 * 1024 * 1024, 8);
  lab.advanceClock(301);

  const snapshot = await lab.ownerApi.computeSnapshot();
  const machine = snapshot.find((m) => m.machineId === offlineMachineId)!;
  expect(machine.kernelCount).toBeUndefined();
  expect(machine.memoryBytes).toBeUndefined();
  expect(machine.totalMemoryBytes).toBeUndefined();
  expect(machine.cores).toBeUndefined();
});

it("leaves environments absent on computeSnapshot for a machine that has never reported them", async () => {
  // Absent is not the same fact as "reported holding none" — a report that
  // never carried the field at all must not read as an empty array.
  const lab = await freshLab();
  const snapshot = await lab.ownerApi.computeSnapshot();
  const machine = snapshot.find((m) => m.machineId === lab.machineId)!;
  expect(machine.environments).toBeUndefined();
});

it("remembers what a machine last reported holding of its environments, even once it goes offline", async () => {
  // Unlike every other field on MachineCompute, environments survives the
  // machine going offline: D2's "the machine's report is the truth about
  // what is built" only holds for an unreachable machine if that report is
  // remembered rather than re-asked on every poll.
  const lab = await freshLab();
  const reported: KernelEnvStatus[] = [
    {
      state: "ready", name: "python", language: "python", manager: "uv",
      platform: "macos-aarch64", root: "/work/envs/python", version: "3.12.7",
      packageCount: 6, lockRevision: 1,
    },
  ];
  await fetch(`${lab.base}/daemon/report`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({
      platform: "macos-aarch64", daemonVersion: "0.1.0", capabilities: [], clis: [],
      environments: reported,
    }),
  });
  lab.advanceClock(301);

  const snapshot = await lab.ownerApi.computeSnapshot();
  const machine = snapshot.find((m) => m.machineId === lab.machineId)!;
  // Offline, so every other field is absent (as asserted above) — but this
  // one is not.
  expect(machine.kernelCount).toBeUndefined();
  expect(machine.environments).toEqual(reported);
});

it("serves one fan-out to both readers of it", async () => {
  const lab = await freshLab();
  const machineId = lab.machineId;
  const { sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });

  // Attached by hand rather than through `attachStubDaemon`, which answers a
  // `kernel-list` the instant it arrives — too fast to prove anything here,
  // since `listRunningKernels` and `computeSnapshot` are two separate HTTP
  // calls and an instant reply can settle the sweep before the second one
  // has even reached the server. Held open until both have had the chance
  // to ask is what makes "only one kernel-list went out" a fact about the
  // sweep rather than a race this test happened to win.
  const deliveries: RunCommand[] = [];
  const detach = lab.relay.attach(machineId, (_seq, command) => deliveries.push(command));

  const listing = lab.ownerApi.listRunningKernels();
  const snapshotting = lab.ownerApi.computeSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const kernelListCommands = deliveries.filter((c) => c.type === "kernel-list");
  expect(kernelListCommands).toHaveLength(1);
  await fetch(`${lab.base}/daemon/kernel/list`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({
      requestId: kernelListCommands[0]!.runId,
      kernels: [
        {
          id: "k_1",
          sessionId,
          taskId,
          name: "main",
          language: "python",
          state: "idle",
          incarnation: 1,
          executionCount: 0,
          queueDepth: 0,
          environment: "python",
          resources: { memoryBytes: 2 * 1024 * 1024 },
        },
      ],
    }),
  });
  detach();

  const [kernels, snapshot] = await Promise.all([listing, snapshotting]);
  const summed = kernels
    .filter((k) => k.machineId === machineId)
    .reduce((n, k) => n + (k.resources?.memoryBytes ?? 0), 0);
  expect(snapshot.find((m) => m.machineId === machineId)!.memoryBytes).toBe(summed);
});

it("refuses a kernel-list reply from a machine the request was never sent to, and still accepts the real one", async () => {
  // `requestId` is minted off the same globally-sequential counter session
  // ids are, so it is exactly as guessable. A second paired machine — any
  // member's, not only a stranger's — could otherwise race the real machine
  // to answer first,
  // stamping fabricated kernels with the *targeted* machine and Research, or
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
  lab.relay.attach(lab.machineId, (_seq, command) => seen.push(command));
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

  // The real machine's own answer, for the exact same request, still lands
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
    expect.objectContaining({ id: "k_real", machineId: lab.machineId, researchId: lab.researchId }),
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

it("drops a kernel report naming a session that belongs to a different machine than the one reporting it, but keeps that machine's own honest report in the same reply", async () => {
  // No requestId guessing needed for this one: a machine answers its own,
  // legitimately-addressed kernel-list ask with a report naming a session
  // it does not hold — a real session, opened on a different machine
  // entirely. A host only ever reports kernels for sessions opened on its
  // own machine, so
  // an honest report can never produce this; only a forged one can.
  const lab = await freshLab();
  const { sessionId: sessionOnA, taskId: taskOnA } = await recordCellVia(lab, { source: "x = 1" });

  const { machineId: machineB, token: tokenB } = await pairClaudeMachine(lab.base, lab.memberApi, "bobs-desktop");
  const taskOnB = await lab.memberApi.createTask({
    researchId: lab.researchId,
    stage: "background",
    title: "machine B's own task",
  });
  const { runId: runOnB } = await lab.memberApi.startRun({
    researchId: lab.researchId,
    taskId: taskOnB.id,
    prompt: "go",
    options: { planMode: false, agent: "claude" },
  });
  const turnOnB = lab.store.get(`SELECT session_id FROM turns WHERE id = ?`, [runOnB]);
  const sessionOnB = turnOnB!.session_id as string;

  const seen: RunCommand[] = [];
  lab.relay.attach(machineB, (_seq, command) => seen.push(command));
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

it("drops a kernel report whose taskId names a Task the session never ran a turn for, even inside the session's own Research", async () => {
  // A Task in the *same* Research as the session's real one is deliberately
  // used here rather than a different Research: the binding is to the turn
  // that actually opened this session for a Task, not to Research membership,
  // so a taskId nothing here ever recorded a turn for is refused whether or
  // not it happens to share a Research with the real one.
  const lab = await freshLab();
  const { sessionId } = await recordCellVia(lab, { source: "x = 1" });
  const untouchedTask = await lab.ownerApi.createTask({
    researchId: lab.researchId,
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

it("keeps listing a Task's kernels after the Task is re-filed into a different Research", async () => {
  // `sessions.study_id` is fixed at the moment a session opens and never
  // moves with a later re-filing — binding a report's `taskId` to that
  // Research, rather than to the turn that actually opened the session for
  // it, would silently drop every live kernel of a Task the moment a
  // researcher moved it.
  const lab = await freshLab();
  const { sessionId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  const destinationResearch = await lab.ownerApi.createResearch({ key: "MOV", title: "Moved" });
  await lab.ownerApi.updateTask(taskId, { researchId: destinationResearch.id });

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
  lab.relay.attach(lab.machineId, (_seq, command) => taken.push(command));
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

it("records a cell a machine named a record for, without that record's name on it", async () => {
  // The route this cell arrives on stores no envelope and recomputes no
  // hash — a `provenanceId` here would be a paired machine deciding what a
  // row in a shared notebook points at. The cell is still recorded: the work
  // happened, and only the claim about a record behind it is dropped.
  const lab = await freshLab();
  const { kernelId, taskId } = await recordCellVia(lab, { source: "x = 1" });
  const stub = attachSilentDaemon(lab);
  const { cellId } = await lab.ownerApi.kernelExecute(kernelId, "2 + 2");
  const sent = stub.taken.at(-1)!;

  const res = await postCell(
    lab,
    cellReport(
      { cellId, sessionId: sent.sessionId!, taskId: sent.taskId!, kernelId },
      { provenanceId: "d".repeat(64) },
    ),
  );

  expect(res.status).toBe(200);
  const recorded = (await lab.ownerApi.taskNotebook(taskId)).find((c) => c.id === cellId)!;
  expect(recorded.source).toBe("2 + 2");
  expect("provenanceId" in recorded).toBe(false);
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
  // Task's notebook in any Research, attributed to a session that never ran
  // there at all.
  const lab = await freshLab();
  const { sessionId } = await recordCellVia(lab, { source: "x = 1" });
  const untouchedTask = await lab.ownerApi.createTask({
    researchId: lab.researchId,
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
