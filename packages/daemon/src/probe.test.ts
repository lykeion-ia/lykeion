import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  adapterMissingReason,
  cliFingerprint,
  consentGap,
  probeAgentClis,
  resolveLaunch,
  signedOutReasonFor,
  type ProbedCli,
} from "./probe";
import { consentKey } from "./adapter-consent";
import { isolationFor } from "./agent-registry";
import type { AgentAuth } from "./agent-auth";
import { forgetRedirectProofs } from "./redirect";
import { DEMOTION_HOLD_SECONDS, forgetDemotions, recordDemotion } from "./agent-demotions";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  // Demotions are process-wide, so one recorded here would go on holding an
  // agent back through every later test in this file.
  forgetDemotions();
  // Rung 5 caches its answer per CLI build, and nearly every fixture here
  // calls itself the same version — so without this, a test asserting that a
  // redirect FAILS would inherit the previous test's "proven" and pass for a
  // reason that has nothing to do with its own fixture.
  forgetRedirectProofs();
});

function pathWith(commands: Record<string, string>): string {
  return pathRunning(
    Object.fromEntries(Object.entries(commands).map(([name, version]) => [name, `echo "${version}"`])),
  );
}

/** A PATH holding commands that do whatever is asked of them, for the cases
 *  where what a command says — and on which stream, and after how many blank
 *  lines — is the thing under test. */
/** A stand-in for this machine's state directory: its own, so denying it
 *  never reaches a fixture another helper put under the temp directory. */
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-probe-state-"));
  dirs.push(dir);
  return dir;
}

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

/** A fake `claude` that answers both questions the ladder asks it: which
 *  build it is, and — against whatever home it was pointed at — that nobody
 *  is signed in there. Rung 5 needs the second, and needs it in a shape the
 *  row's own reader recognises: a fixture that printed only a version was
 *  answering the redirect question with a usage error, which is not an answer
 *  at all. */
function claudeAnswering(version = "2.1.220"): string {
  return `if [ "$1" = "auth" ]; then printf '{"loggedIn":false}'; else echo "${version}"; fi`;
}

/** The same for `codex`, which has no `--json` for this and prints its
 *  refusal on stderr — see `agent-registry.ts`'s own note on why. */
function codexAnswering(version = "0.146.0"): string {
  return `if [ "$1" = "login" ]; then echo "Not logged in" >&2; else echo "${version}"; fi`;
}

/** The body of a minimal ACP adapter: reads the one line `initialize` writes
 *  to its stdin, answers it — `initialize` is always the first call on a
 *  fresh connection, so its id is always 1 — and lets the shell exit once
 *  that line is flushed. Enough to prove a real handshake happened, rather
 *  than assert against a canned "it would have worked". */
function acpHandshakeScript(): string {
  return 'read -r line\nprintf \'{"jsonrpc":"2.0","id":1,"result":{}}\\n\'';
}

/** An `authStates` override that reports each given agent id as signed in.
 *  Real `claude` and `codex` CLIs are commonly installed on a developer's own
 *  `PATH`, and `agentAuthStates`'s default asks whatever that resolves to —
 *  not the fixture a test built under its own throwaway `path` — so a probe
 *  test whose subject is adapter resolution or the ACP handshake, not
 *  sign-in, supplies this rather than depending on whether the machine
 *  running the suite happens to be signed in to the real thing. */
function signedIn(...agentIds: string[]): () => Promise<AgentAuth[]> {
  return async () => agentIds.map((agent) => ({ agent, name: agent, available: true, signedIn: true }));
}

/** The complement of `signedIn`: an `authStates` override that reports one
 *  agent as signed out, for the test that proves rung 6 itself — deleting
 *  the check in `probeAdapter` would make this test fail, where every other
 *  use of `signedIn` above would keep passing regardless. */
function signedOut(agentId: string): () => Promise<AgentAuth[]> {
  return async () => [{ agent: agentId, name: agentId, available: true, signedIn: false }];
}

it(
  "reports a command that is on PATH and answers",
  async () => {
    // A budget far past anything this needs, because what is being asserted
    // is that a command on PATH is found and its answer read — not how long
    // a loaded machine takes to start a shell script. What a real probe
    // allows a command, and what happens when one takes longer, is the
    // subject of its own test below.
    const clis = await probeAgentClis({ dataDir: stateDir(), path: pathWith({ claude: "1.2.3" }), timeoutMs: 30_000 });
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
    dataDir: stateDir(),
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
  const clis = await probeAgentClis({ dataDir: stateDir(), path: pathRunning({ claude: "exit 0" }), timeoutMs: 30_000 });
  const claude = clis.find((c) => c.id === "claude")!;
  expect(claude.available).toBe(true);
  expect(claude.version).toBe("");
});

