import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import type { LykeionApi, RunEventFrame } from "@lykeion/api";
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
 *  loopback port — the same harness `api/sessions.test.ts` and
 *  `run-stream.test.ts` build for the same reason: a grants test needs the
 *  raw store and relay directly, not only what the wire contract returns. */
function freshLabServer(): Promise<{ base: string; store: Store; relay: RunRelay; close(): Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-grants-"));
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

  const listener = createRequestListener({
    store, config, secure: false, indexHtml, channel, openStreams, runs: relay,
    reverts: createRevertRegistry(), kernelLists: createKernelListRegistry(), titles: createTitleRegistry(), pendingCells: createPendingCells(),
    coordinator: createEnvironmentSetupCoordinator({ store, runs: relay }),
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

/** Pairs a machine for whichever `LykeionApi` is handed to it and reports it
 *  as offering the `claude` CLI — the way `api/sessions.test.ts` pairs one,
 *  parameterized on the caller since this file needs a second member's
 *  machine as well as the owner's. */
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

interface GrantsLab {
  base: string;
  store: Store;
  relay: RunRelay;
  ownerApi: LykeionApi;
  ownerCookie: string;
  memberCookie: string;
  machineId: string;
  /** The paired machine's own bearer token, for posting frames and grants
   *  the way its daemon would. */
  token: string;
  researchId: string;
  taskId: string;
  runId: string;
}

/** A lab with an owner and a member, a machine the owner has paired and
 *  reported as offering `claude`, a Research, a Task filed into it, and a turn
 *  already started on that machine — what every test below needs before it
 *  can post a permission card, answer it, or write a grant. */
async function labWithRunInFlight(): Promise<GrantsLab> {
  const server = await freshLabServer();
  servers.push(server);

  const ownerCookie = await signUpOwner(server.base);
  const ownerApi = apiFor(server.base, ownerCookie);

  const invite = await ownerApi.createInvite("member");
  const memberCookie = await redeemInvite(server.base, invite.code, "member@lab.example", "Member");

  const { machineId, token } = await pairClaudeMachine(server.base, ownerApi, "ana-macbook");

  const research = await ownerApi.createResearch({ key: "CMP", title: "Comparative" });
  const task = await ownerApi.createTask({ researchId: research.id, stage: "background", title: "run me" });

  const { runId } = await ownerApi.startRun({
    researchId: research.id, taskId: task.id, prompt: "go",
    options: { planMode: false, agent: "claude" },
  });

  return {
    base: server.base,
    store: server.store,
    relay: server.relay,
    ownerApi,
    ownerCookie,
    memberCookie,
    machineId,
    token,
    researchId: research.id,
    taskId: task.id,
    runId,
  };
}

/** A lab with a second member's own machine paired beside the owner's, for
 *  the tests that have to prove a machine can only write a grant for a run
 *  it actually owns. */
async function labWithTwoPairedMachines(): Promise<GrantsLab & { memberToken: string }> {
  const lab = await labWithRunInFlight();
  const memberApi = apiFor(lab.base, lab.memberCookie);
  const { token: memberToken } = await pairClaudeMachine(lab.base, memberApi, "bobs-desktop");
  return { ...lab, memberToken };
}

/** A lab that already carries one standing grant for its Research and
 *  machine — what the two cascade tests start from. */
async function labWithGrant(): Promise<GrantsLab> {
  const lab = await labWithRunInFlight();
  await postGrant(lab, { path: "/work/rna-seq", mode: "write" });
  return lab;
}

/** POSTs a batch of run frames to `/daemon/run/events`, bearing the paired
 *  machine's token — the way the daemon that actually holds the run does. */
async function postFrames(lab: GrantsLab, frames: RunEventFrame[]): Promise<void> {
  const res = await fetch(`${lab.base}/daemon/run/events`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${lab.token}` },
    body: JSON.stringify({ runId: lab.runId, frames }),
  });
  if (!res.ok) throw new Error(`postFrames answered ${res.status}`);
}

/** POSTs to `/daemon/run/grant` bearing whichever token and naming whichever
 *  run a caller hands it, and hands back the raw response — the primitive
 *  every test in this file that needs to inspect a non-200 outcome (a
 *  refusal's status, its body, or that nothing was written) is built on. */
function fetchGrant(
  lab: GrantsLab,
  token: string,
  runId: string,
  grant: { path: string; mode: string },
): Promise<Response> {
  return fetch(`${lab.base}/daemon/run/grant`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ runId, path: grant.path, mode: grant.mode }),
  });
}

/** POSTs a standing grant to `/daemon/run/grant`, bearing the paired
 *  machine's token — what a real daemon sends once a "research"-scope decision
 *  answers a card, and what these tests send directly instead of driving a
 *  whole ACP subprocess through one. */
async function postGrant(lab: GrantsLab, grant: { path: string; mode: "read" | "write" }): Promise<void> {
  const res = await fetchGrant(lab, lab.token, lab.runId, grant);
  if (!res.ok) throw new Error(`postGrant answered ${res.status}`);
}

/** Opens `/runs/<runId>/events` as the owner and hands every `event: frame`
 *  block it reads to `onFrame`, in order, as they arrive — reading raw SSE
 *  off the wire the same way `run-stream.test.ts`'s own `openRunStream`
 *  does. */
async function openRunStream(
  lab: GrantsLab,
  runId: string,
  cursor: number | undefined,
  onFrame: (f: RunEventFrame) => void,
): Promise<void> {
  const url = `${lab.base}/runs/${runId}/events${cursor === undefined ? "" : `?cursor=${cursor}`}`;
  const res = await fetch(url, { headers: { cookie: lab.ownerCookie } });
  if (!res.ok) throw new Error(`run stream answered ${res.status}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffered += decoder.decode(value, { stream: true });
        let cut = buffered.indexOf("\n\n");
        while (cut !== -1) {
          const block = buffered.slice(0, cut);
          buffered = buffered.slice(cut + 2);
          const lines = block.split("\n");
          const eventLine = lines.find((l) => l.startsWith("event:"));
          const dataLine = lines.find((l) => l.startsWith("data:"));
          if (eventLine?.slice("event:".length).trim() === "frame" && dataLine)
            onFrame(JSON.parse(dataLine.slice("data:".length).trim()) as RunEventFrame);
          cut = buffered.indexOf("\n\n");
        }
      }
    } catch {
      // The connection was torn down from outside the read loop (the lab's
      // own teardown at `afterEach`, most often) rather than settling on its
      // own — nothing left here for a test to see either way.
    }
  })();
}

