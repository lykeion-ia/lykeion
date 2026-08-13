import { expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOGUE } from "./agent-registry";
import {
  agentHomeFor,
  allAgentHomes,
  confinementFor,
  foreignHomes,
  workspaceKey,
} from "./agent-home";
import { policyFor, renderSeatbeltProfile } from "./sandbox";

const home = homedir();
const WORKSPACE = "/work/studies/s_47/tasks/t_176";
const KEY = workspaceKey(WORKSPACE);
const claude = join(home, ".claude");

it("names a working directory the way the tools that key on it do", () => {
  expect(workspaceKey("/work/studies/s_47/tasks/t_176")).toBe(
    "-work-studies-s-47-tasks-t-176",
  );
  expect(workspaceKey("/a_b/c")).toBe("-a-b-c");
});

const lykeionClaude = join(home, ".lykeion", "agents", "claude");
const lykeionCodex = join(home, ".lykeion", "agents", "codex");

it("gives an agent the installation Lykeion made for it", () => {
  expect(agentHomeFor("claude", WORKSPACE).state).toContain(lykeionClaude);
  expect(agentHomeFor("codex", WORKSPACE).state).toContain(lykeionCodex);
});

it("never gives an agent the researcher's own installation", () => {
  const declared = agentHomeFor("claude", WORKSPACE);
  const everything = [...declared.state, ...declared.credentials, ...declared.sealed];
  expect(everything).not.toContain(claude);
  expect(everything).not.toContain(join(home, ".codex"));
});

it("denies the researcher's own installation outright", () => {
  // Not narrowed — absent. Their credentials file holds live OAuth tokens for
  // a dozen third-party services, and a run has no business in any of it.
  expect(foreignHomes("claude", WORKSPACE)).toContain(claude);
  expect(foreignHomes("codex", WORKSPACE)).toContain(join(home, ".codex"));
});

it("denies one agent's installation to another", () => {
  expect(foreignHomes("claude", WORKSPACE)).toContain(lykeionCodex);
  expect(foreignHomes("codex", WORKSPACE)).toContain(lykeionClaude);
});

it("grants a declared credentialsOutsideHome only to the agent that declared it, and denies it to every other", () => {
  // Claude Code is the one entry that declares this today (its macOS
  // sign-in lives in the login keychain, not inside CLAUDE_CONFIG_DIR).
  // Codex's own auth.json is inside its home already, so it declares
  // nothing here — this is the test that would fail if a hand-edit ever
  // gave codex the same grant it has no earned claim to.
  const claudeIsolation = CATALOGUE.find((entry) => entry.id === "claude")!.isolation!;
  const outsideHome = claudeIsolation.credentialsOutsideHome ?? [];
  expect(outsideHome.length).toBeGreaterThan(0);
  for (const path of outsideHome) {
    expect(agentHomeFor("claude", WORKSPACE).credentials).toContain(path);
    // Not merely absent from codex's own home — actively denied to it,
    // the same as claude's Lykeion home is denied to codex.
    expect(agentHomeFor("codex", WORKSPACE).credentials).not.toContain(path);
    expect(foreignHomes("codex", WORKSPACE)).toContain(path);
    expect(foreignHomes("claude", WORKSPACE)).not.toContain(path);
  }
});

it("never denies an agent its own home while naming the others", () => {
  for (const entry of CATALOGUE) {
    if (entry.isolation === undefined) continue;
    const own = [
      ...agentHomeFor(entry.id, WORKSPACE).state,
      ...agentHomeFor(entry.id, WORKSPACE).credentials,
    ];
    for (const foreign of foreignHomes(entry.id, WORKSPACE)) expect(own).not.toContain(foreign);
  }
});