it("reads a version a command answers on the error stream", async () => {
  const clis = await probeAgentClis({
    dataDir: stateDir(),
    path: pathRunning({ claude: 'echo "2026.2.21-2" >&2' }),
    timeoutMs: 30_000,
  });
  const claude = clis.find((c) => c.id === "claude")!;
  expect(claude.available).toBe(true);
  expect(claude.version).toBe("2026.2.21-2");
});

it("reads a version out of an answer that opens with a blank line", async () => {
  const clis = await probeAgentClis({
    dataDir: stateDir(),
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
    dataDir: stateDir(),
    path: pathRunning({
      claude: "exit 0",
      codex: 'printf ""',
      cursor: 'printf "   \\n\\n"',
      copilot: "exit 3",
    }),
    timeoutMs: 30_000,
  });
  const found = clis.filter((cli) => ["claude", "codex", "cursor", "copilot"].includes(cli.id));
  expect(found.map((cli) => [cli.id, cli.available, cli.version])).toEqual([
    ["claude", true, ""],
    ["codex", true, ""],
    ["copilot", true, ""],
    ["cursor", true, ""],
  ]);
  // And nothing else on the catalogue was invented into existence by a PATH
  // holding only those four.
  expect(clis.filter((cli) => cli.available).map((cli) => cli.id).sort()).toEqual([
    "claude",
    "codex",
    "copilot",
    "cursor",
  ]);
}, 60_000);

it("reports a command that is not installed, without inventing a version", async () => {
  const clis = await probeAgentClis({ dataDir: stateDir(), path: pathWith({}) });
  const claude = clis.find((c) => c.id === "claude")!;
  expect(claude.available).toBe(false);
  expect(claude.version).toBe("");
});

it("reports every catalogue entry, installed or not", async () => {
  const clis = await probeAgentClis({ dataDir: stateDir(), path: pathWith({ claude: "1.2.3" }) });
  expect(clis).toHaveLength(12);
});

it(
  "reports an agent as session-ready when its adapter handshakes",
  async () => {
    const path = pathRunning({
      claude: claudeAnswering(),
      "claude-agent-acp": acpHandshakeScript(),
    });
    const claude = (
      await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 30_000, authStates: signedIn("claude") })
    ).find((c) => c.id === "claude")!;
    expect(claude.available).toBe(true);
    expect(claude.sessionReady).toBe(true);
    expect("sessionReadyReason" in claude).toBe(false);
  },
  60_000,
);

it(
  "holds an agent back at rung 6 when its adapter would handshake but it is not signed in",
  async () => {
    // Same fixture as "reports an agent as session-ready when its adapter
    // handshakes" — a claude and an adapter that would answer `initialize`
    // successfully — with only `authStates` flipped. Without the rung 6
    // check in `probeAdapter`, this would resolve exactly like that test:
    // sessionReady true, no reason. What is under test is that the check
    // stops the handshake from ever being attempted.
    const path = pathRunning({
      claude: claudeAnswering(),
      "claude-agent-acp": acpHandshakeScript(),
    });
    const claude = (
      await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 30_000, authStates: signedOut("claude") })
    ).find((c) => c.id === "claude")!;
    expect(claude.available).toBe(true);
    expect(claude.sessionReady).toBe(false);
    expect(claude.sessionReadyReason).toBe(signedOutReasonFor("claude"));
  },
  60_000,
);

it(
  "holds an agent back for a cycle when its last turn said its sign-in is gone",
  async () => {
    // The CLI here says it IS signed in — the same fixture as the
    // session-ready test above, with the same `authStates` override. What
    // holds it back is a turn that failed, which is the only evidence that
    // the account rung 7 reads still has a working grant behind it. Supplying
    // `authStates` is deliberate: a demotion is a fact about this machine's
    // observed failures, not about which provider answered the auth
    // question, so filtering only the default path would let this through.
    recordDemotion("claude", "401 OAuth access token has been revoked");
    const path = pathRunning({
      claude: claudeAnswering(),
      "claude-agent-acp": acpHandshakeScript(),
    });
    const claude = (
      await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 30_000, authStates: signedIn("claude") })
    ).find((c) => c.id === "claude")!;
    expect(claude.available).toBe(true);
    expect(claude.sessionReady).toBe(false);
    expect(claude.sessionReadyReason).toBe(signedOutReasonFor("claude"));
  },
  60_000,
);

