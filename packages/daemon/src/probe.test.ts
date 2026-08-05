import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliFingerprint, isRunnable, probeAgentClis, type ProbedCli } from "./probe";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function pathWith(commands: Record<string, string>): string {
  return pathRunning(
    Object.fromEntries(Object.entries(commands).map(([name, version]) => [name, `echo "${version}"`])),
  );
}

/** A PATH holding commands that do whatever is asked of them, for the cases
 *  where what a command says — and on which stream, and after how many blank
 *  lines — is the thing under test. */
function pathRunning(commands: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-probe-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(commands)) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

/** The body of a minimal ACP adapter: reads the one line `initialize` writes
 *  to its stdin, answers it — `initialize` is always the first call on a
 *  fresh connection, so its id is always 1 — and lets the shell exit once
 *  that line is flushed. Enough to prove a real handshake happened, rather
 *  than assert against a canned "it would have worked". */
function acpHandshakeScript(): string {
  return 'read -r line\nprintf \'{"jsonrpc":"2.0","id":1,"result":{}}\\n\'';
}

it(
  "reports a command that is on PATH and answers",
  async () => {
    // A budget far past anything this needs, because what is being asserted
    // is that a command on PATH is found and its answer read — not how long
    // a loaded machine takes to start a shell script. What a real probe
    // allows a command, and what happens when one takes longer, is the
    // subject of its own test below.
    const clis = await probeAgentClis({ path: pathWith({ claude: "1.2.3" }), timeoutMs: 30_000 });
    const claude = clis.find((c) => c.id === "claude")!;
    expect(claude.available).toBe(true);
    expect(claude.version).toBe("1.2.3");
    expect(claude.command).toBe("claude");
  },
  60_000,
);

it(
  "reports a command that takes seconds to answer as installed, at the version it gives",
  async () => {
    // The budget in `probe.ts` itself, not one this test picks: a real CLI
    // behind a shim can spend seconds starting before it prints anything, and
    // whether the default leaves room for that is the thing being asserted.
    // A budget a working command can lose against reports a tool the
    // researcher has installed as one they do not have.
    const clis = await probeAgentClis({
      path: pathRunning({ openclaw: 'sleep 4\necho "2026.2.21-2"' }),
    });
    const openclaw = clis.find((c) => c.id === "openclaw")!;
    expect(openclaw.available).toBe(true);
    expect(openclaw.version).toBe("2026.2.21-2");
  },
  60_000,
);

it("reports a command that answers nothing as installed, without inventing a version", async () => {
  // Exits zero and says nothing. It is on PATH and it ran, so it is
  // installed; what build it is went unsaid, and the empty version is how
  // that is said rather than a claim it is missing.
  const clis = await probeAgentClis({ path: pathRunning({ claude: "exit 0" }), timeoutMs: 30_000 });
  const claude = clis.find((c) => c.id === "claude")!;
  expect(claude.available).toBe(true);
  expect(claude.version).toBe("");
});

it("reads a version a command answers on the error stream", async () => {
  const clis = await probeAgentClis({
    path: pathRunning({ claude: 'echo "2026.2.21-2" >&2' }),
    timeoutMs: 30_000,
  });
  const claude = clis.find((c) => c.id === "claude")!;
  expect(claude.available).toBe(true);
  expect(claude.version).toBe("2026.2.21-2");
});

it("reads a version out of an answer that opens with a blank line", async () => {
  const clis = await probeAgentClis({
    path: pathRunning({ claude: 'printf "\\n\\n1.2.3\\n"' }),
    timeoutMs: 30_000,
  });
  const claude = clis.find((c) => c.id === "claude")!;
  expect(claude.available).toBe(true);
  expect(claude.version).toBe("1.2.3");
});