/** Polls `predicate` until it holds, the way a subscriber with no signal for
 *  "nothing more is coming right now" has to. */
async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the condition to hold");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it("carries a card to the browser and the answer back to the machine", async () => {
  const lab = await labWithRunInFlight();
  const seen: RunEventFrame[] = [];
  await openRunStream(lab, lab.runId, undefined, (f) => seen.push(f));
  await postFrames(lab, [
    {
      seq: 1,
      event: {
        event: "permission-card",
        request: { id: "pr_1", access: { kind: "write-path", target: "/work/rna-seq" }, tool: "t1" },
      },
    },
  ]);
  await until(() => seen.some((f) => f.event.event === "permission-card"));

  const taken: RunCommand[] = [];
  lab.relay.attach(lab.machineId, (_seq, c) => taken.push(c));
  await lab.ownerApi.submitRunDecision(lab.runId, {
    action: "permission",
    requestId: "pr_1",
    decision: { decision: "allow", scope: "once" },
  });
  expect(taken.at(-1)).toMatchObject({ type: "decision", runId: lab.runId });
});

it("writes a Research grant when a card is answered for the Research", async () => {
  const lab = await labWithRunInFlight();
  await postGrant(lab, { path: "/work/rna-seq", mode: "write" });
  expect(lab.store.all(`SELECT path, mode FROM folder_grants WHERE revoked_ts IS NULL`)).toEqual([
    { path: "/work/rna-seq", mode: "write" },
  ]);
});