it(
  "offers an agent again once its demotion is older than a probe cycle",
  async () => {
    // The next cycle asks the CLI again. A researcher who signed back in is
    // offered the agent without restarting anything, which is the whole
    // reason this is a window rather than a latch.
    recordDemotion(
      "claude",
      "401 OAuth access token has been revoked",
      () => Math.floor(Date.now() / 1000) - DEMOTION_HOLD_SECONDS - 1,
    );
    const path = pathRunning({
      claude: claudeAnswering(),
      "claude-agent-acp": acpHandshakeScript(),
    });
    const claude = (
      await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 30_000, authStates: signedIn("claude") })
    ).find((c) => c.id === "claude")!;
    expect(claude.sessionReady).toBe(true);
  },
  60_000,
);

it("uses the maintained Claude adapter when it is the only bridge on PATH", async () => {
  const path = pathRunning({
    claude: claudeAnswering(),
    "claude-agent-acp": acpHandshakeScript(),
  });
  const resolved: string[] = [];
  const claude = (await probeAgentClis({
    dataDir: stateDir(),
    path,
    timeoutMs: 30_000,
    authStates: signedIn("claude"),
    onAdapterResolved: (agentId, launch) => {
      if (agentId === "claude") resolved.push(launch.command);
    },
  })).find((c) => c.id === "claude")!;
  expect(claude.sessionReady).toBe(true);
  expect(resolved).toEqual([join(path, "claude-agent-acp")]);
  // Rung 5 spawns the CLI through the boundary before the handshake does, so
  // this now starts two sandboxed children rather than one. vitest's default
  // is five seconds, which a loaded machine loses against for reasons that
  // have nothing to do with what is asserted here.
}, 30_000);

it("resolves the first declared adapter that is on PATH, keeping its own arguments", async () => {
  // The command comes back as the path it resolved to and the arguments come
  // back as the row declared them. Both halves matter: the resolved path is
  // what the boundary is rendered against, and the arguments are the half a
  // literal `args: []` used to throw away.
  const path = pathRunning({ "second-choice": "exit 0" });
  const launch = await resolveLaunch(
    [
      { command: "first-choice", args: ["--acp"], provenance: "community" },
      { command: "second-choice", args: ["--serve", "acp"], provenance: "protocol" },
    ],
    path,
  );
  expect(launch).toEqual({
    command: join(path, "second-choice"),
    args: ["--serve", "acp"],
    provenance: "protocol",
  });
});

it("answers nothing when no declared adapter is on PATH", async () => {
  const launch = await resolveLaunch(
    [{ command: "nowhere-at-all", args: [], provenance: "community" }],
    pathRunning({}),
  );
  expect(launch).toBeUndefined();
});

it("says the CLI is missing rather than blaming its isolation, when only the bridge is installed", async () => {
  // Installing the bridge and not the CLI it bridges to is an ordinary
  // mistake — they are separate packages. Rung 5 asks the CLI a question, and
  // a command that is not there fails to answer exactly like a wedged one
  // does, so without this the researcher is told their isolation could not be
  // verified and goes looking at their configuration instead of at the thing
  // they never installed.
  const path = pathRunning({ "claude-agent-acp": acpHandshakeScript() });
  const claude = (
    await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 30_000, authStates: signedIn("claude") })
  ).find((c) => c.id === "claude")!;
  expect(claude.available).toBe(false);
  expect(claude.sessionReady).toBe(false);
  expect(claude.sessionReadyReason).toMatch(/not installed/);
}, 30_000);

it("holds an agent back when its CLI ignores the home it was pointed at", async () => {
  // The test that makes a declaration written from documentation safe to
  // ship. This fake CLI reports the same signed-in answer no matter what it
  // is pointed at, which is exactly what a wrong `homeEnv` looks like from
  // outside. Without this rung the agent would be offered, every run would
  // read the researcher's own installation, and every other rung would still
  // be green — which is why nothing downstream could have caught it.
  const path = pathRunning({
    claude: 'if [ "$1" = "auth" ]; then printf \'{"loggedIn":true,"email":"r@lab.org"}\'; else echo "2.1.220"; fi',
    "claude-agent-acp": acpHandshakeScript(),
  });
  const claude = (
    await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 30_000, authStates: signedIn("claude") })
  ).find((c) => c.id === "claude")!;
  expect(claude.available).toBe(true);
  expect(claude.sessionReady).toBe(false);
  expect(claude.sessionReadyReason).toContain("CLAUDE_CONFIG_DIR");
}, 30_000);