it("keeps every declared agent's home from being an ancestor of another's", () => {
  // foreignHomes only ever excludes a path from denial by exact match against
  // an agent's own state and credentials — it has no notion of one path
  // sitting inside another. That is safe today only because the sole path
  // two agents share (the shell scratch directory) is byte-identical between
  // them, so the exact match catches it. A rendered denial is a `subpath`
  // rule, though, and it is rendered after the owner's own `allow`: if a
  // future catalogue entry ever named a directory that is a strict ancestor
  // of another entry's directory — rather than the identical path this one
  // shares — the ancestor would be denied by subpath to the agent whose home
  // sits inside it, and that denial would swallow the owner's own allow
  // along with it, unlike this scratch directory that is annotated in own.
  // This does not fix that; it pins the invariant the current subtraction
  // depends on, so a catalogue entry that violates it fails here — at test
  // time — rather than in a rendered sandbox profile.
  const ids = CATALOGUE.filter((entry) => entry.isolation !== undefined).map((entry) => entry.id);
  for (const a of ids) {
    for (const b of ids) {
      if (a === b) continue;
      const ownA = [...agentHomeFor(a, WORKSPACE).state, ...agentHomeFor(a, WORKSPACE).credentials];
      const ownB = [...agentHomeFor(b, WORKSPACE).state, ...agentHomeFor(b, WORKSPACE).credentials];
      for (const pathA of ownA) {
        for (const pathB of ownB) {
          // Identical paths (the shared scratch directory) are the one
          // exception the exact-match subtraction already handles.
          if (pathA === pathB) continue;
          expect(pathB.startsWith(`${pathA}/`)).toBe(false);
          expect(pathA.startsWith(`${pathB}/`)).toBe(false);
        }
      }
    }
  }
});

it("gives an agent the scratch directory its shell cannot run without", () => {
  const state = agentHomeFor("claude", WORKSPACE).state;
  const scratch = state.find((path) => path.includes("/tmp/"));
  expect(scratch).toBe(`/tmp/claude-${process.getuid?.() ?? 0}/${KEY}`);
});

it("never grants the root that scratch directory sits in", () => {
  const state = agentHomeFor("claude", WORKSPACE).state;
  expect(state).not.toContain(`/tmp/claude-${process.getuid?.() ?? 0}`);
});

it("keys a workspace on where it physically is, not on the name it was opened by", () => {
  // An agent asks the kernel where it is and is told the physical path, so
  // the per-directory names it derives are the resolved workspace's. A run
  // opened through a link and keyed on the link's own name is granted one
  // scratch directory and one Task record while the agent creates two
  // others, and every shell it runs fails at the mkdir before running
  // anything — which is what this asserts, on a link built here rather than
  // on whichever of this machine's temporary directories happens to be one.
  const real = mkdtempSync(join(tmpdir(), "lykeion-agent-home-real-"));
  const parent = mkdtempSync(join(tmpdir(), "lykeion-agent-home-link-"));
  const link = join(parent, "workspace");
  symlinkSync(real, link);
  try {
    const resolved = workspaceKey(realpathSync(real));
    expect(workspaceKey(link)).not.toBe(resolved);
    const declared = agentHomeFor("claude", link);
    expect(declared.state).toContain(join(`/tmp/claude-${process.getuid?.() ?? 0}`, resolved));
    expect(declared.state).toContain(join(lykeionClaude, "projects", resolved));
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(real, { recursive: true, force: true });
  }
});

it("lets an agent's shell tidy up after a command it already ran, and nothing wider", () => {
  // The shell writes where it ended up into a scratch file with a fresh random
  // name and then removes it. No path to grant, only a shape — and without it
  // a command that worked is drawn as one that failed. This pattern is
  // rendered straight into the sandbox profile as a live regex, so pinning
  // both anchors and the character class here is what stands between a typo
  // in this one string and a boundary that admits arbitrary paths.
  const [pattern] = agentHomeFor("claude", WORKSPACE).patterns;
  expect(pattern).toBeDefined();
  const re = new RegExp(pattern!);
  expect(re.test("/private/tmp/claude-9a9a-cwd")).toBe(true);
  // Trailing anchor: a separator, or anything else, after "-cwd" must not
  // still match. Losing the trailing `$` is what would let this through.
  expect(re.test("/private/tmp/claude-9a9a-cwd/escaped")).toBe(false);
  // Character class: a separator inside the random segment must not match
  // either. Adding "/" to the class is what would let this through, and it
  // is exactly the mutation that would widen the boundary to arbitrary paths
  // under /private/tmp.
  expect(re.test("/private/tmp/claude-9a9a/etc/passwd-cwd")).toBe(false);
  // Required suffix and disallowed characters in the random segment.
  expect(re.test("/private/tmp/claude-mcp-browser-bridge-cwd")).toBe(false);
  expect(re.test("/private/tmp/claude-501")).toBe(false);
  // Leading anchor: a match starting anywhere but the beginning of the
  // string must not count. Losing the leading `^` is what would let a path
  // carrying this shape as a suffix — rather than being it — through.
  expect(re.test("/not-tmp/private/tmp/claude-9a9a-cwd")).toBe(false);
});

it("gives an agent this Task's record and denies it every other", () => {
  const declared = agentHomeFor("claude", WORKSPACE);
  expect(declared.state).toContain(join(lykeionClaude, "projects", KEY));
  expect(declared.private).toContain(join(lykeionClaude, "projects"));
});

