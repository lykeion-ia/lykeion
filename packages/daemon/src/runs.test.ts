import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import type {
  ExecutionLogEntry,
  PermissionRequest,
  RunEvent,
  TurnState,
} from "@lykeion/api";
import { backoffDelayMs } from "./lab";
import type { KernelHost } from "./kernel-host";
import { PROTOCOL_VERSION } from "./kernel-protocol";
import { startRuns, type RunSubsystem } from "./runs";
import { envRoot } from "./environments";
import { environmentSetupOutcomeSpool } from "./environment-setup-outcomes";

const STUB = join(import.meta.dirname, "test-support", "stub-acp-agent.ts");
const running: RunSubsystem[] = [];
const servers: Server[] = [];
const dirs: string[] = [];
const fixtureGeneration = (name: string): string => `envgen_fixture_${name}`;

afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
  for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  // Unconditional, not only on a test's own success path: a test whose
  // `until()` throws first must not leave its script sitting in the
  // environment for whatever runs next in this same file to trip over.
  delete process.env.LYKEION_STUB_SCRIPT;
  delete process.env.LYKEION_STUB_EXIT_MARKER;
  delete process.env.LYKEION_STUB_EXIT_DELAY_MS;
  delete process.env.LYKEION_STUB_SESSION_NEW_MARKER;
  delete process.env.LYKEION_STUB_SESSION_NEW_PARAMS;
  delete process.env.LYKEION_STUB_SESSION_NEW_DELAY_MS;
  delete process.env.LYKEION_STUB_PROMPT_MARKER;
});

/** A lab that holds a command stream open and records what comes back. */
async function stubLab(commands: unknown[]) {
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  const live: string[][] = [];
  const cells: Record<string, unknown>[] = [];
  const kernelListReplies: Array<{ requestId: string; kernels: unknown[] }> = [];
  const titleReplies: Array<{ requestId: string; title: string | null }> = [];
  const kernelEnvLocks: Array<{
    requestId: string;
    name: string;
    declarationGenerationId: string;
    lockfile: string;
  }> = [];
  /** Every declaration this lab was asked for, in order — the whole of what
   *  a card's "allow" is supposed to produce, and the whole of what its
   *  "deny" is supposed not to. */
  const kernelEnvCreates: Array<{
    sessionId: string;
    name: string;
    packages: string[];
    permissionScope?: string;
  }> = [];
  /** How this lab answers `/daemon/kernel-env/create`: `refusal` makes it
   *  refuse in the lab's own words, `rawBody` is written verbatim under a 200
   *  instead — a failure wearing a success code, which is what a proxy's own
   *  page or a truncated response arrives as — and `onCall` fires the moment
   *  the call arrives, which is how a test can place it against everything
   *  else that happened rather than only count it. */
  const kernelEnvCreate: { refusal?: string; rawBody?: string; onCall?: () => void } = {};
  /** Every add this lab was asked for, in order — the whole of what a
   *  `manage_packages` card's "allow" is supposed to produce, and the whole
   *  of what its "deny" is supposed not to. */
  const kernelEnvPackages: Array<{
    sessionId: string;
    name: string;
    packages: string[];
    permissionScope?: string;
  }> = [];
  /** How this lab answers `/daemon/kernel-env/packages`: `refusal` refuses in
   *  the lab's own words, `added` is what it reports as genuinely new (an
   *  empty list being everything asked for already being declared, which
   *  changes nothing and rebuilds nothing), and `rawBody` is written verbatim
   *  under a 200 instead — a failure wearing a success code, which is what a
   *  proxy's own page or a truncated response arrives as. */
  const kernelEnvPackagesAdd: { refusal?: string; added?: string[]; rawBody?: string } = {};
  const kernelEnvRequirements: Array<{
    runId: string;
    sessionId: string;
    environmentName: string;
  }> = [];
  const kernelEnvResults: Array<Record<string, unknown>> = [];
  const kernelEnvResult = { failuresRemaining: 0, conflictsRemaining: 0 };
  const kernelEnvProgress: Array<{
    requestId: string;
    name: string;
    progress: { stage: "resolving" | "installing" | "finalizing"; line: string };
  }> = [];
  /** What `/daemon/kernel-envs` answers with — this lab's declaration list,
   *  which the daemon asks for before it confines a session. `null` makes
   *  the endpoint fail, which is how a test stands in for a lab that cannot
   *  be asked right now. `rawBody`, when set, is written verbatim under a
   *  200 instead — how a test stands in for the same failure wearing a
   *  success code: a proxy's error page, a truncated response, a body whose
   *  `declarations` is not a list. */
  const kernelEnvDeclarations: { list: unknown[] | null; rawBody?: string } = { list: [] };
  let commandStream: import("node:http").ServerResponse | undefined;
  let seq = 0;
  let lockRevision = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      commandStream = res;
      res.on("close", () => {
        if (commandStream === res) commandStream = undefined;
      });
      for (const c of commands) {
        seq += 1;
        res.write(`event: command\ndata: ${JSON.stringify({ seq, command: c })}\n\n`);
      }
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      if (req.url === "/daemon/run/events")
        events.push(parsed as unknown as { runId: string; frames: never[] });
      if (req.url === "/daemon/run/live") live.push(parsed.runIds as string[]);
      if (req.url === "/daemon/cell") cells.push(parsed);
      if (req.url === "/daemon/kernel/list")
        kernelListReplies.push(parsed as { requestId: string; kernels: unknown[] });
      if (req.url === "/daemon/task/title")
        titleReplies.push(parsed as { requestId: string; title: string | null });
      if (req.url === "/daemon/kernel-env/lock") {
        kernelEnvLocks.push(parsed as {
          requestId: string;
          name: string;
          declarationGenerationId: string;
          lockfile: string;
        });
        lockRevision += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ lockRevision }));
        return;
      }
      if (req.url === "/daemon/kernel-envs") {
        if (kernelEnvDeclarations.rawBody !== undefined) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(kernelEnvDeclarations.rawBody);
          return;
        }
        if (kernelEnvDeclarations.list === null) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "this lab cannot list its environments right now" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          // Production declarations have an opaque generation. Most of this
          // older test fixture predates that field, so supply a deterministic
          // one at the fake-server boundary; tests about stale/missing marker
          // identity still spell their exact tokens explicitly below.
          declarations: kernelEnvDeclarations.list.map((declaration) => {
            if (
              typeof declaration === "object" && declaration !== null &&
              typeof (declaration as { name?: unknown }).name === "string" &&
              (declaration as { declarationGenerationId?: unknown }).declarationGenerationId === undefined
            )
              return {
                ...declaration,
                declarationGenerationId: fixtureGeneration(
                  (declaration as { name: string }).name,
                ),
              };
            return declaration;
          }),
        }));
        return;
      }
      if (req.url === "/daemon/kernel-env/create") {
        kernelEnvCreates.push(
          parsed as unknown as {
            sessionId: string;
            name: string;
            packages: string[];
            permissionScope?: string;
          },
        );
        kernelEnvCreate.onCall?.();
        if (kernelEnvCreate.refusal !== undefined) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: kernelEnvCreate.refusal }));
          return;
        }
        if (kernelEnvCreate.rawBody !== undefined) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(kernelEnvCreate.rawBody);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            declaration: {
              name: parsed.name,
              language: "python",
              manager: "uv",
              packages: parsed.packages,
              createdBy: "u_ana",
              createdTs: 1,
              lockRevision: 0,
            },
          }),
        );
        return;
      }
      if (req.url === "/daemon/kernel-env/packages") {
        kernelEnvPackages.push(
          parsed as unknown as {
            sessionId: string;
            name: string;
            packages: string[];
            permissionScope?: string;
          },
        );
        if (kernelEnvPackagesAdd.refusal !== undefined) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: kernelEnvPackagesAdd.refusal }));
          return;
        }
        if (kernelEnvPackagesAdd.rawBody !== undefined) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(kernelEnvPackagesAdd.rawBody);
          return;
        }
        const added = kernelEnvPackagesAdd.added ?? (parsed.packages as string[]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            declaration: {
              name: parsed.name,
              language: "python",
              manager: "uv",
              packages: added,
              createdBy: "u_ana",
              createdTs: 1,
              lockRevision: 1,
            },
            added,
            building: added.length > 0,
          }),
        );
        return;
      }
      if (req.url === "/daemon/kernel-env/require") {
        kernelEnvRequirements.push(
          parsed as unknown as {
            runId: string;
            sessionId: string;
            environmentName: string;
          },
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ waiterId: "wait_1" }));
        return;
      }
      if (req.url === "/daemon/kernel-env/result") {
        kernelEnvResults.push(parsed);
        if (kernelEnvResult.conflictsRemaining > 0) {
          kernelEnvResult.conflictsRemaining -= 1;
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "terminal outcome fingerprint conflict" }));
          return;
        }
        if (kernelEnvResult.failuresRemaining > 0) {
          kernelEnvResult.failuresRemaining -= 1;
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "temporary result transport failure" }));
          return;
        }
      }
      if (req.url === "/daemon/kernel-env/progress")
        kernelEnvProgress.push(parsed as (typeof kernelEnvProgress)[number]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  return {
    base: `http://127.0.0.1:${port}`,
    events,
    live,
    cells,
    kernelListReplies,
    titleReplies,
    kernelEnvLocks,
    kernelEnvCreates,
    kernelEnvCreate,
    kernelEnvPackages,
    kernelEnvPackagesAdd,
    kernelEnvRequirements,
    kernelEnvResults,
    kernelEnvResult,
    kernelEnvProgress,
    kernelEnvDeclarations,
    commandConnected(): boolean {
      return commandStream !== undefined;
    },
    disconnectCommands(): void {
      commandStream?.end();
      commandStream = undefined;
    },
    send(command: unknown): void {
      if (!commandStream) throw new Error("the command stream is not connected");
      seq += 1;
      commandStream.write(`event: command\ndata: ${JSON.stringify({ seq, command })}\n\n`);
    },
  };
}

/** A file the stub can write while it is confined. Every run is sandboxed,
 *  and the one directory a run may write is its Task's — so a marker the
 *  stub records its own progress in has to live there, created up front
 *  because the stub only appends. */
function markerIn(dataDir: string, name: string): string {
  const taskDir = join(`${dataDir}-work`, "studies", "s_cmp", "tasks", "t_cmp");
  mkdirSync(taskDir, { recursive: true });
  dirs.push(`${dataDir}-work`);
  return join(taskDir, name);
}

/**
 * An environment as a machine that has built it looks on disk: the
 * interpreter `readEnvStatus` probes, and — only when `finished` — the
 * completion marker `materializeEnvironment` writes LAST, once `uv pip sync`
 * has actually returned. An interpreter with no marker beside it is not a
 * spelling of "nearly built": it is exactly what an interrupted provision
 * leaves behind, which is what `broken` means and why it is worth being able
 * to write here.
 *
 * `base`, when given, writes the `pyvenv.cfg` `uv venv` leaves behind, whose
 * `home` records which interpreter this environment was actually built on.
 * Optional because a venv with no readable `pyvenv.cfg` is its own case:
 * this machine cannot say what the base is, which is not the same fact as
 * there being none.
 */
/** An R environment as micromamba leaves one: `bin/Rscript` rather than
 *  `bin/python3`, and the same completion marker. Separate from `envOnDisk`
 *  rather than a flag on it, because the difference between the two shapes
 *  IS what several of these tests are about — a helper that could produce
 *  either from one argument invites a test asserting the wrong one. */
function rEnvOnDisk(
  workDir: string,
  name: string,
  finished: boolean,
  generation: string | null = fixtureGeneration(name),
): string {
  const root = envRoot(workDir, name);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "Rscript"), "");
  if (finished)
    writeFileSync(
      join(root, ".lykeion-env.json"),
      JSON.stringify({
        ...(generation === null
          ? {}
          : {
              schemaVersion: 2,
              requestId: `envsetup_fixture_${name}`,
              name,
              manager: "conda",
              lockfileFingerprint: "a".repeat(64),
              packageFingerprint: "b".repeat(64),
            }),
        lockRevision: 3,
        packageCount: 99,
        version: "4.4.1",
        ...(generation === null ? {} : { declarationGenerationId: generation }),
      }),
    );
  return root;
}

function envOnDisk(
  workDir: string,
  name: string,
  finished: boolean,
  base?: string,
  generation: string | null = fixtureGeneration(name),
): string {
  const root = envRoot(workDir, name);
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "python3"), "");
  if (base !== undefined)
    writeFileSync(join(root, "pyvenv.cfg"), `home = ${base}\nversion_info = 3.12.7\n`);
  if (finished)
    writeFileSync(
      join(root, ".lykeion-env.json"),
      JSON.stringify({
        ...(generation === null
          ? {}
          : {
              schemaVersion: 2,
              requestId: `envsetup_fixture_${name}`,
              name,
              manager: "uv",
              lockfileFingerprint: "a".repeat(64),
              packageFingerprint: "b".repeat(64),
            }),
        lockRevision: 3,
        packageCount: 12,
        version: "3.12.7",
        ...(generation === null ? {} : { declarationGenerationId: generation }),
      }),
    );
  return root;
}

/**
 * Whether the boundary a kernel was handed actually lets it open one named
 * file — asked of the rendered profile that went out on the wire, not of the
 * list it was rendered from.
 *
 * A question about a file rather than about a string, because that is what
 * decides whether a kernel starts: the operating system either opens
 * `<base>/lib/python3.13/os.py` or it does not. `(subpath …)` covers a
 * directory and everything beneath it and stops at the component boundary,
 * so a grant on a base's `bin` directory answers `false` here for the
 * standard library beside it — while a containment check on the same profile
 * answers `true`, having found the venv's `home` spelled out somewhere in a
 * grant that reaches none of what the kernel reads.
 *
 * Conservative: the allows, minus anything a deny takes back, ignoring the
 * few narrow allows the profile ends with. So `true` here means genuinely
 * reachable, and nothing in these tests sits beneath one of those.
 */
function grantsReadOf(prefix: string[], file: string): boolean {
  // Found by its own first line rather than by counting arguments, so a
  // backend that stops rendering one of these fails loudly here instead of
  // quietly asserting nothing.
  const profile = prefix.find((arg) => arg.startsWith("(version 1)")) ?? "";
  const covers = (root: string): boolean => file === root || file.startsWith(`${root}/`);
  const subpathsOf = (rule: "allow" | "deny"): string[] =>
    profile
      .split("\n")
      .filter((line) => line.startsWith(`(${rule} `) && line.includes("file-read"))
      .flatMap((line) => [...line.matchAll(/\(subpath "([^"]*)"\)/g)].map((match) => match[1]!));
  if (subpathsOf("deny").some(covers)) return false;
  return subpathsOf("allow").some(covers);
}

/**
 * What the stub adapter is configured with, handed over on purpose.
 *
 * A run's environment is an allowlist now, so nothing a test exports reaches
 * the adapter by inheritance any more — which is the feature working. Every
 * `startRuns` here that actually spawns an adapter passes this; the two that
 * hand back no adapter at all have nothing to configure.
 *
 * A thunk rather than a snapshot: these are set at various points relative to
 * the call, and a value read once at construction would be empty for most of
 * them.
 */
const stubEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith("LYKEION_STUB_") && entry[1] !== undefined,
    ),
  );

/**
 * A fake `uv` binary, in the shape `environments.test.ts`'s own `stubUv`
 * builds — the same three subcommands `handleKernelEnvSetup` actually
 * drives, `venv`/`pip compile`/`pip sync`, faked out so these tests exercise
 * the WIRE (which command carries a lockfile, which endpoint gets called,
 * what the lab is told) rather than a real network resolve. No test here
 * resolves from PyPI.
 */
function stubUv(
  lockfile: string,
  options: { invocationLog?: string; failAt?: "compile" | "sync" } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), "lyk-runs-uv-"));
  dirs.push(dir);
  writeFileSync(join(dir, "stub-lockfile.txt"), lockfile);
  const script = [
    "#!/bin/sh",
    'here="$(cd "$(dirname "$0")" && pwd)"',
    ...(options.invocationLog === undefined
      ? []
      : [`printf '%s\\n' "$*" >> ${JSON.stringify(options.invocationLog)}`]),
    'if [ "$1" = "venv" ]; then',
    '  target="$2"',
    '  mkdir -p "$target/bin"',
    '  : > "$target/bin/python3"',
    '  chmod +x "$target/bin/python3"',
    "  printf 'version_info = 3.12.7\\n' > \"$target/pyvenv.cfg\"",
    "  exit 0",
    "fi",
    'if [ "$1" = "pip" ] && [ "$2" = "compile" ]; then',
    ...(options.failAt === "compile"
      ? ['  echo "stub resolve failed" >&2', "  exit 17"]
      : []),
    '  cat "$here/stub-lockfile.txt"',
    '  exit 0',
    "fi",
    'if [ "$1" = "pip" ] && [ "$2" = "sync" ]; then',
    ...(options.failAt === "sync"
      ? ['  echo "stub install failed" >&2', "  exit 19"]
      : []),
    '  exit 0',
    "fi",
    'echo "unhandled stub uv invocation: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
  writeFileSync(join(dir, "uv"), script);
  chmodSync(join(dir, "uv"), 0o755);
  return dir;
}

/** Minimal micromamba replay used to prove the journal checkpoint sits
 * above both provisioners. The command carries an explicit lock, so no
 * solver or network access is involved. */
function stubMicromamba(invocationLog: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lyk-runs-micromamba-"));
  dirs.push(dir);
  const script = [
    "#!/bin/sh",
    `printf '%s\\n' "$*" >> ${JSON.stringify(invocationLog)}`,
    'if [ "$1" = "create" ]; then',
    '  target="$6"',
    '  mkdir -p "$target/bin"',
    "  printf '#!/bin/sh\\necho \"Rscript (R) version 4.4.1 (2024-06-14)\"\\n' > \"$target/bin/Rscript\"",
    '  chmod +x "$target/bin/Rscript"',
    "  exit 0",
    "fi",
    'echo "unhandled stub micromamba invocation: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
  writeFileSync(join(dir, "micromamba"), script);
  chmodSync(join(dir, "micromamba"), 0o755);
  return dir;
}

/** Runs `fn` with a stub `uv` directory prepended to this PROCESS's own
 *  PATH — the fallback `resolveEnvironment`/`materializeEnvironment` read
 *  when `startRuns` gives them no `path` of their own, since `startRuns`'s
 *  options carry none: this daemon always searches the researcher's own
 *  PATH for the real thing, and a test stands in for that PATH rather than
 *  asking the daemon for a seam it does not otherwise need. Restored
 *  afterward regardless of how `fn` settles. */
async function withStubUvOnPath<T>(uvDir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = `${uvDir}:${original ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = original;
  }
}

function subsystem(
  base: string,
  dataDir: string,
  kernelHost?: () => KernelHost,
  kernelReachMs?: number,
  environmentSetup?: Pick<
    Parameters<typeof startRuns>[0],
    "environmentSetupCheckpoint" | "environmentSetupJournal"
  >,
) {
  const r = startRuns({
    lab: base,
    token: "machine-token",
    workDir: `${dataDir}-work`,
    dataDir,
    adapterFor: () => ({
      command: process.execPath,
      args: ["--experimental-strip-types", STUB],
    }),
    ...(kernelHost === undefined ? {} : { kernelHost }),
    ...(kernelReachMs === undefined ? {} : { kernelReachMs }),
    ...environmentSetup,
    extraEnv: stubEnv,
  });
  running.push(r);
  return r;
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${what} never happened`);
}

/** Whether a run actually RAN and finished — not merely whether the lab has
 *  heard anything about it, and not merely whether it ended.
 *
 *  Two different false-passes are shut here, and both were live. A turn queued
 *  behind another publishes a `queued` state frame the moment it is accepted,
 *  so "this lab has an event for that run id" is true long before the turn has
 *  done anything at all. And `refuse` ends a run that never reached a session
 *  with a `completed` frame of its own carrying `state: "failed"` — so a turn
 *  this machine turned away looks, to a predicate that reads only the event
 *  name, exactly like a turn that ran to the end. A test whose whole subject
 *  is what happens DURING a turn has to be able to tell those apart, or it
 *  goes green on the machine never having got that far. */
function hasRunToCompletion(
  lab: { events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> },
  runId: string,
): boolean {
  return lab.events
    .filter((post) => post.runId === runId)
    .flatMap((post) => post.frames)
    .map((frame) => frame.event)
    .some(
      (event): boolean =>
        event.event === "completed" && event.state.state === "completed",
    );
}

/** Every `ahead` a run's `queued` frames have carried, in the order they were
 *  published. */
function queuedPositions(
  lab: { events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> },
  runId: string,
): number[] {
  return lab.events
    .filter((post) => post.runId === runId)
    .flatMap((post) => post.frames)
    .map((frame) => frame.event)
    .filter((event): event is Extract<RunEvent, { event: "state" }> => event.event === "state")
    .map((event) => event.state)
    .filter((state): state is Extract<TurnState, { state: "queued" }> => state.state === "queued")
    .map((state) => state.ahead);
}

/** One cell as this machine's kernel host announces one: the cell itself, the
 *  session and Task it ran in, and the record of how it ran — which the host
 *  names by the hash of that record's own bytes. */
function announcedCell(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cell_host",
    sessionId: "se_1",
    taskId: "t_cmp",
    kernelId: "k_1",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 1,
    source: "1 + 1",
    origin: { surface: "agent", by: "a_claude" },
    ok: true,
    wallMs: 4,
    ts: 99,
    outputs: [],
    provenanceId: "p_1",
    provenance: {
      version: "lykeion.provenance.v1",
      identity: { taskId: "t_cmp", sessionId: "se_1", kernelId: "k_1", cellId: "cell_host" },
      outputs: { status: "succeeded", items: [] },
    },
    ...overrides,
  };
}

/** What this machine asked its host in order to put a kernel within reach,
 *  short what it tells the host about the workspace on its own clock: that
 *  telling is awaited off the path a turn is on, so where it lands among
 *  these is not something a caller decides or a test can pin. */
function reaching(asked: string[]): string[] {
  return asked.filter((method) => method !== "kernel.set_code_state");
}

/** A kernel host that answers, and says in what order it was asked.
 *
 *  `configuring` holds the boundary's reply open for as long as a test wants,
 *  which is what makes "before" and "after" observable at all: a machine that
 *  did not wait for it would have opened its session while this was still
 *  unanswered. */
function stubKernelHost(
  configuring: number,
  protocol: unknown = PROTOCOL_VERSION,
  languages: Array<{
    language: string; environment: string; interpreter: string; reads: string[];
  }> = [{ language: "python", environment: "python", interpreter: "/usr/bin/python3", reads: [] }],
  /** What the host says it could LAUNCH, as against what it discovered.
   *  Defaults to the discovered languages, which is what a host reported
   *  before the two were told apart — so every existing caller is unchanged
   *  and a test that cares passes them separately. */
  capable: string[] = languages.map((descriptor) => descriptor.language),
  /** What an environment of each launchable language must read beyond its own
   *  root — the directory holding that language's driver. Defaults to nothing,
   *  which is what a host reported before it said. */
  environmentReads: Record<string, string[]> = {},
) {
  const asked: string[] = [];
  /** The same asks, whole. `asked` answers "in what order", and a test about
   *  what this daemon actually SAID needs the params beside the name. */
  const calls: Array<{ method: string; params: unknown }> = [];
  const answering: { configured?: { token?: string }; refusing: boolean } = { refusing: false };
  /** Session ids this host will not take a boundary for, so a test can have
   *  ONE session's re-send fail while the others succeed. */
  const refusingFor = new Set<string>();
  /** Every boundary this host has been handed, in order — not only the last.
   *  A session configured a second time is the whole subject of the
   *  mid-session build tests, and `configured` alone cannot tell one call
   *  from two. */
  const configurations: Array<Record<string, unknown>> = [];
  /** Every `kernel.restart_environment` this host was asked for, whole. The
   *  method's own arguments are the point — which environment, and the
   *  sentence the ending carries — so `asked`'s method names alone cannot
   *  stand in for it. */
  const environmentRestarts: Array<Record<string, unknown>> = [];
  const cellListeners: Array<(params: unknown) => void> = [];
  /** What this daemon answers when the host asks IT for something — the
   *  second direction of the wire, which the real `kernel-host.ts` carries
   *  over the host's own stdin and which this stub stands in for at the
   *  interface. */
  const served = new Map<string, (params: unknown) => Promise<unknown>>();
  /** A boundary naming `env` is parked here BEFORE it is recorded, until the
   *  test lets it go — which is how a test puts one re-send's arrival after
   *  another's when its own read of the disk happened first. */
  const holding: { env?: string; entered: number; gate: Promise<void>; open?: () => void } = {
    entered: 0,
    gate: Promise.resolve(),
  };
  /** Every boundary is parked here AFTER it is recorded until `want` of them
   *  have arrived — a host that is alive and answering nothing. Re-sends
   *  dispatched together clear it between them; re-sends sent one after
   *  another cannot, and the first never returns. */
  const barrier: { want: number; entered: number; gate: Promise<void>; open?: () => void } = {
    want: 0,
    entered: 0,
    gate: Promise.resolve(),
  };
  const host: KernelHost = {
    call: async (method, params) => {
      asked.push(method);
      calls.push({ method, params });
      if (method === "host.hello") return { protocol, languages, capable, environmentReads };
      if (method === "kernel.restart_environment") {
        environmentRestarts.push((params ?? {}) as Record<string, unknown>);
        return { restarted: [] };
      }
      if (method === "kernel.configure_session") {
        const forSession = (params as { session_id?: string } | undefined)?.session_id;
        if (answering.refusing || (forSession !== undefined && refusingFor.has(forSession)))
          throw new Error("this host will not take a boundary right now");
        const named = ((params as { environments?: Array<{ name: string }> } | undefined)
          ?.environments ?? []).map((entry) => entry.name);
        if (holding.env !== undefined && named.includes(holding.env)) {
          holding.entered += 1;
          await holding.gate;
        }
        answering.configured = params as { token?: string };
        configurations.push(params as Record<string, unknown>);
        if (barrier.want > 0) {
          barrier.entered += 1;
          if (barrier.entered >= barrier.want) barrier.open?.();
          await barrier.gate;
        }
        await new Promise((resolve) => setTimeout(resolve, configuring));
        asked.push("the boundary landed");
        return {};
      }
      return {};
    },
    on: (method, handler) => {
      if (method === "cell") cellListeners.push(handler);
    },
    serve: (method, handler) => {
      served.set(method, handler);
    },
    stop: () => Promise.resolve(),
    get running() {
      return true;
    },
    stderrTail: () => "",
  };
  return {
    host,
    asked,
    calls,
    configurations,
    environmentRestarts,
    /** Asks this daemon for something, the way the real host does when it
     *  writes `{id, method, params}` to its own stdout — and refuses a
     *  method nothing served with the same sentence `kernel-host.ts` writes
     *  back, so a test cannot pass here on a registration that never
     *  happened. */
    ask(method: string, params: unknown): Promise<unknown> {
      const handler = served.get(method);
      if (handler === undefined)
        return Promise.reject(
          new Error(`this machine's daemon serves no method named ${method}`),
        );
      return handler(params);
    },
    get configured() {
      return answering.configured;
    },
    /** Makes every later `configure_session` raise — a host that has fallen
     *  over, or been replaced, between opening a session and building an
     *  environment under it. */
    refuseConfigures(): void {
      answering.refusing = true;
    },
    /** Makes every later `configure_session` for THIS session raise, and
     *  leaves every other session's alone — a host that has lost one
     *  session's confinement, not one that has fallen over. */
    refuseConfiguresFor(sessionId: string): void {
      refusingFor.add(sessionId);
    },
    /** Undoes both refusals — a host that has come back. What a test needs to
     *  ask "and afterwards?": a machine that gave up on something the first
     *  time it was refused looks identical, while it is being refused, to one
     *  that will try again. */
    allowConfigures(): void {
      answering.refusing = false;
      refusingFor.clear();
    },
    /** Parks every later boundary that names `env` before recording it, so a
     *  test can hold one re-send's arrival open while another runs to
     *  completion. Nothing about the held call is recorded until
     *  `releaseHeld`, which is what makes "which boundary landed last"
     *  something a test can arrange rather than something it has to catch. */
    holdBoundariesNaming(env: string): void {
      holding.env = env;
      holding.gate = new Promise<void>((resolve) => {
        holding.open = resolve;
      });
    },
    releaseHeld(): void {
      holding.open?.();
    },
    /** How many boundaries have reached the hold, whether or not they have
     *  been let go — the only way to know a re-send is in flight when the
     *  point of the hold is that it has not landed. */
    get heldEntries(): number {
      return holding.entered;
    },
    /** Answers no boundary until `n` of them have been handed over, and then
     *  answers them all. A host that is alive and silent, with no clock in
     *  it: `n` re-sends in flight at once release each other, and `n` sent
     *  one after another cannot. */
    barrierAt(n: number): void {
      barrier.want = n;
      barrier.gate = new Promise<void>((resolve) => {
        barrier.open = resolve;
      });
    },
    /** Fires this host's own "cell" notification at whoever wired
     *  `forwardKernelCells` onto it, the way `kernel-host.ts` would once the
     *  real process wrote one to its stdout. */
    announceCell(params: unknown): void {
      for (const listener of cellListeners) listener(params);
    },
  };
}

const startRunOn = (runId: string, sessionId = "se_1") => ({
  type: "start-run",
  runId,
  agent: "claude",
  studyId: "s_cmp",
  taskId: "t_cmp",
  sessionId,
  prompt: "go",
});

it("gives a session a kernel before it starts the agent it names one to", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const opened = markerIn(data, "session-opened");
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = opened;
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(400);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_kernels"));

  await until(() => kernels.asked.includes("the boundary landed"), "the boundary landing");
  // The agent has not been started yet, so no tool call of its own could have
  // reached a kernel this machine had not described a boundary for.
  expect(existsSync(opened)).toBe(false);

  await until(() => existsSync(named), "the session opening");
  const params = JSON.parse(readFileSync(named, "utf8")) as {
    mcpServers: Array<{ name: string; args: string[]; env: Array<{ name: string; value: string }> }>;
    _meta?: unknown;
  };
  expect(reaching(kernels.asked)).toEqual([
    "host.hello",
    "kernel.configure_session",
    "the boundary landed",
  ]);
  expect(params.mcpServers.map((server) => server.name)).toEqual(["notebook"]);
  // Present and empty, not absent: the ACP schema requires `env`, and the
  // real adapters silently drop an entry without it — a session that opens
  // with no kernel tools and no error anywhere.
  expect(params.mcpServers[0]?.env).toEqual([]);
  // Alongside the bridge, the run's settings sources are emptied and its MCP
  // config held strict — a claude adapter left to its defaults loads the
  // machine owner's own MCP servers and account connectors into the very
  // session the bridge was supposed to be the whole tool set of.
  expect(params._meta).toMatchObject({
    claudeCode: { options: { settingSources: [], strictMcpConfig: true } },
  });
  expect(params.mcpServers[0]?.args).toContain("--session");
  expect(params.mcpServers[0]?.args).toContain("se_1");
  // The word the relay carries is the one the host was told to expect, and
  // nothing else on this machine has it. A relay holding some other word is a
  // relay this session's kernels were not given to.
  const args = params.mcpServers[0]?.args ?? [];
  const carried = args[args.indexOf("--token") + 1];
  expect(carried).toBeTruthy();
  expect(kernels.configured?.token).toBe(carried);
});

it("writes each language's boundary from that language's own reads alone", async () => {
  // Named for what it can prove, which is a property of the policy TEXT and
  // not of the permission that text produces. It was called "renders one
  // boundary per language and never one shared between them", and read as
  // proof that a Python cell cannot reach R's libraries; it is not, and no
  // assertion made from this side of the wire could be. A path absent from a
  // profile may still be readable, because `SYSTEM_READ` grants whole trees
  // this never names — /opt among them, which is where a homebrew R keeps
  // most of itself. The denial that actually holds is the one under the
  // researcher's home, and it is asserted where it can be asked of the
  // operating system: sandbox.kernel.test.ts.
  //
  // What is left here is still worth holding, and is the part the wiring
  // owns: each descriptor's reads reach that language's policy and no
  // other's, so nothing above ever hands a kernel a boundary built for a
  // language it is not. The reads below are stood in for by paths outside
  // /opt precisely so this stays a statement about routing rather than one
  // that borrows a system grant and looks like confinement.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    {
      language: "python", environment: "python",
      interpreter: "/nowhere/python/bin", reads: ["/nowhere/python/env"],
    },
    { language: "r", environment: "r", interpreter: "/nowhere/r/bin", reads: ["/nowhere/r/site-library"] },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_two_languages"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{ language: string; name: string; interpreter: string; prefix: string[] }>;
  };
  const byLanguage = Object.fromEntries(
    configured.environments.map((entry) => [entry.language, entry]),
  );
  expect(Object.keys(byLanguage).sort()).toEqual(["python", "r"]);
  expect(byLanguage.python.name).toBe("python");
  expect(byLanguage.r.name).toBe("r");
  expect(byLanguage.python.interpreter).toBe("/nowhere/python/bin");
  expect(byLanguage.r.interpreter).toBe("/nowhere/r/bin");
  // Told apart, not merely both present: one prefix built from the union of
  // both descriptors would satisfy every line below except these two.
  expect(byLanguage.python.prefix).not.toEqual(byLanguage.r.prefix);
  expect(byLanguage.python.prefix.join(" ")).toContain("/nowhere/python/env");
  expect(byLanguage.r.prefix.join(" ")).toContain("/nowhere/r/site-library");
  expect(byLanguage.python.prefix.join(" ")).not.toContain("/nowhere/r/site-library");
  expect(byLanguage.r.prefix.join(" ")).not.toContain("/nowhere/python/env");
});

