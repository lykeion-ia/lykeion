import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { CATALOGUE, entryFor, isolationFor, lykeionHomeFor } from "./agent-registry";

// Only the PATH-resolution tests below touch this — restored after each so a
// test that mutates process.env.PATH to prove a resolution failure never
// leaks into whatever runs next.
const REAL_PATH = process.env.PATH;
const dirs: string[] = [];
afterEach(() => {
  process.env.PATH = REAL_PATH;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Claude's own `_meta`, asked the way `session.ts` asks it: the row is
 *  handed its own `skillsOff`, which is where the flags that empty its skill
 *  set are declared. */
async function claudeSessionMeta(): Promise<{ claudeCode: { options: Record<string, unknown> } }> {
  const isolation = isolationFor("claude")!;
  return (await isolation.sessionMeta!(isolation.skillsOff)) as {
    claudeCode: { options: Record<string, unknown> };
  };
}

it("keeps every catalogued agent, declared or not", () => {
  const ids = CATALOGUE.map((entry) => entry.id);
  expect(ids).toContain("claude");
  expect(ids).toContain("codex");
  // The eleven stay as rows so phases 2 and 3 have a roadmap to fill in.
  expect(ids).toContain("gemini");
  expect(ids).toHaveLength(13);
});

it("declares isolation for exactly the agents Lykeion can confine today", () => {
  const declared = CATALOGUE.filter((entry) => entry.isolation !== undefined);
  expect(declared.map((entry) => entry.id)).toEqual(["claude", "codex"]);
});

it("names the variable that redirects each declared agent's home", () => {
  expect(isolationFor("claude")?.homeEnv).toBe("CLAUDE_CONFIG_DIR");
  expect(isolationFor("codex")?.homeEnv).toBe("CODEX_HOME");
});

it("reaches no isolation for an agent nobody has declared", () => {
  expect(isolationFor("gemini")).toBeUndefined();
  expect(isolationFor("nothing-of-the-sort")).toBeUndefined();
  expect(entryFor("nothing-of-the-sort")).toBeUndefined();
});

it("keeps each agent's home out of the directory the daemon keeps its own state in", () => {
  // config.ts already refuses a --work-dir inside --data-dir, for the same
  // reason: what an agent reaches must not be where the machine's identity is.
  expect(lykeionHomeFor("claude")).toBe(join(homedir(), ".lykeion", "agents", "claude"));
  expect(lykeionHomeFor("codex")).toBe(join(homedir(), ".lykeion", "agents", "codex"));
});

it("reads claude's own answer about who is signed in", () => {
  const read = isolationFor("claude")!.auth.status.read;
  expect(read({ stdout: '{"loggedIn":true,"email":"r@lab.org"}', stderr: "" })).toEqual({
    signedIn: true,
    recognised: true,
    account: "r@lab.org",
  });
  expect(read({ stdout: '{"loggedIn":false,"authMethod":"none"}', stderr: "" })).toEqual({
    signedIn: false,
    recognised: true,
  });
  // A CLI that answered with something else is signed out, not a crash — and
  // is marked as not understood, which is a different fact. The pairing page
  // folds the two together; the redirect proof must not, or a row with the
  // wrong status arguments would certify an isolation nobody observed.
  expect(read({ stdout: "command not found", stderr: "" })).toEqual({
    signedIn: false,
    recognised: false,
  });
  // JSON that parses but is not this command's answer is not an answer.
  expect(read({ stdout: '{"something":"else"}', stderr: "" })).toEqual({
    signedIn: false,
    recognised: false,
  });
  // stdout is the whole of what this reads — `--json` writes there, and
  // stderr is not this closure's to read (see `agent-registry.ts`'s own
  // doc on why, and the codex test below for the CLI that needs it).
  expect(read({ stdout: "", stderr: '{"loggedIn":true,"email":"r@lab.org"}' })).toEqual({
    signedIn: false,
    recognised: false,
  });
});

it("reads codex's answer wherever it actually printed it, without mistaking a refusal for an approval", () => {
  const read = isolationFor("codex")!.auth.status.read;
  // Observed: codex's own "Logged in using ..." line prints to stderr, not
  // stdout — with or without `--json`, which this subcommand has no
  // `--json` for at all. This is the exact shape that read as signed out
  // for as long as `agentAuthStates` existed, until the plumbing started
  // handing both streams to this closure instead of stdout alone.
  expect(read({ stdout: "", stderr: "Logged in using ChatGPT" })).toEqual({
    signedIn: true,
    recognised: true,
  });
  // Read wherever it lands rather than only where it is observed today, in
  // case a future release moves it.
  expect(read({ stdout: "Logged in using ChatGPT", stderr: "" })).toEqual({
    signedIn: true,
    recognised: true,
  });
  // "Not logged in" contains "logged in"; anchoring is what keeps them
  // apart, checked on both streams. Both are recognised answers — this CLI
  // said one of the two things it says.
  expect(read({ stdout: "", stderr: "Not logged in" })).toEqual({ signedIn: false, recognised: true });
  expect(read({ stdout: "Not logged in", stderr: "" })).toEqual({ signedIn: false, recognised: true });
  // Neither sentence appeared, so nothing was understood. Signed out for the
  // pairing page; not an answer for the redirect proof.
  expect(read({ stdout: "", stderr: "error: unknown subcommand" })).toEqual({
    signedIn: false,
    recognised: false,
  });
});

it("declares what rides an agent's own per-session channel, for an agent that has one", async () => {
  // Task 6 is what reads this. It is declared here because the alternative
  // is session.ts asking which agent it is holding, and no file but this one
  // may ask that.
  const meta = await claudeSessionMeta();
  expect(meta.claudeCode.options.settingSources).toEqual([]);
  expect(meta.claudeCode.options.strictMcpConfig).toBe(true);
  // One object for the flag rather than two copies of it, so what closes the
  // skill set and what is sent on the wire cannot drift apart.
  expect(meta.claudeCode.options.extraArgs).toBe(isolationFor("claude")!.skillsOff.extraArgs);
});

it("sends and writes what a row declares, rather than a constant standing beside it", () => {
  // `skillsOff` used to be read by nothing at all: `sessionMeta` named the
  // flags constant directly and `seeds` called the config renderer directly,
  // so a row could declare one set and send another with a passing typecheck
  // and a plausible-looking table. That is the trap laid for a phase-2 author
  // filling in one of the eleven undeclared rows — they would have changed
  // nothing. Both mechanisms are now handed the row's own declaration, which
  // this asserts by handing them a different one and watching the output
  // follow.
  const codex = isolationFor("codex")!;
  const home = lykeionHomeFor("codex");
  expect(codex.seeds!(codex.skillsOff, home)[0]!.contents).toContain("plugins = false");
  expect(codex.seeds!({ features: { plugins: true } }, home)[0]!.contents).toContain(
    "plugins = true",
  );
});

it("sends the adapter channel the flags its own row declares", async () => {
  const claude = isolationFor("claude")!;
  const meta = (await claude.sessionMeta!({ extraArgs: { "some-other-flag": null } })) as {
    claudeCode: { options: Record<string, unknown> };
  };
  expect(meta.claudeCode.options.extraArgs).toEqual({ "some-other-flag": null });
});

it("declares no such channel for an agent whose adapter has none", () => {
  expect(isolationFor("codex")!.sessionMeta).toBeUndefined();
});

it("offers claude only the adapter that can actually carry a plan", () => {
  // claude-code-acp translates only TodoWrite into an ACP plan, and the
  // current CLI no longer ships that tool — so it fails "proposes a plan"
  // every run, for a reason nothing in this repository can fix. Pinned as an
  // exact list rather than an absence, so re-admitting it is a deliberate
  // act that trips a test naming why it was dropped, instead of a name
  // quietly reappearing beside the one that works.
  expect(isolationFor("claude")!.adapters).toEqual([
    { command: "claude-agent-acp", args: [], provenance: "protocol" },
  ]);
});

it("declares codex's adapter as a launch spec, provenance included", () => {
  // Pinned per row rather than only for claude. `provenance` decides whether
  // a researcher is asked before this adapter runs beside their sign-in, and
  // a value no test names can be changed without anything noticing.
  expect(isolationFor("codex")!.adapters).toEqual([
    { command: "codex-acp", args: [], provenance: "protocol" },
  ]);
});

it("declares every adapter as a bare executable, never a path and never a shell", () => {
  // `command` is resolved on PATH by `resolveOnPath`, so a path here would
  // silently skip that resolution and a shell metacharacter would only matter
  // if something ever stopped spawning with an explicit argv. Said out loud
  // because `args` is where a path starts looking reasonable, and the type
  // now has somewhere to put one.
  for (const entry of CATALOGUE) {
    for (const launch of entry.isolation?.adapters ?? []) {
      expect(launch.command).not.toContain(sep);
      expect(launch.command).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  }
});

it("names a PATH-resolved claude, so an adapter that honours the key cannot pick its own vendored binary", async () => {
  // The gap this closes, observed: an adapter left to itself spawns a cli.js
  // vendored at its own build time — found stuck 184 patch releases behind a
  // real, signed-in PATH install, with a built-in skill surviving
  // disable-slash-commands. Inert for the adapter declared today, which
  // resolves its own current binary and overrides `_meta` with it; asserted
  // anyway, because this is what any adapter that does read the key gets.
  const dir = mkdtempSync(join(tmpdir(), "lykeion-registry-path-"));
  dirs.push(dir);
  const claude = join(dir, "claude");
  writeFileSync(claude, "#!/bin/sh\necho hi\n");
  chmodSync(claude, 0o755);
  process.env.PATH = dir;
  const meta = await claudeSessionMeta();
  expect(meta.claudeCode.options.pathToClaudeCodeExecutable).toBe(claude);
});

it("omits the SDK option rather than sending it unresolved, when claude is not on PATH", async () => {
  // Degrading sensibly means this session still opens — it just falls back
  // to whatever the adapter would have done unprompted, rather than this
  // closure crashing or handing over a bare `undefined`.
  const dir = mkdtempSync(join(tmpdir(), "lykeion-registry-path-empty-"));
  dirs.push(dir);
  process.env.PATH = dir;
  const meta = await claudeSessionMeta();
  expect(meta.claudeCode.options).not.toHaveProperty("pathToClaudeCodeExecutable");
});
