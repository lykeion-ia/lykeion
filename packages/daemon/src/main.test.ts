import { afterEach, expect, it } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { reportIfChanged } from "./main";
import type { PairedState } from "./state";
import type { DaemonReport } from "./lab";

// Only the PATH-resolution below touches this — restored after each so a
// probe run inside one test never leaks into the next, the same discipline
// `agent-registry.test.ts` holds it to.
const REAL_PATH = process.env.PATH;
const dirs: string[] = [];
const labs: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  process.env.PATH = REAL_PATH;
  for (const lab of labs.splice(0)) await lab.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A PATH with nothing on it, so a probe run inside `captureReport` finds no
 *  agent CLIs and answers in well under a test's own timeout, rather than
 *  however long whatever this machine happens to have installed takes. Also
 *  the shape of a machine missing `uv`: the kernel floor's own PATH lookup
 *  finds nothing here either. */
function emptyPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-main-path-"));
  dirs.push(dir);
  return dir;
}

/** A PATH holding a `uv` that answers `--version` and nothing else — enough
 *  for the kernel floor to call this machine ready, without installing the
 *  researcher's own `uv` as a dependency of this test. */
function pathWithUv(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-main-path-"));
  dirs.push(dir);
  const file = join(dir, "uv");
  writeFileSync(file, '#!/bin/sh\necho "uv 0.9.0"\n');
  chmodSync(file, 0o755);
  return dir;
}

/** A real HTTP server standing in for the lab, so `reportIfChanged`'s own
 *  `fetch` has somewhere real to land — the same shape `lab.test.ts`'s
 *  `stubLab` stands up for `report` directly, one level up from it. Returns
 *  every body the lab received, in arrival order, so a caller that runs
 *  `reportIfChanged` more than once can tell a suppressed report (nothing
 *  new arrives) apart from a sent one. */
async function stubLab(): Promise<{
  machine: PairedState;
  dataDir: string;
  workDir: string;
  bodies: DaemonReport[];
}> {
  const bodies: DaemonReport[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // `reportIfChanged` asks this route for the lab's own declared
    // environments before it ever builds its report — answered here with
    // none, so `bodies` keeps holding exactly the `/daemon/report` calls
    // every test in this file already reads it as.
    if (req.url === "/daemon/kernel-envs") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ declarations: [] }));
      return;
    }
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      bodies.push(JSON.parse(raw) as DaemonReport);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  labs.push({ close: () => new Promise<void>((resolve) => server.close(() => resolve())) });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const machine: PairedState = {
    lab: `http://127.0.0.1:${port}`,
    token: "a-token",
    runtimeId: "rt_1",
    machineName: "test-machine",
    labName: "Test Lab",
  };
  const dataDir = mkdtempSync(join(tmpdir(), "lykeion-main-data-"));
  dirs.push(dataDir);
  // Never written to by anything in this file — no environment is built
  // here — only read by `readEnvStatus`, which reports `absent` for a
  // directory that does not exist, the same as any other machine that has
  // never provisioned this declaration.
  const workDir = join(dataDir, "work");
  return { machine, dataDir, workDir, bodies };
}

async function captureReport(): Promise<DaemonReport> {
  process.env.PATH = emptyPath();
  const { machine, dataDir, workDir, bodies } = await stubLab();
  await reportIfChanged(machine, dataDir, workDir);
  return bodies[0]!;
}

/** The sentence `processVisibility()` (`kernel-floor.ts`) owes THIS
 *  platform, asserted by its exact text rather than merely being non-empty —
 *  a build that swapped the darwin and linux sentences would still say
 *  SOMETHING and pass a bare non-empty check. Written independently of
 *  `processVisibility()` itself rather than by importing and calling it,
 *  which would compare the function's answer to itself and catch nothing. */
function expectedVisibilitySentence(): string {
  if (process.platform === "darwin")
    return "macOS reports memory and processor use for a process Lykeion started itself.";
  if (process.platform === "linux")
    return "Linux reports these through /proc; a machine mounted with hidepid may withhold them.";
  return "This platform has not been checked for process visibility.";
}

// `lastReported` is a module-level fingerprint shared by every test in this
// file, and every one of these calls `captureReport()` with the same empty
// PATH — so a second call hashes identically to the first on this same real
// machine's memory and core count, and `reportIfChanged` would (correctly)
// swallow it as a repeat rather than sending a fresh body to assert on. One
// test, one report, every field it carries checked together.
it(
  "tells the lab how much machine there is to fill, and that it cannot host a kernel without uv",
  async () => {
    const sent = await captureReport();
    // Pinned to this machine's own figures rather than merely to "more than
    // nothing": every machine that runs this has several cores and several
    // gigabytes, so `toBeGreaterThan(0)` passed just as happily on a report
    // that swapped the two fields, or that sent `1` for each.
    expect(sent.totalMemoryBytes).toBe(totalmem());
    expect(sent.cores).toBe(cpus().length);
    expect(sent.kernels.ready).toBe(false);
    expect(sent.kernels.reason).toContain("uv");
    expect(sent.processVisibility).toBe(expectedVisibilitySentence());
  },
  // A real confined `uv --version` lookup (which fails to resolve, here, but
  // still goes through `probeKernelFloor`'s own machinery) plus a full
  // `probeAgentClis` pass over the catalogue, on a package with no
  // `vitest.config.ts` and so no override to vitest's 5s default. See
  // `kernel-floor.test.ts`'s own note on this same budget.
  30_000,
);

it(
  "reports again once this machine gains uv, even though nothing else about it changed",
  async () => {
    // Before the fingerprint `reportIfChanged` compares reports on was widened
    // to include the kernel floor, this second call compared equal to the
    // first on every field it looked at — clis, memory, cores — and was
    // silently swallowed. A machine that installed `uv` between one probe
    // cycle and the next would then go on being told it could not host a
    // kernel, forever, on the strength of a check this daemon never repeated
    // to anyone.
    const { machine, dataDir, workDir, bodies } = await stubLab();

    process.env.PATH = emptyPath();
    await reportIfChanged(machine, dataDir, workDir);

    process.env.PATH = pathWithUv();
    await reportIfChanged(machine, dataDir, workDir);

    // Whether or not the first call's body actually arrived — a prior test in
    // this file may have already left the lab believing this exact "no uv"
    // answer, in which case the first call here is the one that gets
    // swallowed — the second, gaining `uv`, is a genuinely new answer and has
    // to reach the lab.
    const last = bodies.at(-1);
    expect(last).toBeDefined();
    expect(last!.kernels.ready).toBe(true);
  },
  // The second `reportIfChanged` call spawns a real confined `uv --version`
  // that actually runs (unlike the first test's, which never resolves on an
  // empty PATH) — the spawn `probeKernelFloor`'s own budget
  // (`DEFAULT_TIMEOUT_MS` in `probe.ts`) allows 10s for, on a package whose
  // tests otherwise inherit vitest's 5s default.
  30_000,
);