it("tells the host every name this lab has declared, not only the ones built here", async () => {
  // Two lists, and the host needs both. `environments` is what this machine
  // can start a kernel in; `declared` is what exists at all. A colleague's
  // environment that nobody has downloaded here appears in the second and
  // not the first, and that gap is exactly the fact the host's refusal
  // reads to say "not built on this machine yet" rather than "no such
  // environment".
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    { name: "python", language: "python", manager: "uv", packages: [], createdTs: 1, lockRevision: 1 },
    { name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: 2, lockRevision: 3 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_declared"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    declared?: string[];
    environments: Array<{ name: string }>;
  };
  expect(configured.declared).toEqual(["python", "crispr"]);
  // The point of carrying it: this machine has built one of the two.
  expect(configured.environments.map((entry) => entry.name)).toEqual(["python"]);
});

it("hands the session an environment this machine has actually built, beside the language floor", async () => {
  // The other half of the pair above, and the one that makes every piece
  // behind it reachable. A machine that has built `crispr` must offer it: the
  // map `identity_for` resolves a name against is this list, so an entry
  // missing here is a researcher told "not built on this machine yet" about
  // the environment their own machine finished building.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    { name: "python", language: "python", manager: "uv", packages: [], createdTs: 1, lockRevision: 1 },
    { name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: 2, lockRevision: 3 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  // Built here, and finished: interpreter and completion marker both.
  const root = envOnDisk(workDir, "crispr", true);
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    {
      language: "python", environment: "python",
      interpreter: "/nowhere/python/bin/python3", reads: ["/nowhere/python/base"],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_built"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{
      language: string; name: string; interpreter: string;
      prefix: string[]; default?: boolean;
    }>;
  };
  const byName = Object.fromEntries(configured.environments.map((entry) => [entry.name, entry]));
  expect(Object.keys(byName).sort()).toEqual(["crispr", "python"]);
  const built = byName.crispr!;
  expect(built.language).toBe("python");
  // This machine's own copy, not whatever the floor is run out of.
  expect(built.interpreter).toBe(join(root, "bin", "python3"));
  // A boundary was rendered for it, and it names the environment's own root.
  expect(built.prefix.length).toBeGreaterThan(0);
  expect(built.prefix.join(" ")).toContain(realpathSync(root));
  // And the floor's own reads travel with it: `bin/python3` inside a venv is
  // a link out to the base interpreter, and a boundary is written where the
  // operating system will look. Granting only the root refuses the kernel
  // before its first instruction.
  expect(built.prefix.join(" ")).toContain("/nowhere/python/base");
  // Never the default, whatever is built here. A built environment is
  // reached by being named; anything else would make "which environment did
  // this cell run in" depend on what a machine happens to hold.
  expect("default" in built).toBe(false);
  expect(byName.python!.default).toBe(true);
});

it("hands over nothing for a declared environment this machine has only half built", async () => {
  // Interpreter present, completion marker missing — what an interrupted
  // `uv pip sync` leaves behind, which `readEnvStatus` calls `broken`. Its
  // absence from this list is exactly what produces the refusal a researcher
  // should read, and offering it would hand a kernel an interpreter with
  // none of the packages the environment is FOR.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    { name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: 2, lockRevision: 3 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  envOnDisk(workDir, "crispr", false);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_half_built"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    declared?: string[];
    environments: Array<{ name: string }>;
  };
  // Declared, so the host can say "not built here yet" rather than "no such
  // environment" — and offered by nobody, so it cannot be started.
  expect(configured.declared).toEqual(["crispr"]);
  expect(configured.environments.map((entry) => entry.name)).toEqual(["python"]);
});

it("keeps stale and generationless ready markers declared but unbuilt in kernel configuration", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    {
      name: "stale",
      language: "python",
      manager: "uv",
      packages: ["numpy"],
      createdTs: 2,
      lockRevision: 3,
      declarationGenerationId: "envgen_current_stale",
    },
    {
      name: "missing",
      language: "python",
      manager: "uv",
      packages: ["numpy"],
      createdTs: 3,
      lockRevision: 3,
      declarationGenerationId: "envgen_current_missing",
    },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  envOnDisk(workDir, "stale", true, undefined, "envgen_previous_stale");
  envOnDisk(workDir, "missing", true, undefined, null);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_generation_marker_gate"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    declared?: string[];
    environments: Array<{ name: string }>;
  };
  expect(configured.declared).toEqual(["stale", "missing"]);
  expect(configured.environments.map((entry) => entry.name)).toEqual(["python"]);
});

it("names one default per language, however many descriptors the floor reports", async () => {
  // The host refuses a WHOLE confinement carrying two defaults for one
  // language, which is a session with no kernels at all rather than one
  // degraded kernel. The floor reports one descriptor per language today;
  // this is what keeps that from being the only reason it works.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    {
      language: "python", environment: "python",
      interpreter: "/nowhere/python/bin/python3", reads: ["/nowhere/python/base"],
    },
    {
      language: "python", environment: "python-3.11",
      interpreter: "/nowhere/python311/bin/python3", reads: ["/nowhere/python311/base"],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_two_pythons"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{ language: string; name: string; default?: boolean }>;
  };
  // Both reachable by name — this drops neither.
  expect(configured.environments.map((entry) => entry.name)).toEqual(["python", "python-3.11"]);
  const defaults = configured.environments.filter((entry) => entry.default);
  expect(defaults.map((entry) => entry.name)).toEqual(["python"]);
});

it("replaces the floor's own entry when its name is built here, default and all", async () => {
  // The starter is called `python` and so is the floor descriptor, so a
  // machine that builds the starter has two facts about one `(language,
  // name)` — and only one of them may go out. Which one survives is decided
  // HERE, by key, rather than left to whichever entry the host happens to
  // read last: it files these under `(language, name)` too, and a list
  // carrying the pair twice would make a built environment's reachability a
  // property of iteration order.
  //
  // And the default travels with the name. `python` was this language's
  // default before the starter was built and is after; the only thing that
  // changed is which interpreter the name resolves to. Dropping it here
  // would leave the language with no default at all on exactly the machines
  // that did the most work.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    { name: "python", language: "python", manager: "uv", packages: [], createdTs: 1, lockRevision: 1 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  const root = envOnDisk(workDir, "python", true);
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    {
      language: "python", environment: "python",
      interpreter: "/nowhere/python/bin/python3", reads: ["/nowhere/python/base"],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_built_starter"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{ language: string; name: string; interpreter: string; default?: boolean }>;
  };
  // Exactly one, not two that agree: a duplicate pair on the wire is the
  // unwritten contract this is here to stop.
  expect(configured.environments.length).toBe(1);
  const only = configured.environments[0]!;
  expect([only.language, only.name]).toEqual(["python", "python"]);
  // Backed by the copy this machine built, not by the floor interpreter.
  expect(only.interpreter).toBe(join(root, "bin", "python3"));
  // And still the language's default, because the name still is.
  expect(only.default).toBe(true);
});

it("offers a built R environment, and launches it through Rscript", async () => {
  // The end of the chain this phase exists to build, and the case that was
  // dark on every machine until now. Three separate layers had to agree:
  // the host must report R as launchable, the daemon's gate must admit a
  // declaration on that rather than on what the machine discovered, and the
  // reader must probe the MANAGER's interpreter. Any one of them wrong and
  // this is silent — which is exactly how it shipped twice.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    { name: "rstats", language: "r", manager: "conda", packages: [], createdTs: 1, lockRevision: 3 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  const root = rEnvOnDisk(workDir, "rstats", true);
  const kernels = stubKernelHost(
    0,
    PROTOCOL_VERSION,
    // Discovered: python only — a real machine, where R is never discovered.
    [
      {
        language: "python", environment: "python",
        interpreter: "/nowhere/python/bin/python3", reads: ["/nowhere/python/base"],
      },
    ],
    ["python", "r"],
  );
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_built_r"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{ language: string; name: string; interpreter: string }>;
  };
  const r = configured.environments.find((entry) => entry.name === "rstats");
  expect(r).toBeDefined();
  expect(r!.language).toBe("r");
  // Through the manager's interpreter, not python's. This is the assertion
  // that would have caught an R environment being handed the R driver a
  // python binary.
  expect(r!.interpreter).toBe(join(root, "bin", "Rscript"));
});

it("does not offer an R declaration whose build on disk is a python one", async () => {
  // The protection the declaration gate used to give away for free. It
  // refused any language this machine had not discovered, which incidentally
  // stopped this; it now asks about capability instead, so the manager's own
  // interpreter probe is what has to catch it.
  //
  // Reachable through name reuse: a python environment named `rstats`,
  // deleted, later re-declared as R, on a machine that has not rebuilt it.
  // The stale `bin/python3` and a valid marker would read `ready` to a
  // language-blind probe, and the R driver would be started on a python
  // binary.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    { name: "rstats", language: "r", manager: "conda", packages: [], createdTs: 1, lockRevision: 3 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  // A python-shaped build under an R declaration's name.
  envOnDisk(workDir, "rstats", true, "/nowhere/base/bin");
  const kernels = stubKernelHost(
    0,
    PROTOCOL_VERSION,
    [
      {
        language: "python", environment: "python",
        interpreter: "/nowhere/python/bin/python3", reads: ["/nowhere/python/base"],
      },
    ],
    ["python", "r"],
  );
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_mismatched_r"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{ language: string; name: string }>;
  };
  expect(configured.environments.find((entry) => entry.name === "rstats")).toBeUndefined();
});

it("offers a declaration in a language this host can launch but this machine never discovered", async () => {
  // The regression test for a CRITICAL this branch shipped and caught: an R
  // environment was withheld on every machine, forever.
  //
  // `floorReads` records what this machine DISCOVERED at startup, and R is
  // deliberately no longer discovered from a bare `Rscript` — it reaches a
  // cell only through an environment the lab declared and this machine
  // built. So a gate asking `floorReads.has("r")` answered no everywhere,
  // and every R environment ever built was reported "not built on this
  // machine yet" while it sat there built. False is worse than absent.
  //
  // Asserted as a SILENCE, deliberately, and that is the whole care in this
  // test. A positive "R is offered" assertion is not honestly available
  // here: `envOnDisk` builds a python-shaped root, so making one READY
  // would prove a language-mismatched interpreter got through rather than
  // that R works. What IS honestly available is that the gate no longer
  // rejects on discovery — the declaration below is simply never built, so
  // after the gate it is dropped one line down by `state !== "ready"`,
  // quietly and correctly. Before the fix this same case was rejected AT
  // the gate, loudly and wrongly, which is what makes the silence
  // discriminating.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    { name: "genome", language: "r", manager: "conda", packages: [], createdTs: 1, lockRevision: 1 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  // Never built here — nothing calls `envOnDisk` for it. That is the point.
  const kernels = stubKernelHost(
    0,
    PROTOCOL_VERSION,
    // Discovered: python only, which is every real machine now that R is not
    // discovered at all.
    [
      {
        language: "python", environment: "python",
        interpreter: "/nowhere/python/bin/python3", reads: ["/nowhere/python/base"],
      },
    ],
    // Capable: both, which is every real machine — `LAUNCHERS` carries an R
    // launcher whether or not this machine ever built an R environment.
    ["python", "r"],
  );
  const said: string[] = [];
  const reporting = console.error;
  console.error = (line: unknown) => said.push(String(line));
  try {
    subsystem(lab.base, data, () => kernels.host);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send(startRunOn("run_capable_undiscovered"));
    await until(() => kernels.configured !== undefined, "the boundary landing");
  } finally {
    console.error = reporting;
  }

  // Not turned away for being a language this machine does not run. Both
  // spellings are checked — the one the old gate used and the one the new
  // gate uses — so this keeps failing if either is reintroduced.
  const turnedAway = said.filter(
    (line) => line.includes("genome") && (line.includes("runs no") || line.includes("cannot launch")),
  );
  expect(turnedAway).toEqual([]);
});

it("leaves out a declaration in a language this machine does not run", async () => {
  // The lab is a different trust domain and its list arrives shape-checked,
  // not field-checked — so `language` can be a string this floor never
  // reported or, from an older or broken lab, not a string at all. Either
  // one reaching `configure_session` makes the host refuse the WHOLE
  // confinement, and a refused confinement is a session with no kernel tools
  // whatsoever: one malformed row anywhere in the lab costing every session
  // on every machine its kernels.
  //
  // The same check keeps a declaration to the language it claims: this probe
  // is `bin/python3` for every row regardless, so an `r` row with a python
  // venv under it would otherwise replace the R floor entry and hand the R
  // driver a python interpreter.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    // Not a string at all — what a lab that never validated the field can hold.
    { name: "crispr", language: null, manager: "uv", packages: ["scanpy"], createdTs: 1, lockRevision: 1 },
    // A language this machine has no floor for, so nothing to link out into.
    { name: "genome", language: "r", manager: "uv", packages: [], createdTs: 2, lockRevision: 1 },
    { name: "omics", language: "python", manager: "uv", packages: ["numpy"], createdTs: 3, lockRevision: 1 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  // All three are fully built on disk, so nothing below is explained by one
  // of them merely being absent.
  envOnDisk(workDir, "crispr", true);
  envOnDisk(workDir, "genome", true);
  envOnDisk(workDir, "omics", true);
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    {
      language: "python", environment: "python",
      interpreter: "/nowhere/python/bin/python3", reads: ["/nowhere/python/base"],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_bad_language"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{ language: string; name: string }>;
  };
  // The floor and the one declaration this machine can actually run. The
  // other two cost themselves their entry and nothing else.
  expect(configured.environments.map((entry) => entry.name)).toEqual(["python", "omics"]);
  expect(configured.environments.every((entry) => entry.language === "python")).toBe(true);
});

it("costs a relative interpreter one environment rather than costing the machine every kernel it has", async () => {
  // The failure `config.ts`'s `resolve` closes, arriving by the other door.
  // An environment's `interpreter` is `<workDir>/envs/<name>/bin/python3`,
  // and the host's `_environments_from` refuses a relative one — rightly,
  // since a relative interpreter is resolved against the HOST's own working
  // directory and would put a directory of its choosing in front of every
  // cell's `PATH`. But it refuses the WHOLE list on the first bad entry, so
  // `configure_session` fails, `kernelsFor`'s catch names no server, and the
  // session gets no kernel tools at all — the FLOOR included. That is a
  // machine's every kernel lost to one odd path, which is exactly what the
  // two per-entry `try/catch` loops around this exist to prevent.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    { name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: 2, lockRevision: 3 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  // Really built, so nothing below is explained by the environment simply
  // being absent — `readEnvStatus` calls this one `ready`.
  envOnDisk(workDir, "crispr", true);
  // The same directory, named the way `--work-dir ./work` leaves it once
  // nothing has made it absolute. Resolved against this process's own cwd it
  // is the tree above, so every read of it still lands.
  const asTyped = relative(process.cwd(), workDir);
  expect(isAbsolute(asTyped)).toBe(false);
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    {
      language: "python", environment: "python",
      interpreter: "/nowhere/python/bin/python3", reads: ["/nowhere/python/base"],
    },
  ]);
  // Not `subsystem`, which derives an absolute `workDir` from the data
  // directory — the relative one IS the case.
  const runs = startRuns({
    lab: lab.base,
    token: "machine-token",
    workDir: asTyped,
    dataDir: data,
    adapterFor: () => ({
      command: process.execPath,
      args: ["--experimental-strip-types", STUB],
    }),
    kernelHost: () => kernels.host,
    extraEnv: stubEnv,
  });
  running.push(runs);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_relative_workdir"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{ name: string; interpreter: string }>;
  };
  // The floor survived, which is the whole of it: this session can still run
  // a cell. `crispr` cost itself its entry and nothing else.
  expect(configured.environments.map((entry) => entry.name)).toEqual(["python"]);
  // And nothing relative reached the wire, which is what the host would have
  // refused the whole list over.
  expect(configured.environments.every((entry) => isAbsolute(entry.interpreter))).toBe(true);
});

it("writes a built environment's boundary around the base its own pyvenv.cfg names", async () => {
  // `uv venv` runs with no `--python`, on purpose: which Python an
  // environment is built on is a fact about its lockfile's `requires-python`
  // and not about this daemon. So the base a venv's `bin/python3` links out
  // to genuinely differs from whatever the kernel host process happens to be
  // running under — a different managed CPython, a different version window
  // — and a boundary written from the host's base alone names a directory
  // the venv never links into. The kernel is then refused before its first
  // instruction, which is precisely the failure this read set exists to
  // prevent.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    { name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: 2, lockRevision: 3 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  // A base with the layout a real one has, on disk rather than fabricated as
  // a string: `pyvenv.cfg`'s `home` is the base's BIN directory, and the
  // standard library the interpreter opens before it runs anything is a
  // SIBLING of it at `<prefix>/lib/python3.13`. Read off this repository's
  // own `packages/kernel-host/.venv/pyvenv.cfg`, which records
  // `home = …/cpython-3.12.12-macos-aarch64-none/bin`.
  //
  // Somewhere of its own, not under `data`: the data directory is denied by
  // the policy that grants this, and a fixture inside it would be testing
  // the deny rather than the grant.
  const managed = mkdtempSync(join(tmpdir(), "lykeion-base-"));
  dirs.push(managed);
  const basePrefix = join(managed, "cpython-3.13");
  mkdirSync(join(basePrefix, "bin"), { recursive: true });
  writeFileSync(join(basePrefix, "bin", "python3.13"), "");
  mkdirSync(join(basePrefix, "lib", "python3.13"), { recursive: true });
  writeFileSync(join(basePrefix, "lib", "python3.13", "os.py"), "");
  // Outside the environment's own root, and a different interpreter from the
  // floor's below — which is the whole case.
  const home = join(basePrefix, "bin");
  const root = envOnDisk(workDir, "crispr", true, home);
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    {
      language: "python", environment: "python",
      interpreter: "/nowhere/python/bin/python3", reads: ["/nowhere/python/base"],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_own_base"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{ name: string; prefix: string[] }>;
  };
  const built = configured.environments.find((entry) => entry.name === "crispr");
  expect(built).toBeDefined();
  const opens = (file: string): boolean => grantsReadOf(built!.prefix, file);
  // The file that decides whether this kernel is a kernel at all. A boundary
  // stopping at `home` grants the executable and refuses this, which is a
  // process that dies with nothing said about why.
  expect(opens(join(realpathSync(basePrefix), "lib", "python3.13", "os.py"))).toBe(true);
  // And the executable itself, which the prefix subsumes: reaching the
  // standard library is not bought by giving up the interpreter.
  expect(opens(join(realpathSync(home), "python3.13"))).toBe(true);
  // And still its own root, and still the floor's reads — the base is added
  // to that composition rather than swapped in for it.
  expect(opens(join(realpathSync(root), "bin", "python3"))).toBe(true);
  expect(opens("/nowhere/python/base")).toBe(true);
});

it("leaves a base the baseline already grants to the baseline, rather than losing the environment over it", async () => {
  // `uv venv` runs with no `--python`, so a machine with no managed
  // interpreter builds on the system one and `pyvenv.cfg` records
  // `home = /usr/bin` — a prefix of `/usr`. Named as something this kernel
  // reads, that is a single segment, which `policyFor` refuses as a path that
  // swallows the boundary: the researcher loses the environment their own
  // machine built, over a directory every profile already grants.
  //
  // So it is not named. What makes that safe rather than a silent narrowing is
  // that `SYSTEM_READ` is rendered into EVERY kernel profile unconditionally
  // (`renderSeatbeltProfile`), which the reads below ask the profile itself
  // rather than take on trust.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    { name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: 2, lockRevision: 3 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  const root = envOnDisk(workDir, "crispr", true, "/usr/bin");
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    {
      language: "python", environment: "python",
      interpreter: "/nowhere/python/bin/python3", reads: ["/nowhere/python/base"],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_system_base"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{ name: string; prefix: string[] }>;
  };
  const built = configured.environments.find((entry) => entry.name === "crispr");
  // Offered at all, which is the half of this that a refused boundary takes
  // away.
  expect(built).toBeDefined();
  const opens = (file: string): boolean => grantsReadOf(built!.prefix, file);
  // And the other half: absent is not zero. The base is still readable — the
  // interpreter and the standard library beside it — through the grant the
  // profile carries whatever this list says.
  expect(opens("/usr/bin/python3")).toBe(true);
  expect(opens("/usr/lib/python3.13/os.py")).toBe(true);
  // Nothing else about the composition moved: its own root and the floor's
  // reads are still named, so this dropped the base and not the read set.
  expect(opens(join(realpathSync(root), "bin", "python3"))).toBe(true);
  expect(opens("/nowhere/python/base")).toBe(true);
});

it("costs an environment whose boundary will not render its own entry, and no other", async () => {
  // Two shapes of base the system read does NOT cover, so neither is dropped
  // and both reach `policyFor`, which refuses them: a one-segment prefix
  // outside the baseline (Fink's `/sw`, an older all-users Anaconda's
  // `/anaconda3`), and a prefix equal to the researcher's home, which is
  // categorically not something the baseline grants.
  //
  // Unguarded, either one raises out of the loop and the session is handed NO
  // kernel tools at all: one odd environment anywhere in the lab costing the
  // researcher every kernel on the machine. It costs itself its entry instead.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    { name: "fink", language: "python", manager: "uv", packages: [], createdTs: 1, lockRevision: 1 },
    { name: "athome", language: "python", manager: "uv", packages: [], createdTs: 2, lockRevision: 1 },
    { name: "omics", language: "python", manager: "uv", packages: ["numpy"], createdTs: 3, lockRevision: 1 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  // A base with a real layout for the one that must survive, so nothing below
  // is explained by all three being equally unusable.
  const managed = mkdtempSync(join(tmpdir(), "lykeion-base-"));
  dirs.push(managed);
  const basePrefix = join(managed, "cpython-3.13");
  mkdirSync(join(basePrefix, "bin"), { recursive: true });
  writeFileSync(join(basePrefix, "bin", "python3.13"), "");
  // All three fully built on disk: what separates them is the base each one
  // records, and nothing else.
  envOnDisk(workDir, "fink", true, "/sw/bin");
  envOnDisk(workDir, "athome", true, join(homedir(), "bin"));
  envOnDisk(workDir, "omics", true, join(basePrefix, "bin"));
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    {
      language: "python", environment: "python",
      interpreter: "/nowhere/python/bin/python3", reads: ["/nowhere/python/base"],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_unrenderable_base"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    declared?: string[];
    environments: Array<{ name: string; prefix: string[] }>;
  };
  // The floor still goes out, and so does the one built environment whose
  // boundary this machine can actually render.
  expect(configured.environments.map((entry) => entry.name)).toEqual(["python", "omics"]);
  // Reached, not merely listed: the surviving entry carries a real boundary.
  const survivor = configured.environments.find((entry) => entry.name === "omics")!;
  expect(grantsReadOf(survivor.prefix, join(realpathSync(basePrefix), "bin", "python3.13"))).toBe(true);
  // Still declared, both of them: what this machine will not do is offer to
  // start a kernel in them.
  expect(configured.declared).toEqual(["fink", "athome", "omics"]);
});

it("keeps a language whose floor the baseline already grants, rather than losing every kernel over it", async () => {
  // A kernel host running on a system python reports a `sys.base_prefix` of
  // `/usr`. Named as something this kernel reads that is one segment, which
  // `policyFor` refuses as a path that swallows the boundary — and since it is
  // the only language this host has, the refusal takes the whole session's
  // kernel tools with it. A machine that would run python perfectly, offering
  // none.
  //
  // So `/usr` is not named, for exactly the reason the built loop does not name
  // a venv's `/usr` base: every profile this renders already carries it. What
  // makes that safe rather than a silent narrowing is asked of the rendered
  // profile below rather than taken on trust.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    {
      language: "python", environment: "python", interpreter: "/usr/bin/python3",
      // Two reads, one covered by the baseline and one not: what is filtered is
      // the ENTRY, not the descriptor, so the second must still be named.
      reads: ["/usr", "/nowhere/python/site-packages"],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_system_floor"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{ language: string; name: string; default?: boolean; prefix: string[] }>;
  };
  // Offered at all, which is the half a refused boundary takes away — and
  // still its language's default.
  expect(configured.environments.map((entry) => entry.name)).toEqual(["python"]);
  expect(configured.environments[0]!.default).toBe(true);
  const opens = (file: string): boolean => grantsReadOf(configured.environments[0]!.prefix, file);
  // And the other half: absent is not zero. The interpreter and the standard
  // library beside it are still readable, through the grant every profile
  // carries whatever this list says.
  expect(opens("/usr/bin/python3")).toBe(true);
  expect(opens("/usr/lib/python3.13/os.py")).toBe(true);
  // The read the baseline does NOT cover is still named: this dropped one entry
  // and not the descriptor.
  expect(opens("/nowhere/python/site-packages")).toBe(true);
  // And the session opens holding its kernel tools, which is the whole claim:
  // the machine that would work completely does not hand back nothing.
  await until(() => existsSync(named), "the session opening");
  const params = JSON.parse(readFileSync(named, "utf8")) as { mcpServers: Array<{ name: string }> };
  expect(params.mcpServers.map((server) => server.name)).toEqual(["notebook"]);
});

it("hands a built environment the floor's FILTERED reads when that floor is a /usr one", async () => {
  // The built loop below composes its own reads from `floorReads`
  // (`reads: [status.root, ...ownBase, ...(floorReads.get(declaration.language)
  // ?? [])]`, runs.ts) — and `floorReads` is only supposed to hold what the
  // floor loop above has ALREADY dropped what the baseline grants
  // unconditionally (`alreadySystemReadable`, filtered before
  // `floorReads.set`). If those two lines were ever reordered so
  // `floorReads` recorded the RAW descriptor instead, a floor reading out of
  // `/usr` — a system python's `sys.base_prefix` — would hand `/usr` straight
  // into a BUILT environment's own reads. `policyFor` refuses any boundary
  // naming `/usr`, a one-segment path that swallows it, so the built
  // environment would lose its entry entirely: a researcher told their own
  // `crispr` build is "not built on this machine yet", on a machine whose
  // only fault is running a system python.
  //
  // This is the one test in the file that puts a `/usr` floor descriptor and
  // a built environment of the SAME language in the same confinement, which
  // is exactly the combination that exercises `floorReads.get(...)` inside
  // the built loop rather than only the floor loop's own (correctly
  // filtered) `reads` variable.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    { name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: 2, lockRevision: 3 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  const root = envOnDisk(workDir, "crispr", true);
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    {
      language: "python", environment: "python", interpreter: "/usr/bin/python3",
      // One read the baseline already covers and one it does not — the same
      // shape as the floor-only test above, so the composition below can
      // tell "the filtered list travelled into the built entry" from
      // "nothing travelled at all".
      reads: ["/usr", "/nowhere/python/site-packages"],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_floor_and_built"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{
      language: string; name: string; interpreter: string;
      prefix: string[]; default?: boolean;
    }>;
  };
  // Both entries reach the wire — the hole this pins drops the built entry
  // silently (its boundary refuses to render), not the floor's.
  expect(configured.environments.map((entry) => entry.name).sort()).toEqual(["crispr", "python"]);
  const floor = configured.environments.find((entry) => entry.name === "python")!;
  const built = configured.environments.find((entry) => entry.name === "crispr")!;
  expect(built.language).toBe("python");
  expect(built.interpreter).toBe(join(root, "bin", "python3"));

  const floorOpens = (file: string): boolean => grantsReadOf(floor.prefix, file);
  const builtOpens = (file: string): boolean => grantsReadOf(built.prefix, file);
  // The floor's own boundary renders, /usr and all, through SYSTEM_READ.
  expect(floorOpens("/usr/bin/python3")).toBe(true);
  expect(floorOpens("/nowhere/python/site-packages")).toBe(true);
  // The built entry is where the hole lives: it must still reach its own
  // interpreter, and the floor's filtered read must have travelled with it —
  // asked of the rendered profile rather than taken on trust.
  expect(builtOpens(join(realpathSync(root), "bin", "python3"))).toBe(true);
  expect(builtOpens("/nowhere/python/site-packages")).toBe(true);
});

it("costs a language whose boundary will not render its own kernel, and no other", async () => {
  // The floor reports what each language is actually run out of, and a machine
  // can report one the baseline does not cover and `policyFor` still refuses:
  // a floor read equal to the researcher's home, which is categorically not
  // something `SYSTEM_READ` grants and is somebody's whole world besides.
  // Unguarded it raises out of the loop before any other language is reached,
  // and the session opens with no kernel tools whatsoever: a researcher who
  // cannot run a cell in any language because of the one this machine happens
  // to have installed oddly.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    {
      language: "python", environment: "python",
      interpreter: join(homedir(), "bin", "python3"), reads: [homedir()],
    },
    {
      language: "r", environment: "r",
      interpreter: "/nowhere/r/bin/R", reads: ["/nowhere/r/site-library"],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_unrenderable_floor"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{ language: string; name: string; default?: boolean; prefix: string[] }>;
  };
  // R keeps its kernel, python's descriptor costs itself its own.
  expect(configured.environments.map((entry) => entry.name)).toEqual(["r"]);
  expect(configured.environments[0]!.language).toBe("r");
  // And it is its language's default, which is a fact about the descriptor
  // that could be rendered rather than about the first one reported.
  expect(configured.environments[0]!.default).toBe(true);
  expect(grantsReadOf(configured.environments[0]!.prefix, "/nowhere/r/site-library")).toBe(true);
  // The session still opens with its kernel tools, which is the whole claim:
  // one language this machine cannot confine is not every kernel lost.
  await until(() => existsSync(named), "the session opening");
  const params = JSON.parse(readFileSync(named, "utf8")) as { mcpServers: Array<{ name: string }> };
  expect(params.mcpServers.map((server) => server.name)).toEqual(["notebook"]);
});

it("costs a language whose reads the host sent malformed its own kernel, and no other", async () => {
  // `hello` is a cast, not a validated shape (`kernelsFor` in runs.ts): the
  // host is another process talking over a socket, and nothing here checks
  // that a descriptor's `reads` actually came across as a list of strings.
  // The filter that turns `descriptor.reads` into the list `policyFor` is
  // handed — `.filter((read) => !alreadySystemReadable(read))` — used to sit
  // one line ABOVE the per-descriptor `try`. A `reads` that is not a list
  // throws out of `.filter` itself; a list holding something that is not a
  // string throws out of `alreadySystemReadable`'s own `path.startsWith`
  // instead. Either way, above the `try`, that throw escapes the whole loop,
  // rejects `reaching()`, and is caught only by the outer handler — the
  // session opens with NO kernel server at all, which is exactly the failure
  // the per-descriptor `try` exists to prevent, arriving through the door
  // beside it. Moved inside the `try`, the same throw costs only the
  // descriptor that produced it.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    {
      language: "python", environment: "python", interpreter: "/usr/bin/python3",
      // Malformed on purpose, and cast past `stubKernelHost`'s own typed
      // signature to get it there: the real host is an untyped wire, and a
      // descriptor's `reads` holding a number instead of a path string is
      // exactly the shape `hello`'s cast lets through uninspected.
      reads: [42] as unknown as string[],
    },
    {
      language: "r", environment: "r",
      interpreter: "/nowhere/r/bin/R", reads: ["/nowhere/r/site-library"],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_malformed_reads"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{ language: string; name: string; default?: boolean; prefix: string[] }>;
  };
  // R keeps its kernel, python's malformed descriptor costs itself its own.
  expect(configured.environments.map((entry) => entry.name)).toEqual(["r"]);
  expect(configured.environments[0]!.language).toBe("r");
  expect(configured.environments[0]!.default).toBe(true);
  expect(grantsReadOf(configured.environments[0]!.prefix, "/nowhere/r/site-library")).toBe(true);
  // The session still opens with its kernel tools: one descriptor arriving
  // malformed is not every kernel on the machine lost.
  await until(() => existsSync(named), "the session opening");
  const params = JSON.parse(readFileSync(named, "utf8")) as { mcpServers: Array<{ name: string }> };
  expect(params.mcpServers.map((server) => server.name)).toEqual(["notebook"]);
});

it("names no kernel server at all when not one boundary on this machine could be rendered", async () => {
  // The other side of the two tests above, and the reason they are a skip
  // rather than a shrug. A machine where EVERY boundary failed is not a
  // session with fewer kernels — it is a machine that cannot confine a kernel,
  // and this end's contract for that is to name no server rather than hand the
  // agent a notebook tool with nothing behind it. A tool that leads to a
  // kernel which could never start is worse than no tool: the agent calls it,
  // and the researcher reads the failure as their code's.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    {
      language: "python", environment: "python",
      interpreter: join(homedir(), "bin", "python3"), reads: [homedir()],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_nothing_renderable"));

  await until(() => existsSync(named), "the session opening");
  const params = JSON.parse(readFileSync(named, "utf8")) as { mcpServers: Array<{ name: string }> };
  expect(params.mcpServers).toEqual([]);
  // And the session was never configured with an empty environment list: the
  // refusal happens before the host is asked, so no kernel is left listening
  // for cells nobody can run.
  expect(kernels.configured).toBeUndefined();
});

it("still configures a host that reports no languages, which is not a host that tried and failed", async () => {
  // The distinction the refusal above rests on, from the other side. A host
  // reporting no languages and a lab that declared nothing is a machine with
  // nothing to offer — not one that tried to confine a kernel and could not —
  // and it goes down the path it went down before any of this existed: the
  // session is configured with an empty environment list, and the agent gets
  // its notebook tool.
  //
  // Without the `unrenderable > 0` conjunct the guard would read `entries.size
  // === 0` alone, and this machine would be refused a kernel server for having
  // reported honestly.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, []);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_no_languages"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as { environments: unknown[] };
  // Configured, and with an empty list rather than not configured at all.
  expect(configured.environments).toEqual([]);
  // And the session opens naming the kernel server, which is what a refusal
  // here would take away.
  await until(() => existsSync(named), "the session opening");
  const params = JSON.parse(readFileSync(named, "utf8")) as { mcpServers: Array<{ name: string }> };
  expect(params.mcpServers.map((server) => server.name)).toEqual(["notebook"]);
});