it("seals what Lykeion wrote against the agent rewriting it", () => {
  expect(agentHomeFor("codex", WORKSPACE).sealed).toContain(join(lykeionCodex, "config.toml"));
});

it("declares nothing for an agent nobody has declared", () => {
  expect(agentHomeFor("gemini", WORKSPACE).state).toEqual([]);
});

/** Every installation of the researcher's own this machine has been found to
 *  reach. Written out by name rather than read back off `researcherHomes`,
 *  which is the list under test: a test fed by the thing it is checking
 *  passes just as happily with three of these deleted. */
const RESEARCHER_HOMES = [
  // One per catalogue entry, spelled out rather than mapped over `CATALOGUE`:
  // a list built from the same source as the code under test would keep
  // agreeing with it after an entry was dropped from both.
  ".claude",
  ".codex",
  ".gemini",
  ".copilot",
  ".cursor",
  ".opencode",
  ".kimi",
  ".kiro",
  ".qoder",
  ".codebuddy",
  ".hermes",
  ".openclaw",
  ".pi",
  // The XDG spelling of each of the above. A CLI following that convention
  // keeps nothing in `~/.<command>` at all, so the dotfile list alone would
  // deny a directory it does not use and leave the one it does.
  ".config/claude",
  ".config/codex",
  ".config/gemini",
  ".config/copilot",
  ".config/cursor",
  ".config/opencode",
  ".config/kimi",
  ".config/kiro",
  ".config/qoder",
  ".config/codebuddy",
  ".config/hermes",
  ".config/openclaw",
  ".config/pi",
  // The cross-tool stores, which belong to no entry and so derive from none.
  ".agents",
  ".gsd",
  ".mcp-auth",
];

it("denies whatever a row says its own CLI keeps things in", () => {
  // No row declares `researcherHome` yet, so this asserts nothing today —
  // deliberately. The rows plan writes eleven declarations, and the first one
  // that needs this field is the first chance to get it wrong; a test already
  // standing there is what turns that from a silent hole into a red suite.
  // The fixture above is hand-written for exactly that reason, so this cannot
  // agree with the code by sharing its source.
  for (const entry of CATALOGUE) {
    for (const declared of entry.isolation?.researcherHome ?? []) {
      expect(RESEARCHER_HOMES.map((name) => join(homedir(), name))).toContain(declared);
    }
  }
});