it("never calls a command missing on the strength of what it would not say", async () => {
  // Four commands that each decline to name their build in their own way,
  // rather than the one entry another test plants. Every one of them is on
  // PATH, so every one of them is installed; none of the four ways of saying
  // nothing is evidence of a machine that does not have the tool.
  const clis = await probeAgentClis({
    path: pathRunning({
      claude: "exit 0",
      codex: 'printf ""',
      gemini: 'printf "   \\n\\n"',
      copilot: "exit 3",
    }),
    timeoutMs: 30_000,
  });
  const found = clis.filter((cli) => ["claude", "codex", "gemini", "copilot"].includes(cli.id));
  expect(found.map((cli) => [cli.id, cli.available, cli.version])).toEqual([
    ["claude", true, ""],
    ["codex", true, ""],
    ["gemini", true, ""],
    ["copilot", true, ""],
  ]);
  // And nothing else on the catalogue was invented into existence by a PATH
  // holding only those four.
  expect(clis.filter((cli) => cli.available).map((cli) => cli.id).sort()).toEqual([
    "claude",
    "codex",
    "copilot",
    "gemini",
  ]);
}, 60_000);

it("reports a command that is not installed, without inventing a version", async () => {
  const clis = await probeAgentClis({ path: pathWith({}) });
  const claude = clis.find((c) => c.id === "claude")!;
  expect(claude.available).toBe(false);
  expect(claude.version).toBe("");
});

it("reports every catalogue entry, installed or not", async () => {
  const clis = await probeAgentClis({ path: pathWith({ claude: "1.2.3" }) });
  expect(clis).toHaveLength(13);
});

it(
  "reports an agent as session-ready when its adapter handshakes",
  async () => {
    const path = pathRunning({
      claude: 'echo "2.1.220"',
      "claude-code-acp": acpHandshakeScript(),
    });
    const claude = (await probeAgentClis({ path, timeoutMs: 30_000 })).find((c) => c.id === "claude")!;
    expect(claude.available).toBe(true);
    expect(claude.sessionReady).toBe(true);
    expect("sessionReadyReason" in claude).toBe(false);
  },
  60_000,
);

it("uses the maintained Claude adapter when it is the only bridge on PATH", async () => {
  const path = pathRunning({
    claude: 'echo "2.1.220"',
    "claude-agent-acp": acpHandshakeScript(),
  });
  const resolved: string[] = [];
  const claude = (await probeAgentClis({
    path,
    timeoutMs: 30_000,
    onAdapterResolved: (agentId, command) => {
      if (agentId === "claude") resolved.push(command);
    },
  })).find((c) => c.id === "claude")!;
  expect(claude.sessionReady).toBe(true);
  expect(resolved).toEqual([join(path, "claude-agent-acp")]);
});

it("prefers the maintained Claude adapter when both bridges are on PATH", async () => {
  const path = pathRunning({
    claude: 'echo "2.1.220"',
    "claude-agent-acp": acpHandshakeScript(),
    "claude-code-acp": "echo deprecated-bridge-was-launched >&2\nexit 1",
  });
  const claude = (await probeAgentClis({ path, timeoutMs: 30_000 })).find((c) => c.id === "claude")!;
  expect(claude.sessionReady).toBe(true);
});

it("falls back to the compatibility Claude adapter when it is the only bridge on PATH", async () => {
  const path = pathRunning({
    claude: 'echo "2.1.220"',
    "claude-code-acp": acpHandshakeScript(),
  });
  const claude = (await probeAgentClis({ path, timeoutMs: 30_000 })).find((c) => c.id === "claude")!;
  expect(claude.sessionReady).toBe(true);
});

it("says the CLI is there but the adapter is not, rather than calling it absent", async () => {
  const claude = (await probeAgentClis({ path: pathWith({ claude: "2.1.220" }) })).find(
    (c) => c.id === "claude",
  )!;
  expect(claude.available).toBe(true);
  expect(claude.sessionReady).toBe(false);
  expect(claude.sessionReadyReason).toMatch(/adapter/i);
});

it("carries what initialize refused with, so a version floor is named", async () => {
  const path = pathRunning({
    claude: 'echo "1.0.0"',
    "claude-code-acp": "echo 'needs claude >= 2.0.0' >&2\nexit 1",
  });
  const claude = (await probeAgentClis({ path })).find((c) => c.id === "claude")!;
  expect(claude.sessionReady).toBe(false);
  expect(claude.sessionReadyReason).toContain("needs claude >= 2.0.0");
});

it("has no adapter to try for a catalogue entry that speaks no ACP yet, and says so", async () => {
  // `gemini` carries no adapter mapping at all — unlike `claude`, there is no
  // second binary to look for, so this settles without spawning anything.
  const gemini = (await probeAgentClis({ path: pathWith({ gemini: "1.0.0" }) })).find(
    (c) => c.id === "gemini",
  )!;
  expect(gemini.available).toBe(true);
  expect(gemini.sessionReady).toBe(false);
  expect(gemini.sessionReadyReason).toMatch(/adapter/i);
});