it("costs an unbuildable name its own entry and no other", async () => {
  // A lab older than the name check `kernelEnvCreate` now applies can still
  // hold a name no machine can resolve to a path. `envRoot` refuses it here,
  // as it must — but that refusal has to stay this environment's own. An
  // unguarded throw inside the loop would leave the session with no kernel
  // tools at all, so one bad name anywhere in the lab would cost every
  // session on every machine its kernels.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    { name: "../x", language: "python", manager: "uv", packages: [], createdTs: 1, lockRevision: 1 },
    { name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: 2, lockRevision: 3 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  envOnDisk(workDir, "crispr", true);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_bad_name"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    declared?: string[];
    environments: Array<{ name: string }>;
  };
  // The floor still goes out, and so does every other environment this
  // machine has built.
  expect(configured.environments.map((entry) => entry.name)).toEqual(["python", "crispr"]);
  // Still declared, because it is: what this machine will not do is offer to
  // start a kernel in it.
  expect(configured.declared).toEqual(["../x", "crispr"]);
});

it("still confines a session when the lab will not say what it has declared", async () => {
  // A transient lab blip must not stop kernels starting. What it does stop
  // is this machine claiming to know something it does not: the key is left
  // off the message entirely rather than sent as an empty list, because the
  // host answers a cell differently for "the lab declared nothing" than for
  // "nobody here could ask".
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = null;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_no_declarations"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as Record<string, unknown>;
  // Absent, and not `[]`: an empty list is the lab's own answer, and this
  // lab gave none.
  expect("declared" in configured).toBe(false);
  // The session opens anyway, with its kernel tools — the whole point.
  expect(configured.environments).toBeDefined();
  await until(() => existsSync(named), "the session opening");
  const params = JSON.parse(readFileSync(named, "utf8")) as {
    mcpServers: Array<{ name: string }>;
  };
  expect(params.mcpServers.map((server) => server.name)).toEqual(["notebook"]);
});

it("hands the host this Research's default, clearing the floor's own and marking what it names", async () => {
  // The soft default's whole shape on this side of the wire. A Research that
  // has confirmed one is naming which environment an unaddressed cell of
  // that language lands in, and the machine's own floor no longer gets to
  // answer that question — otherwise the researcher confirms `python-3-13`
  // and every cell they do not address keeps running in whatever this
  // machine happened to discover first.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    { language: "python", environment: "python", interpreter: "/usr/bin/python3", reads: [] },
    {
      language: "python",
      environment: "python-3-13",
      interpreter: "/usr/local/bin/python3.13",
      reads: [],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send({
    ...startRunOn("run_research_default"),
    environmentDefaults: [{ language: "python", environmentName: "python-3-13" }],
  });

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    defaults?: Record<string, string>;
    environments: Array<{ name: string; default?: boolean }>;
  };
  expect(configured.defaults).toEqual({ python: "python-3-13" });
  expect(
    configured.environments.map((entry) => ({ name: entry.name, default: entry.default === true })),
  ).toEqual([
    { name: "python", default: false },
    { name: "python-3-13", default: true },
  ]);
});

it("tells a session already open about a default confirmed since it opened", async () => {
  // The moment the whole soft default turns on, and the one a captured copy
  // would miss. A researcher confirms the default only AFTER the build that
  // suggested it — which is after the session that asked for the environment
  // was configured — so the first turn carrying that answer arrives on a
  // conversation this machine has had open the whole time. Without this the
  // confirmed default reaches the host on no turn of this Task at all, and a
  // cell that names nothing goes on landing wherever the machine's own floor
  // put it.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    { language: "python", environment: "python", interpreter: "/usr/bin/python3", reads: [] },
    {
      language: "python",
      environment: "python-3-13",
      interpreter: "/usr/local/bin/python3.13",
      reads: [],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send(startRunOn("run_before_default"));
  await until(() => kernels.configurations.length === 1, "the first boundary");

  lab.send({
    ...startRunOn("run_after_default"),
    environmentDefaults: [{ language: "python", environmentName: "python-3-13" }],
  });
  await until(() => kernels.configurations.length === 2, "the second boundary");

  const second = kernels.configurations[1]! as {
    session_id: string;
    defaults?: Record<string, string>;
    environments: Array<{ name: string; default?: boolean }>;
  };
  // The same session, re-described — not a new one, which would have cost the
  // researcher the notebook state the conversation was carrying.
  expect(second.session_id).toBe("se_1");
  expect(second.defaults).toEqual({ python: "python-3-13" });
  expect(second.environments.find((entry) => entry.name === "python-3-13")?.default).toBe(true);

  // And a third turn saying the same thing costs no round trip at all: the
  // host already holds this, and re-sending it every turn would be a message
  // per turn of every conversation on this machine.
  lab.send({
    ...startRunOn("run_same_default"),
    environmentDefaults: [{ language: "python", environmentName: "python-3-13" }],
  });
  await until(
    () => hasRunToCompletion(lab, "run_same_default"),
    "the third turn running to the end",
  );
  expect(kernels.configurations.length).toBe(2);
});

it("still owes the default on the next turn when the host would not take it on this one", async () => {
  // What "degraded rather than fatal" has to mean. A host that refuses one
  // re-describe leaves the session resolving unaddressed cells the old way —
  // that is the accepted cost. What is NOT acceptable is this machine
  // recording the delivery anyway: every later turn would then compare equal,
  // skip the re-describe, and the confirmed default would never reach the
  // host again for the whole life of that session. The record is written by
  // `configure` on success and by nothing else, so a refusal leaves the
  // default still owed.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    { language: "python", environment: "python", interpreter: "/usr/bin/python3", reads: [] },
    {
      language: "python",
      environment: "python-3-13",
      interpreter: "/usr/local/bin/python3.13",
      reads: [],
    },
  ]);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send(startRunOn("run_owed_before"));
  await until(() => kernels.configurations.length === 1, "the first boundary");

  // The host loses this session's confinement between turns.
  kernels.refuseConfiguresFor("se_1");
  lab.send({
    ...startRunOn("run_owed_refused"),
    environmentDefaults: [{ language: "python", environmentName: "python-3-13" }],
  });
  // The turn runs anyway — a boundary this machine could not re-send must not
  // cost the researcher the work. Run to COMPLETION, not merely ended: a
  // refusal ends a turn too, and one would mean this machine had turned the
  // turn away rather than carried it through without the new default.
  await until(
    () => hasRunToCompletion(lab, "run_owed_refused"),
    "the turn whose re-describe was refused running to the end",
  );
  expect(kernels.configurations.length).toBe(1);

  kernels.allowConfigures();
  lab.send({
    ...startRunOn("run_owed_after"),
    environmentDefaults: [{ language: "python", environmentName: "python-3-13" }],
  });
  await until(() => kernels.configurations.length === 2, "the boundary owed since the refusal");

  const delivered = kernels.configurations[1]! as {
    session_id: string;
    defaults?: Record<string, string>;
  };
  expect(delivered.session_id).toBe("se_1");
  expect(delivered.defaults).toEqual({ python: "python-3-13" });
});

it("gives up on a wedged host rather than holding the turn and everything behind it", async () => {
  // The re-describe sits on turn admission and `runTurn` is chained on
  // `turnQueues`, so an unbounded wait here is not one slow turn — it is that
  // turn never ending and every later turn on the session queued behind it,
  // with no ending and no event for any of them. `host.call` settles only on
  // a reply or on host death, so a host that is alive and wedged produces
  // exactly that. The deadline is what turns it back into one turn that
  // resolves cells the old way.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0, PROTOCOL_VERSION, [
    { language: "python", environment: "python", interpreter: "/usr/bin/python3", reads: [] },
    {
      language: "python",
      environment: "python-3-13",
      interpreter: "/usr/local/bin/python3.13",
      reads: [],
    },
  ]);
  // A short reach deadline so the wedged wait below is observable in a test
  // rather than in ninety seconds. It bounds this daemon's every configure,
  // which is why the first turn's own boundary is waited for explicitly
  // before anything is wedged.
  subsystem(lab.base, data, () => kernels.host, 500);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send(startRunOn("run_wedged_before"));
  await until(() => kernels.configurations.length === 1, "the first boundary");

  // Answers nothing from here on: the barrier waits for a second boundary
  // that this test never sends, so the re-describe below is handed to a host
  // that is alive and will not reply.
  kernels.barrierAt(2);
  lab.send({
    ...startRunOn("run_wedged"),
    environmentDefaults: [{ language: "python", environmentName: "python-3-13" }],
  });

  // Sent while the wedged turn is still inside its re-describe, so it really
  // does queue behind it on `turnQueues` — which is the half of the harm that
  // is about more than one turn. Sent after the wait instead, it would join an
  // empty queue and prove nothing about being stuck behind anything.
  lab.send(startRunOn("run_behind_wedged"));

  await until(
    () => hasRunToCompletion(lab, "run_wedged"),
    "the wedged turn running to the end rather than hanging",
  );
  await until(
    () => hasRunToCompletion(lab, "run_behind_wedged"),
    "the turn queued behind the wedged one running to the end too",
  );
  // Read back rather than assumed from the send order: this turn was told it
  // had something in front of it, which is what "behind the wedged one"
  // means. Without it, a send that happened to land on an empty queue would
  // prove only that a lone turn can run.
  expect(queuedPositions(lab, "run_behind_wedged")).toContain(1);
});

it("keeps a Research default this machine has not built, so the refusal can still name it", async () => {
  // The unbuilt case, and the reason the map is sent separately from the
  // entries at all. A Research whose R default is not built here still HAS
  // that default: the cell resolves to `meta-analysis-r` and is refused by
  // name, which is a sentence a researcher can act on. Dropped for want of a
  // matching entry, the same cell would be refused as a session with no R
  // environment — true of the machine, and useless about the work.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send({
    ...startRunOn("run_unbuilt_default"),
    environmentDefaults: [{ language: "r", environmentName: "meta-analysis-r" }],
  });

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    defaults?: Record<string, string>;
    environments: Array<{ name: string; default?: boolean }>;
  };
  expect(configured.defaults).toEqual({ r: "meta-analysis-r" });
  expect(configured.environments.some((entry) => entry.name === "meta-analysis-r")).toBe(false);
  // And python is untouched: this Research said nothing about it, so the
  // machine's own floor still answers for a cell that names none.
  expect(configured.environments.find((entry) => entry.name === "python")?.default).toBe(true);
});

it("leaves the declaration list absent when the lab's answer cannot be read", async () => {
  // The same failure as the test above, wearing a 200. A proxy's error page,
  // a truncated body, a `declarations` that is not a list — none of them is
  // a lab saying it has declared nothing, and reading them as one is worse
  // than reading nothing at all: the host would then tell a researcher
  // *this lab has no environment named X* about an environment their
  // colleague declared, which is the one sentence this whole surface exists
  // to prevent.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.rawBody = "<html><body>502 Bad Gateway</body></html>";
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_unreadable_declarations"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as Record<string, unknown>;
  expect("declared" in configured).toBe(false);
  // And the session still opens: an unreadable answer is a lab blip, and a
  // lab blip must not be a machine that starts no kernels.
  expect(configured.environments).toBeDefined();
});

it("tells the host where to keep the record of every cell it runs", async () => {
  // A host left to decide for itself writes under a home directory — the same
  // pile for every daemon on this machine, whatever each was told to keep its
  // own state in.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ sleep: 200 }, { endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_store_root"));
  await until(() => existsSync(named), "the session opening");

  const hello = kernels.calls.find((call) => call.method === "host.hello")!;
  expect((hello.params as { storeRoot?: string }).storeRoot).toBe(join(data, "provenance"));
});

it("tells the host what backs the workspace as a turn starts", async () => {
  // Nothing else connects the probe to the host. Unconnected, every record
  // this lab keeps would say the repository behind a cell was never looked
  // for — on a machine where looking is one `git` invocation away — and every
  // test either side of this hop would still pass.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ sleep: 200 }, { endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_code_state"));
  await until(() => existsSync(named), "the session opening");

  await until(
    () => kernels.calls.some((call) => call.method === "kernel.set_code_state"),
    "the code state reaching the host",
  );
  // Filed under the session whose turn this is, read off the confinement
  // that opened it rather than written here: the workspace probed is that
  // session's own directory, and the host holds every session on this
  // machine. A record joining one session's `cwd` to another's branch is one
  // nothing downstream can detect, since it is immutable and named by the
  // hash of its own bytes.
  const configured = kernels.calls.find((call) => call.method === "kernel.configure_session")!
    .params as { session_id: string };
  // A Task directory this machine made is not a repository, and saying so is
  // a different fact from never having asked.
  expect(kernels.calls.find((call) => call.method === "kernel.set_code_state")!.params).toEqual({
    session_id: configured.session_id,
    codeState: { status: "unavailable", reason: "not_applicable" },
  });
});

it("forwards a cell the kernel host announces to the run currently taking its session's turn", async () => {
  // Held open past the point the cell is announced: `runOfSession` only
  // names this run for as long as its turn is actually the one running, and
  // a script that ended the turn immediately would race that window closed
  // before the announcement below ever reached it.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ sleep: 500 }, { endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_cell"));

  // Not the boundary landing alone: this run's own turn has to actually be
  // the one running on its session — `runOfSession` names it only once the
  // whole session has opened, which is what the marker below confirms.
  await until(() => existsSync(named), "the session opening");

  kernels.announceCell(announcedCell({ sessionId: "se_1" }));

  await until(
    () =>
      lab.events.some(
        (post) =>
          post.runId === "run_cell" &&
          post.frames.some((frame) => frame.event.event === "cell"),
      ),
    "the cell reaching the lab",
  );

  const forwarded = lab.events
    .filter((post) => post.runId === "run_cell")
    .flatMap((post) => post.frames)
    .map((frame) => frame.event)
    .find((event): event is Extract<RunEvent, { event: "cell" }> => event.event === "cell")!;
  expect(forwarded.cell.source).toBe("1 + 1");
  expect(forwarded.cell.kernelId).toBe("k_1");
  expect(typeof forwarded.cell.id).toBe("string");
  // The session and Task the announcement named do not travel any further
  // than the routing decision itself.
  expect("sessionId" in forwarded.cell).toBe(false);
  expect("taskId" in forwarded.cell).toBe(false);
  // A turn whose log holds no kernel call leaves the cell unjoined rather
  // than joined to a guess.
  expect("toolUseId" in forwarded.cell).toBe(false);
});

it("joins a forwarded cell to the kernel call the session's own log says it arrived as", async () => {
  // The announcement below carries no toolUseId of its own — a provider that
  // forwarded nothing down the MCP channel — so the daemon reads the turn's
  // log instead, where the adapter announced the very call the cell ran as.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    {
      emit: "tool_call",
      toolCallId: "toolu_x",
      title: "mcp__notebook__execute_python_cell",
      rawInput: { code: "1 + 1" },
    },
    { sleep: 500 },
    { endTurn: "end_turn" },
  ]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_joined_cell"));
  await until(() => existsSync(named), "the session opening");
  // The claim reads the turn's log, so the call has to have reached it —
  // announced to the lab is announced to the log, and later than it.
  await until(
    () =>
      lab.events.some(
        (post) =>
          post.runId === "run_joined_cell" &&
          post.frames.some((frame) => frame.event.event === "log-entry"),
      ),
    "the kernel call reaching the log",
  );

  kernels.announceCell(announcedCell({ sessionId: "se_1" }));

  await until(
    () =>
      lab.events.some(
        (post) =>
          post.runId === "run_joined_cell" &&
          post.frames.some((frame) => frame.event.event === "cell"),
      ),
    "the cell reaching the lab",
  );

  const forwarded = lab.events
    .filter((post) => post.runId === "run_joined_cell")
    .flatMap((post) => post.frames)
    .map((frame) => frame.event)
    .find((event): event is Extract<RunEvent, { event: "cell" }> => event.event === "cell")!;
  expect(forwarded.cell.toolUseId).toBe("toolu_x");
});

it("drops a cell the kernel host announces for a session with no run currently taking its turn", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ sleep: 500 }, { endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_no_cell"));
  await until(() => existsSync(named), "the session opening");

  kernels.announceCell(announcedCell({ sessionId: "se_never_started_a_turn" }));

  // A batched event waits out a 50ms flush window before it would ever
  // reach the lab at all — given long enough to have done that, and to have
  // shown up below, before this asserts it never did.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const cellFrames = lab.events
    .filter((post) => post.runId === "run_no_cell")
    .flatMap((post) => post.frames)
    .filter((frame) => frame.event.event === "cell");
  expect(cellFrames).toEqual([]);
});

it("opens the session anyway when this machine's kernels never answer", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  // A host that is up and says nothing — a cold environment still being
  // provisioned, or one wedged. Its calls settle only when the process behind
  // them dies, so without a deadline the turn never begins at all: no state
  // frame, no failure, nothing a researcher could act on.
  const silent: KernelHost = {
    call: () => new Promise(() => {}),
    on: () => {},
    serve: () => {},
    stop: () => Promise.resolve(),
    get running() {
      return true;
    },
    stderrTail: () => "",
  };
  // Captured rather than left on the terminal, and then asserted: a machine
  // that quietly ran a turn without the kernels it was asked for is a machine
  // nobody can diagnose.
  const said: string[] = [];
  const reporting = console.error;
  console.error = (line: unknown) => said.push(String(line));
  try {
    subsystem(lab.base, data, () => silent, 50);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send(startRunOn("run_silent_kernels"));
    await until(() => existsSync(named), "the session opening");
  } finally {
    console.error = reporting;
  }

  expect(JSON.parse(readFileSync(named, "utf8"))).toMatchObject({ mcpServers: [] });
  expect(said.join("\n")).toContain("did not answer in time");
});

it("starts an agent with no tool server at all where this machine holds no kernels", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  subsystem(lab.base, data);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_no_kernels"));

  await until(() => existsSync(named), "the session opening");
  // A tool that leads to a kernel which could never start is worse than no
  // tool: the agent spends its turn discovering that for itself.
  expect(JSON.parse(readFileSync(named, "utf8"))).toMatchObject({ mcpServers: [] });
});

it("says which runs it holds as soon as it connects", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);
  await until(() => lab.live.length > 0, "a live report");
  expect(lab.live[0]).toEqual([]);
});

it("retires a local run the rebuilt server reports already terminal", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ wait: "cancel", timeoutMs: 10_000 }]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const promptMarker = markerIn(data, "prompt-called");
  process.env.LYKEION_STUB_PROMPT_MARKER = promptMarker;
  process.env.LYKEION_STUB_SESSION_NEW_DELAY_MS = "250";
  const liveReports: string[][] = [];
  let commandConnections = 0;
  let finalStream: import("node:http").ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      commandConnections += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (commandConnections === 1) {
        res.write(
          `data: ${JSON.stringify({
            seq: 1,
            command: {
              type: "start-run",
              runId: "run_migrated_terminal",
              studyId: "s_cmp",
              taskId: "t_cmp",
              sessionId: "se_migrated_terminal",
              agent: "claude",
              prompt: "must be retired",
              grants: [],
            },
          })}\n\n`,
        );
        res.end();
      } else if (commandConnections === 2) {
        res.end();
      } else {
        finalStream = res;
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { runIds?: string[] };
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/daemon/run/live") {
        const report = parsed.runIds ?? [];
        liveReports.push(report);
        res.end(JSON.stringify(
          report.includes("run_migrated_terminal")
            ? { retireRunIds: ["run_migrated_terminal"] }
            : {},
        ));
      } else {
        res.end("{}");
      }
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const r = startRuns({
    lab: `http://127.0.0.1:${port}`,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () => undefined,
  });
  running.push(r);

  await until(() => liveReports.length >= 3, "the post-close retirement reconciliation");
  await new Promise((resolve) => setTimeout(resolve, 350));
  expect(liveReports[1]).toContain("run_migrated_terminal");
  // The response at index 1 initiated physical close, so it cannot also be
  // the post-close watermark. The next request reports the exact identity
  // once more; only its successful retirement echo allows bounded cleanup.
  expect(liveReports[2]).toContain("run_migrated_terminal");
  r.adaptersChanged();
  await until(() => liveReports.length >= 4, "the cleaned live report");
  expect(liveReports.at(-1)).toEqual([]);
  expect(existsSync(promptMarker)).toBe(false);
  finalStream?.end();
});

it("never resurrects a retired deferred run when an adapter later appears", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "echo_prompt" }, { endTurn: "end_turn" }]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const promptMarker = markerIn(data, "retired-deferred-prompt");
  process.env.LYKEION_STUB_PROMPT_MARKER = promptMarker;
  const liveReports: Array<{ runIds: string[]; commandCursor?: number }> = [];
  let commandConnections = 0;
  let finalStream: import("node:http").ServerResponse | undefined;
  const command = {
    type: "start-run",
    runId: "run_retired_deferred",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_retired_deferred",
    agent: "claude",
    prompt: "this command must remain retired",
    grants: [],
  };
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      commandConnections += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (commandConnections === 1) {
        res.write(`event: command\ndata: ${JSON.stringify({ seq: 1, command })}\n\n`);
        res.end();
      } else if (commandConnections === 2) {
        res.end();
      } else {
        finalStream = res;
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { runIds?: string[]; commandCursor?: number };
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/daemon/run/live") {
        liveReports.push({
          runIds: parsed.runIds ?? [],
          ...(parsed.commandCursor === undefined ? {} : { commandCursor: parsed.commandCursor }),
        });
        res.end(JSON.stringify(
          parsed.runIds?.includes(command.runId)
            ? { retireRunIds: [command.runId] }
            : {},
        ));
      } else {
        res.end("{}");
      }
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  let available = false;
  const r = startRuns({
    lab: `http://127.0.0.1:${port}`,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () =>
      available
        ? { command: process.execPath, args: ["--experimental-strip-types", STUB] }
        : undefined,
    extraEnv: stubEnv,
  });
  running.push(r);

  await until(
    () => liveReports.some((report) => report.runIds.includes(command.runId)),
    "the deferred identity to be reported live",
  );
  await until(
    () => liveReports.some((report) => report.commandCursor === 1 && report.runIds.length === 0),
    "the retired identity to disappear from the next live report",
  );
  available = true;
  r.adaptersChanged();
  finalStream?.write(`event: command\ndata: ${JSON.stringify({ seq: 2, command })}\n\n`);
  await new Promise((resolve) => setTimeout(resolve, 350));

  expect(existsSync(promptMarker)).toBe(false);
  finalStream?.end();
});

it("does not retry deferred work until the current live reconciliation has retired it", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { emit: "echo_prompt" },
    { endTurn: "end_turn" },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const promptMarker = markerIn(data, "reconciliation-gated-prompt");
  process.env.LYKEION_STUB_PROMPT_MARKER = promptMarker;
  const command = {
    type: "start-run",
    runId: "run_reconciliation_gated",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_reconciliation_gated",
    agent: "claude",
    prompt: "must be retired before capability retry",
    grants: [],
  };
  let commandConnections = 0;
  let retirementResponse: import("node:http").ServerResponse | undefined;
  let retirementRequestSeen = false;
  let finalStream: import("node:http").ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      commandConnections += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (commandConnections === 1) {
        res.write(`event: command\ndata: ${JSON.stringify({ seq: 1, command })}\n\n`);
        res.end();
      } else {
        finalStream = res;
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { runIds?: string[] };
      if (req.url === "/daemon/run/live" && parsed.runIds?.includes(command.runId)) {
        retirementRequestSeen = true;
        retirementResponse = res;
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  let available = false;
  const r = startRuns({
    lab: `http://127.0.0.1:${port}`,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () =>
      available
        ? { command: process.execPath, args: ["--experimental-strip-types", STUB] }
        : undefined,
    extraEnv: stubEnv,
  });
  running.push(r);

  await until(() => retirementRequestSeen, "the delayed live reconciliation");
  available = true;
  r.adaptersChanged();
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(existsSync(promptMarker)).toBe(false);

  retirementResponse!.writeHead(200, { "content-type": "application/json" });
  retirementResponse!.end(JSON.stringify({ retireRunIds: [command.runId] }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(existsSync(promptMarker)).toBe(false);
  finalStream?.end();
});

it("keeps deferred work gated after a lost retirement response until a later reconciliation succeeds", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { emit: "echo_prompt" },
    { endTurn: "end_turn" },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const promptMarker = markerIn(data, "lost-reconciliation-gated-prompt");
  process.env.LYKEION_STUB_PROMPT_MARKER = promptMarker;
  const command = {
    type: "start-run",
    runId: "run_lost_reconciliation_gated",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_lost_reconciliation_gated",
    agent: "claude",
    prompt: "must remain retired after a lost response",
    grants: [],
  };
  let commandConnections = 0;
  let lostRetirementResponse = false;
  let laterSuccessfulResponse: import("node:http").ServerResponse | undefined;
  let finalStream: import("node:http").ServerResponse | undefined;
  let available = false;
  let r!: RunSubsystem;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      commandConnections += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (commandConnections === 1) {
        res.write(`event: command\ndata: ${JSON.stringify({ seq: 1, command })}\n\n`);
        res.end();
      } else {
        finalStream = res;
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { runIds?: string[] };
      if (req.url === "/daemon/run/live" && parsed.runIds?.includes(command.runId)) {
        if (!lostRetirementResponse) {
          // The durable server processed the retirement, but the response was
          // reset before the daemon could apply it. Capability appearing in
          // this window must not turn response loss into permission to prompt.
          lostRetirementResponse = true;
          available = true;
          queueMicrotask(() => r.adaptersChanged());
          res.destroy();
          return;
        }
        laterSuccessfulResponse = res;
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  r = startRuns({
    lab: `http://127.0.0.1:${port}`,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () =>
      available
        ? { command: process.execPath, args: ["--experimental-strip-types", STUB] }
        : undefined,
    extraEnv: stubEnv,
  });
  running.push(r);

  await until(() => lostRetirementResponse, "the processed retirement response to be lost");
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(existsSync(promptMarker)).toBe(false);

  await until(() => laterSuccessfulResponse !== undefined, "the later reconciliation attempt");
  laterSuccessfulResponse!.writeHead(200, { "content-type": "application/json" });
  laterSuccessfulResponse!.end(JSON.stringify({ retireRunIds: [command.runId] }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(existsSync(promptMarker)).toBe(false);
  finalStream?.end();
});

it("closes a retired active child before releasing its same-session successor", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ wait: "cancel", timeoutMs: 10_000 }]);
  process.env.LYKEION_STUB_EXIT_DELAY_MS = "500";
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const sessions = markerIn(data, "sessions-started");
  const prompts = markerIn(data, "prompts-started");
  const exited = markerIn(data, "old-child-exited");
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = sessions;
  process.env.LYKEION_STUB_PROMPT_MARKER = prompts;
  process.env.LYKEION_STUB_EXIT_MARKER = exited;

  let commandConnections = 0;
  let firstStream: import("node:http").ServerResponse | undefined;
  let finalStream: import("node:http").ServerResponse | undefined;
  let liveReports = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      commandConnections += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (commandConnections === 1) {
        for (const [index, runId] of ["run_retired_active", "run_successor"].entries()) {
          res.write(
            `data: ${JSON.stringify({
              seq: index + 1,
              command: {
                type: "start-run",
                runId,
                studyId: "s_cmp",
                taskId: "t_cmp",
                sessionId: "se_shared_retirement",
                agent: "claude",
                prompt: runId,
                grants: [],
              },
            })}\n\n`,
          );
        }
        firstStream = res;
      } else {
        finalStream = res;
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/daemon/run/live") {
        liveReports += 1;
        res.end(JSON.stringify(
          liveReports === 2 ? { retireRunIds: ["run_retired_active"] } : {},
        ));
      } else {
        res.end("{}");
      }
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  subsystem(`http://127.0.0.1:${port}`, data);

  await until(() => existsSync(prompts), "the first turn to become active");
  firstStream?.end();
  await until(
    () =>
      existsSync(sessions) &&
      readFileSync(sessions, "utf8").trim().split("\n").filter(Boolean).length >= 2,
    "the successor to begin its session",
  );
  expect(existsSync(exited)).toBe(true);
  finalStream?.end();
});

it("keeps an active turn exact after more than the bounded terminal-history horizon", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ wait: "cancel", timeoutMs: 10_000 }]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const promptMarker = markerIn(data, "active-turn-prompt");
  process.env.LYKEION_STUB_PROMPT_MARKER = promptMarker;
  let commandStream: import("node:http").ServerResponse | undefined;
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  const command = {
    type: "start-run",
    runId: "run_active_beyond_history",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_active_beyond_history",
    agent: "claude",
    prompt: "execute exactly once",
    grants: [],
  };
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      commandStream = res;
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as typeof events[number];
      if (req.url === "/daemon/run/events") events.push(parsed);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  subsystem(`http://127.0.0.1:${port}`, data);
  await until(() => commandStream !== undefined, "the command stream");
  commandStream!.write(`event: command\ndata: ${JSON.stringify({ seq: 1, command })}\n\n`);
  await until(() => existsSync(promptMarker), "the active prompt");

  for (let index = 0; index < 1_001; index += 1) {
    commandStream!.write(`event: command\ndata: ${JSON.stringify({
      seq: index + 2,
      command: { type: "start-run", runId: `run_historical_${index}` },
    })}\n\n`);
  }
  commandStream!.write(`event: command\ndata: ${JSON.stringify({ seq: 1_003, command })}\n\n`);
  commandStream!.write(`event: command\ndata: ${JSON.stringify({
    seq: 1_004,
    command: { type: "cancel", runId: command.runId },
  })}\n\n`);

  await until(
    () => events.some((post) =>
      post.runId === command.runId &&
      post.frames.some((frame) => frame.event.event === "completed"),
    ),
    "the active turn to be cancelled",
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(readFileSync(promptMarker, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);
  commandStream?.end();
}, 15_000);

it("keeps a released run exact through failed post-close reconciliation beyond history", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ wait: "cancel", timeoutMs: 10_000 }]);
  process.env.LYKEION_STUB_EXIT_DELAY_MS = "800";
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const promptMarker = markerIn(data, "releasing-run-prompt");
  const exitMarker = markerIn(data, "releasing-run-exited");
  process.env.LYKEION_STUB_PROMPT_MARKER = promptMarker;
  process.env.LYKEION_STUB_EXIT_MARKER = exitMarker;
  let commandStream: import("node:http").ServerResponse | undefined;
  let conflicted = false;
  let retirementAnswered = false;
  let lastHistoryPosted = false;
  let postCloseReconciliationLost = false;
  let postCloseReconciliationApplied = false;
  let r!: RunSubsystem;
  const command = {
    type: "start-run",
    runId: "run_releasing_beyond_history",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_releasing_beyond_history",
    agent: "claude",
    prompt: "execute exactly once while the old child closes",
    grants: [],
  };
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      commandStream = res;
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { runId?: string };
      if (req.url === "/daemon/run/events" && parsed.runId === "run_release_history_1000")
        lastHistoryPosted = true;
      if (req.url === "/daemon/run/live" && conflicted && !retirementAnswered) {
        retirementAnswered = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ retireRunIds: [command.runId] }));
        return;
      }
      if (req.url === "/daemon/run/live" && retirementAnswered && existsSync(exitMarker)) {
        if (!postCloseReconciliationLost) {
          postCloseReconciliationLost = true;
          res.destroy();
          return;
        }
        postCloseReconciliationApplied = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ retireRunIds: [command.runId] }));
        return;
      }
      if (req.url === "/daemon/run/events" && parsed.runId === command.runId && !conflicted) {
        conflicted = true;
        // Start retirement reconciliation before the 409 reaches the daemon
        // and begins physical close. Its eventual success cannot stand in
        // for the post-close report required to release exact identity.
        queueMicrotask(() => r.adaptersChanged());
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "the durable run is already terminal" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  r = subsystem(`http://127.0.0.1:${port}`, data);
  await until(() => commandStream !== undefined, "the command stream");
  commandStream!.write(`event: command\ndata: ${JSON.stringify({ seq: 1, command })}\n\n`);
  await until(
    () => conflicted && retirementAnswered && existsSync(promptMarker),
    "the run to enter delayed reconciled release",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  for (let index = 0; index < 1_001; index += 1) {
    commandStream!.write(`event: command\ndata: ${JSON.stringify({
      seq: index + 2,
      command: { type: "start-run", runId: `run_release_history_${index}` },
    })}\n\n`);
  }
  await until(() => lastHistoryPosted, "the newer history to be processed during release");
  await until(() => existsSync(exitMarker), "the delayed child to exit");
  await until(() => postCloseReconciliationLost, "the post-close reconciliation response to be lost");

  commandStream!.write(`event: command\ndata: ${JSON.stringify({ seq: 1_003, command })}\n\n`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(readFileSync(promptMarker, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);

  await until(() => postCloseReconciliationApplied, "the later post-close reconciliation to apply");
  commandStream?.end();
}, 20_000);

it("keeps a cancelled-unacknowledged run exact while its subprocess may still be alive", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ sleep: 2_000 }, { endTurn: "end_turn" }]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const promptMarker = markerIn(data, "cancelled-unacknowledged-replay-prompt");
  process.env.LYKEION_STUB_PROMPT_MARKER = promptMarker;
  const lab = await stubLab([]);
  const command = {
    type: "start-run",
    runId: "run_cancelled_unack_beyond_history",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_cancelled_unack_beyond_history",
    agent: "claude",
    prompt: "execute once while the abandoned prompt is outstanding",
    grants: [],
  };
  const r = startRuns({
    lab: lab.base,
    token: "machine-token",
    workDir: `${data}-work`,
    dataDir: data,
    cancelGraceMs: 20,
    adapterFor: () => ({ command: process.execPath, args: ["--experimental-strip-types", STUB] }),
    extraEnv: stubEnv,
  });
  running.push(r);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(command);
  await until(() => existsSync(promptMarker), "the first prompt");
  lab.send({ type: "cancel", runId: command.runId });
  await until(
    () => lab.events.some((post) =>
      post.runId === command.runId &&
      post.frames.some((frame) =>
        frame.event.event === "completed" &&
        frame.event.state.state === "cancelled" &&
        frame.event.state.unacknowledged,
      ),
    ),
    "the unacknowledged cancellation",
  );

  for (let index = 0; index < 1_001; index += 1)
    lab.send({ type: "start-run", runId: `run_cancelled_unack_history_${index}` });
  lab.send(command);
  await new Promise((resolve) => setTimeout(resolve, 500));

  expect(readFileSync(promptMarker, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);
}, 15_000);