it("never raises the card a second time for that Research", async () => {
  const lab = await labWithRunInFlight();
  await postGrant(lab, { path: "/work/rna-seq", mode: "write" });
  await postFrames(lab, [{ seq: 1, event: { event: "completed", state: { state: "completed" } } }]);
  const taken: RunCommand[] = [];
  lab.relay.attach(lab.machineId, (_seq, c) => taken.push(c));
  await lab.ownerApi.startRun({
    researchId: lab.researchId, taskId: lab.taskId, prompt: "again",
    options: { planMode: false, agent: "claude" },
  });
  // The daemon answers a covered request itself, so the second run never
  // raises a card at all — which is only true if the grant travelled.
  expect(taken[0]!.grants).toEqual([{ path: "/work/rna-seq", mode: "write" }]);
});

// ---- ownership on /daemon/run/grant — a run id is `run_<seq>`, sequential
// and guessable, and a grant is a durable authorization record, so the 403
// guard here is the one thing standing between a paired machine and a grant
// it never earned. Each of the three names the second machine as the
// *caller*, which is the only arrangement where the assertion can catch the
// guard's absence.

it("refuses — and never writes — a grant for a run a different paired machine does not own", async () => {
  const lab = await labWithTwoPairedMachines(); // one owner's, one member's
  const res = await fetchGrant(lab, lab.memberToken, lab.runId, { path: "/work/rna-seq", mode: "write" });
  expect(res.status).toBe(403);
  expect(lab.store.all(`SELECT * FROM folder_grants`)).toEqual([]);
});

it("refuses a grant for a run id nobody holds", async () => {
  const lab = await labWithRunInFlight();
  const res = await fetchGrant(lab, lab.token, "run_9999", { path: "/work/rna-seq", mode: "write" });
  expect(res.status).toBe(403);
  expect(lab.store.all(`SELECT * FROM folder_grants`)).toEqual([]);
});

it("gives the same refusal for an unowned run as for one that does not exist", async () => {
  // Run ids are sequential and guessable; a caller probing for which ones
  // are real must learn nothing from how the two cases are refused.
  const lab = await labWithTwoPairedMachines();
  const unowned = await fetchGrant(lab, lab.memberToken, lab.runId, { path: "/work/rna-seq", mode: "write" });
  const missing = await fetchGrant(lab, lab.token, "run_9999", { path: "/work/rna-seq", mode: "write" });
  expect(unowned.status).toBe(missing.status);
  expect(await unowned.json()).toEqual(await missing.json());
});

it("refuses a path that is not absolute, so an empty string never reads as every path", async () => {
  // `covers()` on the daemon side tests `path.startsWith(grant.path + "/")`
  // — an empty `grant.path` would make every absolute path match, a blanket
  // grant by accident, exactly what a named "global" scope is refused for.
  const lab = await labWithRunInFlight();
  const res = await fetchGrant(lab, lab.token, lab.runId, { path: "", mode: "write" });
  expect(res.status).toBe(400);
  expect(lab.store.all(`SELECT id FROM folder_grants`)).toEqual([]);
});

it("drops a Research's grants when the Research is deleted", async () => {
  const lab = await labWithGrant();
  await lab.ownerApi.deleteResearch(lab.researchId);
  expect(lab.store.all(`SELECT id FROM folder_grants`)).toEqual([]);
});

it("drops a machine's grants when the machine is removed", async () => {
  const lab = await labWithGrant();
  await lab.ownerApi.removeMachine(lab.machineId);
  expect(lab.store.all(`SELECT id FROM folder_grants`)).toEqual([]);
});

it("refuses a global scope by name rather than narrowing it", async () => {
  const lab = await labWithRunInFlight();
  await expect(
    lab.ownerApi.submitRunDecision(lab.runId, {
      action: "permission",
      requestId: "pr_1",
      decision: { decision: "allow", scope: "global" },
    }),
  ).rejects.toThrow(/every Research/);
});