it("offers an agent whose CLI answers signed out from a home it was pointed at", async () => {
  // The positive half. A CLI that honours the variable cannot be signed in to
  // a home created empty a moment ago, so answering "no" here is what earns
  // the agent its place rather than what disqualifies it.
  const path = pathRunning({
    claude: 'if [ "$1" = "auth" ]; then printf \'{"loggedIn":false}\'; else echo "2.1.220"; fi',
    "claude-agent-acp": acpHandshakeScript(),
  });
  const claude = (
    await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 30_000, authStates: signedIn("claude") })
  ).find((c) => c.id === "claude")!;
  expect(claude.sessionReady).toBe(true);
}, 30_000);

it("reports what an adapter said on its way to saying nothing", async () => {
  // Observed rather than imagined. A real CLI's ACP mode printed an
  // entitlement refusal to stderr and then held the connection open forever
  // without ever answering `initialize`. The process never exits, so there is
  // no exit code to read; what it wrote is the only account of why, and it is
  // the part a researcher can act on.
  // The budget has to clear the boundary's own startup — `sandbox-exec` plus
  // a shell — before it can mean "this adapter is not answering". Set below
  // that and the probe gives up while the child is still being created, so
  // there is nothing on stderr yet and this passes or fails on how loaded the
  // machine is rather than on what the adapter did.
  const path = pathRunning({
    claude: 'if [ "$1" = "auth" ]; then printf \'{"loggedIn":false}\'; else echo "2.1.220"; fi',
    "claude-agent-acp": 'echo "IneligibleTierError: this client is no longer supported" >&2\nsleep 30',
  });
  const claude = (
    await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 8_000, authStates: signedIn("claude") })
  ).find((c) => c.id === "claude")!;
  expect(claude.sessionReady).toBe(false);
  expect(claude.sessionReadyReason).toContain("IneligibleTierError");
}, 15_000);

it("says where a silent adapter stopped, rather than only that time ran out", async () => {
  // The same failure with nothing on stderr. A bare "did not answer within
  // 8000ms" names a budget and not a place, so it reads identically to a
  // machine that was merely busy — and the researcher cannot tell whether to
  // wait, retry, or go and fix something.
  //
  // Same budget as the test above, for the same reason: below the boundary's
  // startup cost this would assert the right message about an adapter that
  // had not started yet, which proves nothing about a silent one.
  const path = pathRunning({
    claude: 'if [ "$1" = "auth" ]; then printf \'{"loggedIn":false}\'; else echo "2.1.220"; fi',
    "claude-agent-acp": "sleep 30",
  });
  const claude = (
    await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 8_000, authStates: signedIn("claude") })
  ).find((c) => c.id === "claude")!;
  expect(claude.sessionReady).toBe(false);
  expect(claude.sessionReadyReason).toMatch(/never completed the ACP handshake/);
}, 15_000);

it("does not call an adapter that died a slow one, however quiet it was", async () => {
  // An adapter that EXITS silently is not one that ran out of time, and the
  // handshake sentence would be a plain lie about it. The two are told apart
  // by the rejection's own type rather than by matching on its wording, which
  // an edit to that wording would silently reclassify.
  const path = pathRunning({
    claude: 'if [ "$1" = "auth" ]; then printf \'{"loggedIn":false}\'; else echo "2.1.220"; fi',
    "claude-agent-acp": "exit 3",
  });
  const claude = (
    await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 30_000, authStates: signedIn("claude") })
  ).find((c) => c.id === "claude")!;
  expect(claude.sessionReady).toBe(false);
  expect(claude.sessionReadyReason).not.toMatch(/never completed the ACP handshake/);
  // The same 15s override its two siblings carry. This one exits immediately
  // rather than hanging, so it does not spend the probe's budget — but it
  // still starts a child through `sandbox-exec` and a shell, and vitest's own
  // default is 5s, which a loaded machine can lose against for reasons that
  // have nothing to do with what this asserts.
}, 15_000);

it("holds a community adapter nobody has accepted, naming what accepting it allows", () => {
  // The sentence has to carry the two capabilities, because those are what is
  // being agreed to: the adapter runs beside this agent's sign-in, and it can
  // reach the network. A prompt that says only "third-party" asks a
  // researcher to agree to something it never described to them.
  const gap = consentGap(
    { id: "antigravity", name: "Antigravity" },
    { command: "agy-acp", args: [], provenance: "community" },
    new Set<string>(),
  );
  expect(gap).toBeDefined();
  expect(gap).toContain("agy-acp");
  expect(gap).toMatch(/sign-in|credential/i);
  expect(gap).toMatch(/network/i);
});

it("lets a community adapter through once it has been accepted for that agent", () => {
  const accepted = new Set([consentKey("antigravity", "agy-acp")]);
  expect(
    consentGap(
      { id: "antigravity", name: "Antigravity" },
      { command: "agy-acp", args: [], provenance: "community" },
      accepted,
    ),
  ).toBeUndefined();
});