it("keeps a terminal frame awaiting acknowledgement exact beyond the history horizon", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { emit: "echo_prompt" },
    { endTurn: "end_turn" },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const promptMarker = markerIn(data, "unacknowledged-terminal-prompt");
  process.env.LYKEION_STUB_PROMPT_MARKER = promptMarker;
  let commandStream: import("node:http").ServerResponse | undefined;
  let heldTerminal: import("node:http").ServerResponse | undefined;
  const command = {
    type: "start-run",
    runId: "run_terminal_awaiting_ack",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_terminal_awaiting_ack",
    agent: "claude",
    prompt: "execute once while the terminal frame is held",
    grants: [],
  };
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      commandStream = res;
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as {
        runId?: string;
        frames?: Array<{ event: RunEvent }>;
      };
      if (
        req.url === "/daemon/run/events" &&
        parsed.runId === command.runId &&
        parsed.frames?.some((frame) => frame.event.event === "completed")
      ) {
        heldTerminal = res;
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  subsystem(`http://127.0.0.1:${port}`, data);
  await until(() => commandStream !== undefined, "the command stream");
  commandStream!.write(`event: command\ndata: ${JSON.stringify({ seq: 1, command })}\n\n`);
  await until(() => heldTerminal !== undefined, "the unacknowledged terminal frame");

  for (let index = 0; index < 1_001; index += 1) {
    commandStream!.write(`event: command\ndata: ${JSON.stringify({
      seq: index + 2,
      command: { type: "start-run", runId: `run_terminal_history_${index}` },
    })}\n\n`);
  }
  commandStream!.write(`event: command\ndata: ${JSON.stringify({ seq: 1_003, command })}\n\n`);
  await new Promise((resolve) => setTimeout(resolve, 300));

  expect(readFileSync(promptMarker, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);
  heldTerminal!.writeHead(200, { "content-type": "application/json" });
  heldTerminal!.end("{}");
  commandStream?.end();
}, 15_000);

it("takes a start-run command and posts the turn's events back", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_1",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_1",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);

  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a completed turn",
  );
  const frames = lab.events.flatMap((e) => e.frames);
  expect(frames.some((f) => f.event.event === "assistant-text")).toBe(true);
  // Numbered by the only producer there is, so a retry cannot duplicate one.
  expect(frames.map((f) => f.seq)).toEqual([...frames.map((f) => f.seq)].sort((a, b) => a - b));
  expect(new Set(frames.map((f) => f.seq)).size).toBe(frames.length);
});

it("keeps an unavailable start-run identity replayable and starts it once capability appears", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { emit: "agent_message_chunk", text: "continued once" },
    { endTurn: "end_turn" },
  ]);
  const lab = await stubLab([
    { type: "start-run", runId: "run_2", studyId: "s_cmp", taskId: "t_cmp", sessionId: "se_2", agent: "claude", prompt: "go", grants: [] },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  let available = false;
  const r = startRuns({
    lab: lab.base,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () =>
      available
        ? { command: process.execPath, args: ["--experimental-strip-types", STUB] }
        : undefined,
    extraEnv: stubEnv,
  });
  running.push(r);
  await until(() => lab.commandConnected(), "the command stream");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(lab.events).toEqual([]);

  available = true;
  r.adaptersChanged();
  r.adaptersChanged();
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "the deferred turn",
  );
  const frames = lab.events.flatMap((e) => e.frames);
  expect(frames.filter((f) => f.event.event === "assistant-text")).toHaveLength(1);
  expect(frames.filter((f) => f.event.event === "completed")).toHaveLength(1);
});

it("preserves the first exact deferred command when its run id is delivered twice", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { emit: "echo_prompt" },
    { endTurn: "end_turn" },
  ]);
  const first = {
    type: "start-run",
    runId: "run_duplicate_deferred",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_duplicate_deferred",
    agent: "claude",
    prompt: "first exact command",
    grants: [],
  };
  const lab = await stubLab([first, { ...first, prompt: "overwriting duplicate" }]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  let available = false;
  const r = startRuns({
    lab: lab.base,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () =>
      available
        ? { command: process.execPath, args: ["--experimental-strip-types", STUB] }
        : undefined,
    extraEnv: stubEnv,
  });
  running.push(r);
  await until(() => lab.commandConnected(), "the command stream");
  await new Promise((resolve) => setTimeout(resolve, 100));

  available = true;
  r.adaptersChanged();
  await until(
    () => lab.events.some((post) => post.frames.some((frame) => frame.event.event === "completed")),
    "the first exact deferred command",
  );

  const assistant = lab.events
    .flatMap((post) => post.frames)
    .filter((frame) => frame.event.event === "assistant-text")
    .map((frame) => frame.event.event === "assistant-text" ? frame.event.text : "");
  expect(assistant).toEqual(["first exact command"]);
});

it("backpressures deferred capacity without advancing the rejected command cursor", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { emit: "echo_prompt" },
    { endTurn: "end_turn" },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const commands = Array.from({ length: 1_001 }, (_, index) => ({
    seq: index + 1,
    command: {
      type: "start-run",
      runId: `run_deferred_capacity_${index + 1}`,
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: `se_deferred_capacity_${index + 1}`,
      agent: index === 1_000 ? "claude" : "held-back",
      prompt: index === 1_000 ? "the exact command after capacity frees" : `held ${index + 1}`,
      grants: [],
    },
  }));
  const reports: Array<{ runIds: string[]; commandCursor?: number }> = [];
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  let finalStream: import("node:http").ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const cursor = Number(new URL(req.url, "http://127.0.0.1").searchParams.get("cursor") ?? 0);
      if (cursor < 1_001) {
        for (const frame of commands.slice(cursor))
          res.write(`event: command\ndata: ${JSON.stringify(frame)}\n\n`);
        res.end();
      } else {
        finalStream = res;
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as {
        runIds?: string[];
        commandCursor?: number;
        runId?: string;
        frames?: Array<{ seq: number; event: RunEvent }>;
      };
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/daemon/run/live") {
        reports.push({
          runIds: parsed.runIds ?? [],
          ...(parsed.commandCursor === undefined ? {} : { commandCursor: parsed.commandCursor }),
        });
        res.end(JSON.stringify(
          parsed.commandCursor === 1_000
            ? { retireRunIds: ["run_deferred_capacity_1"] }
            : {},
        ));
      } else {
        if (req.url === "/daemon/run/events") {
          events.push(parsed as typeof events[number]);
        }
        res.end("{}");
      }
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  let available = false;
  const r = startRuns({
    lab: `http://127.0.0.1:${port}`,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: (agent) =>
      available && agent === "claude"
        ? { command: process.execPath, args: ["--experimental-strip-types", STUB] }
        : undefined,
    extraEnv: stubEnv,
  });
  running.push(r);

  await until(
    () => reports.some((report) => report.commandCursor === 1_001),
    "the post-capacity command to be accepted after reconnect",
  );
  const full = reports.find((report) => report.commandCursor === 1_000);
  expect(full).toBeDefined();
  expect(full!.runIds).toHaveLength(1_000);
  expect(full!.runIds).toContain("run_deferred_capacity_1");
  expect(full!.runIds).not.toContain("run_deferred_capacity_1001");
  const afterRetirement = reports.find((report) => report.commandCursor === 1_001)!;
  expect(afterRetirement.runIds).not.toContain("run_deferred_capacity_1");
  expect(afterRetirement.runIds).toContain("run_deferred_capacity_1001");

  available = true;
  r.adaptersChanged();
  await until(
    () => events.some((post) =>
      post.runId === "run_deferred_capacity_1001" &&
      post.frames.some((frame) => frame.event.event === "completed"),
    ),
    "the exact rejected command to start after capacity frees",
  );
  const exactFrames = events
    .filter((post) => post.runId === "run_deferred_capacity_1001")
    .flatMap((post) => post.frames);
  expect(exactFrames.filter((frame) => frame.event.event === "assistant-text"))
    .toHaveLength(1);
  expect(exactFrames.filter((frame) => frame.event.event === "completed"))
    .toHaveLength(1);
  finalStream?.end();
});

it("looks past a capacity-blocked start only far enough to apply a replay-safe cancellation", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const frames = Array.from({ length: 1_001 }, (_, index) => ({
    seq: index + 1,
    command: {
      type: "start-run",
      runId: `run_hol_${index + 1}`,
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: `se_hol_${index + 1}`,
      agent: "held-back",
      prompt: `held ${index + 1}`,
      grants: [],
    },
  }));
  const cancelFrame = {
    seq: 1_002,
    command: { type: "cancel", runId: "run_hol_1" },
  };
  const reports: Array<{ runIds: string[]; commandCursor?: number }> = [];
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  let finalStream: import("node:http").ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const cursor = Number(new URL(req.url, "http://127.0.0.1").searchParams.get("cursor") ?? 0);
      if (cursor < cancelFrame.seq) {
        for (const frame of frames.slice(cursor))
          res.write(`event: command\ndata: ${JSON.stringify(frame)}\n\n`);
        // The duplicate is the crash-window replay: applying this exact
        // idempotent control twice must be harmless, and must not skip its
        // one durable completion frame or move the cursor past a command
        // that was never accepted.
        setTimeout(() => {
          if (res.destroyed) return;
          res.write(`event: command\ndata: ${JSON.stringify(cancelFrame)}\n\n`);
          res.write(`event: command\ndata: ${JSON.stringify(cancelFrame)}\n\n`);
          res.end();
        }, 25);
      } else if (reports.at(-1)?.runIds.includes("run_hol_1")) {
        // The cancellation frame can still be in flight on the first report
        // carrying cursor 1002. Reconnect once more to observe its durable
        // acknowledgement release the terminal identity.
        res.end();
      } else {
        finalStream = res;
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as {
        runIds?: string[];
        commandCursor?: number;
        runId?: string;
        frames?: Array<{ seq: number; event: RunEvent }>;
      };
      if (req.url === "/daemon/run/live") {
        reports.push({
          runIds: parsed.runIds ?? [],
          ...(parsed.commandCursor === undefined ? {} : { commandCursor: parsed.commandCursor }),
        });
      }
      if (req.url === "/daemon/run/events") events.push(parsed as typeof events[number]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const r = startRuns({
    lab: `http://127.0.0.1:${port}`,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () => undefined,
    extraEnv: stubEnv,
  });
  running.push(r);

  await until(
    () => reports.some((report) =>
      report.commandCursor === cancelFrame.seq && !report.runIds.includes("run_hol_1"),
    ),
    "the blocked start and cancellation to be committed contiguously",
  );
  const settled = reports.find((report) =>
    report.commandCursor === cancelFrame.seq && !report.runIds.includes("run_hol_1"),
  )!;
  expect(settled.runIds).toHaveLength(1_000);
  expect(settled.runIds).not.toContain("run_hol_1");
  expect(settled.runIds).toContain("run_hol_1001");
  const cancellationFrames = events
    .filter((post) => post.runId === "run_hol_1")
    .flatMap((post) => post.frames)
    .filter((frame) => frame.event.event === "completed");
  expect(cancellationFrames).toHaveLength(1);
  finalStream?.end();
}, 15_000);

it("authoritatively cancels the capacity-blocked start itself and advances the cursor", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const starts = Array.from({ length: 1_001 }, (_, index) => ({
    seq: index + 1,
    command: {
      type: "start-run",
      runId: `run_blocked_target_${index + 1}`,
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: `se_blocked_target_${index + 1}`,
      agent: "held-back",
      prompt: `held ${index + 1}`,
      grants: [],
    },
  }));
  const cancel = { seq: 1_002, command: { type: "cancel", runId: "run_blocked_target_1001" } };
  const reports: Array<{ runIds: string[]; commandCursor?: number }> = [];
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  let connections = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      connections += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (connections === 1) {
        for (const frame of starts) res.write(`event: command\ndata: ${JSON.stringify(frame)}\n\n`);
        res.write(`event: command\ndata: ${JSON.stringify(cancel)}\n\n`);
        res.write(`event: command\ndata: ${JSON.stringify(cancel)}\n\n`);
        res.end();
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as {
        runIds?: string[];
        commandCursor?: number;
        runId?: string;
        frames?: Array<{ seq: number; event: RunEvent }>;
      };
      if (req.url === "/daemon/run/live")
        reports.push({
          runIds: parsed.runIds ?? [],
          ...(parsed.commandCursor === undefined ? {} : { commandCursor: parsed.commandCursor }),
        });
      if (req.url === "/daemon/run/events") events.push(parsed as typeof events[number]);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const r = startRuns({
    lab: `http://127.0.0.1:${port}`,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () => undefined,
  });
  running.push(r);

  await until(() => reports.some((report) => report.commandCursor !== undefined), "the replay cursor report");
  expect(reports.at(-1)?.commandCursor).toBe(cancel.seq);
  const completions = events
    .filter((post) => post.runId === cancel.command.runId)
    .flatMap((post) => post.frames)
    .filter((frame) => frame.event.event === "completed");
  expect(completions).toHaveLength(1);
  expect(completions[0]?.event).toMatchObject({
    event: "completed",
    state: { state: "cancelled" },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const reportCount = reports.length;
  r.adaptersChanged();
  await until(() => reports.length > reportCount, "the acknowledged cancellation reconciliation");
  expect(reports.at(-1)?.runIds).toHaveLength(1_000);
  expect(reports.at(-1)?.runIds).not.toContain(cancel.command.runId);
}, 15_000);

it("scans contiguous harmless and freeing controls without executing later unsafe work", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  const frames = Array.from({ length: 1_001 }, (_, index) => ({
    seq: index + 1,
    command: {
      type: "start-run",
      runId: `run_multi_control_${index + 1}`,
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: `se_multi_control_${index + 1}`,
      agent: "held-back",
      prompt: `held ${index + 1}`,
      grants: [],
    },
  }));
  const controls = [
    { seq: 1_002, command: { type: "cancel", runId: "run_unknown_harmless" } },
    { seq: 1_003, command: { type: "decision", runId: "run_multi_control_1", decision: { action: "cancel" } } },
    { seq: 1_004, command: { type: "kernel-interrupt", runId: "unsafe", kernelId: "k_must_wait" } },
  ];
  const reports: Array<{ runIds: string[]; commandCursor?: number }> = [];
  let connections = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      connections += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (connections === 1) {
        for (const frame of [...frames, ...controls])
          res.write(`event: command\ndata: ${JSON.stringify(frame)}\n\n`);
        res.end();
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { runIds?: string[]; commandCursor?: number };
      if (req.url === "/daemon/run/live")
        reports.push({
          runIds: parsed.runIds ?? [],
          ...(parsed.commandCursor === undefined ? {} : { commandCursor: parsed.commandCursor }),
        });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const r = startRuns({
    lab: `http://127.0.0.1:${port}`,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () => undefined,
    kernelHost: () => kernels.host,
  });
  running.push(r);

  await until(() => reports.some((report) => report.commandCursor !== undefined), "the control cursor report");
  expect(reports.at(-1)?.commandCursor).toBe(1_003);
  expect(reports.at(-1)?.runIds).toHaveLength(1_000);
  expect(kernels.calls).not.toContainEqual({
    method: "kernel.interrupt",
    params: { kernel_id: "k_must_wait" },
  });
}, 15_000);

it("retains O(1) state across thousands of harmless controls before the freeing cancel", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  const starts = Array.from({ length: 1_001 }, (_, index) => ({
    seq: index + 1,
    command: {
      type: "start-run",
      runId: `run_stress_control_${index + 1}`,
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: `se_stress_control_${index + 1}`,
      agent: "held-back",
      prompt: `held ${index + 1}`,
      grants: [],
    },
  }));
  const harmlessCount = 5_000;
  const harmless = Array.from({ length: harmlessCount }, (_, index) => ({
    seq: 1_002 + index,
    command: { type: "cancel", runId: `run_unknown_stress_${index}` },
  }));
  const freeing = {
    seq: 1_002 + harmlessCount,
    command: { type: "cancel", runId: "run_stress_control_1" },
  };
  const unsafe = {
    seq: freeing.seq + 1,
    command: { type: "kernel-interrupt", runId: "unsafe", kernelId: "k_stress_must_wait" },
  };
  const reports: Array<{ runIds: string[]; commandCursor?: number }> = [];
  let firstStream: import("node:http").ServerResponse | undefined;
  let finalStream: import("node:http").ServerResponse | undefined;
  let connections = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      connections += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (connections === 1) {
        firstStream = res;
        for (const frame of [...starts, ...harmless])
          res.write(`event: command\ndata: ${JSON.stringify(frame)}\n\n`);
      } else {
        finalStream = res;
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { runIds?: string[]; commandCursor?: number };
      if (req.url === "/daemon/run/live")
        reports.push({
          runIds: parsed.runIds ?? [],
          ...(parsed.commandCursor === undefined ? {} : { commandCursor: parsed.commandCursor }),
        });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const runs = startRuns({
    lab: `http://127.0.0.1:${port}`,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () => undefined,
    kernelHost: () => kernels.host,
  });
  running.push(runs);

  const harmlessThrough = harmless.at(-1)!.seq;
  await until(
    () => runs.blockedLookaheadState()?.safeThroughSeq === harmlessThrough,
    "all harmless controls to form one contiguous safe prefix",
  );
  expect(runs.blockedLookaheadState()).toEqual({
    safeThroughSeq: harmlessThrough,
    retainedControlCommands: 0,
  });

  firstStream!.write(`event: command\ndata: ${JSON.stringify(freeing)}\n\n`);
  firstStream!.write(`event: command\ndata: ${JSON.stringify(unsafe)}\n\n`);
  firstStream!.end();
  await until(
    () => reports.some((report) => report.commandCursor === freeing.seq),
    "the freeing control to commit the contiguous cursor",
  );
  expect(reports.find((report) => report.commandCursor === freeing.seq)?.runIds).toHaveLength(1_000);
  expect(kernels.calls).not.toContainEqual({
    method: "kernel.interrupt",
    params: { kernel_id: unsafe.command.kernelId },
  });
  expect(runs.blockedLookaheadState()).toBeUndefined();
  finalStream?.end();
}, 20_000);

it("discards blocked lookahead from an old relay generation before using new relay frames", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  let liveReports = 0;
  let commandConnections = 0;
  let newStreamOpenedAfterLive = false;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      commandConnections += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (commandConnections === 1) {
        for (let index = 0; index < 1_001; index += 1) {
          const frame = {
            seq: index + 1,
            command: {
              type: "start-run",
              runId: `run_old_generation_${index + 1}`,
              studyId: "s_cmp",
              taskId: "t_cmp",
              sessionId: `se_old_generation_${index + 1}`,
              agent: "held-back",
              prompt: `old ${index + 1}`,
              grants: [],
            },
          };
          res.write(`event: command\ndata: ${JSON.stringify(frame)}\n\n`);
        }
        res.end();
      } else {
        newStreamOpenedAfterLive = liveReports >= 2;
        res.write(`event: command\ndata: ${JSON.stringify({
          seq: 1,
          command: { type: "kernel-interrupt", runId: "new_control", kernelId: "k_new_generation" },
        })}\n\n`);
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/daemon/run/live") {
        liveReports += 1;
        res.end(JSON.stringify({ generation: liveReports === 1 ? "relay-old" : "relay-new" }));
      } else {
        res.end("{}");
      }
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const r = startRuns({
    lab: `http://127.0.0.1:${port}`,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () => undefined,
    kernelHost: () => kernels.host,
  });
  running.push(r);

  await until(() => commandConnections >= 2, "the new generation command stream");
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(newStreamOpenedAfterLive).toBe(true);
  expect(kernels.calls).toContainEqual({
    method: "kernel.interrupt",
    params: { kernel_id: "k_new_generation" },
  });
}, 15_000);

it("emits durable cancellation evidence when Stop targets a deferred run", async () => {
  const command = {
    type: "start-run",
    runId: "run_cancelled_while_deferred",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_cancelled_while_deferred",
    agent: "claude",
    prompt: "must never start",
    grants: [],
  };
  const lab = await stubLab([command]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = startRuns({
    lab: lab.base,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () => undefined,
    extraEnv: stubEnv,
  });
  running.push(r);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send({ type: "decision", runId: command.runId, decision: { action: "cancel" } });

  await until(
    () => lab.events.some((post) =>
      post.runId === command.runId &&
      post.frames.some((frame) => frame.event.event === "completed"),
    ),
    "the deferred cancellation frame",
  );
  const completions = lab.events
    .filter((post) => post.runId === command.runId)
    .flatMap((post) => post.frames)
    .filter((frame) => frame.event.event === "completed");
  expect(completions).toHaveLength(1);
  expect(completions[0]?.event).toEqual({
    event: "completed",
    state: { state: "cancelled" },
  });
});

it("replays an unavailable exact start when reconnect observes the adapter", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { emit: "agent_message_chunk", text: "reconnected once" },
    { endTurn: "end_turn" },
  ]);
  const command = {
    type: "start-run",
    runId: "run_reconnected_available",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_reconnected_available",
    agent: "claude",
    prompt: "go",
    grants: [],
  };
  const lab = await stubLab([command]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  let available = false;
  const r = startRuns({
    lab: lab.base,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () =>
      available
        ? { command: process.execPath, args: ["--experimental-strip-types", STUB] }
        : undefined,
    extraEnv: stubEnv,
  });
  running.push(r);
  await until(() => lab.commandConnected(), "the first command stream");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(lab.events).toEqual([]);

  available = true;
  lab.disconnectCommands();
  await until(
    () => lab.live.some((runIds) => runIds.includes(command.runId)),
    "the held run in the reconnect report",
  );
  await until(
    () => lab.events.some((post) =>
      post.runId === command.runId &&
      post.frames.some((frame) => frame.event.event === "completed"),
    ),
    "the reconnect-triggered continuation",
  );
  const frames = lab.events
    .filter((post) => post.runId === command.runId)
    .flatMap((post) => post.frames);
  expect(frames.filter((frame) => frame.event.event === "assistant-text")).toHaveLength(1);
  expect(frames.filter((frame) => frame.event.event === "completed")).toHaveLength(1);
});

it("terminalizes a genuine prompt failure after execution has begun", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ failTurn: "model unavailable" }]);
  const lab = await stubLab([
    { type: "start-run", runId: "run_started_failure", studyId: "s_cmp", taskId: "t_cmp", sessionId: "se_failure", agent: "claude", prompt: "go", grants: [] },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);

  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "the started failure",
  );
  const frames = lab.events.flatMap((e) => e.frames);
  expect(frames).toContainEqual(
    expect.objectContaining({ event: { event: "state", state: { state: "planning" } } }),
  );
  expect(frames).toContainEqual(
    expect.objectContaining({
      event: { event: "completed", state: { state: "failed", reason: "model unavailable" } },
    }),
  );
});

it("refuses a start-run command missing required fields", async () => {
  const lab = await stubLab([{ type: "start-run", runId: "run_bad", agent: "claude", grants: [] }]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a refusal",
  );
  const done = lab.events
    .flatMap((e) => e.frames)
    .find((f) => f.event.event === "completed") as { event: { state: { state: string; reason?: string } } };
  expect(done.event.state.state).toBe("failed");
  expect(done.event.state.reason).toMatch(/studyId|sessionId|prompt/);
});

it("posts the terminal frame for a turn that was still running when stopped", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "t1", title: "Write /tmp/somewhere" },
  ]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_mid",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_mid",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(lab.base, data);

  // Proof the turn is genuinely still running: the subprocess is sitting
  // inside `session/request_permission`, holding `session/prompt` open —
  // nothing will ever answer it on its own.
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "permission-card")),
    "a permission card",
  );

  await r.stop();

  const frames = lab.events.flatMap((e) => e.frames);
  const completed = frames.find((f) => f.event.event === "completed") as
    | { event: { state: { state: string } } }
    | undefined;
  expect(completed?.event.state.state).toBe("failed");
});

it("carries a run's own ending to the lab even when it starts only after stop's own wait has already begun", async () => {
  // stop() must not merely check what was already in flight the moment it
  // started waiting: a `completed` frame produced by closing a session — the
  // very thing this same shutdown just did — can be deferred behind an
  // ordinary batch that is already travelling to the lab, and only start its
  // own POST once that earlier one settles. A wait that only ever looks at
  // its original snapshot would move on and abort the connection out from
  // under a delivery that had only just begun.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "t1", title: "Write /tmp/somewhere" },
  ]);
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  let releaseFirst: (() => void) | undefined;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: 1,
          command: {
            type: "start-run",
            runId: "run_drain",
            studyId: "s_cmp",
            taskId: "t_cmp",
            sessionId: "se_drain",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      if (req.url === "/daemon/run/events") {
        events.push(parsed as unknown as { runId: string; frames: never[] });
        if (!releaseFirst) {
          // Held open: the permission card's own immediate flush — the one
          // batch already in flight the moment `stop` looks at what it must
          // wait on.
          releaseFirst = () => {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{}");
          };
          return;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(base, data);

  await until(() => releaseFirst !== undefined, "the first batch to be held open");

  const stopping = r.stop();
  // Comfortably under FINAL_FLUSH_GRACE_MS (2s): long enough for stop's own
  // synchronous work — closing the session, which rejects the held-open
  // `session/prompt` call and produces the run's `completed` frame — to have
  // already happened, so that frame is sitting in `pending` behind the still
  // -held-open first batch by the time this releases it.
  await new Promise((resolve) => setTimeout(resolve, 200));
  releaseFirst!();
  await stopping;

  expect(events.flatMap((e) => e.frames).find((f) => f.event.event === "completed")).toBeDefined();
});

it("does not act on a start-run command a second time when a reconnect replays it", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const command = {
    type: "start-run",
    runId: "run_replay",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_replay",
    agent: "claude",
    prompt: "go",
    grants: [],
  };
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  const commandUrls: string[] = [];
  let connections = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      connections += 1;
      commandUrls.push(req.url);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: command\ndata: ${JSON.stringify({ seq: 1, command })}\n\n`);
      // The first connection drops before this daemon can prove it saw the
      // command — exactly the situation a lab's own reconnect logic would
      // answer by replaying it, which the second connection does here.
      if (connections === 1) res.end();
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      if (req.url === "/daemon/run/events")
        events.push(parsed as unknown as { runId: string; frames: never[] });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(base, data);

  await until(() => connections >= 2, "a second connection replaying the command");
  await until(
    () => events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a completed turn",
  );
  // Room for the replayed delivery to also run its course and post its own
  // completed frame, if it were (wrongly) acted on a second time.
  await new Promise((resolve) => setTimeout(resolve, 200));

  const completedCount = events.flatMap((e) => e.frames).filter((f) => f.event.event === "completed").length;
  expect(completedCount).toBe(1);
  // The reconnect itself carries a cursor: the seq of the last command this
  // daemon handled (1, from the first connection), not a blank slate.
  expect(commandUrls[1]).toContain("cursor=1");
});

it("resets its command cursor when an upgraded server first reports a relay generation", async () => {
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  const commandCursors: Array<string | null> = [];
  let liveReports = 0;
  let secondStream: import("node:http").ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      const cursor = new URL(req.url, "http://127.0.0.1").searchParams.get("cursor");
      commandCursors.push(cursor);
      const command = commandCursors.length === 1
        ? { type: "decision", runId: "run_already_seen", decision: { action: "cancel" } }
        : {
            type: "start-run",
            runId: "run_after_server_restart",
            studyId: "s_cmp",
            taskId: "t_cmp",
            sessionId: "se_after_server_restart",
            agent: "claude",
            prompt: "delivered from rebuilt relay",
            grants: [],
          };
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Each relay process starts its own sequence at one. Honour the daemon's
      // cursor exactly as the real route does: without a generation reset,
      // the rebuilt relay's first command is filtered out forever.
      if (cursor === null || Number(cursor) < 1)
        res.write(`data: ${JSON.stringify({ seq: 1, command })}\n\n`);
      if (commandCursors.length === 1) res.end();
      else secondStream = res;
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as {
        runId?: string;
        frames?: Array<{ seq: number; event: RunEvent }>;
      };
      if (req.url === "/daemon/run/events")
        events.push({ runId: parsed.runId!, frames: parsed.frames! });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/daemon/run/live") {
        liveReports += 1;
        // The first response models the old server, which did not expose a
        // generation. The second is the upgraded/restarted relay, whose
        // process-local command sequence begins at one again.
        res.end(JSON.stringify(liveReports === 1 ? {} : { generation: "relay-b" }));
      } else {
        res.end("{}");
      }
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(`http://127.0.0.1:${port}`, data);

  await until(
    () => events.some((post) => post.runId === "run_after_server_restart"),
    "the rebuilt relay's first command",
  );
  expect(commandCursors.slice(0, 2)).toEqual([null, null]);
  secondStream?.end();
});

it("stops calling the lab once it says this machine has been removed", async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no such machine" }));
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = startRuns({ lab: base, token: "t", workDir: `${data}-work`, dataDir: data, adapterFor: () => undefined });
  running.push(r);

  await until(() => hits > 0, "the lab to be called at all");
  const afterFirstRefusal = hits;
  // Long enough to span the first retry's own backoff, so a bug that kept
  // retrying regardless of the refusal would show up here as a second call.
  await new Promise((resolve) => setTimeout(resolve, backoffDelayMs(1) + 300));
  expect(hits).toBe(afterFirstRefusal);
});

it("posts a grant to the lab when a card is answered for the Study", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "t1", title: "Write /work/rna-seq" },
  ]);
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  const grants: Array<{ runId: string; path: string; mode: string }> = [];
  let sendCommand: ((c: unknown) => void) | undefined;
  let commandSeq = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      commandSeq += 1;
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: commandSeq,
          command: {
            type: "start-run",
            runId: "run_g",
            studyId: "s_cmp",
            taskId: "t_cmp",
            sessionId: "se_g",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      // Held open so a decision can be sent down it once a card appears,
      // the way the lab's own command stream stays open across a turn.
      sendCommand = (c) => {
        commandSeq += 1;
        res.write(`event: command\ndata: ${JSON.stringify({ seq: commandSeq, command: c })}\n\n`);
      };
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      if (req.url === "/daemon/run/events")
        events.push(parsed as unknown as { runId: string; frames: never[] });
      if (req.url === "/daemon/run/grant")
        grants.push(parsed as unknown as { runId: string; path: string; mode: string });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(base, data);

  await until(() => sendCommand !== undefined, "the command stream to be ready");
  await until(
    () => events.some((e) => e.frames.some((f) => f.event.event === "permission-card")),
    "a permission card",
  );
  const card = events
    .flatMap((e) => e.frames)
    .find((f) => f.event.event === "permission-card") as { event: { request: { id: string } } };

  sendCommand!({
    type: "decision",
    runId: "run_g",
    decision: {
      action: "permission",
      requestId: card.event.request.id,
      decision: { decision: "allow", scope: "study" },
    },
  });

  await until(() => grants.length > 0, "a grant posted to the lab");
  expect(grants[0]).toEqual({ runId: "run_g", path: "/work/rna-seq", mode: "write" });
});

it("waits for a grant still travelling to the lab before stop finishes", async () => {
  // A grant is a durable decision, not a replaceable event batch — losing
  // one to a shutdown that did not wait for it would mean the researcher
  // answered "for the Study" and gets asked again with no trace of having
  // already said yes.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "t1", title: "Write /work/rna-seq" },
  ]);
  const grants: Array<{ runId: string; path: string; mode: string }> = [];
  let releaseGrant: (() => void) | undefined;
  let sendCommand: ((c: unknown) => void) | undefined;
  let commandSeq = 0;
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      commandSeq += 1;
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: commandSeq,
          command: {
            type: "start-run",
            runId: "run_wait",
            studyId: "s_cmp",
            taskId: "t_cmp",
            sessionId: "se_wait",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      sendCommand = (c) => {
        commandSeq += 1;
        res.write(`event: command\ndata: ${JSON.stringify({ seq: commandSeq, command: c })}\n\n`);
      };
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      if (req.url === "/daemon/run/events") {
        events.push(parsed as unknown as { runId: string; frames: never[] });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end("{}");
      }
      if (req.url === "/daemon/run/grant") {
        grants.push(parsed as unknown as { runId: string; path: string; mode: string });
        // Held open on purpose: this response is not sent until the test
        // calls `releaseGrant`, so the daemon's own POST looks exactly like
        // one still in flight at the moment `stop` is called.
        releaseGrant = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        };
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(base, data);

  await until(() => sendCommand !== undefined, "the command stream to be ready");
  await until(
    () => events.some((e) => e.frames.some((f) => f.event.event === "permission-card")),
    "a permission card",
  );
  const card = events
    .flatMap((e) => e.frames)
    .find((f) => f.event.event === "permission-card") as { event: { request: { id: string } } };
  sendCommand!({
    type: "decision",
    runId: "run_wait",
    decision: {
      action: "permission",
      requestId: card.event.request.id,
      decision: { decision: "allow", scope: "study" },
    },
  });

  await until(() => grants.length > 0, "the grant to reach the lab");
  await until(() => releaseGrant !== undefined, "the grant response to be held open");

  let stopped = false;
  const stopping = r.stop().then(() => {
    stopped = true;
  });
  // Comfortably under `FINAL_FLUSH_GRACE_MS` (2s), so this is not merely
  // observing `stop` still running — it is proving it has not given up and
  // moved on while the grant's own response is deliberately withheld.
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(stopped).toBe(false);

  releaseGrant!();
  await stopping;
  expect(stopped).toBe(true);

});

