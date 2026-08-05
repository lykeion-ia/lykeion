import { afterEach, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createHttpApi,
  LykeionError,
  type LykeionApi,
  type RunEvent,
  type RunEventFrame,
  type Transport,
} from "@lykeion/api";
import { signUpOwner, startTestServer, type TestServer } from "./test-support/server-api";

/**
 * The whole spine, driven the way it is actually reached: a browser tab
 * signed in against a real server, a real daemon subprocess pairing with it
 * over loopback HTTP exactly as `pairing.ts` expects a browser to carry it
 * through, and a turn run by the daemon's own run subsystem against a
 * scripted ACP agent standing in for a coding CLI on `PATH`. Nothing here
 * reaches into either process — every claim is made about what a browser and
 * a paired machine would actually see on the wire, because that is the one
 * thing no single package's own suite can honestly stand in for.
 */
const src = dirname(fileURLToPath(import.meta.url));
const daemonSrc = join(src, "..", "..", "daemon", "src");
const stubAgent = join(daemonSrc, "test-support", "stub-acp-agent.ts");

let daemonBundle = "";

const dirs: string[] = [];
const children: ChildProcess[] = [];
const servers: TestServer[] = [];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-run-e2e-"));
  dirs.push(dir);
  daemonBundle = join(dir, "daemon.mjs");
  await build({
    entryPoints: [join(daemonSrc, "main.ts")],
    outfile: daemonBundle,
    bundle: true,
    platform: "node",
    format: "esm",
  });
}, 60_000);

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.pid !== undefined) child.kill("SIGKILL");
  }
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(1)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-run-e2e-daemon-"));
  dirs.push(dir);
  return dir;
}

/** Polls `predicate` until it holds, the same shape `lifecycle.test.ts` and
 *  `runs.test.ts` already poll subprocess and network state with — nothing
 *  here has a signal for "nothing more is coming right now" any more than
 *  those do. */
