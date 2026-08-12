import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentAuthStates, startSignIn } from "./agent-auth";
import { CATALOGUE, lykeionHomeFor, type AuthState, type CatalogueEntry } from "./agent-registry";

// `run` overrides bypass `confinedRunCommand` entirely, so `dataDir` below is
// never read — it exists only because `AuthCheckOptions` is required, the
// same as `ProbeOptions.dataDir` is for `probeAgentClis`.
const unconfined = { dataDir: "/unused" };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A PATH holding an entry for each named command, so `available` answers
 *  from a fixture rather than from whatever the machine running this suite
 *  happens to have installed. */
function pathHolding(...commands: string[]): string {
  const dir = freshDir("lykeion-auth-path-");
  for (const command of commands) {
    const file = join(dir, command);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o755);
  }
  return dir;
}

it("asks each declared agent's own CLI who it is signed in as", async () => {
  const seen: Array<{ command: string; args: readonly string[]; env: Record<string, string> }> = [];
  const run = async (command: string, args: readonly string[], env: Record<string, string>) => {
    seen.push({ command, args, env });
    // claude's own answer is on stdout; codex's own refusal, like its own
    // approval, is on stderr — see `agent-registry.ts`'s own doc on why.
    return command === "claude"
      ? { stdout: '{"loggedIn":true,"email":"r@lab.org"}', stderr: "" }
      : { stdout: "", stderr: "Not logged in" };
  };
  const states = await agentAuthStates(
    { ...unconfined, path: pathHolding("claude", "codex") },
    run,
  );

  expect(states).toEqual([
    { agent: "claude", name: "Claude Code", available: true, signedIn: true, account: "r@lab.org" },
    { agent: "codex", name: "Codex", available: true, signedIn: false },
  ]);
  // Asked against OUR home, never the researcher's. Looked up by command
  // rather than by arrival order: every declared agent is asked concurrently,
  // so which of them reaches `run` first is a race, and the answers above are
  // what `agentAuthStates` puts back in catalogue order.
  const asked = (command: string) => seen.find((call) => call.command === command)?.env;
  expect(asked("claude")).toEqual({
    CLAUDE_CONFIG_DIR: join(homedir(), ".lykeion", "agents", "claude"),
  });
  expect(asked("codex")).toEqual({ CODEX_HOME: join(homedir(), ".lykeion", "agents", "codex") });
});

it("reports a declared agent whose CLI this machine does not have as unavailable, not merely signed out", async () => {
  // "Not installed" and "signed out" are the same answer to "can this
  // machine act as this agent" and opposite answers to "what should the
  // researcher do about it". Folded together, the pairing page offers a Sign
  // in button for a CLI that is not here, and pressing it spawns an ENOENT
  // nothing surfaces. Told apart here, at the one place that already knows.
  const states = await agentAuthStates(
    { ...unconfined, path: pathHolding("claude") },
    async () => ({ stdout: "", stderr: "" }),
  );
  expect(states.find((state) => state.agent === "claude")?.available).toBe(true);
  const codex = states.find((state) => state.agent === "codex")!;
  expect(codex.available).toBe(false);
  expect(codex.signedIn).toBe(false);
});

it(
  "resolves a symlinked command to its own realpath before confining it, so an install anywhere on PATH can still answer",
  async () => {
    // A stand-in for a real install where the command on PATH is a symlink
    // whose target lives somewhere with no reason to be readable on its own.
    // This machine's own real `claude` happens to survive confinement
    // anyway — its target sits under `~/.local`, which an incidental
    // dotfile-reading allow covers — but an install whose target is
    // anywhere else, such as this temp directory, would not: the boundary
    // has to be rendered against the resolved path, not the bare name, for
    // the exec to be permitted at all.
    const realDir = freshDir("lykeion-auth-real-");
    const script = join(realDir, "claude-real");
    writeFileSync(script, '#!/bin/sh\nprintf \'{"loggedIn":true,"email":"r@lab.org"}\\n\'\n');
    chmodSync(script, 0o755);

    const pathDir = freshDir("lykeion-auth-path-");
    symlinkSync(script, join(pathDir, "claude"));

    const states = await agentAuthStates({ dataDir: freshDir("lykeion-auth-state-"), path: pathDir, timeoutMs: 30_000 });
    const claude = states.find((state) => state.agent === "claude")!;
    expect(claude.signedIn).toBe(true);
    expect(claude.account).toBe("r@lab.org");
  },
  30_000,
);

it("does not leave a workspace behind when the platform has no sandbox backend to confine it with", async () => {
  // A platform with no backend is exactly the case `confine()` itself
  // throws on — checked here before `mkdtempSync`, the same way
  // `probeCliVersion` checks before ever calling `readVersion`, so the
  // workspace is never created rather than created and then abandoned.
  //
  // `dataDir` is created first, and outside the prefix being watched
  // (`lykeion-auth-`, the exact prefix `confinedRunCommand`'s own workspace
  // uses): created after the snapshot, its own directory would otherwise
  // read as a leak that has nothing to do with the one under test.
  const dataDir = freshDir("lykeion-state-");
  const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("lykeion-auth-")));
  const states = await agentAuthStates({ dataDir, platform: "linux" });
  expect(states.every((state) => state.signedIn === false)).toBe(true);
  const after = readdirSync(tmpdir()).filter((name) => name.startsWith("lykeion-auth-"));
  expect(after.filter((name) => !before.has(name))).toEqual([]);
});