it("answers a card 'once' or 'for this conversation' without ever posting a grant", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "t1", title: "Write /work/rna-seq" },
    { ask: "permission", toolCallId: "t2", title: "Write /work/other" },
  ]);
  const events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  const grants: Array<{ runId: string; path: string; mode: string }> = [];
  let sendCommand: ((c: unknown) => void) | undefined;
  let commandSeq = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      commandSeq += 1;
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: commandSeq,
          command: {
            type: "start-run",
            runId: "run_h",
            studyId: "s_cmp",
            taskId: "t_cmp",
            sessionId: "se_h",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      sendCommand = (c) => {
        commandSeq += 1;
        res.write(`event: command\ndata: ${JSON.stringify({ seq: commandSeq, command: c })}\n\n`);
      };
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
      if (req.url === "/daemon/run/events")
        events.push(parsed as unknown as { runId: string; frames: never[] });
      if (req.url === "/daemon/run/grant")
        grants.push(parsed as unknown as { runId: string; path: string; mode: string });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(base, data);

  await until(() => sendCommand !== undefined, "the command stream to be ready");
  await until(
    () => events.some((e) => e.frames.some((f) => f.event.event === "permission-card")),
    "the first permission card",
  );
  const firstCard = events.flatMap((e) => e.frames).find((f) => f.event.event === "permission-card") as {
    event: { request: { id: string } };
  };
  sendCommand!({
    type: "decision",
    runId: "run_h",
    decision: {
      action: "permission",
      requestId: firstCard.event.request.id,
      decision: { decision: "allow", scope: "once" },
    },
  });

  await until(
    () => events.flatMap((e) => e.frames).filter((f) => f.event.event === "permission-card").length >= 2,
    "the second permission card",
  );
  const secondCard = events
    .flatMap((e) => e.frames)
    .filter((f) => f.event.event === "permission-card")[1] as { event: { request: { id: string } } };
  sendCommand!({
    type: "decision",
    runId: "run_h",
    decision: {
      action: "permission",
      requestId: secondCard.event.request.id,
      decision: { decision: "allow", scope: "conversation" },
    },
  });

  await until(
    () => events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "the turn to complete",
  );
  expect(grants).toEqual([]);
});

it("fails a turn when the adapter dies, with its stderr as the reason", async () => {
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_x",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_x",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = startRuns({
    lab: lab.base,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () => ({
      command: process.execPath,
      args: ["-e", "process.stderr.write('adapter blew up\\n');process.exit(1)"],
    }),
  });
  running.push(r);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a failure",
  );
  const done = lab.events
    .flatMap((e) => e.frames)
    .find((f) => f.event.event === "completed") as { event: { state: { state: string; reason?: string } } };
  expect(done.event.state.state).toBe("failed");
  expect(done.event.state.reason).toMatch(/adapter blew up/);
});

it("retries the exact numbered event batch after a transient lab outage before sending later frames", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { emit: "agent_message_chunk", text: "after the outage" },
  ]);
  const attempts: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> = [];
  let commandStream: import("node:http").ServerResponse | undefined;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      commandStream = res;
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: 1,
          command: {
            type: "start-run",
            runId: "run_retry",
            studyId: "s_cmp",
            taskId: "t_cmp",
            sessionId: "se_retry",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as {
        runId?: string;
        frames?: Array<{ seq: number; event: RunEvent }>;
      };
      if (req.url === "/daemon/run/events") {
        attempts.push({ runId: parsed.runId!, frames: parsed.frames! });
        if (attempts.length === 1) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "temporary outage" }));
          return;
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(`http://127.0.0.1:${port}`, data);

  await until(
    () =>
      attempts.slice(1).some((attempt) =>
        attempt.frames.some((frame) => frame.event.event === "completed"),
      ),
    "the retried run to complete",
  );

  expect(commandStream).toBeDefined();
  expect(attempts[1]).toEqual(attempts[0]);
  const acknowledged = attempts.slice(1).flatMap((attempt) => attempt.frames);
  expect(acknowledged.map((frame) => frame.seq)).toEqual(
    Array.from({ length: acknowledged.length }, (_, index) => index + 1),
  );
});

it("treats a frame-sequence conflict as an explicit failed resynchronization and reports the run missing", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "blocked", title: "Write /tmp/conflict" },
  ]);
  const liveReports: string[][] = [];
  const acceptedLiveReports: string[][] = [];
  let liveCalls = 0;
  let eventPosts = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: 1,
          command: {
            type: "start-run",
            runId: "run_conflict",
            studyId: "s_cmp",
            taskId: "t_cmp",
            sessionId: "se_conflict",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { runIds?: string[] };
      if (req.url === "/daemon/run/events") {
        eventPosts += 1;
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "expected frame 4, received 1" }));
        return;
      }
      if (req.url === "/daemon/run/live") {
        const report = parsed.runIds ?? [];
        liveReports.push(report);
        liveCalls += 1;
        // The initial report opens the command stream. Fail the first report
        // caused by the 409 itself: durable settlement must wait for a later
        // acknowledged retry, not merely for one best-effort attempt.
        if (liveCalls === 2) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "temporary reconciliation outage" }));
          return;
        }
        acceptedLiveReports.push(report);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const run = subsystem(`http://127.0.0.1:${port}`, data);

  await until(() => run.lastFailure() !== undefined, "a sequence conflict failure");
  await until(
    () => acceptedLiveReports.some((report) => report.length === 0) && liveCalls >= 3,
    "an acknowledged missing-run resynchronization retry",
  );
  expect(run.lastFailure()).toMatch(/out of sync.*expected frame 4, received 1/i);
  expect(eventPosts).toBe(1);
  expect(liveReports[1]).toEqual([]);
  expect(liveReports[2]).toEqual([]);
});

it("reports again when another sequence conflict lands during an in-flight reconciliation", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "blocked", title: "Write /tmp/conflict" },
  ]);
  const liveReports: string[][] = [];
  let eventRequests = 0;
  let secondConflict: import("node:http").ServerResponse | undefined;
  let firstReconciliation: import("node:http").ServerResponse | undefined;
  let overlapScheduled = false;
  const finishOverlap = () => {
    if (!secondConflict || !firstReconciliation || overlapScheduled) return;
    overlapScheduled = true;
    secondConflict.writeHead(409, { "content-type": "application/json" });
    secondConflict.end(JSON.stringify({ error: "second sequence conflict" }));
    setTimeout(() => {
      firstReconciliation?.writeHead(200, { "content-type": "application/json" });
      firstReconciliation?.end("{}");
      firstReconciliation = undefined;
    }, 100);
  };
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [index, runId] of ["run_conflict_a", "run_conflict_b"].entries()) {
        res.write(
          `data: ${JSON.stringify({
            seq: index + 1,
            command: {
              type: "start-run",
              runId,
              studyId: "s_cmp",
              taskId: "t_cmp",
              sessionId: `se_${runId}`,
              agent: "claude",
              prompt: "go",
              grants: [],
            },
          })}\n\n`,
        );
      }
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { runIds?: string[] };
      if (req.url === "/daemon/run/events") {
        eventRequests += 1;
        if (eventRequests === 1) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "first sequence conflict" }));
        } else {
          secondConflict = res;
          finishOverlap();
        }
        return;
      }
      if (req.url === "/daemon/run/live") {
        liveReports.push(parsed.runIds ?? []);
        if (liveReports.length === 2) {
          firstReconciliation = res;
          finishOverlap();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        }
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(`http://127.0.0.1:${port}`, data);

  await until(
    () => liveReports.length >= 3 && liveReports.at(-1)?.length === 0,
    "a reconciliation including the conflict that landed during its predecessor",
  );
  expect(liveReports[1]).toHaveLength(1);
  expect(liveReports[2]).toEqual([]);
});

/** A lab that opens the command stream normally — handing over one start-run
 *  right away — and answers every other daemon call at once, except
 *  `/daemon/run/events`: that request is simply never answered. What a
 *  suspended machine or a load balancer that lost its backend looks like
 *  from here. */
async function deadLab(): Promise<{ base: string }> {
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: 1,
          command: {
            type: "start-run",
            runId: "run_chatty",
            studyId: "s_cmp",
            taskId: "t_cmp",
            sessionId: "se_chatty",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      return;
    }
    if (req.url === "/daemon/run/events") return; // accepted, never answered
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  return { base: `http://127.0.0.1:${port}` };
}

it("fails a turn rather than dropping events when the outbound queue overflows", async () => {
  // A lab that accepts the stream and answers nothing, against a script —
  // several thousand message chunks, well past the outbound queue's own
  // bound, with no `endTurn` directive — that never stops talking. The
  // wrong outcome is a turn that looks complete having quietly lost its
  // middle.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify(
    Array.from({ length: 3000 }, () => ({ emit: "agent_message_chunk", text: "chatter " })),
  );
  const lab = await deadLab();
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(lab.base, data);
  await until(() => r.lastFailure() !== undefined, "an overflow failure");
  expect(r.lastFailure()).toMatch(/could not be sent/);
});

it("gives a run still queued behind another its own honest ending when stop is called before its turn begins", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "t1", title: "Write /tmp/somewhere" },
  ]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_first",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_queue",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
    {
      type: "start-run",
      runId: "run_second",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_queue",
      agent: "claude",
      prompt: "go again",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(lab.base, data);

  // Proof the first turn is genuinely still running, with the second queued
  // behind it on the same session: nothing will answer the open permission
  // request on its own.
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "permission-card")),
    "a permission card",
  );

  await r.stop();

  const completedFor = (runId: string) =>
    lab.events
      .filter((e) => e.runId === runId)
      .flatMap((e) => e.frames)
      .find((f) => f.event.event === "completed") as { event: { state: { state: string } } } | undefined;

  expect(completedFor("run_first")?.event.state.state).toBe("failed");
  expect(completedFor("run_second")?.event.state.state).toBe("failed");
});

it("cancels a queued same-session run durably without ever invoking its prompt", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "first-only", title: "Write /tmp/first" },
  ]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_first",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_queue_cancel",
      agent: "claude",
      prompt: "first",
      grants: [],
    },
    {
      type: "start-run",
      runId: "run_second",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_queue_cancel",
      agent: "claude",
      prompt: "must never run",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);

  await until(
    () => lab.events.some((post) =>
      post.runId === "run_first" &&
      post.frames.some((frame) => frame.event.event === "permission-card"),
    ),
    "the first queued turn to block",
  );
  lab.send({
    type: "decision",
    runId: "run_second",
    decision: { action: "cancel" },
  });
  await until(
    () => lab.events.some((post) =>
      post.runId === "run_second" &&
      post.frames.some((frame) => frame.event.event === "completed"),
    ),
    "the queued turn's cancelled ending",
  );

  const secondFrames = lab.events
    .filter((post) => post.runId === "run_second")
    .flatMap((post) => post.frames);
  // It said it was waiting, and then it said it was cancelled. Nothing
  // between the two: no prose, no tool call, no plan — the prompt was never
  // handed to the agent at all, which is what this test is about. Saying it
  // was waiting is not running it.
  expect(secondFrames).toEqual([
    { seq: 1, event: { event: "state", state: { state: "queued", ahead: 1 } } },
    { seq: 2, event: { event: "completed", state: { state: "cancelled" } } },
  ]);

  lab.send({
    type: "decision",
    runId: "run_first",
    decision: { action: "cancel" },
  });
  await until(
    () => lab.events.some((post) =>
      post.runId === "run_first" &&
      post.frames.some((frame) => frame.event.event === "completed"),
    ),
    "the first turn to stop",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(
    lab.events
      .filter((post) => post.runId === "run_second")
      .flatMap((post) => post.frames),
  ).toEqual(secondFrames);
});

it("cancels and reaps stuck initialization before a same-session successor starts", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const initializing = markerIn(data, "session-new-started");
  const exited = markerIn(data, "initializing-adapter-exited");
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = initializing;
  process.env.LYKEION_STUB_SESSION_NEW_DELAY_MS = "3000";
  process.env.LYKEION_STUB_EXIT_MARKER = exited;
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_cancel_during_init",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_cancel_during_init",
      agent: "claude",
      prompt: "must never reach session/prompt",
      grants: [],
    },
  ]);
  subsystem(lab.base, data);

  await until(() => existsSync(initializing), "session initialization to begin");
  const cancelStarted = Date.now();
  lab.send({
    type: "decision",
    runId: "run_cancel_during_init",
    decision: { action: "cancel" },
  });
  lab.send({
    type: "start-run",
    runId: "run_after_cancelled_init",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_cancel_during_init",
    agent: "claude",
    prompt: "start only after the old child exits",
    grants: [],
  });
  await until(
    () => lab.events.some((post) =>
      post.runId === "run_cancel_during_init" &&
      post.frames.some((frame) => frame.event.event === "completed"),
    ),
    "the initialization-race cancellation",
  );
  await until(
    () =>
      readFileSync(initializing, "utf8").trim().split("\n").filter(Boolean).length >= 2,
    "the same-session successor to begin initialization",
  );

  expect(Date.now() - cancelStarted).toBeLessThan(1500);
  expect(existsSync(exited)).toBe(true);
  expect(
    lab.events
      .filter((post) => post.runId === "run_cancel_during_init")
      .flatMap((post) => post.frames),
  ).toEqual([
    { seq: 1, event: { event: "completed", state: { state: "cancelled" } } },
  ]);
});

it("aborts and reaps a session whose initialization stays stuck after stop", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const initializing = markerIn(data, "session-new-started");
  const prompted = markerIn(data, "prompt-started");
  const exited = markerIn(data, "adapter-exited");
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = initializing;
  // Longer than stop's own bounded final-flush window: a timeout that merely
  // returns while leaving the subprocess alive fails the exit-marker check.
  process.env.LYKEION_STUB_SESSION_NEW_DELAY_MS = "3000";
  process.env.LYKEION_STUB_PROMPT_MARKER = prompted;
  process.env.LYKEION_STUB_EXIT_MARKER = exited;
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_stop_during_init",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_stop_during_init",
      agent: "claude",
      prompt: "must never start after shutdown",
      grants: [],
    },
  ]);
  const run = subsystem(lab.base, data);

  await until(() => existsSync(initializing), "session initialization to begin");
  const stopStarted = Date.now();
  await run.stop();

  expect(Date.now() - stopStarted).toBeLessThan(1500);
  expect(existsSync(prompted)).toBe(false);
  expect(existsSync(exited)).toBe(true);
  expect(
    lab.events
      .filter((post) => post.runId === "run_stop_during_init")
      .flatMap((post) => post.frames),
  ).toEqual([
    {
      seq: 1,
      event: {
        event: "completed",
        state: {
          state: "failed",
          reason: "this machine stopped before this run's turn could begin",
        },
      },
    },
  ]);
});

it("bounds shutdown while retaining and retrying an event batch the lab never accepts", async () => {
  const attempts: Array<Array<{ seq: number; event: RunEvent }>> = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `event: command\ndata: ${JSON.stringify({
          seq: 1,
          command: {
            type: "start-run",
            runId: "run_lost",
            studyId: "s_cmp",
            taskId: "t_cmp",
            sessionId: "se_lost",
            agent: "claude",
            prompt: "go",
            grants: [],
          },
        })}\n\n`,
      );
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      if (req.url === "/daemon/run/events") {
        const parsed = JSON.parse(body || "{}") as {
          frames?: Array<{ seq: number; event: RunEvent }>;
        };
        attempts.push(parsed.frames ?? []);
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "nope" }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : 0);
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(base, data);
  await until(() => attempts.length >= 2, "the retained batch to be retried");
  expect(attempts[1]).toEqual(attempts[0]);

  const started = Date.now();
  await r.stop();
  expect(Date.now() - started).toBeLessThan(2_750);
});

it("reports the working directory a live session is standing in, so a sweep never removes it out from under a running adapter", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_live_dir",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_live_dir",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(lab.base, data);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a completed turn",
  );
  expect(r.liveSessionDirs()).toEqual([join(`${data}-work`, "studies", "s_cmp", "tasks", "t_cmp")]);
});

it("retires a session whose stop was unacknowledged and keeps a later turn healthy", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const oldMarker = markerIn(data, "old.closed");
  const freshMarker = markerIn(data, "fresh.closed");
  process.env.LYKEION_STUB_EXIT_MARKER = oldMarker;
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { sleep: 120 },
    { ask: "permission", toolCallId: "late", title: "Write /late/out.csv" },
    { endTurn: "end_turn" },
  ]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_poisoned",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_reused",
      agent: "claude",
      prompt: "first",
      grants: [],
    },
  ]);
  const r = startRuns({
    lab: lab.base,
    token: "machine-token",
    workDir: `${data}-work`,
    dataDir: data,
    cancelGraceMs: 20,
    adapterFor: () => ({ command: process.execPath, args: ["--experimental-strip-types", STUB] }),
    extraEnv: stubEnv,
  });
  running.push(r);
  await until(() => lab.commandConnected(), "the command stream");
  await until(
    () => lab.events.some((post) => post.runId === "run_poisoned" && post.frames.some(
      (frame) => frame.event.event === "state" && frame.event.state.state === "planning",
    )),
    "the first turn to start",
  );
  lab.send({ type: "cancel", runId: "run_poisoned" });
  await until(
    () => lab.events.some((post) => post.runId === "run_poisoned" && post.frames.some(
      (frame) => frame.event.event === "completed" && frame.event.state.state === "cancelled" && frame.event.state.unacknowledged,
    )),
    "an unacknowledged stop",
  );

  process.env.LYKEION_STUB_EXIT_MARKER = freshMarker;
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "healthy", title: "Write /fresh/out.csv" },
    { endTurn: "end_turn" },
  ]);
  lab.send({
    type: "start-run",
    runId: "run_fresh",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_reused",
    agent: "claude",
    prompt: "second",
    grants: [],
  });
  await until(
    () => lab.events.some((post) => post.runId === "run_fresh" && post.frames.some(
      (frame) => frame.event.event === "permission-card" && frame.event.request.tool === "healthy",
    )),
    "the fresh turn's permission card",
  );
  const card = lab.events.flatMap((post) => post.runId === "run_fresh" ? post.frames : []).find(
    (frame) => frame.event.event === "permission-card",
  )!.event;
  if (card.event !== "permission-card") throw new Error("permission card missing");
  lab.send({
    type: "decision",
    runId: "run_fresh",
    decision: {
      action: "permission",
      requestId: card.request.id,
      decision: { decision: "allow", scope: "once" },
    },
  });
  await until(
    () => lab.events.some((post) => post.runId === "run_fresh" && post.frames.some(
      (frame) => frame.event.event === "completed" && frame.event.state.state === "completed",
    )),
    "the fresh turn to complete",
  );
  expect(lab.events.flatMap((post) => post.runId === "run_fresh" ? post.frames : []).some(
    (frame) => frame.event.event === "log-entry" && frame.event.entry.toolUseId === "late",
  )).toBe(false);

  await r.stop();
  expect(existsSync(oldMarker)).toBe(true);
  expect(existsSync(freshMarker)).toBe(true);
});

it("keeps a Task's work in one directory across the sessions that touch it", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_first_agent",
      studyId: "s_cmp",
      taskId: "t_shared",
      sessionId: "se_first_agent",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(lab.base, data);
  const taskDir = join(`${data}-work`, "studies", "s_cmp", "tasks", "t_shared");
  dirs.push(`${data}-work`);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "the first turn",
  );
  expect(r.liveSessionDirs()).toEqual([taskDir]);

  // A second agent on the same Task opens a new session, and lands in the
  // directory the first one's work is already in.
  lab.send({
    type: "start-run",
    runId: "run_second_agent",
    studyId: "s_cmp",
    taskId: "t_shared",
    sessionId: "se_second_agent",
    agent: "codex",
    prompt: "again",
    grants: [],
  });
  await until(
    () =>
      lab.events.filter((e) => e.frames.some((f) => f.event.event === "completed")).length === 2,
    "the second turn",
  );
  expect(r.liveSessionDirs()).toEqual([taskDir, taskDir]);
  expect(existsSync(join(`${data}-work`, "studies", "s_cmp", "sessions"))).toBe(false);
});

it("refuses a start-run that names no Task, since there is nowhere to run it", async () => {
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_no_task",
      studyId: "s_cmp",
      sessionId: "se_no_task",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a refusal",
  );
  const done = lab.events
    .flatMap((e) => e.frames)
    .find((f) => f.event.event === "completed")!;
  expect(done.event).toMatchObject({ state: { state: "failed" } });
  expect((done.event as { state: { reason: string } }).state.reason).toMatch(/taskId/);
});

it("refuses a run whose grant names a path this machine cannot resolve, and spawns nothing", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const spawned = markerIn(data, "adapter-was-spawned");
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = spawned;
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_bad_grant",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_bad_grant",
      agent: "claude",
      prompt: "go",
      grants: [{ path: "/there-is-no-such-folder-here/data", mode: "write" }],
    },
  ]);
  subsystem(lab.base, data);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a refusal",
  );
  const done = lab.events.flatMap((e) => e.frames).find((f) => f.event.event === "completed")!;
  expect(done.event).toMatchObject({ state: { state: "failed" } });
  expect((done.event as { state: { reason: string } }).state.reason).toMatch(
    /there-is-no-such-folder-here/,
  );
  expect(existsSync(spawned)).toBe(false);
});

it("refuses a run on a platform it cannot confine, naming the platform, and spawns nothing", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const spawned = markerIn(data, "adapter-was-spawned");
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = spawned;
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_no_backend",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_no_backend",
      agent: "claude",
      prompt: "go",
      grants: [],
    },
  ]);
  const r = startRuns({
    lab: lab.base,
    token: "machine-token",
    workDir: `${data}-work`,
    dataDir: data,
    platform: "linux",
    adapterFor: () => ({ command: process.execPath, args: ["--experimental-strip-types", STUB] }),
    extraEnv: stubEnv,
  });
  running.push(r);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "a refusal",
  );
  const done = lab.events.flatMap((e) => e.frames).find((f) => f.event.event === "completed")!;
  expect((done.event as { state: { reason: string } }).state.reason).toMatch(/linux/);
  expect(existsSync(spawned)).toBe(false);
});

it("opens a new session rather than running a later turn inside an older turn's boundary", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const opened = markerIn(data, "sessions-opened");
  const granted = mkdtempSync(join(tmpdir(), "lykeion-granted-"));
  dirs.push(granted);
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = opened;
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_grant_a",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_shared",
      agent: "claude",
      prompt: "first",
      grants: [{ path: granted, mode: "write" }],
    },
  ]);
  subsystem(lab.base, data);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "the first turn",
  );
  expect(readFileSync(opened, "utf8").trim().split("\n")).toHaveLength(1);

  // The same session, with the grant taken away. The boundary the first turn
  // was rendered with no longer describes what the researcher allows, so the
  // subprocess it belongs to cannot be the one this turn runs in.
  lab.send({
    type: "start-run",
    runId: "run_grant_b",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_shared",
    agent: "claude",
    prompt: "second",
    grants: [],
  });
  await until(
    () =>
      lab.events.filter((e) => e.frames.some((f) => f.event.event === "completed")).length === 2,
    "the second turn",
  );
  expect(readFileSync(opened, "utf8").trim().split("\n")).toHaveLength(2);
});

it("keeps one session across turns whose boundary has not changed", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const opened = markerIn(data, "sessions-opened");
  process.env.LYKEION_STUB_SESSION_NEW_MARKER = opened;
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ emit: "agent_message_chunk", text: "hi" }]);
  const start = {
    type: "start-run",
    studyId: "s_cmp",
    taskId: "t_cmp",
    sessionId: "se_stable",
    agent: "claude",
    prompt: "go",
    grants: [],
  };
  const lab = await stubLab([{ ...start, runId: "run_same_a" }]);
  subsystem(lab.base, data);
  await until(
    () => lab.events.some((e) => e.frames.some((f) => f.event.event === "completed")),
    "the first turn",
  );
  lab.send({ ...start, runId: "run_same_b" });
  await until(
    () =>
      lab.events.filter((e) => e.frames.some((f) => f.event.event === "completed")).length === 2,
    "the second turn",
  );
  // One subprocess, and therefore one conversation: nothing about the
  // boundary changed, so nothing had to be given up to keep it honest.
  expect(readFileSync(opened, "utf8").trim().split("\n")).toHaveLength(1);
});

it("says a turn is waiting rather than working, until its place in the queue comes up", async () => {
  // A researcher who typed ahead has a turn that has been taken and has not
  // begun. Reported as `planning` it would read as the agent thinking about a
  // prompt it has not been given yet; `queued` says what is true, and `ahead`
  // is how many turns are in front of it.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "t1", title: "Write /tmp/somewhere" },
  ]);
  const lab = await stubLab([
    {
      type: "start-run",
      runId: "run_head",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_wait",
      agent: "claude",
      prompt: "first",
      grants: [],
    },
    {
      type: "start-run",
      runId: "run_waiting",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_wait",
      agent: "claude",
      prompt: "and also this",
      grants: [],
    },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = subsystem(lab.base, data);

  await until(
    () =>
      lab.events.some(
        (e) =>
          e.runId === "run_waiting" &&
          e.frames.some(
            (f) => f.event.event === "state" && f.event.state.state === "queued",
          ),
      ),
    "the second turn reporting itself as waiting",
  );

  const waiting = lab.events
    .filter((e) => e.runId === "run_waiting")
    .flatMap((e) => e.frames)
    .find((f) => f.event.event === "state") as
    | { event: { state: { state: string; ahead: number } } }
    | undefined;
  expect(waiting?.event.state).toEqual({ state: "queued", ahead: 1 });

  // And the turn in front of it never says it is waiting: it is the one
  // actually working.
  expect(
    lab.events
      .filter((e) => e.runId === "run_head")
      .flatMap((e) => e.frames)
      .some((f) => f.event.event === "state" && f.event.state.state === "queued"),
  ).toBe(false);

  await r.stop();
});

it("moves a waiting turn up as the turns in front of it settle", async () => {
  // A permission request never answered on its own is what keeps run_1
  // genuinely running rather than finishing before run_2 and run_3 even get
  // a chance to report their place in the queue.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "hold", title: "Write /tmp/somewhere" },
  ]);
  const lab = await stubLab(
    ["run_1", "run_2", "run_3"].map((runId) => ({
      type: "start-run",
      runId,
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_move_queue",
      agent: "claude",
      prompt: runId,
      grants: [],
    })),
  );
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);

  // Proof run_1 is genuinely still running, with run_2 and run_3 queued
  // behind it: nothing answers the open permission request on its own, and
  // by the time a real subprocess has reached it, both queued turns have had
  // far longer than they need to report their place.
  await until(
    () =>
      lab.events.some(
        (e) => e.runId === "run_1" && e.frames.some((f) => f.event.event === "permission-card"),
      ),
    "run_1 to become active",
  );

  expect(queuedPositions(lab, "run_2")).toEqual([1]);
  expect(queuedPositions(lab, "run_3")).toEqual([2]);

  lab.send({ type: "decision", runId: "run_1", decision: { action: "cancel" } });
  await until(
    () =>
      lab.events.some(
        (e) => e.runId === "run_1" && e.frames.some((f) => f.event.event === "completed"),
      ),
    "run_1 to settle",
  );
  // run_2 has begun, so it says so rather than saying it is still waiting;
  // run_3 has one turn in front of it now rather than two.
  await until(() => queuedPositions(lab, "run_3").length > 1, "run_3's revised position");
  expect(queuedPositions(lab, "run_3")).toEqual([2, 1]);
});

it("does not repeat a queued turn's position when the turn cancelled ahead of it is only reached later", async () => {
  // run_2's own continuation reaches `sessionOfRun.delete` only once the
  // turns ahead of it in `turnQueues` have settled — by which point a
  // decision already cancelled it and removed its entry. That continuation
  // must find nothing left to remove, and must not re-announce run_4's
  // position on the strength of a removal that never happened.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { ask: "permission", toolCallId: "hold", title: "Write /tmp/somewhere" },
  ]);
  const lab = await stubLab(
    ["run_1", "run_2", "run_3", "run_4"].map((runId) => ({
      type: "start-run",
      runId,
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_no_op_cancel",
      agent: "claude",
      prompt: runId,
      grants: [],
    })),
  );
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);

  await until(
    () =>
      lab.events.some(
        (e) => e.runId === "run_1" && e.frames.some((f) => f.event.event === "permission-card"),
      ),
    "run_1 to become active",
  );
  expect(queuedPositions(lab, "run_4")).toEqual([3]);

  // run_2 is still only queued — cancelling it here removes its entry
  // immediately and revises everyone behind it.
  lab.send({ type: "decision", runId: "run_2", decision: { action: "cancel" } });
  await until(
    () =>
      lab.events.some(
        (e) => e.runId === "run_2" && e.frames.some((f) => f.event.event === "completed"),
      ),
    "run_2's cancelled ending",
  );
  expect(queuedPositions(lab, "run_4")).toEqual([3, 2]);

  // run_1 settling advances `turnQueues` to run_2's own continuation, whose
  // `sessionOfRun.delete` finds nothing left to remove — its own cancel
  // already did that. run_3's continuation follows immediately behind it and
  // becomes genuinely active, which is this test's proof that the whole
  // chain, including run_2's no-op, has finished running.
  lab.send({ type: "decision", runId: "run_1", decision: { action: "cancel" } });
  await until(
    () =>
      lab.events.some(
        (e) => e.runId === "run_3" && e.frames.some((f) => f.event.event === "permission-card"),
      ),
    "run_3 to become active",
  );
  expect(queuedPositions(lab, "run_4")).toEqual([3, 2, 1]);
});

/** A kernel host that records every call it is asked to make, and answers
 *  each with an empty result — enough for a command that carries no reply
 *  of its own back to the lab. */
function recordingKernelHost() {
  const calls: Array<{ method: string; params: unknown }> = [];
  const host: KernelHost = {
    call: async (method, params) => {
      calls.push({ method, params });
      return {};
    },
    on: () => {},
    serve: () => {},
    stop: () => Promise.resolve(),
    get running() {
      return true;
    },
    stderrTail: () => "",
  };
  return { host, calls };
}

it("interrupts a kernel this machine's host is holding when the lab asks it to", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = recordingKernelHost();
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({ type: "kernel-interrupt", runId: "k_1", kernelId: "k_1" });

  await until(() => kernels.calls.length > 0, "the interrupt reaching this machine's kernel host");
  expect(kernels.calls).toEqual([{ method: "kernel.interrupt", params: { kernel_id: "k_1" } }]);
});

it("carries what the researcher said down to the kernel it is stopping", async () => {
  // The whole point of this command, and the one thing `signalKernel` — which
  // passes `kernel_id` and nothing else — could not carry. A stop that
  // arrived without the sentence and the member who said it would end the
  // kernel and leave the agent's tool call failing for no stated reason.
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = recordingKernelHost();
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({
    type: "kernel-stop",
    runId: "k_1",
    kernelId: "k_1",
    feedback: "redo this using less memory",
    by: "u_ana",
  });

  await until(() => kernels.calls.length > 0, "the stop reaching this machine's kernel host");
  expect(kernels.calls).toEqual([
    {
      method: "kernel.stop",
      params: { kernel_id: "k_1", feedback: "redo this using less memory", by: "u_ana" },
    },
  ]);
});

it("stops a kernel with no sentence attached rather than sending an empty one", async () => {
  // A researcher who said nothing said nothing. An absent `feedback` must
  // reach the host as an absent key, not as `undefined` or `""` — the host
  // reads the reason's presence as the thing that tells a kernel somebody
  // ended from a kernel that died.
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = recordingKernelHost();
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({ type: "kernel-stop", runId: "k_1", kernelId: "k_1", by: "u_ana" });

  await until(() => kernels.calls.length > 0, "the stop reaching this machine's kernel host");
  // `toStrictEqual`, not `toEqual`: `toEqual` ignores a key whose value is
  // `undefined`, and this host is called in-process with no JSON round trip
  // to drop one on the way — so an unconditional `feedback: command.feedback`
  // would satisfy `toEqual` while sending the very key this test exists to
  // say is absent. Only the `""` half was ever really being asserted.
  expect(kernels.calls).toStrictEqual([
    { method: "kernel.stop", params: { kernel_id: "k_1", by: "u_ana" } },
  ]);
  // And said directly, since that difference is the whole subject.
  expect("feedback" in (kernels.calls[0]!.params as object)).toBe(false);
});

it("restarts a kernel this machine's host is holding when the lab asks it to", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = recordingKernelHost();
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({ type: "kernel-restart", runId: "k_1", kernelId: "k_1" });

  await until(() => kernels.calls.length > 0, "the restart reaching this machine's kernel host");
  expect(kernels.calls).toEqual([{ method: "kernel.restart", params: { kernel_id: "k_1" } }]);
});

it("does nothing with a kernel-execute command and a machine that holds no kernel host", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({
    type: "kernel-execute",
    runId: "cell_1",
    kernelId: "k_1",
    code: "1",
    cellId: "cell_1",
    sessionId: "se_1",
    taskId: "t_cmp",
    name: "main",
    language: "python",
    by: "u_ana",
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(lab.events).toEqual([]);
  expect(lab.cells).toEqual([]);
});

it("runs a REPL cell on this machine's kernel host and posts the cell straight back, under the id the lab minted", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const calls: Array<{ method: string; params: unknown }> = [];
  const host: KernelHost = {
    call: async (method, params) => {
      calls.push({ method, params });
      if (method !== "kernel.execute") return {};
      return {
        kernelId: "k_1",
        sessionId: "se_1",
        taskId: "t_cmp",
        name: "main",
        language: "python",
        environment: "python",
        executionCount: 4,
        source: "2 + 2",
        origin: { surface: "repl", by: "u_ana" },
        ok: true,
        wallMs: 3,
        ts: 1234,
        outputs: [{ kind: "execute_result", execution_count: 4, data: { "text/plain": "4" }, data_ref: {} }],
      };
    },
    on: () => {},
    serve: () => {},
    stop: () => Promise.resolve(),
    get running() {
      return true;
    },
    stderrTail: () => "",
  };
  subsystem(lab.base, data, () => host);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({
    type: "kernel-execute",
    runId: "cell_1",
    kernelId: "k_1",
    code: "2 + 2",
    cellId: "cell_1",
    sessionId: "se_1",
    taskId: "t_cmp",
    name: "main",
    language: "python",
    by: "u_ana",
  });

  await until(() => lab.cells.length > 0, "the cell reaching the lab");
  expect(calls).toEqual([
    {
      method: "kernel.execute",
      params: {
        session_id: "se_1",
        task_id: "t_cmp",
        name: "main",
        language: "python",
        source: "2 + 2",
        origin: { surface: "repl", by: "u_ana" },
      },
    },
  ]);
  expect(lab.cells[0]).toMatchObject({ cellId: "cell_1", kernelId: "k_1", source: "2 + 2", ok: true });
});