it("renders every researcher home as a deny the kernel reads after the allow that would open it", () => {
  // The one test that crosses the whole chain this branch exists to
  // establish: a row in `agent-registry`, through `confinementFor` and
  // `policyFor`, to the rule a kernel is actually handed. The two ends were
  // each covered on their own — `foreignHomes` names these paths above, and
  // `sandbox.test.ts` renders a hand-built policy — and nothing joined them,
  // so deleting the three homes commit 7d49809 added in answer to an
  // observed leak (`~/.agents`, `~/.gsd`, `~/.mcp-auth`) passed the entire
  // unit suite.
  //
  // Position, not mere presence. Seatbelt is last-match-wins, and every
  // declared agent is granted a blanket read over this home directory's
  // hidden entries so it can find its own configuration at all — see
  // `renderSeatbeltProfile`'s `hidden`. A deny rendered before that allow is
  // a deny the kernel never applies, which is a profile that looks right and
  // hands over `~/.claude/.credentials.json` anyway.
  const workspace = mkdtempSync(join(tmpdir(), "lykeion-agent-home-profile-"));
  const dataDir = mkdtempSync(join(tmpdir(), "lykeion-agent-home-state-"));
  try {
    // What a rule is written against: the kernel canonicalizes the path
    // being accessed, so `policyFor` resolves as far as each path exists,
    // and on a machine whose home is reached through a link the rendered
    // rule names the physical one.
    const physicalHome = realpathSync(home);
    for (const entry of CATALOGUE) {
      if (entry.isolation === undefined) continue;
      const profile = renderSeatbeltProfile(
        policyFor({ workspace, grants: [], dataDir, ...confinementFor(entry.id, workspace) }),
      ).split("\n");
      // The blanket read over hidden entries, which is the allow every one
      // of the denies below has to survive.
      const hiddenAllow = profile.findIndex((line) =>
        line.startsWith("(allow file-read* (regex"),
      );
      expect(hiddenAllow, `${entry.id}: no hidden-config allow rendered`).toBeGreaterThan(-1);
      for (const name of RESEARCHER_HOMES) {
        const denied = join(physicalHome, name);
        const deny = profile.findIndex(
          (line) => line.startsWith("(deny ") && line.includes(`(subpath "${denied}")`),
        );
        expect(deny, `${entry.id}: ${denied} is not denied`).toBeGreaterThan(-1);
        expect(deny, `${entry.id}: ${denied} is denied before it is allowed`).toBeGreaterThan(
          hiddenAllow,
        );
      }
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("names every installation to a policy that belongs to no agent", () => {
  const all = allAgentHomes(WORKSPACE);
  expect(all).toContain(lykeionClaude);
  expect(all).toContain(lykeionCodex);
  expect(all).toContain(claude);
  expect(all).toContain(join(home, ".codex"));
});

/**
 * The bug this pair of tests exists to stop coming back.
 *
 * Claude Code keeps its OAuth credential in the macOS login keychain, and
 * `credentialsOutsideHome` granted that store READ and nothing else — on the
 * belief, written into the declaration's own comment, that "a run proves who
 * it is, and never edits the record of who it is". Refreshing an OAuth token
 * rotates it, so that belief was false: the refresh succeeded at the server,
 * the new token could not be written back, and the next use of the spent one
 * was read as reuse and the grant revoked. A researcher saw
 * `401 OAuth access token has been revoked` on every turn while
 * `claude auth status` cheerfully answered `loggedIn: true`.
 *
 * What makes it worth two tests rather than one is that the obvious
 * experiment does not catch it. A turn run immediately after signing in
 * works — the access token is still valid. The failure arrives hours later,
 * at the first refresh.
 */
it("lets the one row with a rotating credential rewrite it, not merely read it", () => {
  const home = agentHomeFor("claude", WORKSPACE);
  const keychains = join(homedir(), "Library", "Keychains");
  // Read stays where it was.
  expect(home.credentials).toContain(keychains);
  // And the narrow write that a rotation actually needs: the database, its
  // SQLite siblings, and the directory entry they are created beside.
  expect(home.patterns.some((p) => new RegExp(p).test(join(keychains, "login.keychain-db")))).toBe(true);
  expect(home.patterns.some((p) => new RegExp(p).test(join(keychains, "login.keychain-db-wal")))).toBe(true);
  expect(home.patterns.some((p) => new RegExp(p).test(keychains))).toBe(true);
});

it("does not widen that write to the neighbours in the same directory", () => {
  const home = agentHomeFor("claude", WORKSPACE);
  const keychains = join(homedir(), "Library", "Keychains");
  // Every other keychain in there belongs to somebody else's secrets.
  for (const neighbour of ["metadata.keychain-db", "System.keychain", "anything-else"])
    expect(
      home.patterns.some((p) => new RegExp(p).test(join(keychains, neighbour))),
      `${neighbour} must not be writable`,
    ).toBe(false);
});

it("gives a row that declared no rotating credential no write outside its home", () => {
  // Codex keeps `auth.json` inside the directory `homeEnv` redirects, so it
  // needs none of this. A row gaining these patterns by accident is a
  // widening nobody asked for.
  const home = agentHomeFor("codex", WORKSPACE);
  const keychains = join(homedir(), "Library", "Keychains");
  expect(home.patterns.some((p) => new RegExp(p).test(join(keychains, "login.keychain-db")))).toBe(false);
});

it("renders that write as a rule the kernel will actually take", () => {
  // Not just declared — rendered. `patterns` is emitted as
  // `(allow file-read* file-write* (regex …))`, and a malformed regex makes
  // sandbox-exec reject the WHOLE profile rather than the one rule, which
  // does not look like a bad rule when it happens: it looks like an agent
  // that is no longer installed.
  const workspace = mkdtempSync(join(tmpdir(), "lykeion-kc-"));
  const dataDir = mkdtempSync(join(tmpdir(), "lykeion-kc-data-"));
  try {
    const profile = renderSeatbeltProfile(
      policyFor({ workspace, grants: [], dataDir, ...confinementFor("claude", workspace) }),
    ).split("\n");
    const rule = profile.find(
      (line) =>
        line.startsWith("(allow file-read* file-write* (regex") && line.includes("Keychains"),
    );
    expect(rule, "no writable keychain rule was rendered").toBeDefined();
    // And it is not defeated by a deny that comes after it.
    const allowAt = profile.indexOf(rule!);
    const denyAfter = profile.findIndex(
      (line, i) => i > allowAt && line.startsWith("(deny ") && line.includes("Keychains"),
    );
    expect(denyAfter, "a later deny takes the keychain write back").toBe(-1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  }
});