it("does not carry an acceptance from one agent to another", () => {
  // Accepting a program to run as one agent is not accepting it beside a
  // different agent's credential, which is the whole reason the key has two
  // halves rather than naming the program alone.
  const accepted = new Set([consentKey("kiro", "agy-acp")]);
  expect(
    consentGap(
      { id: "antigravity", name: "Antigravity" },
      { command: "agy-acp", args: [], provenance: "community" },
      accepted,
    ),
  ).toBeDefined();
});

it("never asks about an adapter the vendor or the ACP project publishes", () => {
  for (const provenance of ["vendor", "protocol"] as const) {
    expect(
      consentGap(
        { id: "codex", name: "Codex" },
        { command: "codex-acp", args: [], provenance },
        new Set<string>(),
      ),
    ).toBeUndefined();
  }
});

it("does not gate an adapter whose provenance the catalogue already vouches for", async () => {
  // The gate firing on a row it should not would take a working agent off the
  // page silently — `sessionReady: false` for a reason nobody was expecting.
  // Read from the real declaration rather than an injected one, so this stays
  // true if a row's provenance is ever revised.
  const path = pathRunning({
    claude: 'if [ "$1" = "auth" ]; then printf \'{"loggedIn":false}\'; else echo "2.1.220"; fi',
    "claude-agent-acp": acpHandshakeScript(),
  });
  const claude = (
    await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 30_000, authStates: signedIn("claude") })
  ).find((c) => c.id === "claude")!;
  if (isolationFor("claude")!.adapters[0]!.provenance === "community") {
    expect(claude.sessionReadyReason).toMatch(/accept/i);
  } else {
    expect(claude.sessionReady).toBe(true);
  }
}, 30_000);

it("names the CLI rather than a bridge when the adapter IS the CLI", () => {
  // A row whose adapter command is its own command is a CLI that speaks ACP
  // itself. Telling that researcher to install an ACP adapter describes a
  // program nobody publishes and sends them looking for it.
  expect(
    adapterMissingReason({ id: "x", name: "Example", command: "example" }, [
      { command: "example", args: ["--acp"], provenance: "vendor" },
    ]),
  ).toMatch(/install Example/);
  // And the ordinary case still names the bridge, so the sentence only
  // changes for the rows that actually differ.
  expect(
    adapterMissingReason({ id: "y", name: "Other", command: "other" }, [
      { command: "other-acp", args: [], provenance: "community" },
    ]),
  ).toContain("other-acp");
});

it("never launches a bridge this daemon does not declare, even sitting beside one it does", async () => {
  // The deprecated bridge is on PATH and fails loudly if it is ever started,
  // so this is not "the right one was preferred" — it is "the other one was
  // not run at all", which is what dropping it from `adapters` has to mean.
  const path = pathRunning({
    claude: claudeAnswering(),
    "claude-agent-acp": acpHandshakeScript(),
    "claude-code-acp": "echo deprecated-bridge-was-launched >&2\nexit 1",
  });
  const claude = (
    await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 30_000, authStates: signedIn("claude") })
  ).find((c) => c.id === "claude")!;
  expect(claude.sessionReady).toBe(true);
  expect(claude.sessionReadyReason ?? "").not.toContain("deprecated-bridge-was-launched");
  // Two sandboxed children now, not one: rung 5 spawns the CLI through the
  // boundary before the handshake does. vitest's default is five seconds.
}, 30_000);

it("holds claude back when the only bridge on PATH is one this daemon dropped", async () => {
  // There is no compatibility fallback any more. A machine carrying only
  // `claude-code-acp` is a machine that cannot run this agent properly, and
  // the honest report is not-ready with a reason — not a session opened
  // through a bridge that cannot carry a plan.
  const path = pathRunning({
    claude: claudeAnswering(),
    "claude-code-acp": acpHandshakeScript(),
  });
  const claude = (
    await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 30_000, authStates: signedIn("claude") })
  ).find((c) => c.id === "claude")!;
  expect(claude.available).toBe(true);
  expect(claude.sessionReady).toBe(false);
  expect(claude.sessionReadyReason).toMatch(/adapter/i);
  // Two sandboxed children now, not one: rung 5 spawns the CLI through the
  // boundary before the handshake does. vitest's default is five seconds.
}, 30_000);

/** An adapter that handshakes, then advertises a mode named `witnessed` only
 *  when the isolation under test actually reached it — a probe's boundary
 *  denies writes outside its throwaway workspace, so what the adapter saw is
 *  answered back through `session/new` rather than dropped in a file. */