it("records a REPL cell once even when an agent holds the same session's turn", async () => {
  // The host announces every cell it runs, this one included, and the run
  // taking the session's turn is one this announcement would be delivered
  // to. Both ways recorded, the same cell would be two rows in the Task's
  // notebook — the same source, the same outputs, one under the id the lab
  // minted and one under an id nothing else has ever seen.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ sleep: 800 }, { endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;

  const cellListeners: Array<(params: unknown) => void> = [];
  const ran = {
    kernelId: "k_1",
    sessionId: "se_1",
    taskId: "t_cmp",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 4,
    source: "2 + 2",
    origin: { surface: "repl", by: "u_ana" },
    ok: true,
    wallMs: 3,
    ts: 1234,
    outputs: [],
  };
  const host: KernelHost = {
    call: async (method) => {
      if (method === "host.hello")
        return {
          protocol: PROTOCOL_VERSION,
          languages: [
            { language: "python", environment: "python", interpreter: "/usr/bin/python3", reads: [] },
          ],
        };
      if (method !== "kernel.execute") return {};
      // The host answers the call AND announces the cell, which is what the
      // real one does: one event, written twice, because the two ends of it
      // are waiting in different places.
      for (const listener of cellListeners) listener(ran);
      return ran;
    },
    on: (method, handler) => {
      if (method === "cell") cellListeners.push(handler);
    },
    serve: () => {},
    stop: () => Promise.resolve(),
    get running() {
      return true;
    },
    stderrTail: () => "",
  };
  subsystem(lab.base, data, () => host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_repl_during"));
  await until(() => existsSync(named), "the session opening");

  lab.send({
    type: "kernel-execute",
    runId: "cell_9",
    kernelId: "k_1",
    code: "2 + 2",
    cellId: "cell_9",
    sessionId: "se_1",
    taskId: "t_cmp",
    name: "main",
    language: "python",
    by: "u_ana",
  });

  await until(() => lab.cells.length > 0, "the cell reaching the lab");
  // Long enough for a forwarded copy to have been batched and flushed: the
  // events this machine posts leave on a 50ms timer.
  await new Promise((resolve) => setTimeout(resolve, 200));

  expect(lab.cells).toHaveLength(1);
  expect(lab.cells[0]).toMatchObject({ cellId: "cell_9", source: "2 + 2" });
  const forwarded = lab.events
    .flatMap((post) => post.frames)
    .filter((frame) => frame.event.event === "cell");
  expect(forwarded).toEqual([]);
});

it("names no tool server when this machine's kernel host speaks another protocol, and still runs the turn", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const named = markerIn(data, "session-new.json");
  process.env.LYKEION_STUB_SESSION_NEW_PARAMS = named;
  // A host from another build of this machine's own program. The wire shapes
  // either end writes are hand-written on both sides, and this number is what
  // a host says when it is no longer describing the same ones.
  const kernels = stubKernelHost(0, PROTOCOL_VERSION + 1);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_skew"));

  await until(() => existsSync(named), "the session opening");
  const params = JSON.parse(readFileSync(named, "utf8")) as {
    mcpServers: Array<{ name: string }>;
  };
  // No relay named, so no tool leads to a kernel that could never be
  // configured — and the session it was not named to still opened.
  expect(params.mcpServers).toEqual([]);
  expect(reaching(kernels.asked)).toEqual(["host.hello"]);
  await until(
    () =>
      lab.events.some((post) =>
        post.frames.some(
          (frame) => frame.event.event === "completed" && frame.event.state.state === "completed",
        ),
      ),
    "the turn finishing",
  );
});

it("refuses the turn when this machine cannot name a socket short enough to bind", async () => {
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  const was = process.env.TMPDIR;
  // A machine whose temporary directory leaves no room for a socket's name.
  // Nothing this machine can do about it and nothing that changes on the next
  // turn — so it ends the turn in words rather than opening a session with no
  // tool server and saying nothing anyone reads.
  process.env.TMPDIR = `/tmp/${"x".repeat(90)}`;
  try {
    subsystem(lab.base, data, () => kernels.host);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send(startRunOn("run_nowhere"));

    await until(
      () =>
        lab.events.some((post) =>
          post.frames.some(
            (frame) => frame.event.event === "completed" && frame.event.state.state === "failed",
          ),
        ),
      "the turn being refused",
    );
    const failure = lab.events
      .flatMap((post) => post.frames)
      .map((frame) => frame.event)
      .find(
        (event): event is Extract<RunEvent, { event: "completed" }> =>
          event.event === "completed" && event.state.state === "failed",
      )!;
    const reason = failure.state.state === "failed" ? failure.state.reason : "";
    expect(reason).toMatch(/unix socket's name/);
    expect(reason).toMatch(/bytes/);
    // Nothing was asked of the host: the name is decided before it is.
    expect(kernels.asked).toEqual([]);
  } finally {
    if (was === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = was;
  }
});

it("answers the lab's kernel-list ask with what this machine's kernel host reports", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const reported = [
    {
      id: "k_1",
      sessionId: "se_1",
      taskId: "t_cmp",
      name: "main",
      language: "python",
      state: "idle",
      incarnation: 1,
      executionCount: 2,
      queueDepth: 0,
      environment: "python",
    },
  ];
  const host: KernelHost = {
    call: async (method) => (method === "kernel.list" ? { kernels: reported } : {}),
    on: () => {},
    serve: () => {},
    stop: () => Promise.resolve(),
    get running() {
      return true;
    },
    stderrTail: () => "",
  };
  subsystem(lab.base, data, () => host);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({ type: "kernel-list", runId: "klreq_1" });

  await until(() => lab.kernelListReplies.length > 0, "the kernel list reaching the lab");
  expect(lab.kernelListReplies).toEqual([{ requestId: "klreq_1", kernels: reported }]);
});

it("answers the lab's kernel-list ask with an empty list when this machine holds no kernel host", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({ type: "kernel-list", runId: "klreq_2" });

  await until(() => lab.kernelListReplies.length > 0, "the kernel list reaching the lab");
  expect(lab.kernelListReplies).toEqual([{ requestId: "klreq_2", kernels: [] }]);
});

it("answers the lab's name-task ask with what the summarizer made of the message", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { emit: "agent_message_chunk", text: "Python kernel range check" },
  ]);
  subsystem(lab.base, data);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({
    type: "name-task",
    runId: "ntreq_1",
    taskId: "t_1",
    agent: "claude",
    prompt:
      "Use the live Python kernel. Run one cell that sets values = list(range(30)) and prints each.",
  });

  await until(() => lab.titleReplies.length > 0, "the title reaching the lab");
  expect(lab.titleReplies).toEqual([{ requestId: "ntreq_1", title: "Python kernel range check" }]);
});

it("answers a name-task ask with null, rather than silence, when it has no adapter to ask", async () => {
  // Silence would cost the lab its whole deadline for an answer this machine
  // already knows: there is no program here to summarize with.
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = startRuns({
    lab: lab.base,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () => undefined,
  });
  running.push(r);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({ type: "name-task", runId: "ntreq_2", taskId: "t_1", agent: "claude", prompt: "x".repeat(120) });

  await until(() => lab.titleReplies.length > 0, "the refusal reaching the lab");
  expect(lab.titleReplies).toEqual([{ requestId: "ntreq_2", title: null }]);
});

it("names one Task at a time, declining the rest rather than forking an agent per open chat", async () => {
  // Four chats opened in a moment is four `name-task` asks in a moment, and
  // each one launches an agent CLI. Only the first is spent; the others are
  // answered now, and their Tasks keep the names their prompts gave them.
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([
    { wait: true, timeoutMs: 300 },
    { emit: "agent_message_chunk", text: "The one that ran" },
  ]);
  subsystem(lab.base, data);
  await until(() => lab.commandConnected(), "the command stream");

  for (const requestId of ["ntreq_a", "ntreq_b", "ntreq_c"])
    lab.send({ type: "name-task", runId: requestId, taskId: "t_1", agent: "claude", prompt: "y".repeat(120) });

  await until(() => lab.titleReplies.length === 3, "all three asks being answered");
  expect(lab.titleReplies.filter((r) => r.title === null).map((r) => r.requestId)).toEqual([
    "ntreq_b",
    "ntreq_c",
  ]);
  expect(lab.titleReplies.find((r) => r.requestId === "ntreq_a")?.title).toBe("The one that ran");
});

it("does not terminalize a held-back run before its agent can start", async () => {
  // A researcher whose token lapses during a long build can restore capability
  // after the build without losing the exact continuation identity.
  const lab = await stubLab([
    { type: "start-run", runId: "run_held", studyId: "s_h", taskId: "t_h", sessionId: "se_h", agent: "claude", prompt: "go", grants: [] },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = startRuns({
    lab: lab.base,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () => undefined,
    heldBackReason: (agent) => (agent === "claude" ? "sign in to Claude Code to run it" : undefined),
  });
  running.push(r);
  await until(() => lab.commandConnected(), "the command stream");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(lab.events).toEqual([]);
});

it("does not consume an unknown agent's run id with a pre-start terminal frame", async () => {
  // Unknown and temporarily held-back agents share the same safe pre-start
  // state: no frame is invented before an adapter can execute the prompt.
  const lab = await stubLab([
    { type: "start-run", runId: "run_none", studyId: "s_n", taskId: "t_n", sessionId: "se_n", agent: "nope", prompt: "go", grants: [] },
  ]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const r = startRuns({
    lab: lab.base,
    token: "t",
    workDir: `${data}-work`,
    dataDir: data,
    adapterFor: () => undefined,
    heldBackReason: () => undefined,
  });
  running.push(r);
  await until(() => lab.commandConnected(), "the command stream");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(lab.events).toEqual([]);
});

// ---------------------------------------------------------------------------
// kernel-env-setup / kernel-env-reclaim
// ---------------------------------------------------------------------------

it("resolves when the command carries no lockfile, hands the lockfile to the lab, and materializes from it", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const uvDir = stubUv("scanpy==1.9.0\nanndata==0.10.0\n");
  const workDir = `${data}-work`;

  await withStubUvOnPath(uvDir, async () => {
    subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the command stream");

    lab.send({
      type: "kernel-env-setup",
      runId: "envsetup_1",
      name: "crispr",
      language: "python",
      manager: "uv",
      declarationGenerationId: fixtureGeneration("crispr"),
      packages: ["scanpy"],
    });

    await until(() => lab.kernelEnvResults.length > 0, "the setup's own result reaching the lab");
    // This machine resolved — the one thing the replay branch below never
    // does — and handed what it resolved to the lab.
    // `requestId` rides along because a lab refuses a pin from a machine it
    // did not ask: a lockfile is the one thing every other machine later
    // replays verbatim, so a bearer token alone must not authorize writing one.
    expect(lab.kernelEnvLocks).toEqual([
      {
        requestId: "envsetup_1",
        name: "crispr",
        declarationGenerationId: fixtureGeneration("crispr"),
        lockfile: "scanpy==1.9.0\nanndata==0.10.0\n",
      },
    ]);
    const result = lab.kernelEnvResults[0]!;
    expect(result.ok).toBe(true);
    const status = result.status as { state: string; lockRevision: number; packageCount: number };
    expect(status.state).toBe("ready");
    expect(status.lockRevision).toBe(1);
    expect(status.packageCount).toBe(2);
    expect(existsSync(join(envRoot(workDir, "crispr"), "bin", "python3"))).toBe(true);
    expect(
      lab.kernelEnvProgress
        .map(({ progress }) => progress.stage)
        .filter((stage, index, stages) => stage !== stages[index - 1]),
    ).toEqual(["resolving", "installing", "finalizing"]);
  });
});

it("deduplicates a replayed durable environment setup request id", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const uvDir = stubUv("scanpy==1.9.0\n");

  await withStubUvOnPath(uvDir, async () => {
    subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the command stream");
    const command = {
      type: "kernel-env-setup",
      runId: "envsetup_replayed",
      name: "crispr",
      language: "python",
      manager: "uv",
      declarationGenerationId: fixtureGeneration("crispr"),
      packages: ["scanpy"],
    };

    lab.send(command);
    lab.send(command);

    await until(() => lab.kernelEnvResults.length > 0, "the setup's own result");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lab.kernelEnvLocks).toHaveLength(1);
    expect(lab.kernelEnvResults).toHaveLength(1);
  });
});

it("keeps an in-flight environment build exact beyond the terminal-history horizon", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  let commandStream: import("node:http").ServerResponse | undefined;
  const heldProgress: import("node:http").ServerResponse[] = [];
  const command = {
    type: "kernel-env-setup",
    runId: "envsetup_active_beyond_history",
    name: "crispr",
    language: "python",
    manager: "uv",
    declarationGenerationId: fixtureGeneration("crispr"),
    packages: ["scanpy"],
  };
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      commandStream = res;
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { requestId?: string };
      if (
        req.url === "/daemon/kernel-env/progress" &&
        parsed.requestId === command.runId
      ) {
        heldProgress.push(res);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  subsystem(`http://127.0.0.1:${port}`, data);
  await until(() => commandStream !== undefined, "the command stream");
  commandStream!.write(`event: command\ndata: ${JSON.stringify({ seq: 1, command })}\n\n`);
  await until(() => heldProgress.length === 1, "the first build to be in flight");

  for (let index = 0; index < 1_001; index += 1) {
    commandStream!.write(`event: command\ndata: ${JSON.stringify({
      seq: index + 2,
      command: { type: "start-run", runId: `run_build_history_${index}` },
    })}\n\n`);
  }
  commandStream!.write(`event: command\ndata: ${JSON.stringify({
    seq: 1_003,
    command,
  })}\n\n`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const progressRequestsBeforeRelease = heldProgress.length;
  for (const response of heldProgress) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  }
  expect(progressRequestsBeforeRelease).toBe(1);
  commandStream?.end();
}, 15_000);

it("never reposts a successful build as failed when result transport rejects", async () => {
  const lab = await stubLab([]);
  lab.kernelEnvResult.failuresRemaining = 1;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const uvDir = stubUv("scanpy==1.9.0\n");

  await withStubUvOnPath(uvDir, async () => {
    subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send({
      type: "kernel-env-setup",
      runId: "envsetup_result_transport",
      name: "crispr",
      language: "python",
      manager: "uv",
      declarationGenerationId: fixtureGeneration("crispr"),
      packages: ["scanpy"],
    });

    await until(() => lab.kernelEnvResults.length > 0, "the rejected success report");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lab.kernelEnvResults).toHaveLength(1);
    expect(lab.kernelEnvResults[0]).toMatchObject({
      requestId: "envsetup_result_transport",
      name: "crispr",
      ok: true,
    });
  });
});

it("keeps the exact terminal spool after an acknowledgement conflict and removes it only after acceptance", async () => {
  const lab = await stubLab([]);
  lab.kernelEnvResult.conflictsRemaining = 1;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data, `${data}-work`);
  const uvDir = stubUv("scanpy==1.9.0\n");
  const command = {
    type: "kernel-env-setup",
    runId: "envsetup_result_conflict_spool",
    name: "crispr",
    language: "python",
    manager: "uv",
    lockfile: "scanpy==1.9.0\n",
    lockRevision: 7,
    requestedPackages: ["scanpy"],
    declarationGenerationId: "envgen_result_conflict_spool",
    declarationCreatedTs: 50,
  };

  await withStubUvOnPath(uvDir, async () => {
    subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send(command);
    await until(() => lab.kernelEnvResults.length === 1, "the conflicting acknowledgement");

    expect(lab.kernelEnvResults[0]).toMatchObject({
      requestId: command.runId,
      name: command.name,
      declarationGenerationId: command.declarationGenerationId,
      ok: true,
    });
    expect(environmentSetupOutcomeSpool(data).load()).toHaveLength(1);

    await until(() => lab.kernelEnvResults.length === 2, "the accepted exact retry");
    expect(lab.kernelEnvResults[1]).toEqual(lab.kernelEnvResults[0]);
    await until(
      () => environmentSetupOutcomeSpool(data).load().length === 0,
      "the exact accepted acknowledgement to remove the spool",
    );
  });
}, 10_000);

it("reposts the exact successful setup outcome after daemon restart without rematerializing", async () => {
  const lab = await stubLab([]);
  lab.kernelEnvResult.failuresRemaining = 1;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data, `${data}-work`);
  const invocationLog = join(envRoot(`${data}-work`, "crispr"), "stub-invocations");
  const uvDir = stubUv("scanpy==1.9.0\n", { invocationLog });
  const command = {
    type: "kernel-env-setup",
    runId: "envsetup_success_restart",
    name: "crispr",
    language: "python",
    manager: "uv",
    lockfile: "scanpy==1.9.0\n",
    lockRevision: 8,
    requestedPackages: ["scanpy"],
    declarationGenerationId: "envgen_success_restart",
    declarationCreatedTs: 51,
  };

  await withStubUvOnPath(uvDir, async () => {
    const first = subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the first command stream");
    lab.send(command);
    await until(() => lab.kernelEnvResults.length === 1, "the lost success result");
    for (let index = 0; index < 1_001; index += 1)
      lab.send({ type: "start-run", runId: `run_success_spool_history_${index}` });
    await first.stop();
    await until(() => !lab.commandConnected(), "the first daemon to disconnect");

    subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the restarted command stream");
    lab.send(command);
    await until(() => lab.kernelEnvResults.length === 2, "the exact success result to be reposted");

    expect(lab.kernelEnvResults[1]).toEqual(lab.kernelEnvResults[0]);
    expect(readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(2);
  });
}, 20_000);

it("reposts the exact failed setup outcome after daemon restart without rematerializing", async () => {
  const lab = await stubLab([]);
  lab.kernelEnvResult.failuresRemaining = 1;
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data, `${data}-work`);
  const invocationLog = join(envRoot(`${data}-work`, "crispr"), "stub-invocations");
  const uvDir = stubUv("scanpy==1.9.0\n", { invocationLog, failAt: "sync" });
  const command = {
    type: "kernel-env-setup",
    runId: "envsetup_failure_restart",
    name: "crispr",
    language: "python",
    manager: "uv",
    lockfile: "scanpy==1.9.0\n",
    lockRevision: 9,
    requestedPackages: ["scanpy"],
    declarationGenerationId: "envgen_failure_restart",
    declarationCreatedTs: 52,
  };

  await withStubUvOnPath(uvDir, async () => {
    const first = subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the first command stream");
    lab.send(command);
    await until(() => lab.kernelEnvResults.length === 1, "the lost failure result");
    expect(lab.kernelEnvResults[0]).toMatchObject({
      requestId: command.runId,
      name: command.name,
      ok: false,
    });
    for (let index = 0; index < 1_001; index += 1)
      lab.send({ type: "start-run", runId: `run_failure_spool_history_${index}` });
    await first.stop();
    await until(() => !lab.commandConnected(), "the first daemon to disconnect");

    subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the restarted command stream");
    lab.send(command);
    await until(() => lab.kernelEnvResults.length === 2, "the exact failure result to be reposted");

    expect(lab.kernelEnvResults[1]).toEqual(lab.kernelEnvResults[0]);
    expect(readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(2);
  });
}, 20_000);

it("fails a corrupt exact setup spool closed without provisioning or leaking its bytes", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data, `${data}-work`);
  const requestId = "envsetup_corrupt_restart";
  const generation = "envgen_corrupt_restart";
  const spool = environmentSetupOutcomeSpool(data);
  const corruptOutcome = {
    requestId,
    name: "crispr",
    declarationGenerationId: generation,
    result: { ok: false, name: "crispr", error: "original bounded result" },
  } as const;
  spool.begin(corruptOutcome);
  spool.complete(corruptOutcome);
  const spoolRoot = join(data, "environment-setup-outcomes");
  const corruptSecret = "truncated-spool-secret-must-not-leak";
  writeFileSync(
    join(spoolRoot, readdirSync(spoolRoot)[0]!),
    `{"version":1,"requestId":"${requestId}","secret":"${corruptSecret}`,
    { mode: 0o600 },
  );
  const invocationLog = join(data, "corrupt-spool-uv-invocations");
  const uvDir = stubUv("scanpy==1.9.0\n", { invocationLog });

  await withStubUvOnPath(uvDir, async () => {
    subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send({
      type: "kernel-env-setup",
      runId: requestId,
      name: "crispr",
      language: "python",
      manager: "uv",
      lockfile: "scanpy==1.9.0\n",
      lockRevision: 10,
      requestedPackages: ["scanpy"],
      declarationGenerationId: generation,
      declarationCreatedTs: 53,
    });

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(existsSync(invocationLog)).toBe(false);
    expect(lab.kernelEnvResults).toEqual([]);
    expect(JSON.stringify(lab.kernelEnvResults)).not.toContain(corruptSecret);
  });
});

it("does not call either provision phase when the initial exact journal write fails", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data, `${data}-work`);
  const invocationLog = join(data, "journal-failure-invocations");
  const uvDir = stubUv("scanpy==1.9.0\n", { invocationLog });
  const journal = environmentSetupOutcomeSpool(data);
  const refusingJournal = {
    ...journal,
    begin(): never {
      throw new Error("injected journal write failure");
    },
  };

  await withStubUvOnPath(uvDir, async () => {
    const runs = subsystem(lab.base, data, undefined, undefined, {
      environmentSetupJournal: refusingJournal,
    });
    await until(() => lab.commandConnected(), "the command stream");
    lab.send({
      type: "kernel-env-setup",
      runId: "envsetup_initial_journal_failure",
      name: "crispr",
      language: "python",
      manager: "uv",
      lockfile: "scanpy==1.9.0\n",
      lockRevision: 11,
      requestedPackages: ["scanpy"],
      declarationGenerationId: "envgen_initial_journal_failure",
    });

    await until(() => runs.lastFailure()?.includes("journal") === true, "the bounded journal diagnostic");
    expect(existsSync(invocationLog)).toBe(false);
    expect(journal.load()).toEqual([]);
    expect(lab.kernelEnvResults).toEqual([]);
  });
});

it("lets only the durable journal owner provision when two daemon processes receive the same request", async () => {
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data, `${data}-work`);
  const invocationLog = join(envRoot(`${data}-work`, "crispr"), "stub-invocations");
  const uvDir = stubUv("scanpy==1.9.0\n", { invocationLog });
  const streams: import("node:http").ServerResponse[] = [];
  const results: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/daemon/commands")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      streams.push(res);
      return;
    }
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      if (req.url === "/daemon/kernel-env/result")
        results.push(JSON.parse(body || "{}") as Record<string, unknown>);
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  servers.push(server);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const command = {
    type: "kernel-env-setup",
    runId: "envsetup_two_daemons_one_owner",
    name: "crispr",
    language: "python",
    manager: "uv",
    lockfile: "scanpy==1.9.0\n",
    lockRevision: 17,
    requestedPackages: ["scanpy"],
    declarationGenerationId: "envgen_two_daemons_one_owner",
  };

  await withStubUvOnPath(uvDir, async () => {
    const base = `http://127.0.0.1:${port}`;
    // Both process-local snapshots intentionally miss the other's just-created
    // record before `begin`; the filesystem O_EXCL claim, not a racy pre-read,
    // must still choose exactly one owner.
    const firstSpool = environmentSetupOutcomeSpool(data);
    const secondSpool = environmentSetupOutcomeSpool(data);
    const first = subsystem(base, data, undefined, undefined, {
      environmentSetupJournal: { ...firstSpool, hasRecord: () => false },
    });
    const second = subsystem(base, data, undefined, undefined, {
      environmentSetupJournal: { ...secondSpool, hasRecord: () => false },
    });
    await until(() => streams.length === 2, "both independent daemon command streams");
    for (const stream of streams)
      stream.write(`event: command\ndata: ${JSON.stringify({ seq: 1, command })}\n\n`);

    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const invocations = existsSync(invocationLog)
      ? readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean)
      : [];
    const failures = [first.lastFailure(), second.lastFailure()].filter(
      (failure): failure is string => failure !== undefined,
    );
    expect({ invocations: invocations.length, results: results.length }).toEqual({
      invocations: 2,
      results: 1,
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/quarantined/);
  });
}, 20_000);

it("does not promote an older same-generation marker for a new resolve request with package growth", async () => {
  for (const fixture of [
    { manager: "uv" as const, language: "python" as const, interpreter: "python3" },
    { manager: "conda" as const, language: "r" as const, interpreter: "Rscript" },
  ]) {
    const lab = await stubLab([]);
    const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
    dirs.push(data, `${data}-work`);
    const name = fixture.manager === "uv" ? "crispr" : "rstats";
    const generation = `envgen_package_growth_${fixture.manager}`;
    const root = envRoot(`${data}-work`, name);
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin", fixture.interpreter), "");
    writeFileSync(
      join(root, ".lykeion-env.json"),
      JSON.stringify({
        requestId: `envsetup_old_${fixture.manager}`,
        name,
        manager: fixture.manager,
        declarationGenerationId: generation,
        lockRevision: 22,
        lockfileFingerprint: "a".repeat(64),
        packageFingerprint: "b".repeat(64),
        packageCount: 1,
        version: fixture.manager === "uv" ? "3.12.7" : "4.4.1",
      }),
    );
    const requestId = `envsetup_new_${fixture.manager}`;
    const spool = environmentSetupOutcomeSpool(data);
    expect(spool.begin({ requestId, name, declarationGenerationId: generation }).role).toBe("owner");

    const runs = subsystem(lab.base, data);
    await until(() => lab.commandConnected(), `${fixture.manager}'s command stream`);
    lab.send({
      type: "kernel-env-setup",
      runId: requestId,
      name,
      language: fixture.language,
      manager: fixture.manager,
      declarationGenerationId: generation,
      packages: fixture.manager === "uv" ? ["scanpy", "numpy"] : ["jsonlite", "ggplot2"],
    });
    await until(
      () => lab.kernelEnvResults.length > 0 || runs.lastFailure() !== undefined,
      `${fixture.manager}'s recovery decision`,
    );

    expect(lab.kernelEnvResults).toEqual([]);
    expect(runs.lastFailure()).toMatch(/quarantined/);
    expect(spool.load()).toEqual([
      { requestId, name, declarationGenerationId: generation, state: "provisioning" },
    ]);
  }
});

it("reconciles an exact ready marker after a post-provision crash without a second provision call", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data, `${data}-work`);
  const invocationLog = join(envRoot(`${data}-work`, "crispr"), "stub-invocations");
  const uvDir = stubUv("scanpy==1.9.0\n", { invocationLog });
  const never = new Promise<void>(() => {});
  const command = {
    type: "kernel-env-setup",
    runId: "envsetup_crash_after_provision",
    name: "crispr",
    language: "python",
    manager: "uv",
    lockfile: "scanpy==1.9.0\n",
    lockRevision: 12,
    requestedPackages: ["scanpy"],
    declarationGenerationId: "envgen_crash_after_provision",
    declarationCreatedTs: 54,
  };

  await withStubUvOnPath(uvDir, async () => {
    const first = subsystem(lab.base, data, undefined, undefined, {
      environmentSetupCheckpoint: () => never,
    });
    await until(() => lab.commandConnected(), "the first command stream");
    lab.send(command);
    await until(
      () => existsSync(join(envRoot(`${data}-work`, "crispr"), ".lykeion-env.json")),
      "the exact ready marker before the crash checkpoint",
    );
    expect(environmentSetupOutcomeSpool(data).load()).toEqual([
      {
        requestId: command.runId,
        name: command.name,
        declarationGenerationId: command.declarationGenerationId,
        state: "provisioning",
      },
    ]);
    await first.stop();
    await until(() => !lab.commandConnected(), "the first daemon to disconnect");

    subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the restarted command stream");
    lab.send(command);
    await until(() => lab.kernelEnvResults.length === 1, "the marker-reconciled success");

    expect(lab.kernelEnvResults[0]).toMatchObject({
      requestId: command.runId,
      name: command.name,
      declarationGenerationId: command.declarationGenerationId,
      ok: true,
    });
    expect(readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(2);
  });
}, 20_000);

it("uses the same post-marker crash journal seam for conda without a second materialization", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data, `${data}-work`);
  const invocationLog = join(`${data}-work`, ".mamba-cache", "stub-invocations");
  const micromambaDir = stubMicromamba(invocationLog);
  const never = new Promise<void>(() => {});
  const command = {
    type: "kernel-env-setup",
    runId: "envsetup_conda_crash_after_provision",
    name: "rstats",
    language: "r",
    manager: "conda",
    lockfile:
      "@EXPLICIT\nhttps://conda.anaconda.org/conda-forge/osx-arm64/r-base-4.4.1.tar.bz2#0123456789abcdef0123456789abcdef\n",
    lockRevision: 15,
    requestedPackages: ["r-base"],
    declarationGenerationId: "envgen_conda_crash_after_provision",
    declarationCreatedTs: 57,
  };

  await withStubUvOnPath(micromambaDir, async () => {
    const first = subsystem(lab.base, data, undefined, undefined, {
      environmentSetupCheckpoint: () => never,
    });
    await until(() => lab.commandConnected(), "the first command stream");
    lab.send(command);
    await until(
      () => existsSync(join(envRoot(`${data}-work`, "rstats"), ".lykeion-env.json")),
      "the conda exact ready marker before the crash checkpoint",
    );
    expect(
      JSON.parse(
        readFileSync(join(envRoot(`${data}-work`, "rstats"), ".lykeion-env.json"), "utf8"),
      ),
    ).toMatchObject({
      schemaVersion: 2,
      requestId: command.runId,
      name: command.name,
      manager: command.manager,
      declarationGenerationId: command.declarationGenerationId,
      lockRevision: command.lockRevision,
      lockfileFingerprint: createHash("sha256").update(command.lockfile).digest("hex"),
      packageFingerprint: createHash("sha256")
        .update(JSON.stringify([...command.requestedPackages].sort()))
        .digest("hex"),
    });
    await first.stop();
    await until(() => !lab.commandConnected(), "the first daemon to disconnect");

    subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the restarted command stream");
    lab.send(command);
    await until(() => lab.kernelEnvResults.length === 1, "the conda marker-reconciled success");
    expect(lab.kernelEnvResults[0]).toMatchObject({
      requestId: command.runId,
      declarationGenerationId: command.declarationGenerationId,
      ok: true,
      status: { manager: "conda", language: "r", lockRevision: 15 },
    });
    expect(readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);
  });
}, 20_000);

it("reconciles an exact ready marker after terminal journal promotion fails without provisioning again", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data, `${data}-work`);
  const invocationLog = join(envRoot(`${data}-work`, "crispr"), "stub-invocations");
  const uvDir = stubUv("scanpy==1.9.0\n", { invocationLog });
  const journal = environmentSetupOutcomeSpool(data);
  const refusingJournal = {
    ...journal,
    complete(): never {
      throw new Error("injected terminal journal promotion failure");
    },
  };
  const command = {
    type: "kernel-env-setup",
    runId: "envsetup_success_terminal_write_failure",
    name: "crispr",
    language: "python",
    manager: "uv",
    lockfile: "scanpy==1.9.0\n",
    lockRevision: 14,
    requestedPackages: ["scanpy"],
    declarationGenerationId: "envgen_success_terminal_write_failure",
    declarationCreatedTs: 56,
  };

  await withStubUvOnPath(uvDir, async () => {
    const first = subsystem(lab.base, data, undefined, undefined, {
      environmentSetupJournal: refusingJournal,
    });
    await until(() => lab.commandConnected(), "the first command stream");
    lab.send(command);
    await until(
      () => first.lastFailure()?.includes("terminal environment setup outcome") === true,
      "the failed terminal promotion",
    );
    expect(journal.load()[0]?.state).toBe("provisioning");
    expect(lab.kernelEnvResults).toEqual([]);
    await first.stop();
    await until(() => !lab.commandConnected(), "the first daemon to disconnect");

    subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the restarted command stream");
    lab.send(command);
    await until(() => lab.kernelEnvResults.length === 1, "the reconciled success result");
    expect(lab.kernelEnvResults[0]).toMatchObject({
      requestId: command.runId,
      declarationGenerationId: command.declarationGenerationId,
      ok: true,
    });
    expect(readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(2);
  });
}, 20_000);

it("reposts a terminal claim left by a crash before main promotion without provisioning again", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data, `${data}-work`);
  const invocationLog = join(envRoot(`${data}-work`, "crispr"), "stub-invocations");
  const uvDir = stubUv("scanpy==1.9.0\n", { invocationLog });
  const crashingJournal = environmentSetupOutcomeSpool(data, {
    afterTerminalClaim() {
      throw new Error("injected crash after immutable terminal claim");
    },
  });
  const command = {
    type: "kernel-env-setup",
    runId: "envsetup_terminal_claim_crash",
    name: "crispr",
    language: "python",
    manager: "uv",
    lockfile: "scanpy==1.9.0\n",
    lockRevision: 16,
    requestedPackages: ["scanpy"],
    declarationGenerationId: "envgen_terminal_claim_crash",
    declarationCreatedTs: 58,
  };

  await withStubUvOnPath(uvDir, async () => {
    const first = subsystem(lab.base, data, undefined, undefined, {
      environmentSetupJournal: crashingJournal,
    });
    await until(() => lab.commandConnected(), "the first command stream");
    lab.send(command);
    await until(
      () => first.lastFailure()?.includes("terminal environment setup outcome") === true,
      "the crash after the terminal claim",
    );
    expect(crashingJournal.load()).toEqual([
      expect.objectContaining({
        requestId: command.runId,
        declarationGenerationId: command.declarationGenerationId,
        state: "terminal",
      }),
    ]);
    expect(lab.kernelEnvResults).toEqual([]);
    await first.stop();
    await until(() => !lab.commandConnected(), "the first daemon to disconnect");

    subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the restarted command stream");
    await until(() => lab.kernelEnvResults.length === 1, "the claimed terminal replay");
    expect(lab.kernelEnvResults[0]).toMatchObject({
      requestId: command.runId,
      declarationGenerationId: command.declarationGenerationId,
      ok: true,
    });
    expect(readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(2);
    await until(
      () => environmentSetupOutcomeSpool(data).hasRecord(command.runId) === false,
      "the exact claim acknowledgement",
    );
  });
}, 20_000);