async function until(
  predicate: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function realServerOnLoopback(): Promise<TestServer> {
  const server = await startTestServer();
  servers.push(server);
  return server;
}

/**
 * A `Transport` that actually speaks the wire the way a signed-in browser
 * tab does: `/rpc/<method>` with the session cookie, the same as
 * `test-support/server-api.ts`'s `apiFor` — except `openRun` is real rather
 * than a no-op, reading `/runs/<id>/events` off a live `fetch` body the same
 * way `run-stream.test.ts`'s `openRunStream` does. `apiFor` cannot be reused
 * for this test: its `openRun` is a stub, which is correct for the tests
 * that only exercise the RPC surface, and wrong for the one thing this file
 * exists to prove — that a `RunHandle`'s `onEvent` built by
 * `createHttpApi.startRun` actually receives frames a daemon posted.
 */
function transportFor(base: string, cookie: string): Transport {
  return {
    async request(method, args) {
      const res = await fetch(`${base}/rpc/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ args }),
      });
      if (res.status === 401) {
        const body = (await res.json()) as { error?: string };
        throw new LykeionError("unauthenticated", body.error ?? "not signed in");
      }
      if (!res.ok) throw new Error(`${method} answered ${res.status}`);
      const body = (await res.json()) as {
        ok: boolean;
        value?: unknown;
        error?: { code: string; message: string };
      };
      if (body.ok) return body.value;
      throw new LykeionError(
        body.error!.code as ConstructorParameters<typeof LykeionError>[0],
        body.error!.message,
      );
    },
    openEvents: () => () => {},
    openRun(runId, cursor, onFrame, onClose) {
      const controller = new AbortController();
      const url = `${base}/runs/${runId}/events${cursor === undefined ? "" : `?cursor=${cursor}`}`;
      void (async () => {
        try {
          const res = await fetch(url, { headers: { cookie }, signal: controller.signal });
          if (!res.ok || !res.body) {
            onClose();
            return;
          }
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffered = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) {
              onClose();
              return;
            }
            buffered += decoder.decode(value, { stream: true });
            let cut = buffered.indexOf("\n\n");
            while (cut !== -1) {
              const block = buffered.slice(0, cut);
              buffered = buffered.slice(cut + 2);
              const lines = block.split("\n");
              const eventLine = lines.find((line) => line.startsWith("event:"));
              const dataLine = lines.find((line) => line.startsWith("data:"));
              const kind = eventLine?.slice("event:".length).trim();
              if (kind === "frame" && dataLine)
                onFrame(JSON.parse(dataLine.slice("data:".length).trim()) as RunEventFrame);
              if (kind === "end") {
                onClose();
                return;
              }
              cut = buffered.indexOf("\n\n");
            }
          }
        } catch {
          // Torn down from outside the read loop — this test's own cleanup,
          // most often — rather than settled on its own.
          onClose();
        }
      })();
      return () => controller.abort();
    },
  };
}

interface SignedInOwner {
  cookie: string;
  api: LykeionApi;
}

async function signInAsOwner(lab: TestServer): Promise<SignedInOwner> {
  const cookie = await signUpOwner(lab.base);
  return { cookie, api: createHttpApi(transportFor(lab.base, cookie)) };
}

/**
 * A `claude` this daemon's own probe resolves on `PATH` by that bare name —
 * the same name `probe.ts`'s catalogue already carries. Answering
 * `--version` is what makes the daemon's report say this machine has
 * `claude` installed at all; a real session never launches this binary
 * directly, since `claude-code-acp` — `writeAdapterStub`, below — is what
 * both the probe's handshake and a real run actually speak to.
 */
function writeClaudeStub(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, "claude"),
    `#!/usr/bin/env node
process.stdout.write("2.1.220\\n");
process.exit(0);
`,
    { mode: 0o755 },
  );
}

/**
 * Claude adapters this daemon's probe handshakes to decide `sessionReady`
 * and its run subsystem actually launches a session through. Both supported
 * names point at the same fixture so a globally installed preferred adapter
 * cannot outrank the compatibility stub on PATH and turn this hermetic test
 * into a call to the researcher's real toolchain.
 */
function writeAdapterStub(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const result = spawnSync(${JSON.stringify(process.execPath)}, ["--experimental-strip-types", ${JSON.stringify(stubAgent)}], { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
`;
  for (const command of ["claude-agent-acp", "claude-code-acp"])
    writeFileSync(join(binDir, command), script, { mode: 0o755 });
}

interface DaemonHandle {
  name: string;
  child: ChildProcess;
  output(): string;
}

/**
 * A real daemon child process, taken through the same loopback pairing
 * flow a researcher's browser is: admitted onto the nonce link the daemon
 * prints, submitting the connect form, and carrying the code the lab mints
 * back to the daemon's own `/paired` callback — the whole path
 * `pairing.test.ts` exercises piece by piece, driven here against a real
 * subprocess and a real lab in one pass. `claude` is put on `PATH` before
 * the child ever starts, so the daemon's own probe — not this test — is
 * what decides the machine offers it.
 */
async function pairAndServe(
  lab: TestServer,
  ownerApi: LykeionApi,
  options: { env?: Record<string, string> } = {},
): Promise<DaemonHandle> {
  const dataDir = freshDir();
  const binDir = freshDir();
  writeClaudeStub(binDir);
  writeAdapterStub(binDir);

  const name = "e2e-daemon";
  let output = "";
  const child = spawn(
    process.execPath,
    [daemonBundle, "serve", "--no-browser", "--data-dir", dataDir, "--lab", lab.base],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${binDir}:${dirname(process.execPath)}`,
        ...(options.env ?? {}),
      },
    },
  );
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  children.push(child);

  await until(() => /Pair this machine -> (\S+)/.test(output), "a pairing link", 15_000);
  const link = /Pair this machine -> (\S+)/.exec(output)![1]!;
  const daemonBase = new URL(link).origin;

  const admitted = await fetch(link, { redirect: "manual" });
  const cookie = admitted.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error(`admitting the pairing link did not set a cookie: ${await admitted.text()}`);

  const connected = await fetch(`${daemonBase}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ lab: lab.base, name }),
    redirect: "manual",
  });
  if (connected.status !== 302)
    throw new Error(`the daemon's /connect answered ${connected.status}: ${await connected.text()}`);
  const target = new URL(connected.headers.get("location")!);
  const params = new URLSearchParams(target.hash.slice(target.hash.indexOf("?")));

  const { code } = await ownerApi.pairMachine({
    name: params.get("name") ?? name,
    platform: params.get("platform") ?? "",
    daemonVersion: params.get("version") ?? "",
    challenge: params.get("challenge") ?? "",
    redirect: params.get("redirect") ?? "",
  });

  const paired = await fetch(
    `${daemonBase}/paired?code=${encodeURIComponent(code)}&state=${encodeURIComponent(params.get("state") ?? "")}`,
  );
  if (paired.status !== 200)
    throw new Error(`the daemon's /paired answered ${paired.status}: ${await paired.text()}`);

  return { name, child, output: () => output };
}

/** Whether the lab has heard, from the daemon's own probe, that this
 *  machine's `claude` can actually run a session — its adapter resolved on
 *  `PATH` and answered `initialize`, not merely that the bare command
 *  answers `--version`. */
async function machineIsSessionReady(ownerApi: LykeionApi, machineName: string): Promise<boolean> {
  const runtimes = await ownerApi.listRuntimes();
  const runtime = runtimes.find((r) => r.name === machineName);
  return runtime !== undefined && (runtime.clis ?? []).some((cli) => cli.id === "claude" && cli.sessionReady);
}

it(
  "carries a prompt from the contract to an agent and the answer back",
  async () => {
    const lab = await realServerOnLoopback();
    const owner = await signInAsOwner(lab);
    const daemon = await pairAndServe(lab, owner.api, {
      env: { LYKEION_STUB_SCRIPT: JSON.stringify([{ emit: "agent_message_chunk", text: "42" }]) },
    });

    await until(
      () => machineIsSessionReady(owner.api, daemon.name),
      "the daemon to report claude as session-ready",
      20_000,
    );

    const study = await owner.api.createStudy({ key: "CMP", title: "Comparative" });
    const task = await owner.api.createTask({ studyId: study.id, stage: "background", title: "run me" });

    const handle = await owner.api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "what is six times seven",
      options: { planMode: false, agent: "claude" },
    });
    const seen: RunEvent[] = [];
    handle.onEvent((e) => seen.push(e));

    await until(() => seen.some((e) => e.event === "completed"), "the turn to complete", 20_000);
    expect(seen.filter((e) => e.event === "assistant-text")).not.toHaveLength(0);
    expect(await owner.api.runHistory(task.id)).toHaveLength(1);
  },
  60_000,
);