function witnessingAdapterScript(check: string): string {
  return [
    "read -r line",
    'printf \'{"jsonrpc":"2.0","id":1,"result":{}}\\n\'',
    "read -r line",
    `if ${check}; then marker=witnessed; else marker=missed; fi`,
    'printf \'{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1","modes":{"currentModeId":"%s","availableModes":[{"id":"%s","name":"Witness"},{"id":"other","name":"Other"}]}}}\\n\' "$marker" "$marker"',
    "read -r line || true",
  ].join("\n");
}

it("opens its throwaway claude session with the same isolation a real one carries", async () => {
  // A probe's session is a real session an agent could act in, so the
  // owner's registries are shut out of it the same way: the `_meta` that
  // empties the settings sources and holds MCP config strict rides the
  // probe's `session/new` too.
  const path = pathRunning({
    claude: claudeAnswering(),
    "claude-agent-acp": witnessingAdapterScript(
      'case "$line" in *\'"settingSources":[]\'*\'"strictMcpConfig":true\'*) true ;; *) false ;; esac',
    ),
  });
  const claude = (
    await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 30_000, authStates: signedIn("claude") })
  ).find((c) => c.id === "claude")!;
  expect(claude.sessionReady).toBe(true);
  const mode = claude.options?.find((option) => option.id === "mode");
  expect(mode?.currentValue).toBe("witnessed");
  // Two sandboxed children now, not one: rung 5 spawns the CLI through the
  // boundary before the handshake does. vitest's default is five seconds.
}, 30_000);

it("spawns its throwaway codex session with the registryless base config a real one gets", async () => {
  const path = pathRunning({
    codex: codexAnswering(),
    // The exact directory, not merely a non-empty one: a probe that spawned
    // its adapter with the researcher's own CODEX_HOME still passes
    // `[ -n "$CODEX_HOME" ]`, which is the one failure this witness exists
    // to catch.
    "codex-acp": witnessingAdapterScript(
      `[ "$CODEX_HOME" = ${JSON.stringify(join(homedir(), ".lykeion", "agents", "codex"))} ]`,
    ),
  });
  const codex = (
    await probeAgentClis({ dataDir: stateDir(), path, timeoutMs: 30_000, authStates: signedIn("codex") })
  ).find((c) => c.id === "codex")!;
  expect(codex.sessionReady).toBe(true);
  const mode = codex.options?.find((option) => option.id === "mode");
  expect(mode?.currentValue).toBe("witnessed");
  // Two sandboxed children now, not one: rung 5 spawns the CLI through the
  // boundary before the handshake does. vitest's default is five seconds.
}, 30_000);

it("says the CLI is there but the adapter is not, rather than calling it absent", async () => {
  const claude = (await probeAgentClis({ dataDir: stateDir(), path: pathWith({ claude: "2.1.220" }) })).find(
    (c) => c.id === "claude",
  )!;
  expect(claude.available).toBe(true);
  expect(claude.sessionReady).toBe(false);
  expect(claude.sessionReadyReason).toMatch(/adapter/i);
});

it("carries what initialize refused with, so a version floor is named", async () => {
  const path = pathRunning({
    claude: claudeAnswering("1.0.0"),
    "claude-agent-acp": "echo 'needs claude >= 2.0.0' >&2\nexit 1",
  });
  const claude = (
    await probeAgentClis({ dataDir: stateDir(), path, authStates: signedIn("claude") })
  ).find((c) => c.id === "claude")!;
  expect(claude.sessionReady).toBe(false);
  expect(claude.sessionReadyReason).toContain("needs claude >= 2.0.0");
});

it("has no adapter to try for a catalogue entry that speaks no ACP yet, and says whose gap that is", async () => {
  // `copilot` carries no adapter mapping at all — unlike `claude`, there is
  // no second binary to look for, so this settles without spawning anything.
  //
  // What it says matters as much as that it stops. The reason used to name an
  // ACP adapter, which reads as an errand a researcher could run; the missing
  // thing is this daemon's own declaration row, and no amount of installing
  // supplies one.
  //
  // This used to be asked of `gemini`, whose row is now deleted rather than
  // undeclared — its vendor switched the product off in June 2026, and a row
  // waiting to be filled in is a different thing from one that can never be.
  const copilot = (await probeAgentClis({ dataDir: stateDir(), path: pathWith({ copilot: "1.0.0" }) })).find(
    (c) => c.id === "copilot",
  )!;
  expect(copilot.available).toBe(true);
  expect(copilot.sessionReady).toBe(false);
  expect(copilot.sessionReadyReason).toContain("Copilot");
  expect(copilot.sessionReadyReason).not.toMatch(/install/i);
});