it("converges restart cleanup after a crash following either acknowledgement unlink", async () => {
  for (const phase of ["main", "claim"] as const) {
    const lab = await stubLab([]);
    const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
    dirs.push(data, `${data}-work`);
    const invocationLog = join(envRoot(`${data}-work`, "crispr"), "stub-invocations");
    const uvDir = stubUv("scanpy==1.9.0\n", { invocationLog });
    let crashed = false;
    const journal = environmentSetupOutcomeSpool(data, {
      afterAckMainUnlink() {
        if (phase === "main" && !crashed) {
          crashed = true;
          throw new Error("injected crash after main acknowledgement unlink");
        }
      },
      afterAckClaimUnlink() {
        if (phase === "claim" && !crashed) {
          crashed = true;
          throw new Error("injected crash after claim acknowledgement unlink");
        }
      },
    });
    const command = {
      type: "kernel-env-setup",
      runId: `envsetup_ack_unlink_${phase}`,
      name: "crispr",
      language: "python",
      manager: "uv",
      lockfile: "scanpy==1.9.0\n",
      lockRevision: phase === "main" ? 18 : 19,
      requestedPackages: ["scanpy"],
      declarationGenerationId: `envgen_ack_unlink_${phase}`,
    };

    await withStubUvOnPath(uvDir, async () => {
      const first = subsystem(lab.base, data, undefined, undefined, {
        environmentSetupJournal: journal,
      });
      await until(() => lab.commandConnected(), `${phase}'s first command stream`);
      lab.send(command);
      await until(() => crashed, `${phase}'s injected acknowledgement crash`);
      expect(lab.kernelEnvResults).toHaveLength(1);
      await first.stop();
      await until(() => !lab.commandConnected(), `${phase}'s first daemon disconnect`);

      subsystem(lab.base, data);
      await until(() => lab.commandConnected(), `${phase}'s restarted command stream`);
      if (phase === "main")
        await until(() => lab.kernelEnvResults.length === 2, "the claim-only exact repost");
      else
        await new Promise((resolve) => setTimeout(resolve, 500));
      await until(
        () => environmentSetupOutcomeSpool(data).hasRecord(command.runId) === false,
        `${phase}'s acknowledged cleanup`,
      );
      expect(lab.kernelEnvResults).toHaveLength(phase === "main" ? 2 : 1);
      expect(readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(2);
    });
  }
}, 20_000);

it("keeps a terminal-write failure without an exact ready marker quarantined after restart", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data, `${data}-work`);
  const invocationLog = join(envRoot(`${data}-work`, "crispr"), "stub-invocations");
  const uvDir = stubUv("scanpy==1.9.0\n", { invocationLog, failAt: "sync" });
  const journal = environmentSetupOutcomeSpool(data);
  const refusingJournal = {
    ...journal,
    complete(): never {
      throw new Error("injected terminal journal write failure");
    },
  };
  const command = {
    type: "kernel-env-setup",
    runId: "envsetup_terminal_write_failure",
    name: "crispr",
    language: "python",
    manager: "uv",
    lockfile: "scanpy==1.9.0\n",
    lockRevision: 13,
    requestedPackages: ["scanpy"],
    declarationGenerationId: "envgen_terminal_write_failure",
    declarationCreatedTs: 55,
  };

  await withStubUvOnPath(uvDir, async () => {
    const first = subsystem(lab.base, data, undefined, undefined, {
      environmentSetupJournal: refusingJournal,
    });
    await until(() => lab.commandConnected(), "the first command stream");
    lab.send(command);
    await until(
      () => first.lastFailure()?.includes("terminal environment setup outcome") === true,
      "the terminal write diagnostic",
    );
    expect(environmentSetupOutcomeSpool(data).load()).toEqual([
      {
        requestId: command.runId,
        name: command.name,
        declarationGenerationId: command.declarationGenerationId,
        state: "provisioning",
      },
    ]);
    await first.stop();
    await until(() => !lab.commandConnected(), "the first daemon to disconnect");

    const restarted = subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the restarted command stream");
    lab.send(command);
    await until(
      () => restarted.lastFailure()?.includes("quarantined") === true,
      "the unresolved provisioning quarantine",
    );

    expect(lab.kernelEnvResults).toEqual([]);
    expect(readFileSync(invocationLog, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(2);
    expect(environmentSetupOutcomeSpool(data).load()[0]?.state).toBe("provisioning");
  });
}, 20_000);

it("materializes from the lockfile a command already carries, and never resolves — D4's whole point", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  // A lockfile shaped nothing like whatever a resolve would have produced —
  // if this machine resolved instead of replaying, the marker below would
  // carry a package count this text does not.
  const uvDir = stubUv("this-must-never-be-resolved==0.0.0\n");

  await withStubUvOnPath(uvDir, async () => {
    subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the command stream");

    lab.send({
      type: "kernel-env-setup",
      runId: "envsetup_2",
      name: "crispr",
      language: "python",
      manager: "uv",
      lockfile: "onlyone==1.0.0\n",
      lockRevision: 5,
      requestedPackages: ["onlyone"],
      declarationGenerationId: "envgen_exact_command",
      declarationCreatedTs: 41,
    });

    await until(() => lab.kernelEnvResults.length > 0, "the setup's own result reaching the lab");
    // The observable proof: nothing here ever asked the lab for a revision,
    // which is the only thing a resolve would have done.
    expect(lab.kernelEnvLocks).toEqual([]);
    const result = lab.kernelEnvResults[0]!;
    expect(result.ok).toBe(true);
    const status = result.status as {
      state: string;
      lockRevision: number;
      declarationGenerationId: string;
      declarationCreatedTs: number;
      packageCount: number;
    };
    // Carried straight through from the command, not derived.
    expect(status.lockRevision).toBe(5);
    expect(status.declarationGenerationId).toBe("envgen_exact_command");
    expect(status.declarationCreatedTs).toBe(41);
    // Built from the ONE package the given lockfile actually named.
    expect(status.packageCount).toBe(1);
  });
});

it("reports failure rather than hanging the lab's wait when materializing fails", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const emptyBin = mkdtempSync(join(tmpdir(), "lyk-runs-broken-uv-"));
  dirs.push(emptyBin);
  // PATH replaced outright, not merely prepended — `uv` must be genuinely
  // unreachable, not just shadowed by an empty directory ahead of a real
  // install this machine happens to have. `runConfinedIn` then fails fast,
  // with no network involved, before it ever gets near `venv`/`pip`.
  const original = process.env.PATH;
  process.env.PATH = emptyBin;

  try {
    subsystem(lab.base, data);
    await until(() => lab.commandConnected(), "the command stream");

    lab.send({
      type: "kernel-env-setup",
      runId: "envsetup_3",
      name: "crispr",
      language: "python",
      manager: "uv",
      declarationGenerationId: fixtureGeneration("crispr"),
      packages: ["scanpy"],
    });

    await until(() => lab.kernelEnvResults.length > 0, "the setup's own result reaching the lab");
    const result = lab.kernelEnvResults[0]!;
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    // Nothing was ever resolved, so nothing was ever handed to the lab to
    // write down — a failed setup pins nothing.
    expect(lab.kernelEnvLocks).toEqual([]);
  } finally {
    process.env.PATH = original;
  }
});

it("frees this machine's own copy of an environment on kernel-env-reclaim", async () => {
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  const root = envRoot(workDir, "crispr");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "python3"), "");

  subsystem(lab.base, data);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({ type: "kernel-env-reclaim", runId: "envreclaim_1", name: "crispr" });

  await until(() => !existsSync(root), "this machine's own copy being removed");
  expect(existsSync(root)).toBe(false);
});

it("refuses a kernel-env-setup command carrying no name, rather than leaving the lab waiting on it", async () => {
  // The lab's durable record of this build stays non-terminal until a result
  // settles it, and nothing else ever will — so returning silently here would
  // leave a researcher watching a Setup that was never going to finish.
  // Answered, never dropped, for the reason the kernel host's own loop answers
  // a method it does not know: a request with no reply reads as a hung machine
  // rather than a refused message.
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  subsystem(lab.base, data);
  await until(() => lab.commandConnected(), "the command stream");

  lab.send({ type: "kernel-env-setup", runId: "envsetup_4" });

  await until(() => lab.kernelEnvResults.length === 1, "the refusal");
  expect(lab.kernelEnvResults[0]!.requestId).toBe("envsetup_4");
  expect(lab.kernelEnvResults[0]!.ok).toBe(false);
  // Nothing was built and nothing was pinned on the way to refusing.
  expect(lab.kernelEnvLocks).toEqual([]);
});

/** A `crispr` this lab has declared and no machine has built yet — the state
 *  the whole Setup flow starts from. */
const CRISPR_DECLARED = {
  name: "crispr",
  language: "python",
  manager: "uv",
  packages: ["scanpy"],
  createdTs: 2,
  lockRevision: 3,
  declarationGenerationId: fixtureGeneration("crispr"),
};

/** The command the lab sends when a researcher clicks Setup on a refusal, in
 *  its replay shape — the lockfile is already pinned, so nothing here
 *  resolves and no network is involved. */
const setupCrispr = (runId: string) => ({
  type: "kernel-env-setup",
  runId,
  name: "crispr",
  language: "python",
  manager: "uv",
  lockfile: "onlyone==1.0.0\n",
  lockRevision: 3,
  requestedPackages: ["onlyone"],
  declarationGenerationId: fixtureGeneration("crispr"),
});

it("restarts the rebuilt environment's kernels once the build has succeeded, and says why", async () => {
  // `materializeEnvironment` runs `uv venv --clear`, which removes everything
  // already at the target path — so a kernel still running against a rebuilt
  // environment is a process whose interpreter and site-packages have been
  // deleted out from under it. The restart is correctness, not courtesy, and
  // the reason is what keeps a namespace from vanishing silently.
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  dirs.push(`${data}-work`);
  const uvDir = stubUv("onlyone==1.0.0\n");
  const kernels = stubKernelHost(0);

  await withStubUvOnPath(uvDir, async () => {
    subsystem(lab.base, data, () => kernels.host);
    await until(() => lab.commandConnected(), "the command stream");

    lab.send({ ...setupCrispr("envsetup_restart"), reason: "scanpy was added to crispr" });
    await until(() => lab.kernelEnvResults.length > 0, "the build's own result");

    expect(lab.kernelEnvResults[0]!.ok).toBe(true);
    expect(kernels.environmentRestarts).toEqual([
      { name: "crispr", reason: "scanpy was added to crispr" },
    ]);
    // Before the result, and after the boundary. The result unblocks whoever
    // is waiting on the build; a kernel relaunched ahead of the re-described
    // boundary would be started inside the map the session was opened with.
    expect(kernels.asked.indexOf("kernel.restart_environment")).toBeGreaterThan(
      kernels.asked.indexOf("kernel.configure_session"),
    );
  });
});

it("restarts nothing when the build failed", async () => {
  // A build that failed left the previous environment where it was. Ending
  // healthy kernels over it would turn a failed install into lost work — the
  // researcher would have their namespace taken to make room for software
  // that never arrived.
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const emptyBin = mkdtempSync(join(tmpdir(), "lyk-runs-no-uv-"));
  dirs.push(emptyBin);
  const kernels = stubKernelHost(0);
  // PATH replaced outright so `uv` is genuinely unreachable and the
  // materialize fails fast, with no network involved.
  const original = process.env.PATH;
  process.env.PATH = emptyBin;

  try {
    subsystem(lab.base, data, () => kernels.host);
    await until(() => lab.commandConnected(), "the command stream");

    lab.send({ ...setupCrispr("envsetup_failed"), reason: "scanpy was added to crispr" });
    await until(() => lab.kernelEnvResults.length > 0, "the build's own result");

    expect(lab.kernelEnvResults[0]!.ok).toBe(false);
    expect(kernels.environmentRestarts).toEqual([]);
  } finally {
    process.env.PATH = original;
  }
});

it("restarts a rebuilt environment's kernels even when nobody gave a reason", async () => {
  // A researcher's own Setup click carries no sentence — they are looking at
  // the button they pressed. What it does NOT carry is a reason to skip the
  // restart: the directory was cleared whoever asked for the build.
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  dirs.push(`${data}-work`);
  const uvDir = stubUv("onlyone==1.0.0\n");
  const kernels = stubKernelHost(0);

  await withStubUvOnPath(uvDir, async () => {
    subsystem(lab.base, data, () => kernels.host);
    await until(() => lab.commandConnected(), "the command stream");

    lab.send(setupCrispr("envsetup_no_reason"));
    await until(() => lab.kernelEnvResults.length > 0, "the build's own result");

    // Named, and with no sentence invented for it.
    expect(kernels.environmentRestarts).toEqual([{ name: "crispr" }]);
  });
});

it("tells a session already open about an environment built underneath it, over the same bridge", async () => {
  // The step the whole phase turns on. The refusal a researcher clicks Setup
  // on arrives inside a session that is already open, and `configure_session`
  // is otherwise sent once, when that session is created — so without this
  // the very next cell is refused again, naming an environment this machine
  // finished building seconds ago, and the only remedy is retiring the
  // session and the notebook state the build existed to serve.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    CRISPR_DECLARED,
    // A row in a language this machine does not run, carried through both
    // configures. The guard that drops it lives in ONE computation, shared by
    // the session's own configure and this re-configure; a second copy of
    // that computation is exactly what would let an `r` row reach the host on
    // the re-send and cost the session every kernel it has.
    { name: "tidyverse", language: "r", manager: "uv", packages: [], createdTs: 3, lockRevision: 1 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  const uvDir = stubUv("onlyone==1.0.0\n");
  // 400ms per boundary, which is what makes the ORDER observable below: a
  // result posted before the re-configure had landed would arrive with only
  // one landing recorded.
  const kernels = stubKernelHost(400);

  await withStubUvOnPath(uvDir, async () => {
    const r = subsystem(lab.base, data, () => kernels.host);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send(startRunOn("run_mid_session"));
    // The session is genuinely installed, not merely configured: the handle
    // that re-sends its boundary is filed at the same line the session is.
    await until(() => r.liveSessionDirs().length > 0, "the session opening");
    const first = kernels.configurations[0]! as {
      token: string; socket: string; session_id: string;
      environments: Array<{ name: string }>;
    };
    // Declared lab-wide, absent from this machine — the state that produces
    // "not built on this machine yet".
    expect(first.environments.map((entry) => entry.name)).toEqual(["python"]);

    lab.send(setupCrispr("envsetup_mid"));
    await until(() => lab.kernelEnvResults.length > 0, "the build's own result");

    expect(lab.kernelEnvResults[0]!.ok).toBe(true);
    // A SECOND boundary, for the session that was already open.
    expect(kernels.configurations.length).toBe(2);
    const second = kernels.configurations[1]! as {
      token: string; socket: string; session_id: string; declared?: string[];
      environments: Array<{ name: string }>;
    };
    expect(second.session_id).toBe("se_1");
    expect(second.environments.map((entry) => entry.name).sort()).toEqual(["crispr", "python"]);
    // The same bridge, not a new one. A fresh token or socket would leave the
    // session's kernels talking over a relay the host no longer answers for.
    expect(second.token).toBe(first.token);
    expect(second.socket).toBe(first.socket);
    // Recomputed by the same code the first configure used, `r` row and all.
    expect(second.declared).toEqual(["crispr", "tidyverse"]);
    // And it had LANDED before the lab was told the build was done — the
    // result is what unblocks the researcher's next cell.
    expect(kernels.asked.filter((entry) => entry === "the boundary landed").length).toBe(2);
  });
});

it("still tells the lab a build succeeded when the host will not take the new boundary", async () => {
  // The build did succeed. The lab is holding a researcher's Setup open on
  // hearing so, and a host that will not take the news is not a reason to
  // report a failure that did not happen — it costs that session a restart,
  // and nothing else.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [CRISPR_DECLARED];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  const uvDir = stubUv("onlyone==1.0.0\n");
  const kernels = stubKernelHost(0);

  await withStubUvOnPath(uvDir, async () => {
    const r = subsystem(lab.base, data, () => kernels.host);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send(startRunOn("run_refused_reconfigure"));
    await until(() => r.liveSessionDirs().length > 0, "the session opening");
    // Only after the session has its own boundary: what fails here is the
    // re-send, not the session.
    kernels.refuseConfigures();

    lab.send(setupCrispr("envsetup_refused"));
    await until(() => lab.kernelEnvResults.length > 0, "the build's own result");

    expect(lab.kernelEnvResults[0]!.ok).toBe(true);
    expect(lab.kernelEnvResults[0]!.requestId).toBe("envsetup_refused");
    // The environment really is on disk, which is what the lab was told.
    expect(existsSync(join(envRoot(workDir, "crispr"), "bin", "python3"))).toBe(true);
    // A boundary really was TENDERED and really was refused. Without this the
    // test is green in a world where the re-send does not exist at all: the
    // host throws before recording, so `configurations.length === 1` and
    // `ok === true` both hold whether the build re-configured anything or
    // nothing. `asked` is pushed before the refusal, so it is the only thing
    // here that can tell "refused" from "never attempted".
    expect(kernels.asked.filter((m) => m === "kernel.configure_session").length).toBe(2);
    // And the re-send really did fail: one boundary ever landed.
    expect(kernels.configurations.length).toBe(1);
  });
});

it("re-configures the session that survived a revert and not the one that ended", async () => {
  // TWO sessions, and only one of them ends. With one, "the ended session was
  // skipped" and "nothing was re-configured at all" are the same observation,
  // and the second is a subsystem that does not work — so the surviving
  // session is what makes the skip discriminating. It also pins the other
  // half: a session whose own cell asked for nothing is told anyway, because
  // an environment is a fact about the machine rather than about the session
  // that clicked Setup.
  //
  // The handle that re-sends a boundary lives and dies with its session. One
  // left behind would describe a session to a host that has forgotten it,
  // every time any environment on this machine is built, for as long as this
  // daemon runs.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [CRISPR_DECLARED];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  const uvDir = stubUv("onlyone==1.0.0\n");
  const kernels = stubKernelHost(0);

  await withStubUvOnPath(uvDir, async () => {
    const r = subsystem(lab.base, data, () => kernels.host);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send(startRunOn("run_ended_session", "se_1"));
    await until(() => r.liveSessionDirs().length === 1, "the first session opening");
    lab.send(startRunOn("run_surviving_session", "se_2"));
    await until(() => r.liveSessionDirs().length === 2, "the second session opening");
    expect(kernels.configurations.length).toBe(2);

    // A revert ends the session outright — the child is closed and nothing
    // on this machine holds it any more.
    lab.send({
      type: "revert",
      runId: "run_ended_session",
      studyId: "s_cmp",
      taskId: "t_cmp",
      sessionId: "se_1",
    });
    await until(() => r.liveSessionDirs().length === 1, "the first session ending");

    lab.send(setupCrispr("envsetup_ended"));
    await until(() => lab.kernelEnvResults.length > 0, "the build's own result");

    expect(lab.kernelEnvResults[0]!.ok).toBe(true);
    // Exactly one further boundary, and it is the survivor's.
    expect(kernels.configurations.length).toBe(3);
    const third = kernels.configurations[2]! as {
      session_id: string;
      environments: Array<{ name: string }>;
    };
    expect(third.session_id).toBe("se_2");
    expect(third.environments.map((entry) => entry.name).sort()).toEqual(["crispr", "python"]);
    // Nothing named `se_1` a second time: the only boundary this host was
    // ever handed for it is the one it was opened with.
    expect(
      kernels.configurations.filter((entry) => entry.session_id === "se_1").length,
    ).toBe(1);
  });
});

it("tells the rest of this machine's sessions even when one of them will not be told", async () => {
  // The failure class six fix rounds on this branch were about: one entry of
  // a loop failing and taking the rest of the loop with it. Here `se_1`'s
  // host refuses its boundary and `se_2`'s does not, and `se_2` must still
  // end up describing the environment that was just built — with the lab told
  // the build succeeded, because it did.
  //
  // The refusal is also the only thing the per-session catch is FOR once the
  // re-sends are settled together: `Promise.allSettled` is what keeps one
  // rejection off the others, and the catch is what says whose it was. So
  // stderr is asserted, since a failure nobody can attribute to a session is
  // a restart nobody knows to perform.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [CRISPR_DECLARED];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  const uvDir = stubUv("onlyone==1.0.0\n");
  const kernels = stubKernelHost(0);
  const said: string[] = [];

  await withStubUvOnPath(uvDir, async () => {
    const r = subsystem(lab.base, data, () => kernels.host);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send(startRunOn("run_refused_one", "se_1"));
    await until(() => r.liveSessionDirs().length === 1, "the first session opening");
    lab.send(startRunOn("run_told_one", "se_2"));
    await until(() => r.liveSessionDirs().length === 2, "the second session opening");
    expect(kernels.configurations.length).toBe(2);

    // Only after both sessions have their own boundary: what fails here is
    // one re-send, not one session.
    kernels.refuseConfiguresFor("se_1");

    const reporting = console.error;
    console.error = (line: unknown) => said.push(String(line));
    try {
      lab.send(setupCrispr("envsetup_one_refused"));
      await until(() => lab.kernelEnvResults.length > 0, "the build's own result");
    } finally {
      console.error = reporting;
    }

    // The build succeeded and the lab hears so.
    expect(lab.kernelEnvResults[0]!.ok).toBe(true);
    // `se_2` was told, even though `se_1`'s attempt raised.
    const forSecond = kernels.configurations.filter((entry) => entry.session_id === "se_2");
    expect(forSecond.length).toBe(2);
    expect(
      (forSecond[1]! as { environments: Array<{ name: string }> }).environments
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["crispr", "python"]);
    // `se_1` was not, and nothing pretended otherwise: exactly the two initial
    // boundaries plus the survivor's re-send ever landed.
    expect(kernels.configurations.filter((entry) => entry.session_id === "se_1").length).toBe(1);
    // And the researcher on `se_1` is findable — named, with what it costs
    // them. An unattributed failure is a restart nobody knows to perform.
    expect(
      said.some((line) => line.includes("se_1") && line.includes("crispr") && line.includes("restart")),
    ).toBe(true);
    // And ONLY that researcher. `some` above is satisfied by an
    // implementation that says the same sentence about every open session,
    // including the ones that were told perfectly well — and an attribution
    // that names everybody attributes nothing: it sends a researcher whose
    // session is fine off to restart it and lose the notebook state this
    // whole path exists to keep.
    expect(said.filter((line) => line.includes("se_2")).length).toBe(0);
  });
});

it("stops offering a reclaimed environment to a session that is already open", async () => {
  // The mirror of the build, and worse. `identity_for` resolves a cell's
  // environment name against the map its session was confined with and never
  // asks the filesystem — so a session still holding an entry for an
  // environment this machine has just deleted mints a kernel and execs an
  // interpreter that is not there. An environment that was never built at
  // least refuses in a sentence the researcher can act on; this one fails to
  // launch with nothing useful said.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [CRISPR_DECLARED];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  const uvDir = stubUv("onlyone==1.0.0\n");
  const kernels = stubKernelHost(0);

  await withStubUvOnPath(uvDir, async () => {
    const r = subsystem(lab.base, data, () => kernels.host);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send(startRunOn("run_reclaimed_under"));
    await until(() => r.liveSessionDirs().length > 0, "the session opening");

    // Built first, so what the reclaim takes away is something this session
    // is genuinely being offered rather than something it never had.
    lab.send(setupCrispr("envsetup_before_reclaim"));
    await until(() => lab.kernelEnvResults.length > 0, "the build's own result");
    expect(kernels.configurations.length).toBe(2);
    const built = kernels.configurations[1]! as {
      token: string;
      socket: string;
      environments: Array<{ name: string }>;
    };
    expect(built.environments.map((entry) => entry.name).sort()).toEqual(["crispr", "python"]);

    lab.send({ type: "kernel-env-reclaim", runId: "envreclaim_mid", name: "crispr" });
    await until(() => !existsSync(envRoot(workDir, "crispr")), "this machine's own copy going");
    // A reclaim answers nothing back to the lab, so the boundary is the only
    // thing there is to wait on.
    await until(() => kernels.configurations.length === 3, "the session hearing about it");

    const third = kernels.configurations[2]! as {
      token: string;
      socket: string;
      session_id: string;
      declared?: string[];
      environments: Array<{ name: string }>;
    };
    expect(third.session_id).toBe("se_1");
    // Gone from what the session is offered — so the next cell naming it is
    // refused by name rather than handed a path that is not on disk.
    expect(third.environments.map((entry) => entry.name)).toEqual(["python"]);
    // Still DECLARED, which is what makes that refusal the honest sentence
    // ("not built on this machine yet") rather than "no such environment".
    expect(third.declared).toEqual(["crispr"]);
    // Over the same bridge the session's kernels already talk on.
    expect(third.token).toBe(built.token);
    expect(third.socket).toBe(built.socket);
  });
  // Longer than the 5s default, because a reclaim answers the lab nothing:
  // the only way to observe it not happening is `until` running out, and
  // that budget has to fit INSIDE the test's own or the failure arrives as a
  // bare timeout instead of naming what never happened.
}, 15_000);

it("leaves a session confined by the reclaim when a reclaim and a build re-send at once", async () => {
  // Two callers reach the re-send now, and each reads this machine's disk on
  // its own account. A reclaim arriving while a build's re-send is still in
  // flight hands the SAME session two boundaries built from two different
  // moments, and unserialised the one the host answers last is what that
  // session is left confined by. If that is the build's — read while the
  // copy was still there — the session goes on offering an environment this
  // machine has just deleted, and the next cell naming it execs an
  // interpreter that is gone. Precisely the state the reclaim's re-send
  // exists to prevent, reached by a race rather than by a missing loop.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [CRISPR_DECLARED];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  const uvDir = stubUv("onlyone==1.0.0\n");
  const kernels = stubKernelHost(0);

  await withStubUvOnPath(uvDir, async () => {
    const r = subsystem(lab.base, data, () => kernels.host);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send(startRunOn("run_raced_retells"));
    await until(() => r.liveSessionDirs().length > 0, "the session opening");

    // Armed on `crispr`, which the session's own boundary cannot name — it
    // is declared and not built — so the one thing this holds is the build's
    // re-send, and it holds it AFTER that re-send has read the copy off the
    // disk and BEFORE the host is told about it. That gap is the race.
    kernels.holdBoundariesNaming("crispr");
    lab.send(setupCrispr("envsetup_raced"));
    await until(() => kernels.heldEntries === 1, "the build's re-send reaching the host");

    // The reclaim, while that re-send is in the air. Deleting the copy is not
    // part of the re-send, so it happens on either shape.
    lab.send({ type: "kernel-env-reclaim", runId: "envreclaim_raced", name: "crispr" });
    await until(() => !existsSync(envRoot(workDir, "crispr")), "this machine's own copy going");

    // Room for the reclaim's own re-send to overtake the held one, which is
    // what unserialised code does here in a few milliseconds. Not an
    // assertion and not a timing claim: nothing below requires it to have
    // happened, and serialised it cannot happen at all. It is only how long
    // the race is given to show itself before the held boundary is let go.
    for (let i = 0; i < 100 && kernels.configurations.length < 2; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    kernels.releaseHeld();

    await until(() => kernels.configurations.length === 3, "both re-sends landing");
    await until(() => lab.kernelEnvResults.length > 0, "the build's own result");

    const last = kernels.configurations[2]! as {
      session_id: string;
      declared?: string[];
      environments: Array<{ name: string }>;
    };
    expect(last.session_id).toBe("se_1");
    // Whichever of the two was started first, the boundary this session is
    // LEFT with does not offer what this machine no longer has.
    expect(last.environments.map((entry) => entry.name)).toEqual(["python"]);
    // And it is still declared, so the cell that names it is refused in the
    // sentence a researcher can act on.
    expect(last.declared).toEqual(["crispr"]);
    // The build itself still succeeded, because it did — the reclaim took
    // its copy away afterwards, which is not the build failing.
    expect(lab.kernelEnvResults[0]!.ok).toBe(true);
  });
  // The window above is a second of it, and the fixture is already ~3.5s.
}, 20_000);

it("names the sessions left unheard when this machine's kernel host goes quiet", async () => {
  // A host that is alive and answering nothing is the one case the
  // per-session catch cannot report. `host.call` has no timeout of its own —
  // a call is settled by a reply or by the host dying and by nothing else
  // (`call`, kernel-host.ts) — so that task never settles, its catch never
  // runs, and the deadline over the whole set is the only thing that will
  // ever speak. If it speaks generically, the researcher owed a restart
  // cannot be found from the log at all.
  //
  // `se_1` is held forever and `se_2` is refused outright, so both branches
  // report in one run: the refusal through the per-session catch, the silence
  // through the deadline. Each session named ONCE — a deadline that re-named
  // the session it already heard about would be telling a researcher whose
  // kernels are fine to throw away their notebook state.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [CRISPR_DECLARED];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  const uvDir = stubUv("onlyone==1.0.0\n");
  const kernels = stubKernelHost(0);
  const said: string[] = [];

  await withStubUvOnPath(uvDir, async () => {
    // Small enough that a host which never answers is observed inside this
    // test rather than 90s after it. The assertions below are about what was
    // SAID, not about when.
    const r = subsystem(lab.base, data, () => kernels.host, 2_000);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send(startRunOn("run_quiet_host", "se_1"));
    await until(() => r.liveSessionDirs().length === 1, "the first session opening");
    lab.send(startRunOn("run_refused_host", "se_2"));
    await until(() => r.liveSessionDirs().length === 2, "the second session opening");

    // Both only after each session has its own boundary: what goes wrong here
    // is the re-send, not the session. The refusal is checked before the
    // hold, so `se_2` never reaches it.
    kernels.holdBoundariesNaming("crispr");
    kernels.refuseConfiguresFor("se_2");

    const reporting = console.error;
    console.error = (line: unknown) => said.push(String(line));
    try {
      lab.send(setupCrispr("envsetup_quiet"));
      await until(() => lab.kernelEnvResults.length > 0, "the build's own result");
    } finally {
      console.error = reporting;
      kernels.releaseHeld();
    }

    // The build succeeded and the lab still hears so, on the deadline path
    // exactly as on the refusal path.
    expect(lab.kernelEnvResults[0]!.ok).toBe(true);
    // The held session is named — by the deadline, since nothing else can.
    const forHeld = said.filter((line) => line.includes("se_1"));
    expect(forHeld.length).toBe(1);
    expect(forHeld[0]!).toContain("crispr");
    expect(forHeld[0]!).toContain("restart");
    // The refused one is named once, by its own catch, and NOT a second time
    // by the deadline: it settled, and the deadline speaks only for what did
    // not.
    expect(said.filter((line) => line.includes("se_2")).length).toBe(1);
  });
}, 20_000);

it("sends this machine's open sessions their new boundary together, not one after another", async () => {
  // The concurrency itself, pinned by an outcome with no clock in it. This
  // host takes a boundary and then answers NOTHING until a second one has
  // arrived: two re-sends dispatched together release each other, and two
  // sent one after another cannot — the first is never answered, the single
  // deadline over the whole set fires, and the second is never even started.
  // Four boundaries or three.
  //
  // What it buys: each re-send costs a `host.hello`, a lab declarations
  // fetch and, against a host that will not answer, up to a whole
  // KERNEL_REACH_MS — and a researcher whose build has already finished
  // waits through every one of them before the lab is told.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [CRISPR_DECLARED];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  const uvDir = stubUv("onlyone==1.0.0\n");
  const kernels = stubKernelHost(0);

  await withStubUvOnPath(uvDir, async () => {
    // A ceiling of this fixture's own, because the serial shape has to be
    // able to GIVE UP for the test to see what it did — 90s of the real one
    // would arrive as the suite's own timeout instead. Nothing asserts on
    // it; the concurrent shape never reaches it.
    const r = subsystem(lab.base, data, () => kernels.host, 3_000);
    await until(() => lab.commandConnected(), "the command stream");
    lab.send(startRunOn("run_together_one", "se_1"));
    await until(() => r.liveSessionDirs().length === 1, "the first session opening");
    lab.send(startRunOn("run_together_two", "se_2"));
    await until(() => r.liveSessionDirs().length === 2, "the second session opening");
    expect(kernels.configurations.length).toBe(2);

    // Armed only now: a session's OWN boundary has to be answered for it to
    // open at all, and those two arrive one after another by construction.
    kernels.barrierAt(2);

    lab.send(setupCrispr("envsetup_together"));
    await until(() => lab.kernelEnvResults.length > 0, "the build's own result");

    expect(lab.kernelEnvResults[0]!.ok).toBe(true);
    // Both were told. One after another, `se_1`'s re-send would still be
    // waiting on a host that will not answer until a second arrives, the
    // aggregate deadline would have fired, and this would be 3.
    expect(kernels.configurations.length).toBe(4);
    expect(
      kernels.configurations.slice(2).map((entry) => entry.session_id).sort(),
    ).toEqual(["se_1", "se_2"]);
  });
}, 20_000);

/**
 * An agent asking for an environment, and a researcher answering.
 *
 * The one thing on this wire that travels host → daemon → researcher → lab,
 * so every one of these drives it end to end: the ask arrives the way the
 * real host writes one, the card goes out to the lab as a frame, the
 * decision comes back down the command stream, and what is asserted is what
 * the lab was — or was not — asked to declare.
 */

/** Every permission card this machine has published, in order. */
function cardsOf(lab: {
  events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }>;
  // The whole request, not just its id. The narrower annotation this
  // replaced described less than the value it returns, so a test wanting to
  // assert what a card actually ASKS had to reach past the helper.
}): PermissionRequest[] {
  return lab.events
    .flatMap((post) => post.frames)
    .map((frame) => frame.event)
    .filter(
      (event): event is Extract<RunEvent, { event: "permission-card" }> =>
        event.event === "permission-card",
    )
    .map((event) => event.request);
}

/**
 * Whether this run has reached the state a turn publishes the instant its
 * prompt is sent — which is also the instant its session is in
 * `liveSessions`, and therefore the first moment an ask naming that session
 * can find one. Waited on rather than the boundary landing, which happens a
 * whole session-creation earlier.
 */
function turnStarted(
  lab: { events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }> },
  runId: string,
): boolean {
  return lab.events
    .filter((post) => post.runId === runId)
    .flatMap((post) => post.frames)
    .map((frame) => frame.event)
    .some((event) => event.event === "state" && event.state.state === "planning");
}