it("does not treat a non-executable file as a command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-probe-"));
  dirs.push(dir);
  writeFileSync(join(dir, "claude"), "not executable");
  const clis = await probeAgentClis({ path: dir });
  expect(clis.find((c) => c.id === "claude")!.available).toBe(false);
});

it("gives up on a command that never answers, and still calls it installed", async () => {
  // Thirty seconds against a fifth of a second: this command is never going
  // to answer inside the budget. The probe comes back anyway — the test's own
  // ten-second limit is what asserts that — and what it comes back with is
  // the third thing a probe can find. The command is on PATH, so it is
  // installed; it did not say which build inside the time it was given, so
  // there is no version to show. Reading a lost race as an absent tool is how
  // a screen ends up saying a researcher does not have something they are
  // able to run by typing its name.
  const dir = mkdtempSync(join(tmpdir(), "lykeion-probe-"));
  dirs.push(dir);
  const file = join(dir, "claude");
  writeFileSync(file, "#!/bin/sh\nsleep 30\n");
  chmodSync(file, 0o755);
  const claude = (await probeAgentClis({ path: dir, timeoutMs: 200 })).find((c) => c.id === "claude")!;
  expect(claude.available).toBe(true);
  expect(claude.version).toBe("");
}, 10_000);

it("isRunnable refuses a file without the executable bit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-probe-"));
  dirs.push(dir);
  const file = join(dir, "claude");
  writeFileSync(file, "not executable");
  expect(await isRunnable(file)).toBe(false);
});

it("isRunnable accepts a file with the executable bit set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-probe-"));
  dirs.push(dir);
  const file = join(dir, "claude");
  writeFileSync(file, "#!/bin/sh\necho hi\n");
  chmodSync(file, 0o755);
  expect(await isRunnable(file)).toBe(true);
});

it("cliFingerprint does not depend on the order clis arrive in", () => {
  const a: ProbedCli[] = [
    { id: "codex", name: "Codex", command: "codex", version: "1.0.0", available: true, sessionReady: false },
    { id: "claude", name: "Claude Code", command: "claude", version: "2.0.0", available: false, sessionReady: false },
  ];
  const b = [...a].reverse();
  expect(cliFingerprint(a)).toBe(cliFingerprint(b));
});

it("cliFingerprint is stable for an identical probe reported twice", () => {
  const clis: ProbedCli[] = [
    { id: "claude", name: "Claude Code", command: "claude", version: "1.0.0", available: true, sessionReady: true },
  ];
  expect(cliFingerprint(clis)).toBe(cliFingerprint([...clis]));
});

it("cliFingerprint differs when a known id's version changes, with the id set unchanged", () => {
  const before: ProbedCli[] = [
    { id: "claude", name: "Claude Code", command: "claude", version: "1.0.0", available: true, sessionReady: true },
  ];
  const after: ProbedCli[] = [{ ...before[0]!, version: "1.0.1" }];
  expect(cliFingerprint(before)).not.toBe(cliFingerprint(after));
});

it("cliFingerprint differs when a known id's availability flips, with the id and version unchanged", () => {
  const before: ProbedCli[] = [
    { id: "claude", name: "Claude Code", command: "claude", version: "1.0.0", available: true, sessionReady: true },
  ];
  const after: ProbedCli[] = [{ ...before[0]!, available: false }];
  expect(cliFingerprint(before)).not.toBe(cliFingerprint(after));
});

it("cliFingerprint differs when sessionReady flips, with the id, version and availability unchanged", () => {
  // An adapter that gets installed while the daemon is already running
  // changes nothing `available` or `version` would ever show — this is the
  // one fact that would otherwise go unreported until something else about
  // the CLI happened to change too.
  const before: ProbedCli[] = [
    { id: "claude", name: "Claude Code", command: "claude", version: "1.0.0", available: true, sessionReady: false },
  ];
  const after: ProbedCli[] = [{ ...before[0]!, sessionReady: true }];
  expect(cliFingerprint(before)).not.toBe(cliFingerprint(after));
});