it("does not treat a non-executable file as a command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-probe-"));
  dirs.push(dir);
  writeFileSync(join(dir, "claude"), "not executable");
  const clis = await probeAgentClis({ dataDir: stateDir(), path: dir });
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
  const claude = (await probeAgentClis({ dataDir: stateDir(), path: dir, timeoutMs: 200 })).find((c) => c.id === "claude")!;
  expect(claude.available).toBe(true);
  expect(claude.version).toBe("");
}, 10_000);

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

it("cliFingerprint differs when sessionReadyReason changes with sessionReady staying false", () => {
  // Rung 6's own case: install an ACP adapter for an agent that is not yet
  // signed in, and sessionReady stays false straight through that step —
  // id, version, available and sessionReady are all unchanged. The reason
  // moving from "no adapter" to "not signed in" is the only fact that says
  // anything happened, and it is exactly the fact a researcher needs the
  // dock to catch up on.
  const before: ProbedCli[] = [
    {
      id: "claude",
      name: "Claude Code",
      command: "claude",
      version: "1.0.0",
      available: true,
      sessionReady: false,
      sessionReadyReason: "no ACP adapter is known for claude yet",
    },
  ];
  const after: ProbedCli[] = [{ ...before[0]!, sessionReadyReason: "not signed in" }];
  expect(cliFingerprint(before)).not.toBe(cliFingerprint(after));
});

it("cliFingerprint differs when an agent that offered nothing knowable now offers a catalogue", () => {
  // The case this exists for. A probe that reaches an adapter but cannot
  // open a throwaway session — installed but not signed in, an entitlement
  // refused — leaves the options UNKNOWN and everything else identical. Not
  // counted here, the successful probe five minutes later compared equal to
  // the failed one and was dropped, so the lab kept "unknown" for the life
  // of the daemon and the composer offered a bare Default against an agent
  // with a whole catalogue to give.
  const before: ProbedCli[] = [
    { id: "codex", name: "Codex", command: "codex", version: "1.0.0", available: true, sessionReady: true },
  ];
  const after: ProbedCli[] = [
    {
      ...before[0]!,
      options: [
        {
          id: "model",
          category: "model",
          currentValue: "gpt-5.6-sol",
          choices: [{ value: "gpt-5.6-sol", label: "GPT-5.6-Sol" }],
        },
      ],
    },
  ];
  expect(cliFingerprint(before)).not.toBe(cliFingerprint(after));
});