/**
 * An independent ground truth for whether `entry` is signed in on this real
 * machine, bypassing `agentAuthStates`'s own plumbing entirely — no
 * `confinedRunCommand`, no sandbox, no `RunCommand` indirection. It still
 * reuses the declaration's own `read`, because the parser is what
 * `agent-registry.test.ts` exists to verify; what this exists to verify is
 * everything *around* the parser, which a hand-written string and an
 * injected `run` can each get right while the two together still miss a
 * bug in how the real CLI's real streams reach it — exactly how a genuinely
 * signed-in Codex read back as signed out for as long as `agentAuthStates`
 * has existed.
 */
function realStatus(entry: CatalogueEntry): Promise<AuthState> {
  const isolation = entry.isolation!;
  const env = { ...process.env, [isolation.homeEnv]: lykeionHomeFor(entry.id) };
  return new Promise((resolve) => {
    execFile(entry.command, [...isolation.auth.status.args], { env, timeout: 10_000 }, (_error, stdout, stderr) => {
      resolve(isolation.auth.status.read({ stdout, stderr }));
    });
  });
}

for (const entry of CATALOGUE) {
  if (entry.isolation === undefined) continue;
  it(
    `reports ${entry.name} as signed in when this machine's own real, unconfined CLI says it is`,
    async (ctx) => {
      // Skipped, not failed, when this machine has no such CLI installed or
      // it is genuinely signed out — the ground truth above is what tells
      // the two apart from "agentAuthStates is wrong", and it is
      // deliberately independent of the thing being tested.
      const truth = await realStatus(entry);
      if (!truth.signedIn) {
        ctx.skip();
        return;
      }
      const states = await agentAuthStates({
        dataDir: freshDir("lykeion-auth-real-state-"),
        timeoutMs: 30_000,
      });
      const state = states.find((s) => s.agent === entry.id);
      expect(state?.signedIn).toBe(true);
    },
    30_000,
  );
}

it("reads a CLI that could not answer at all as signed out", async () => {
  // A status command that fails describes an agent that is not signed in.
  // Throwing here would take the whole pairing page down over one CLI.
  const run = async () => {
    throw new Error("spawn ENOENT");
  };
  const states = await agentAuthStates(unconfined, run);
  expect(states.every((state) => state.signedIn === false)).toBe(true);
});

it("starts a sign-in against our home, detached from this request", async () => {
  const spawnFn = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
  const outcome = await startSignIn("claude", spawnFn as never, pathHolding("claude"));
  expect(outcome.started).toBe(true);
  expect(spawnFn).toHaveBeenCalledWith(
    "claude",
    ["auth", "login", "--claudeai"],
    expect.objectContaining({
      detached: true,
      env: expect.objectContaining({
        CLAUDE_CONFIG_DIR: join(homedir(), ".lykeion", "agents", "claude"),
      }),
    }),
  );
});

it("does not let a CLI missing from PATH take the whole daemon down with it", async () => {
  // spawn() reports a missing executable asynchronously — an 'error' event
  // fired after startSignIn has already returned { started: true } — not by
  // throwing where the try/catch above could see it. A real EventEmitter
  // throws an error event nobody is listening for into the process that
  // created it, so this is a faithful regression test rather than a check
  // that a listener merely got attached: if agent-auth.ts ever drops the
  // listener again, this emit is what would crash the test process itself.
  // A CLI that was on PATH when this was asked and gone by the time the
  // spawn lands is the case this still has to survive — the guard below
  // narrows the window, and cannot close it.
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  const spawnFn = vi.fn(() => child);
  const outcome = await startSignIn("claude", spawnFn as never, pathHolding("claude"));
  expect(outcome.started).toBe(true);
  expect(() => child.emit("error", new Error("spawn claude ENOENT"))).not.toThrow();
});

it("refuses to start a sign-in for a declared CLI this machine does not have", async () => {
  // The page already refuses to offer a button for an agent it was told is
  // unavailable, but this is the invariant held for any caller rather than
  // for that one page: nothing is spawned, and the answer says why instead
  // of reporting a sign-in as started and leaving the caller to work it out
  // from a row that never turns over.
  const spawnFn = vi.fn();
  const outcome = await startSignIn("codex", spawnFn as never, pathHolding("claude"));
  expect(outcome.started).toBe(false);
  expect(outcome.reason).toContain("not installed on this machine");
  expect(spawnFn).not.toHaveBeenCalled();
});

it("refuses to start a sign-in for an agent nobody has declared", async () => {
  const spawnFn = vi.fn();
  const outcome = await startSignIn("gemini", spawnFn as never);
  expect(outcome.started).toBe(false);
  expect(outcome.reason).toBeTruthy();
  expect(spawnFn).not.toHaveBeenCalled();
});