it(
  "detaches and resubscribes the same HTTP handle without losing frames or cancelling the run",
  async () => {
    const lab = await realServerOnLoopback();
    const owner = await signInAsOwner(lab);
    const daemon = await pairAndServe(lab, owner.api, {
      env: {
        LYKEION_STUB_SCRIPT: JSON.stringify([
          { emit: "agent_message_chunk", text: "before " },
          { sleep: 600 },
          { emit: "agent_message_chunk", text: "during " },
          { sleep: 1_500 },
          { emit: "agent_message_chunk", text: "after" },
        ]),
      },
    });

    await until(
      () => machineIsSessionReady(owner.api, daemon.name),
      "the daemon to report claude as session-ready",
      20_000,
    );
    const study = await owner.api.createStudy({ key: "CMP", title: "Comparative" });
    const task = await owner.api.createTask({ studyId: study.id, stage: "background", title: "run me" });
    const handle = await owner.api.startRun({
      studyId: study.id,
      taskId: task.id,
      prompt: "keep running while this tab detaches",
      options: { planMode: false, agent: "claude" },
    });

    const beforeDetach: RunEvent[] = [];
    handle.onEvent((event) => beforeDetach.push(event));
    await until(
      () => beforeDetach.some((event) => event.event === "assistant-text" && event.text === "before "),
      "the first chunk before detaching",
      20_000,
    );
    handle.detach();

    await until(async () => {
      const resumed = await owner.api.resumeRuns(task.id);
      const snapshot = resumed[0]?.snapshot;
      for (const run of resumed) run.detach();
      return snapshot?.live.text?.includes("during ") ?? false;
    }, "the detached chunk to become durable", 20_000);

    const afterReattach: RunEvent[] = [];
    handle.onEvent((event) => afterReattach.push(event));
    await until(
      () => afterReattach.some((event) => event.event === "completed"),
      "the reattached run to complete",
      20_000,
    );

    const snapshot = afterReattach.find((event) => event.event === "snapshot");
    expect(snapshot).toEqual(expect.objectContaining({
      event: "snapshot",
      snapshot: expect.objectContaining({ live: { text: expect.stringContaining("during ") } }),
    }));
    expect(afterReattach).toContainEqual({ event: "assistant-text", text: "after", partial: true });
    expect((await owner.api.runHistory(task.id))[0]?.status).toBe("ok");
  },
  60_000,
);