it("cliFingerprint differs when an agent's catalogue itself changes", () => {
  // A provider shipping a model is a change the lab has to see: the id,
  // version, availability and readiness are all untouched by it.
  const base: ProbedCli = {
    id: "codex", name: "Codex", command: "codex", version: "1.0.0",
    available: true, sessionReady: true,
  };
  const withOne: ProbedCli[] = [
    {
      ...base,
      options: [
        { id: "model", category: "model", currentValue: "gpt-5.5", choices: [{ value: "gpt-5.5", label: "GPT-5.5" }] },
      ],
    },
  ];
  const withTwo: ProbedCli[] = [
    {
      ...base,
      options: [
        {
          id: "model",
          category: "model",
          currentValue: "gpt-5.5",
          choices: [
            { value: "gpt-5.5", label: "GPT-5.5" },
            { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
          ],
        },
      ],
    },
  ];
  expect(cliFingerprint(withOne)).not.toBe(cliFingerprint(withTwo));
});

it("offers no agent at all on a platform whose runs cannot be confined", async () => {
  const clis = await probeAgentClis({ dataDir: stateDir(), path: "", platform: "linux" });
  expect(clis.length).toBeGreaterThan(0);
  for (const cli of clis) {
    expect(cli.sessionReady).toBe(false);
    expect(cli.sessionReadyReason).toMatch(/linux/);
  }
});

it(
  "reports what an agent advertised when a session was opened with it",
  async () => {
    const advertises = {
      models: {
        currentModelId: "sonnet",
        availableModels: [
          { modelId: "opus", name: "Opus" },
          { modelId: "sonnet", name: "Sonnet" },
        ],
      },
    };
    const clis = await probeAgentClis({
    dataDir: stateDir(),
      path: pathRunning({
        // The CLI itself, answering signed-out against whatever home it is
        // pointed at, because rung 5 asks it that before any adapter starts.
        claude: 'if [ "$1" = "auth" ]; then printf \'{"loggedIn":false}\'; else echo "2.1.220"; fi',
        "claude-agent-acp": [
          "read -r line",
          `printf '{"jsonrpc":"2.0","id":1,"result":{}}\\n'`,
          "read -r line",
          `printf '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s","models":{"currentModelId":"sonnet","availableModels":[{"modelId":"opus","name":"Opus"},{"modelId":"sonnet","name":"Sonnet"}]}}}\\n'`,
          "read -r line",
        ].join("\n"),
      }),
      timeoutMs: 30_000,
      authStates: signedIn("claude"),
    });
    const claude = clis.find((c) => c.id === "claude")!;
    expect(claude.sessionReady).toBe(true);
    expect(claude.options).toEqual([
      {
        id: "model",
        category: "model",
        currentValue: advertises.models.currentModelId,
        choices: [
          { value: "opus", label: "Opus" },
          { value: "sonnet", label: "Sonnet" },
        ],
      },
    ]);
  },
  60_000,
);

it(
  "leaves what an agent offers unknown when no session could be opened to ask",
  async () => {
    const clis = await probeAgentClis({
    dataDir: stateDir(),
      path: pathRunning({
        // The CLI itself, answering signed-out against whatever home it is
        // pointed at, because rung 5 asks it that before any adapter starts.
        claude: 'if [ "$1" = "auth" ]; then printf \'{"loggedIn":false}\'; else echo "2.1.220"; fi',
        // Answers the handshake and refuses to open a session.
        "claude-agent-acp": [
          "read -r line",
          `printf '{"jsonrpc":"2.0","id":1,"result":{}}\\n'`,
          "read -r line",
          `printf '{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"not entitled"}}\\n'`,
          "read -r line",
        ].join("\n"),
      }),
      timeoutMs: 30_000,
      authStates: signedIn("claude"),
    });
    const claude = clis.find((c) => c.id === "claude")!;
    // The handshake still earned `sessionReady`; what it offers is absent
    // rather than reported as nothing, which is a different fact.
    expect(claude.sessionReady).toBe(true);
    expect(claude.options).toBeUndefined();
  },
  60_000,
);

it(
  "never runs a CLI it cannot confine, and still reports it as installed",
  async () => {
    const escaped = join(mkdtempSync(join(tmpdir(), "lykeion-probe-escape-")), "ran.txt");
    const clis = await probeAgentClis({
    dataDir: stateDir(),
      // A "CLI" that records having been executed at all.
      path: pathRunning({ claude: `echo ran > ${escaped}\necho "9.9.9"` }),
      platform: "linux",
      timeoutMs: 30_000,
    });
    const claude = clis.find((c) => c.id === "claude")!;
    // Found on PATH, so it is installed; never executed, so its build is
    // unknown — a narrower claim than a version, and a true one.
    expect(claude.available).toBe(true);
    expect(claude.version).toBe("");
    expect(existsSync(escaped)).toBe(false);
  },
  60_000,
);

it(
  "confines the CLI it asks for a version, so a probe cannot be an escape either",
  async () => {
    const escaped = join(mkdtempSync(join(tmpdir(), "lykeion-probe-escape-")), "ran.txt");
    const clis = await probeAgentClis({
    dataDir: stateDir(),
      path: pathRunning({ claude: `echo escaped > ${escaped}\necho "1.2.3"` }),
      timeoutMs: 30_000,
    });
    const claude = clis.find((c) => c.id === "claude")!;
    // It answered, so it really ran — and it still could not write outside
    // the throwaway directory the probe confined it to.
    expect(claude.version).toBe("1.2.3");
    expect(existsSync(escaped)).toBe(false);
  },
  60_000,
);

it("names the agent rather than a command a researcher has to copy", () => {
  // The daemon runs the flow; the researcher presses a button on the pairing
  // page. This string is what the dock shows to whoever skipped that.
  const reason = signedOutReasonFor("claude");
  expect(reason).toContain("Claude Code");
  expect(reason).toContain("not signed in");
  expect(reason).not.toContain("CLAUDE_CONFIG_DIR");
});

it("says nothing about signing in to an agent nobody has declared", () => {
  expect(signedOutReasonFor("copilot")).toBeUndefined();
});

it("runs a command in the directory its boundary was rendered for, not the one the daemon was started in", async () => {
  // A command whose "version" is wherever it was run. The profile allows the
  // throwaway workspace and nothing else, so a child left in the daemon's own
  // directory cannot reach the directory it is standing in — and a program
  // that cannot do that never gets as far as printing anything.
  const clis = await probeAgentClis({
    dataDir: stateDir(),
    path: pathRunning({ claude: "pwd" }),
    timeoutMs: 30_000,
  });
  const claude = clis.find((c) => c.id === "claude")!;
  expect(claude.available).toBe(true);
  expect(claude.version).not.toBe("");
  expect(claude.version).toContain("lykeion-probe-");
  expect(claude.version).not.toBe(process.cwd());
});