/** A turn that stays in flight for as long as one of these tests needs, so
 *  the session raising a card is the session a decision can still reach. */
const HOLD_THE_TURN_OPEN = JSON.stringify([{ sleep: 5000 }, { endTurn: "end_turn" }]);

function decideOn(runId: string, requestId: string, decision: unknown) {
  return { type: "decision", runId, decision: { action: "permission", requestId, decision } };
}

it("refuses to create an environment for a session this machine is not running", async () => {
  // No live session, no card — and a refusal rather than a silent allow.
  // Consent nobody was asked for is not consent, and this is the shape that
  // arrives when a host names a session that ended underneath it.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_none"));
  await until(() => turnStarted(lab, "run_env_none"), "the turn starting");

  await expect(
    kernels.ask("environment.create", {
      session_id: "se_gone",
      name: "crispr",
      packages: ["scanpy"],
    }),
  ).rejects.toThrow(/se_gone/);
  expect(lab.kernelEnvCreates).toEqual([]);
  expect(cardsOf(lab)).toEqual([]);
});

it("records a non-mutating environment requirement for the exact live source run", async () => {
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_require"));
  await until(() => turnStarted(lab, "run_env_require"), "the turn starting");

  await expect(
    kernels.ask("environment.require", { session_id: "se_1", name: "atacseq" }),
  ).resolves.toEqual({ waiterId: "wait_1" });

  expect(lab.kernelEnvRequirements).toEqual([
    {
      runId: "run_env_require",
      sessionId: "se_1",
      environmentName: "atacseq",
    },
  ]);
  expect(cardsOf(lab)).toEqual([]);
  expect(lab.kernelEnvCreates).toEqual([]);
  expect(lab.kernelEnvPackages).toEqual([]);
});

it("refuses an environment requirement when its session has no live source run", async () => {
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_require_none"));
  await until(() => turnStarted(lab, "run_env_require_none"), "the turn starting");

  await expect(
    kernels.ask("environment.require", { session_id: "se_gone", name: "atacseq" }),
  ).rejects.toThrow(/live source turn/i);
  expect(lab.kernelEnvRequirements).toEqual([]);
  expect(cardsOf(lab)).toEqual([]);
});

it("does not ask the lab for an environment the researcher denied", async () => {
  // Asserted on the LAB rather than on the thrown sentence: a version that
  // declared the environment and then threw would satisfy a test that only
  // read the message, and would have left a colleague's lab holding a name
  // its researcher had just refused.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_deny"));
  await until(() => turnStarted(lab, "run_env_deny"), "the turn starting");

  const asked = kernels.ask("environment.create", {
    session_id: "se_1",
    name: "crispr",
    packages: ["scanpy", "anndata"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");
  lab.send(decideOn("run_env_deny", cardsOf(lab)[0]!.id, { decision: "deny" }));

  await expect(asked).rejects.toThrow(/crispr/);
  expect(lab.kernelEnvCreates).toEqual([]);
});

it("declares an allowed environment and only then re-describes the session", async () => {
  // The order is the point. Reconfigured after the declaration, the session
  // can see the new name the moment this returns; reconfigured before it —
  // or not at all — the agent creates `crispr`, lists, and is told this lab
  // declares no such thing.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  // Written into the host's own log of what it was asked, so "the lab was
  // called" and "the session was re-described" are two entries in ONE
  // ordering rather than two counts nothing places against each other.
  lab.kernelEnvCreate.onCall = () => kernels.asked.push("the lab declared it");
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_allow"));
  await until(() => turnStarted(lab, "run_env_allow"), "the turn starting");

  const asked = kernels.ask("environment.create", {
    session_id: "se_1",
    name: "crispr",
    packages: ["scanpy"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");
  lab.send(
    decideOn("run_env_allow", cardsOf(lab)[0]!.id, { decision: "allow", scope: "once" }),
  );

  expect(await asked).toMatchObject({ name: "crispr", packages: ["scanpy"] });
  expect(lab.kernelEnvCreates).toEqual([
    // The language is on this body now, and `toEqual` is what caught it
    // arriving — the whole body is asserted rather than a subset, so a field
    // added to this wire cannot land unnoticed.
    //
    // `python` because SOMETHING on this path defaulted, and it is worth
    // being exact about which: the stub host calls the daemon's handler
    // directly, so the kernel-host's own reader never ran here and the
    // default that fired is `serveEnvironmentCreate`'s. There are three of
    // them on the full path — the host's `_created_language`, this one, and
    // the lab route's — each defaulting for a caller older than the field.
    // An earlier version of this comment said there was exactly one, which
    // would make this test prove something it cannot see.
    // `permissionScope` is on this body now, and it is what the researcher
    // answered THIS card with — `once` here, so the lab writes no standing
    // grant for the name.
    {
      sessionId: "se_1",
      name: "crispr",
      packages: ["scanpy"],
      language: "python",
      permissionScope: "once",
    },
  ]);
  const declaredAt = kernels.asked.indexOf("the lab declared it");
  expect(declaredAt).toBeGreaterThan(-1);
  expect(kernels.asked.lastIndexOf("kernel.configure_session")).toBeGreaterThan(declaredAt);
});

it("carries an R create through the card and on to the lab as R", async () => {
  // The agent-facing R path, end to end through this process. Until this
  // phase nothing on this wire carried a language and the lab hard-coded
  // python, so an agent asking for an R environment got a Python one wearing
  // that name — and neither the card the researcher answered nor the body the
  // lab stored said which kind it was.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_r"));
  await until(() => turnStarted(lab, "run_env_r"), "the turn starting");

  const asked = kernels.ask("environment.create", {
    session_id: "se_1",
    name: "rstats",
    packages: ["ggplot2"],
    language: "r",
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");
  // The CARD carries it, not only the lab call. What a researcher is
  // approving is software on every machine in this lab, and which software
  // follows from the language rather than from the name — `rstats` says
  // nothing about whether conda-forge or PyPI is about to be read.
  expect(cardsOf(lab)[0]!.access).toEqual({
    kind: "environment",
    target: { name: "rstats", packages: ["ggplot2"], language: "r" },
  });
  lab.send(decideOn("run_env_r", cardsOf(lab)[0]!.id, { decision: "allow", scope: "once" }));

  await asked;
  expect(lab.kernelEnvCreates).toEqual([
    {
      sessionId: "se_1",
      name: "rstats",
      packages: ["ggplot2"],
      language: "r",
      permissionScope: "once",
    },
  ]);
});

it("refuses a language nothing can build before a researcher is asked anything", async () => {
  // Refused BEFORE the card, and that is the half worth asserting. A guard
  // that refused after raising one would have put a question in front of a
  // researcher that has no right answer — approve an environment in a
  // language this lab has no provisioner for, or decline something that was
  // never going to happen either way.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_bad_lang"));
  await until(() => turnStarted(lab, "run_env_bad_lang"), "the turn starting");

  await expect(
    kernels.ask("environment.create", {
      session_id: "se_1",
      name: "nope",
      packages: [],
      language: "ruby",
    }),
  ).rejects.toThrow(/ruby/);

  expect(cardsOf(lab)).toEqual([]);
  expect(lab.kernelEnvCreates).toEqual([]);
});

it("refuses an environment card answered for the Study or globally", async () => {
  // The surface offers neither, and the surface is not a guard: a decision
  // arrives over the wire from a browser this end does not control, so what
  // scopes a card was SHOWN with is not something to take a client's word
  // for. Refused by name rather than quietly narrowed to `once` — a
  // researcher told "for this Study" and given one call would believe the
  // wrong thing.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_scope"));
  await until(() => turnStarted(lab, "run_env_scope"), "the turn starting");

  for (const scope of ["study", "global"] as const) {
    const before = cardsOf(lab).length;
    const asked = kernels.ask("environment.create", {
      session_id: "se_1",
      name: "crispr",
      packages: ["scanpy"],
    });
    await until(() => cardsOf(lab).length > before, `a permission card for ${scope}`);
    lab.send(
      decideOn("run_env_scope", cardsOf(lab)[before]!.id, { decision: "allow", scope }),
    );
    await expect(asked).rejects.toThrow(/crispr/);
  }
  expect(lab.kernelEnvCreates).toEqual([]);
});

it("asks once for an environment allowed for this conversation, not twice", async () => {
  // What makes the card's two scopes mean different things. `once` asks
  // again next time; `conversation` does not, and a second card for a name
  // the researcher just allowed teaches them their answer meant less than
  // it said.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_again"));
  await until(() => turnStarted(lab, "run_env_again"), "the turn starting");

  const first = kernels.ask("environment.create", {
    session_id: "se_1",
    name: "crispr",
    packages: ["scanpy"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");
  lab.send(
    decideOn("run_env_again", cardsOf(lab)[0]!.id, {
      decision: "allow",
      scope: "conversation",
    }),
  );
  await first;

  await kernels.ask("environment.create", {
    session_id: "se_1",
    name: "crispr",
    packages: ["anndata"],
  });
  expect(lab.kernelEnvCreates).toHaveLength(2);
  // One card, for two creates. Nothing was asked the second time.
  expect(cardsOf(lab)).toHaveLength(1);
  // And the answer travelled with the change it authorised, so the lab can
  // hold this conversation's grant past the life of this process. The
  // SECOND call carries `once`: it was covered by the grant the first one
  // minted, nobody answered anything, and a scope reported wider than what
  // was answered would be authority minted off a card that was never shown.
  expect(lab.kernelEnvCreates.map((call) => call.permissionScope)).toEqual([
    "conversation",
    "once",
  ]);
});

it("asks nothing about an environment the lab says this conversation already allowed", async () => {
  // The daemon end of a grant that survives a restart. A researcher answered
  // "for this conversation" on a turn this process never saw — a daemon that
  // has since restarted, or a session retired when its boundary changed — and
  // the lab, which is where that answer is kept, sends it back with the turn.
  // Read off the command rather than remembered here, because a conversation
  // outlives every process that carries it.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send({ ...startRunOn("run_env_seeded"), environmentGrants: ["crispr"] });
  await until(() => turnStarted(lab, "run_env_seeded"), "the turn starting");

  await kernels.ask("environment.add_packages", {
    session_id: "se_1",
    name: "crispr",
    packages: ["scanpy"],
  });

  // No card at all, and the change went through on the strength of the grant
  // the lab was already holding.
  expect(cardsOf(lab)).toEqual([]);
  expect(lab.kernelEnvPackages).toEqual([
    // `once`, because nobody answered anything here: the grant that covered
    // this is already durable, and re-declaring one off a card that was never
    // shown is not this machine's to do.
    { sessionId: "se_1", name: "crispr", packages: ["scanpy"], permissionScope: "once" },
  ]);

  // And only that environment: a grant is kept by name, so an environment
  // nobody was asked about is still a question.
  const other = kernels.ask("environment.add_packages", {
    session_id: "se_1",
    name: "atacseq",
    packages: ["scanpy"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card for the other environment");
  expect(environmentTargetOf(cardsOf(lab)[0]!)).toMatchObject({ name: "atacseq" });
  lab.send(decideOn("run_env_seeded", cardsOf(lab)[0]!.id, { decision: "deny" }));
  await expect(other).rejects.toThrow(/atacseq/);
});

it("carries the lab's own reason back for a create it refused", async () => {
  // The researcher has just said yes to this. "It failed" with no reason is
  // the worst possible answer to a card they approved, and the lab is the
  // only party that knows which of its refusals this was.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  lab.kernelEnvCreate.refusal = "this lab already has an environment named crispr";
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_taken"));
  await until(() => turnStarted(lab, "run_env_taken"), "the turn starting");

  const asked = kernels.ask("environment.create", {
    session_id: "se_1",
    name: "crispr",
    packages: ["scanpy"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");
  lab.send(
    decideOn("run_env_taken", cardsOf(lab)[0]!.id, { decision: "allow", scope: "once" }),
  );
  await expect(asked).rejects.toThrow("this lab already has an environment named crispr");
});

it("leaves no standing grant behind a create this lab refused, so the next change is still a card", async () => {
  // A grant must not outlive the act it was given for. "For this
  // conversation" on an environment card is a standing grant over the NAME,
  // and it auto-allows every later `manage_packages` for that name with no
  // card at all — which is honest while the create it was given on actually
  // happened. It can fail: `python` is seeded on every lab, an agent chooses
  // the name, and the lab answers `conflict`. Minted when the researcher
  // answered, the session would then hold uncarded authority to install
  // software into the environment every default Python kernel in this lab
  // runs in, obtained from a card that said *Create environment python?* for
  // something that was never created.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  lab.kernelEnvCreate.refusal = "this lab already has an environment named python";
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_ungranted"));
  await until(() => turnStarted(lab, "run_env_ungranted"), "the turn starting");

  const create = kernels.ask("environment.create", {
    session_id: "se_1",
    name: "python",
    packages: ["scanpy"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");
  lab.send(
    decideOn("run_env_ungranted", cardsOf(lab)[0]!.id, {
      decision: "allow",
      scope: "conversation",
    }),
  );
  // Refused by the lab, which is the state this is about: the card was
  // answered, and the thing it was a card FOR did not happen.
  await expect(create).rejects.toThrow(/python/);

  // The very call the grant would have covered. It has to reach a researcher.
  const added = kernels.ask("environment.add_packages", {
    session_id: "se_1",
    name: "python",
    packages: ["torch"],
  });
  await until(() => cardsOf(lab).length > 1, "a second permission card");
  const second = cardsOf(lab)[1]! as { id: string; tool?: string };
  expect(second.tool).toBe("manage_packages");

  // And answered "no" it stays no — nothing reached the lab off the back of
  // a card about a create that never happened.
  lab.send(decideOn("run_env_ungranted", second.id, { decision: "deny" }));
  await expect(added).rejects.toThrow(/python/);
  expect(lab.kernelEnvPackages).toEqual([]);
});

it("refuses a create whose shape is not one, without raising a card", async () => {
  // Nothing between a model and this checked anything, and what arrives here
  // decides what a researcher is shown. A card naming `undefined` is not a
  // question anybody can answer.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_shape"));
  await until(() => turnStarted(lab, "run_env_shape"), "the turn starting");

  await expect(
    kernels.ask("environment.create", {
      session_id: "se_1",
      name: "crispr",
      packages: ["scanpy", 7],
    }),
  ).rejects.toThrow(/list of package names/);
  expect(cardsOf(lab)).toEqual([]);
  expect(lab.kernelEnvCreates).toEqual([]);
});

/** Every execution-log entry this machine has published, in order. What the
 *  lab durably keeps of a decision, and the only place a researcher reads
 *  back what they answered. */
function logEntriesOf(lab: {
  events: Array<{ runId: string; frames: Array<{ seq: number; event: RunEvent }> }>;
}): ExecutionLogEntry[] {
  return lab.events
    .flatMap((post) => post.frames)
    .map((frame) => frame.event)
    .filter(
      (event): event is Extract<RunEvent, { event: "log-entry" }> =>
        event.event === "log-entry",
    )
    .map((event) => event.entry);
}

it("writes each environment decision its own row, carrying its own reason", async () => {
  // Two decisions in one turn, answered differently. Keyed on the card's
  // `tool` — the literal tool NAME on a card this machine raised — the second
  // row would be written over the first, inheriting its `ts` and its `result`:
  // the lab would durably hold ONE row saying `allowed-once` whose stated
  // reason explains that an environment change was refused.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_rows"));
  await until(() => turnStarted(lab, "run_env_rows"), "the turn starting");

  const refused = kernels.ask("environment.create", {
    session_id: "se_1",
    name: "crispr",
    packages: ["scanpy"],
  });
  await until(() => cardsOf(lab).length > 0, "the first card");
  lab.send(
    decideOn("run_env_rows", cardsOf(lab)[0]!.id, { decision: "allow", scope: "study" }),
  );
  await expect(refused).rejects.toThrow(/crispr/);

  const allowed = kernels.ask("environment.create", {
    session_id: "se_1",
    name: "atacseq",
    packages: ["anndata"],
  });
  await until(() => cardsOf(lab).length > 1, "the second card");
  lab.send(
    decideOn("run_env_rows", cardsOf(lab)[1]!.id, { decision: "allow", scope: "once" }),
  );
  await allowed;

  // Waited for rather than read: frames reach the lab on their own timer, and
  // a count taken the instant the ask settled would be reading a batch that
  // has not been posted yet.
  await until(() => logEntriesOf(lab).length >= 2, "both decisions reaching the lab");
  const rows = logEntriesOf(lab);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.decision).toBe("denied");
  expect(rows[0]!.result).toMatch(/not something to remember beyond this conversation/);
  expect(rows[1]!.decision).toBe("allowed-once");
  // The allowance carries no reason at all, rather than the refusal's.
  expect(rows[1]!.result).toBeUndefined();
  // Two rows, and two different rows: one key each.
  expect(rows[0]!.toolUseId).not.toBe(rows[1]!.toolUseId);
  // And each names what it was about. `input: {}` here would be an empty
  // object invented for the one thing a researcher reads this back for.
  expect(rows[0]!.title).toMatch(/crispr/);
  expect(rows[0]!.input).toEqual({ environment: "crispr", packages: ["scanpy"] });
  expect(rows[1]!.title).toMatch(/atacseq/);
  expect(rows[1]!.input).toEqual({ environment: "atacseq", packages: ["anndata"] });
});

it("records the second refusal of one environment as well as the first", async () => {
  // Two denials of the same name are byte-identical as rows — same decision,
  // same title, same input, no result — so under one shared key the second is
  // not merely overwritten, it is never published at all: `emitStep`
  // suppresses a republish whose fingerprint has not changed. A consent
  // decision the researcher actually made would exist nowhere.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_twice"));
  await until(() => turnStarted(lab, "run_env_twice"), "the turn starting");

  for (const nth of [0, 1]) {
    const asked = kernels.ask("environment.create", {
      session_id: "se_1",
      name: "crispr",
      packages: ["scanpy"],
    });
    await until(() => cardsOf(lab).length > nth, `card ${nth + 1}`);
    lab.send(decideOn("run_env_twice", cardsOf(lab)[nth]!.id, { decision: "deny" }));
    await expect(asked).rejects.toThrow(/crispr/);
  }

  const denials = (): ExecutionLogEntry[] =>
    logEntriesOf(lab).filter((entry) => entry.decision === "denied");
  await until(() => denials().length >= 2, "both refusals reaching the lab");
  expect(denials()).toHaveLength(2);
  expect(new Set(denials().map((entry) => entry.toolUseId)).size).toBe(2);
});

it("refuses a create the lab answered 200 to with a body this end cannot read", async () => {
  // A 200 nothing here understands is not a declaration. Passed on, the agent
  // is told its environment exists on the strength of a body nothing read —
  // and the session is re-described for a name that may not be in the lab at
  // all. A proxy's own page and a truncated response both arrive exactly
  // like this.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  lab.kernelEnvCreate.rawBody = JSON.stringify({ ok: true });
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_unreadable"));
  await until(() => turnStarted(lab, "run_env_unreadable"), "the turn starting");

  const asked = kernels.ask("environment.create", {
    session_id: "se_1",
    name: "crispr",
    packages: ["scanpy"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");
  lab.send(
    decideOn("run_env_unreadable", cardsOf(lab)[0]!.id, { decision: "allow", scope: "once" }),
  );

  await expect(asked).rejects.toThrow(/no declaration/);
});

it("refuses to raise a card for an environment when the turn it belongs to is over", async () => {
  // The guard the ACP raise site has applied all along, at the one raise site
  // that did not. A card raised in the gap between a turn ending and the next
  // starting is published into a run that has already emitted its terminal
  // frame, and answered by a researcher looking at a different turn.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_over"));
  await until(
    () =>
      lab.events
        .flatMap((post) => post.frames)
        .some((frame) => frame.event.event === "completed"),
    "the turn ending",
  );

  await expect(
    kernels.ask("environment.create", {
      session_id: "se_1",
      name: "crispr",
      packages: ["scanpy"],
    }),
  ).rejects.toThrow(/was not approved/);
  // No card was put in front of anybody. Nothing is recorded either, and
  // there is nowhere for a record to go: this window is precisely the one
  // where the run a frame would travel on has already ended. What the agent
  // is told is the whole of the disclosure.
  expect(cardsOf(lab)).toEqual([]);
});

/**
 * An agent asking for PACKAGES, and a researcher answering.
 *
 * The other verb, and the first on this wire that changes something already
 * running. Same ladder as a create, driven the same way end to end: the ask
 * arrives as the host writes one, the card goes out as a frame, the decision
 * comes back down the command stream, and what is asserted is what the lab
 * was — or was not — asked to change.
 */

/** What one card is asking about, as a test reads it — the environment's
 *  name and the packages the card actually carries. */
function environmentTargetOf(request: { access?: unknown }): {
  name: string;
  packages: string[];
} {
  return (request.access as { target: { name: string; packages: string[] } }).target;
}

it("does not ask the lab for packages the researcher denied", async () => {
  // Asserted on the LAB rather than on the thrown sentence: a version that
  // added the packages and then threw would satisfy a test that only read
  // the message, and would have left every machine in the lab installing
  // software its researcher had just refused.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_pkg_deny"));
  await until(() => turnStarted(lab, "run_pkg_deny"), "the turn starting");

  const asked = kernels.ask("environment.add_packages", {
    session_id: "se_1",
    name: "python",
    packages: ["scanpy"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");
  lab.send(decideOn("run_pkg_deny", cardsOf(lab)[0]!.id, { decision: "deny" }));

  await expect(asked).rejects.toThrow(/python/);
  expect(lab.kernelEnvPackages).toEqual([]);
});

it("tells the add-packages card which language the environment is in", async () => {
  // The card that changes what is installed on every machine in this lab
  // used to say only a name. `serveEnvironmentAddPackages` holds the name
  // and nothing else, so this reads the language off the very list this
  // machine handed its kernel host when it configured the session — no
  // fetch, and no second answer that could disagree with what a cell finds.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_pkg_lang"));
  await until(() => turnStarted(lab, "run_pkg_lang"), "the turn starting");

  const asked = kernels.ask("environment.add_packages", {
    session_id: "se_1",
    name: "python",
    packages: ["scanpy"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");

  expect(cardsOf(lab)[0]!.access).toEqual({
    kind: "environment",
    target: { name: "python", packages: ["scanpy"], language: "python" },
  });
  // Answered, and the refusal awaited. This test is about what the card SAYS
  // rather than about the decision, so it would read fine leaving the ask
  // hanging — and it would leave a rejected promise nobody handled behind it.
  // Vitest counts those: every assertion here passes and `vitest run` still
  // exits non-zero, which is a green suite and a failed build.
  lab.send(decideOn("run_pkg_lang", cardsOf(lab)[0]!.id, { decision: "deny" }));
  await expect(asked).rejects.toThrow(/python/);
});

it("names no language on an add for an environment this machine never described", async () => {
  // The absent half, and it is the common one: a name the lab declares that
  // this machine has not built has no entry in the session's own environment
  // list, so nothing here knows its language. The card says nothing rather
  // than guessing Python — the same "absent is not zero" rule the rest of
  // this product applies to numbers, applied to a sentence.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_pkg_nolang"));
  await until(() => turnStarted(lab, "run_pkg_nolang"), "the turn starting");

  const asked = kernels.ask("environment.add_packages", {
    session_id: "se_1",
    name: "crispr",
    packages: ["scanpy"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");

  expect(cardsOf(lab)[0]!.access).toEqual({
    kind: "environment",
    target: { name: "crispr", packages: ["scanpy"] },
  });
  // Answered for the same reason as the test above — see the note there.
  lab.send(decideOn("run_pkg_nolang", cardsOf(lab)[0]!.id, { decision: "deny" }));
  await expect(asked).rejects.toThrow(/crispr/);
});

it("raises the card under manage_packages, carrying what was asked for and not what results", async () => {
  // The card's own wording comes off `request.tool`, so the tool name is what
  // makes "Add scanpy to python?" rather than "Create environment python?".
  // And `target.packages` is what was ASKED FOR: a researcher approving "add
  // scanpy" must not be shown the environment's entire contents as though all
  // of it were being installed now.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  // The lab answers with the environment's whole resulting list, which is a
  // superset of what was asked for — so a card built from the ANSWER rather
  // than the ask would be observable here.
  lab.kernelEnvPackagesAdd.added = ["scanpy"];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_pkg_card"));
  await until(() => turnStarted(lab, "run_pkg_card"), "the turn starting");

  const asked = kernels.ask("environment.add_packages", {
    session_id: "se_1",
    name: "python",
    packages: ["scanpy"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");
  const card = cardsOf(lab)[0]! as { id: string; tool?: string; access?: unknown };
  expect(card.tool).toBe("manage_packages");
  // `language` joined this target when the add card started naming what it
  // installs into. Asserted whole rather than loosened to a subset: this
  // test's whole point is that `packages` is what was ASKED FOR and not what
  // the environment ends up holding, and a `toMatchObject` here would stop
  // noticing a third field arriving with the wrong contents.
  expect(environmentTargetOf(card)).toEqual({
    name: "python",
    packages: ["scanpy"],
    language: "python",
  });

  lab.send(decideOn("run_pkg_card", card.id, { decision: "allow", scope: "once" }));
  await asked;
  expect(lab.kernelEnvPackages).toEqual([
    { sessionId: "se_1", name: "python", packages: ["scanpy"], permissionScope: "once" },
  ]);
});

it("writes the decision its own row, naming the environment and the packages asked for", async () => {
  // The row is the only durable record that a researcher approved installing
  // software on every machine in this lab. `input: {}` here would be an empty
  // object invented for the one thing a researcher reads this back for.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_pkg_row"));
  await until(() => turnStarted(lab, "run_pkg_row"), "the turn starting");

  const asked = kernels.ask("environment.add_packages", {
    session_id: "se_1",
    name: "python",
    packages: ["scanpy", "anndata"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");
  lab.send(decideOn("run_pkg_row", cardsOf(lab)[0]!.id, { decision: "allow", scope: "once" }));
  await asked;

  await until(() => logEntriesOf(lab).length >= 1, "the decision reaching the lab");
  const row = logEntriesOf(lab)[0]!;
  expect(row.decision).toBe("allowed-once");
  expect(row.title).toMatch(/python/);
  expect(row.input).toEqual({ environment: "python", packages: ["scanpy", "anndata"] });
});

it("asks once for an environment allowed for this conversation, however many packages follow", async () => {
  // R76, and this is the first task in which the widened grant is reachable
  // at all — a second `create` is refused 409 by the lab, so nothing before
  // this could get a second card past it. The `conversation` grant is keyed
  // by environment NAME, and `scopesFor` tells the researcher exactly that:
  // "Any packages for this environment, until this chat ends". The realistic
  // sequence is `add scanpy` then `add anndata`, and a per-package key would
  // make the scope cover nothing at all.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_pkg_again"));
  await until(() => turnStarted(lab, "run_pkg_again"), "the turn starting");

  const first = kernels.ask("environment.add_packages", {
    session_id: "se_1",
    name: "python",
    packages: ["scanpy"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");
  lab.send(
    decideOn("run_pkg_again", cardsOf(lab)[0]!.id, { decision: "allow", scope: "conversation" }),
  );
  await first;

  // A DIFFERENT package, into the same environment. No card, and it still
  // reaches the lab — the grant covers the environment, exactly as the card
  // said it would.
  await kernels.ask("environment.add_packages", {
    session_id: "se_1",
    name: "python",
    packages: ["anndata"],
  });
  expect(lab.kernelEnvPackages).toHaveLength(2);
  expect(cardsOf(lab)).toHaveLength(1);

  // And it covers that environment and no other: a name the researcher has
  // not answered for is still a question.
  const other = kernels.ask("environment.add_packages", {
    session_id: "se_1",
    name: "crispr",
    packages: ["anndata"],
  });
  await until(() => cardsOf(lab).length > 1, "a card for the other environment");
  lab.send(decideOn("run_pkg_again", cardsOf(lab)[1]!.id, { decision: "deny" }));
  await expect(other).rejects.toThrow(/crispr/);
});

it("refuses an add for a session this machine is not running, and one with no packages at all", async () => {
  // No live session, no card — consent nobody was asked for is not consent.
  // And an add of nothing is refused before a card is raised, because a card
  // asking a researcher to approve installing no software is not a question
  // anybody can answer.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_pkg_shape"));
  await until(() => turnStarted(lab, "run_pkg_shape"), "the turn starting");

  await expect(
    kernels.ask("environment.add_packages", {
      session_id: "se_gone",
      name: "python",
      packages: ["scanpy"],
    }),
  ).rejects.toThrow(/se_gone/);
  for (const packages of [[], ["scanpy", 7], "scanpy"]) {
    await expect(
      kernels.ask("environment.add_packages", { session_id: "se_1", name: "python", packages }),
    ).rejects.toThrow(/at least one package name/);
  }
  expect(cardsOf(lab)).toEqual([]);
  expect(lab.kernelEnvPackages).toEqual([]);
});

it("refuses an add the lab answered 200 to with a body this end cannot read", async () => {
  // A 200 nothing here understands is not an answer. Invented, the agent is
  // told its packages are on their way on the strength of a body nothing
  // read — and the shape a lenient reader would invent is the WORST of the
  // three: an empty `added`, which the host reports as "already holds them,
  // nothing is being rebuilt". A researcher approved a card, the agent is
  // told the state was already reached, and nothing is installed anywhere. A
  // proxy's own page and a truncated response both arrive exactly like this.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  lab.kernelEnvPackagesAdd.rawBody = JSON.stringify({ ok: true });
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_pkg_unreadable"));
  await until(() => turnStarted(lab, "run_pkg_unreadable"), "the turn starting");

  const asked = kernels.ask("environment.add_packages", {
    session_id: "se_1",
    name: "python",
    packages: ["scanpy"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");
  lab.send(
    decideOn("run_pkg_unreadable", cardsOf(lab)[0]!.id, { decision: "allow", scope: "once" }),
  );

  await expect(asked).rejects.toThrow(/no declaration/);
});

it("carries the lab's own reason back for an add it refused", async () => {
  // The researcher has just said yes to this. "It failed" with no reason is
  // the worst possible answer to a card they approved, and the lab is the
  // only party that knows which of its refusals this was — a name it does
  // not declare, most of all, since that is a create the agent has to ask
  // for separately.
  process.env.LYKEION_STUB_SCRIPT = HOLD_THE_TURN_OPEN;
  const lab = await stubLab([]);
  lab.kernelEnvPackagesAdd.refusal = "this lab declares no environment named crispr";
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const kernels = stubKernelHost(0);
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_pkg_missing"));
  await until(() => turnStarted(lab, "run_pkg_missing"), "the turn starting");

  const asked = kernels.ask("environment.add_packages", {
    session_id: "se_1",
    name: "crispr",
    packages: ["scanpy"],
  });
  await until(() => cardsOf(lab).length > 0, "a permission card");
  lab.send(decideOn("run_pkg_missing", cardsOf(lab)[0]!.id, { decision: "allow", scope: "once" }));

  await expect(asked).rejects.toThrow("this lab declares no environment named crispr");
});

it("grants a built environment whatever its language needs beyond its own root", async () => {
  // A kernel is `<interpreter> <driver>`, and the driver is a file in the
  // kernel host's own package — not in the environment the interpreter came
  // from. The boundary is `(deny default)`, so a read set of just the
  // environment root refuses the kernel at exec, before it writes a word to
  // stderr. That is what "this machine's r kernel did not start", with
  // nothing after the colon, actually was on a real machine.
  //
  // Python never showed it: its floor descriptor lists the driver's own
  // directory among its reads, and a built `python` environment inherits its
  // language's floor reads. R has no floor descriptor at all — deliberately,
  // since it is no longer discovered from a bare `Rscript` — so an R
  // environment's read set was its root and nothing else.
  process.env.LYKEION_STUB_SCRIPT = JSON.stringify([{ endTurn: "end_turn" }]);
  const lab = await stubLab([]);
  lab.kernelEnvDeclarations.list = [
    { name: "rstats", language: "r", manager: "conda", packages: [], createdTs: 1, lockRevision: 3 },
  ];
  const data = mkdtempSync(join(tmpdir(), "lykeion-runs-"));
  dirs.push(data);
  const workDir = `${data}-work`;
  dirs.push(workDir);
  rEnvOnDisk(workDir, "rstats", true);
  const kernels = stubKernelHost(
    0,
    PROTOCOL_VERSION,
    // Discovered: python only — a real machine, where R is never discovered.
    [
      {
        language: "python", environment: "python",
        interpreter: "/nowhere/python/bin/python3", reads: ["/nowhere/python/base"],
      },
    ],
    ["python", "r"],
    { r: ["/nowhere/kernel-host/lykeion_kernel"] },
  );
  subsystem(lab.base, data, () => kernels.host);
  await until(() => lab.commandConnected(), "the command stream");
  lab.send(startRunOn("run_env_reads"));

  await until(() => kernels.configured !== undefined, "the boundary landing");
  const configured = kernels.configured as unknown as {
    environments: Array<{ name: string; prefix: string[] }>;
  };
  const r = configured.environments.find((entry) => entry.name === "rstats");
  expect(r, "the R environment was not offered at all").toBeDefined();
  // Rendered INTO the boundary, which is the only place it does any good.
  expect(r!.prefix.join(" ")).toContain("/nowhere/kernel-host/lykeion_kernel");
});
