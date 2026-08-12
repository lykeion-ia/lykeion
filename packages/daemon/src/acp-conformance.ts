/**
 * Holds any ACP adapter to one set of behaviours the daemon's own session
 * pipeline depends on: that a session actually opens, that a prompt produces
 * prose, that a tool call and a permission request land the way `session.ts`
 * turns them into an `ExecutionLogEntry` and a `PermissionRequest`, that a
 * session's tools are the ones named on `session/new` and no others, that a
 * plan surfaces, and that a turn a researcher stops actually stops.
 *
 * The stub every other daemon test drives is one adapter this is pointed at.
 * Real coding-agent adapters — `claude-agent-acp` and `codex-acp`, the two
 * the catalogue declares — are the others, and they do not share the stub's timing,
 * tool names or prose. Every assertion below is written against the *shape*
 * of what an adapter produces — an event kind, a non-empty string, a
 * terminal state — never against wording only the stub would say.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@lykeion/api";
import { connectAcp } from "./acp";
import { confinementFor } from "./agent-home";
import { confine, policyFor } from "./sandbox";
import { startSession, type LiveSession, type McpServer } from "./session";

/** Vitest's own timeout for a single test — long enough that a real agent's
 *  reply, shaped by a model call rather than the milliseconds the stub
 *  answers in, is never mistaken for a broken adapter. One test's budget
 *  covers opening the session as well as the turn: spawning a cold CLI,
 *  handshaking and getting a session id back can itself take several seconds
 *  before the model is asked anything, and a behaviour that then has to make
 *  a tool call or produce a plan needs what is left to still be a model's
 *  worth of time. */
const TEST_TIMEOUT_MS = 60_000;

/** The permission behaviour waits twice in series against a real model: a card appearing
 *  — which a real adapter may spend a whole model turn deciding to raise,
 *  trying the write inside its own sandbox first and only then escalating —
 *  then answering however many cards the write takes (a stat or a read of
 *  the target before the write itself is a plausible second ask), and only
 *  then a full turn actually finishing. `TEST_TIMEOUT_MS` split across all
 *  of that is tight; this gives it real room without lengthening the other
 *  six. */
const PERMISSION_TEST_TIMEOUT_MS = 150_000;

/** How much slack this suite's own deadline leaves inside Vitest's own test
 *  timeout, so THIS suite's diagnostic — which behaviour, and what was
 *  observed — is what a run actually reports, rather than Vitest's generic
 *  "test timed out" arriving a moment later and replacing it. */
const DEADLINE_SAFETY_MARGIN_MS = 5_000;

/** One deadline for everything a test waits on, computed once at the top of
 *  each `it` and threaded through every `withTimeout`/`waitFor` call inside
 *  it. A test that waits more than once — opening a session, then waiting on
 *  an event; finding a card, then waiting on a turn to finish — spends down
 *  one shared budget this way, rather than each wait getting a fresh
 *  `testTimeoutMs` of its own and the two together silently doubling what
 *  the test is actually allowed to take. */
function deadlineFor(testTimeoutMs: number): number {
  return Date.now() + testTimeoutMs - DEADLINE_SAFETY_MARGIN_MS;
}

/** The same handshake `session.ts` opens every real session with — a probe
 *  of a behaviour asks the same question a session start would, so passing
 *  it never claims more than starting a session for real could cash in. */
const INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
};

type AdapterFactory = () => {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** Which agent this adapter speaks for, so a conformance session is
   *  confined exactly as a real one is — its own credentials and state
   *  included, without which the adapter answers every prompt by saying it
   *  is not signed in. */
  agent: string;
};

/** How much of the events a behaviour actually saw are worth keeping in a
 *  failure message — enough to show the shape of what happened, bounded so a
 *  chatty adapter's tool output cannot grow a failure message without limit. */
const EVENTS_DUMP_MAX_CHARS = 4000;

function eventsDump(events: RunEvent[]): string {
  const dump = JSON.stringify(events);
  return `events observed: ${dump.length > EVENTS_DUMP_MAX_CHARS ? `…${dump.slice(-EVENTS_DUMP_MAX_CHARS)}` : dump}`;
}

/** Races one ACP request against `deadline`, so a request that never answers
 *  fails with which behaviour was waiting on it and whatever stderr is
 *  available, rather than surfacing as Vitest's generic timeout with
 *  neither. */
function withTimeout<T>(
  promise: Promise<T>,
  behaviour: string,
  deadline: number,
  stderrTail: () => string,
): Promise<T> {
  const remainingMs = Math.max(0, deadline - Date.now());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `conformance: "${behaviour}" did not happen within the ${remainingMs}ms left on this test's deadline.\nstderr: ${stderrTail()}`,
        ),
      );
    }, remainingMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Polls `check` until it is true or `deadline` passes. `check` is called on
 *  every tick before it is asked whether the condition holds, so a caller
 *  waiting on an outcome that depends on answering a card the adapter raised
 *  along the way — approving a permission request so a turn can actually
 *  reach the log entry or plan being waited for — can fold that answering
 *  into the same loop rather than a second one racing it. Whatever `check`
 *  throws is caught and turned into this promise's own rejection: thrown
 *  from inside a `setTimeout` callback, it would otherwise escape uncaught
 *  by anything awaiting this call. */
function waitFor(
  behaviour: string,
  check: () => boolean,
  events: RunEvent[],
  deadline: number,
  stderrTail: () => string,
): Promise<void> {
  const budgetMs = Math.max(0, deadline - Date.now());
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      let holds: boolean;
      try {
        holds = check();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (holds) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(
          new Error(
            `conformance: "${behaviour}" did not happen within the ${budgetMs}ms left on this test's deadline.\n${eventsDump(events)}\nstderr: ${stderrTail()}`,
          ),
        );
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

/** Answers every permission card seen so far and not yet answered, allowing
 *  once. Used by behaviours that need a turn to actually finish and are not
 *  themselves testing the permission flow — a real adapter asked to do
 *  something as ordinary as list a directory may still gate it, and a
 *  behaviour that is not about permissions must not hang on that gate. */
function autoApprove(session: LiveSession, events: RunEvent[], answered: Set<string>): void {
  for (const event of events) {
    if (event.event !== "permission-card") continue;
    if (answered.has(event.request.id)) continue;
    answered.add(event.request.id);
    session.decide({
      action: "permission",
      requestId: event.request.id,
      decision: { decision: "allow", scope: "once" },
    });
  }
}

/**
 * A whole MCP stdio server in one file, written into a session's workspace so
 * the adapter's boundary can read it and the server itself can write markers
 * beside it. It publishes one tool. Which markers appear, and what the
 * `called` marker contains, is how the behaviour below tells three facts
 * apart: `connected` — the server entry survived the adapter's own schema
 * (the shipped bug was an entry silently dropped there); `listed` — the
 * adapter asked what tools it has; `called` — the tool ran, and the marker
 * carries the env variable the client named on `session/new`, which nothing
 * but the `env` field could have delivered.
 */
const PROBE_MCP_SOURCE = `
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { createInterface } = require("node:readline");
const markers = process.argv[2];
const mark = (name, text) => appendFileSync(join(markers, name), (text ?? "") + "\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    mark("connected");
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "lykeion-conformance-probe", version: "1" },
    } });
    return;
  }
  if (msg.method === "tools/list") {
    mark("listed");
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{
      name: "conformance_probe",
      description: "Answers with this server's probe value. Takes no arguments.",
      inputSchema: { type: "object", properties: {} },
    }] } });
    return;
  }
  if (msg.method === "tools/call") {
    const value = process.env.LYKEION_CONFORMANCE_PROBE ?? "";
    mark("called", value);
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: value }] } });
    return;
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
`;

/** The MCP server names the machine owner's own registries hold, read by the
 *  test process itself — which runs unconfined, as the owner. What they name
 *  is exactly what must never surface inside a session: the user-scope
 *  registry (`~/.claude.json`) and codex's `config.toml` are the two files
 *  the per-agent isolation channels exist to shut out. Silently empty where
 *  a registry is absent — a CI machine, the stub — since a name that does
 *  not exist cannot leak. */
function ownRegistryServers(agent: string): string[] {
  try {
    if (agent === "claude") {
      const parsed = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      return Object.keys(parsed.mcpServers ?? {});
    }
    if (agent === "codex") {
      const config = readFileSync(join(homedir(), ".codex", "config.toml"), "utf8");
      return [...config.matchAll(/\[mcp_servers\.([^.\]]+)\]/g)]
        .map((match) => match[1] ?? "")
        .filter((name) => name.length > 0);
    }
  } catch {
    // Unreadable is indistinguishable from absent for this purpose.
  }
  return [];
}

function escapedForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The adapter command, wrapped so even a behaviour that drives ACP directly
 * runs inside a boundary. Two of the checks below talk to the connection
 * rather than to a `LiveSession`, and a real adapter spawned that way is
 * still the researcher's own agent CLI executing on their machine — "never
 * launch an unsandboxed run" is not a rule about which caller asked.
 */
function confinedFor(
  agent: string,
  cwd: string,
  command: string,
  args: string[],
): [string, string[]] {
  const dataDir = mkdtempSync(join(tmpdir(), "lykeion-acp-conformance-state-"));
  const confined = confine(
    process.platform,
    policyFor({ workspace: cwd, grants: [], dataDir, ...confinementFor(agent, cwd) }),
    { command, args },
  );
  return [confined.command, confined.args];
}

export function acpConformance(
  name: string,
  adapter: AdapterFactory,
  opts?: {
    /** How many times a failed behaviour is retried before it counts as
     *  red. Zero for the stub, whose script is deterministic and whose
     *  failures must stay loud on the first try; the certified adapters
     *  answer through a real model, and one unlucky turn — prose where a
     *  plan was asked for, a refusal where an escalation was — must not be
     *  read as a broken adapter. Vitest does not run `afterEach` between
     *  retries; `openings`/`live` already tolerate several sessions per
     *  test, and the hooks close them all. */
    retry?: number;
  },
): void {
  const retry = opts?.retry ?? 0;
  describe(name, () => {
    const dirs: string[] = [];
    const live: LiveSession[] = [];
    /** Every session start this block has begun, settled or not. A start that
     *  outruns the test that asked for it lands in `live` late, so cleanup has
     *  to wait on these before it can know what there is to close. */
    const openings: Promise<void>[] = [];

    afterEach(async () => {
      for (const session of live.splice(0)) await session.close();
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    // The last test in this block has no next test whose `afterEach` could
    // pick up a session that opened after it gave up, so an adapter that
    // spawns slowly would otherwise be left running past the suite.
    afterAll(async () => {
      await Promise.all(openings);
      for (const session of live.splice(0)) await session.close();
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function workspace(): string {
      const dir = mkdtempSync(join(tmpdir(), "lykeion-acp-conformance-"));
      dirs.push(dir);
      return dir;
    }

    async function openSession(
      deadline: number,
      opts?: { cwd?: string; mcpServers?: McpServer[] },
    ): Promise<{ session: LiveSession; events: RunEvent[] }> {
      const { command, args, env, agent } = adapter();
      const events: RunEvent[] = [];
      const starting = startSession({
        adapter: { command, args },

        agent,
        cwd: opts?.cwd ?? workspace(),
        dataDir: mkdtempSync(join(tmpdir(), "lykeion-acp-conformance-state-")),
        grants: [],
        onEvent: (event) => events.push(event),
        onGrant: () => {},
        env,
        ...(opts?.mcpServers === undefined ? {} : { mcpServers: opts.mcpServers }),
      });
      // Tracked against the eventual settlement of `starting` itself, not
      // against the `withTimeout` race below: a session that finishes
      // opening after this test has already given up on the clock is still
      // a live subprocess this suite spawned, and `afterEach` must still be
      // able to close it — losing the race below must not also lose the
      // cleanup.
      openings.push(starting.then((session) => void live.push(session), () => {}));
      const session = await withTimeout(
        starting,
        "a session opens",
        deadline,
        () => "no session opened yet — nothing to read stderr from",
      );
      return { session, events };
    }

    it(
      "completes initialize",
      async () => {
        const deadline = deadlineFor(TEST_TIMEOUT_MS);
        const { command, args, env, agent } = adapter();
        const cwd = workspace();
        const connection = await connectAcp(...confinedFor(agent, cwd, command, args), {
          cwd,
          env,
        });
        try {
          const result = await withTimeout(
            connection.request("initialize", INITIALIZE_PARAMS),
            "initialize completes",
            deadline,
            () => connection.stderrTail(),
          );
          expect(typeof result).toBe("object");
          expect(result).not.toBeNull();
        } finally {
          await connection.close();
        }
      },
      { timeout: TEST_TIMEOUT_MS, retry },
    );

    it(
      "returns a session from session/new",
      async () => {
        const deadline = deadlineFor(TEST_TIMEOUT_MS);
        const { command, args, env, agent } = adapter();
        const cwd = workspace();
        const connection = await connectAcp(...confinedFor(agent, cwd, command, args), {
          cwd,
          env,
        });
        try {
          await withTimeout(
            connection.request("initialize", INITIALIZE_PARAMS),
            "initialize completes",
            deadline,
            () => connection.stderrTail(),
          );
          const result = (await withTimeout(
            connection.request("session/new", { cwd, mcpServers: [] }),
            "session/new returns a session",
            deadline,
            () => connection.stderrTail(),
          )) as { sessionId?: unknown };
          expect(typeof result.sessionId).toBe("string");
          expect((result.sessionId as string).length).toBeGreaterThan(0);
        } finally {
          await connection.close();
        }
      },
      { timeout: TEST_TIMEOUT_MS, retry },
    );

    it(
      "turns a prompt into assistant-text",
      async () => {
        const deadline = deadlineFor(TEST_TIMEOUT_MS);
        const { session, events } = await openSession(deadline);
        session.prompt(
          "Reply with one short sentence confirming you are ready. Do not run any tools or make any file changes.",
        );
        // The same predicate both waits on and is asserted with below: a
        // reply whose first streamed chunk is whitespace (a leading newline
        // is a common way for one to start) must not satisfy the wait and
        // then fail the assertion a moment later on formatting alone.
        const hasProse = (): boolean =>
          events.some((event) => event.event === "assistant-text" && event.text.trim().length > 0);
        await waitFor("a prompt produces assistant-text", hasProse, events, deadline, () => session.stderrTail());
        expect(hasProse()).toBe(true);
      },
      { timeout: TEST_TIMEOUT_MS, retry },
    );

    it(
      "turns a tool call into a log entry",
      async () => {
        const deadline = deadlineFor(TEST_TIMEOUT_MS);
        const { session, events } = await openSession(deadline);
        const answered = new Set<string>();
        session.prompt(
          "Use a tool to list the files in the current directory, then briefly describe what you see. " +
            "If you are asked for permission to do this, it is fine to proceed.",
        );
        await waitFor(
          "a tool call becomes a log entry",
          () => {
            autoApprove(session, events, answered);
            return events.some((event) => event.event === "log-entry");
          },
          events,
          deadline,
          () => session.stderrTail(),
        );
      },
      { timeout: TEST_TIMEOUT_MS, retry },
    );

    it(
      "reaches a tool through an MCP server named on session/new",
      async () => {
        const deadline = deadlineFor(TEST_TIMEOUT_MS);
        const cwd = workspace();
        const probe = join(cwd, "probe-mcp.cjs");
        writeFileSync(probe, PROBE_MCP_SOURCE);
        const nonce = `probe-${Math.random().toString(36).slice(2)}`;
        // A decoy in the workspace's own project scope: an `.mcp.json` whose
        // one MCP server marks being reached into its own directory. A
        // session that connects it took tools from a settings source rather
        // than from `session/new` — the channel the settings-sources
        // override exists to close, and the very file a run could write
        // itself to widen its next turn. Deliberately NOT a config-dir
        // redirect: pointing CLAUDE_CONFIG_DIR anywhere fresh signs the
        // owner's CLI out, and a behaviour that breaks authentication
        // measures its own sabotage rather than the adapter.
        const decoyMarks = join(cwd, "decoy-marks");
        mkdirSync(decoyMarks);
        writeFileSync(
          join(cwd, ".mcp.json"),
          JSON.stringify({
            mcpServers: { decoy: { command: process.execPath, args: [probe, decoyMarks] } },
          }),
        );
        const { session, events } = await openSession(deadline, {
          cwd,
          mcpServers: [
            {
              name: "probe",
              command: process.execPath,
              args: [probe, cwd],
              env: [{ name: "LYKEION_CONFORMANCE_PROBE", value: nonce }],
            },
          ],
        });
        const answered = new Set<string>();
        session.prompt(
          'Call the tool "conformance_probe" from the MCP server named "probe" with no arguments, ' +
            "then repeat its output verbatim. If you are asked for permission, it is fine to proceed.",
        );
        // The server having been spoken to at all is the deterministic half:
        // an entry the adapter's schema dropped is a server no one ever
        // connects, silently — precisely how the kernel bridge shipped broken.
        await waitFor(
          "the named server is connected",
          () => {
            autoApprove(session, events, answered);
            return existsSync(join(cwd, "connected"));
          },
          events,
          deadline,
          () => session.stderrTail(),
        );
        // The full round trip: the tool ran, and what it answered with is the
        // env variable named on session/new — deliverable only by `env`.
        await waitFor(
          "the probe tool answers with the env it was started with",
          () => {
            autoApprove(session, events, answered);
            return (
              existsSync(join(cwd, "called")) && readFileSync(join(cwd, "called"), "utf8").includes(nonce)
            );
          },
          events,
          deadline,
          () => session.stderrTail(),
        );
        // By now every server this session will ever connect has been — the
        // probe's own round trip is complete. The decoy staying silent is
        // the claude-shaped proof; no foreign `mcp__…` startup surfacing in
        // the log is the codex-shaped one (its adapter reports each server
        // it starts that way). Either firing means the session's tools came
        // from somewhere other than session/new.
        expect(
          existsSync(join(decoyMarks, "connected")),
          `the decoy user-scope server was connected — this adapter read a config dir's own MCP servers into the session.\nstderr: ${session.stderrTail()}`,
        ).toBe(false);
        const foreign = events.filter(
          (event) =>
            event.event === "log-entry" &&
            /^mcp__(?!probe__)/.test(event.entry.title ?? ""),
        );
        expect(
          foreign,
          `a server nothing named on session/new started in this session.\n${eventsDump(foreign)}`,
        ).toEqual([]);
      },
      { timeout: TEST_TIMEOUT_MS, retry },
    );

    it(
      "offers exactly the tools named on session/new",
      async () => {
        // The behaviour above proves the named server is reachable and that
        // a *settings-source* decoy stays out. This one is aimed at the two
        // channels a decoy in the workspace cannot reach: the CLI's own
        // user-scope registry and whatever an authenticated account delivers
        // — the servers `ownRegistryServers` reads off this machine's real
        // config, which no test fixture plants. The observation is the
        // agent's own report of its tool set, which is a model's word rather
        // than an API's — retried in certify mode like every behaviour here,
        // and honest about being the strongest observation available without
        // redirecting the owner's config dir (see the comment above on why
        // that sabotage is avoided).
        const deadline = deadlineFor(TEST_TIMEOUT_MS);
        const cwd = workspace();
        const probe = join(cwd, "probe-mcp.cjs");
        writeFileSync(probe, PROBE_MCP_SOURCE);
        const { session, events } = await openSession(deadline, {
          cwd,
          mcpServers: [
            { name: "probe", command: process.execPath, args: [probe, cwd], env: [] },
          ],
        });
        const answered = new Set<string>();
        session.prompt(
          "List the full name of every tool you can call right now, one per line, exactly as each " +
            "tool is named. Do not call any tool.",
        );
        await waitFor(
          "the tool-listing turn finishes",
          () => {
            autoApprove(session, events, answered);
            return events.some((event) => event.event === "completed");
          },
          events,
          deadline,
          () => session.stderrTail(),
        );
        const prose = events
          .filter(
            (event): event is Extract<RunEvent, { event: "assistant-text" }> =>
              event.event === "assistant-text",
          )
          .map((event) => event.text)
          .join("");
        expect(prose.trim().length).toBeGreaterThan(0);
        // `probe__`, not `probe\b`: a tool is named `mcp__<server>__<tool>`, so
        // what follows the server name is an underscore — a word character, and
        // therefore no word boundary. Written with `\b` the exclusion never
        // fired for a real tool name, and this read
        // `mcp__notebook__execute_python_cell`
        // and the probe's own tool as servers nobody named. The behaviour could
        // then only pass on a session reporting no MCP tools at all, which is
        // the opposite of what it exists to check. Line 552 has it right.
        const foreign =
          prose.match(/\bmcp__(?!probe(?:__|\b)|notebook(?:__|\b))\w+/g) ?? [];
        expect(
          foreign,
          `this session reports tools from servers nothing named on session/new.\n${eventsDump(events)}`,
        ).toEqual([]);
        const leaked = ownRegistryServers(adapter().agent).filter(
          (name) =>
            name !== "probe" &&
            name !== "notebook" &&
            new RegExp(`\\b${escapedForRegex(name)}\\b`, "i").test(prose),
        );
        expect(
          leaked,
          `this session reports servers out of the machine owner's own registry.\n${eventsDump(events)}`,
        ).toEqual([]);
      },
      { timeout: TEST_TIMEOUT_MS, retry },
    );

    it(
      "raises a permission card that can be answered and lets the turn finish",
      async () => {
        const deadline = deadlineFor(PERMISSION_TEST_TIMEOUT_MS);
        const { session, events } = await openSession(deadline);
        const outside = mkdtempSync(join(tmpdir(), "lykeion-acp-conformance-outside-"));
        dirs.push(outside);
        const target = join(outside, "conformance-probe.txt");
        // The write itself is expected to be refused by the OS boundary even
        // after approval — the shared temp directory is deliberately outside
        // it — and that is fine: what this behaviour certifies is the
        // permission flow, so the prompt pins the two places a real agent
        // otherwise stalls it. An agent whose own sandbox refuses the write
        // must escalate rather than give up (no card ever appears), and one
        // whose approved write then fails must report and finish rather than
        // retry (the turn never settles).
        session.prompt(
          `Write the text "conformance" to a new file at the absolute path ${target}. ` +
            "That path is outside your working directory. If your tools block the write, " +
            "request permission or sandbox escalation rather than giving up. Make exactly one " +
            "attempt after any approval; whether it succeeds or fails, state the outcome in one " +
            "sentence and finish. Do not retry.",
        );
        await waitFor(
          "a permission request becomes a card",
          () => events.some((event) => event.event === "permission-card"),
          events,
          deadline,
          () => session.stderrTail(),
        );
        const card = events.find((event) => event.event === "permission-card");
        if (card === undefined || card.event !== "permission-card") throw new Error("unreachable");
        // Answered directly, since this is the one card this behaviour is
        // actually about — but recorded into the same `answered` set
        // `autoApprove` reads below, so a real adapter that gates the same
        // write more than once (a stat or a read of the target before the
        // write itself is a plausible second ask) does not stall this turn
        // on a second card nobody is watching for.
        const answered = new Set<string>([card.request.id]);
        session.decide({
          action: "permission",
          requestId: card.request.id,
          decision: { decision: "allow", scope: "once" },
        });
        await waitFor(
          "answering a permission card lets the turn finish",
          () => {
            autoApprove(session, events, answered);
            return events.some((event) => event.event === "completed");
          },
          events,
          deadline,
          () => session.stderrTail(),
        );
        expect(
          events.some(
            (event) =>
              event.event === "log-entry" &&
              event.entry.toolUseId === card.request.tool &&
              event.entry.decision === "allowed-once",
          ),
        ).toBe(true);
      },
      { timeout: PERMISSION_TEST_TIMEOUT_MS, retry },
    );

    it(
      "proposes a plan",
      async () => {
        const deadline = deadlineFor(TEST_TIMEOUT_MS);
        const { session, events } = await openSession(deadline);
        const answered = new Set<string>();
        // The `plan-proposed` event only exists when the adapter sends an ACP
        // `plan` update, which every certified adapter translates from its
        // agent's own plan/todo tool — a plan written as prose produces
        // nothing. So the prompt names the tool rather than hoping the model
        // reaches for it: asked merely to "write out a plan", a real model
        // answers in prose often enough to read as a broken adapter.
        session.prompt(
          "Use your plan tool (your todo/plan list) to record a three-to-five step plan for how you " +
            "would approach organizing files in this directory. Create the plan entries with that tool — " +
            "do not merely write them as prose — then stop without executing any step.",
        );
        await waitFor(
          "a plan is proposed",
          () => {
            autoApprove(session, events, answered);
            return events.some((event) => event.event === "plan-proposed" && event.plan.steps.length > 0);
          },
          events,
          deadline,
          () => session.stderrTail(),
        );
      },
      { timeout: TEST_TIMEOUT_MS, retry },
    );

    it(
      "lands a cancelled turn on session/cancel",
      async () => {
        const deadline = deadlineFor(TEST_TIMEOUT_MS);
        const { session, events } = await openSession(deadline);
        session.prompt("Count slowly from one to twenty, sending each number as its own short message.");
        // A short grace period so the prompt has actually reached the
        // adapter before it is told to stop — cancelling before the turn
        // even began is a different question than this behaviour asks.
        await new Promise((resolve) => setTimeout(resolve, 100));
        session.cancel();
        await waitFor(
          "session/cancel lands the turn cancelled",
          () => events.some((event) => event.event === "completed"),
          events,
          deadline,
          () => session.stderrTail(),
        );
        const completed = events.find((event) => event.event === "completed");
        if (completed === undefined || completed.event !== "completed") throw new Error("unreachable");
        // An adapter fast enough to finish the whole count before the stop
        // reaches it settles `completed` rather than `cancelled`, and reads
        // from the bare assertion exactly like an adapter that ignores
        // session/cancel outright. What it was doing when the stop landed is
        // the only thing that tells those two apart, so this assertion
        // carries the same evidence every wait in this suite does.
        expect(
          completed.state.state,
          `conformance: "session/cancel lands the turn cancelled" saw ${completed.state.state}.\n${eventsDump(events)}\nstderr: ${session.stderrTail()}`,
        ).toBe("cancelled");
      },
      { timeout: TEST_TIMEOUT_MS, retry },
    );

    it(
      "cannot read the researcher's own agent installation",
      async () => {
        // Their credentials file is not only a sign-in. It holds live OAuth
        // access tokens for a dozen third-party services — mail, chat, issue
        // trackers — none of which a run has any business in. Until this
        // phase, `~/.claude` was granted wholesale with only `projects`,
        // `history.jsonl` and `todos` carved out, so that file was reachable.
        const deadline = deadlineFor(TEST_TIMEOUT_MS);
        const { session, events } = await openSession(deadline);
        const answered = new Set<string>();
        const target = join(homedir(), ".claude", ".credentials.json");
        session.prompt(
          `Try to read the file ${target}. Reply with exactly READ if you could read its ` +
            `contents, or exactly DENIED if you could not. If asked for permission, proceed.`,
        );
        const said = (): string =>
          events
            .filter((event) => event.event === "assistant-text")
            .map((event) => event.text)
            .join("");
        // Matches the answer rather than merely the presence of one, which is
        // what keeps this wait correct — but only accidentally, so it is
        // written down rather than left to be rediscovered. `assistant-text`
        // arrives in chunks, and a wait for non-empty text resolves on the
        // first character of a word still being streamed; the skills
        // behaviour below was written that way and failed a correct agent
        // every run until it was changed. A regex over whole words cannot
        // match half of one, so this one waits long enough by construction.
        // Anyone tempted to "simplify" it to `said().length > 0` would be
        // reintroducing exactly that defect.
        //
        // One narrower race does survive here, named so it is a known cost
        // rather than a surprise: this resolves on whichever of the two words
        // lands first, so an agent that narrates "I could not READ it" before
        // settling on DENIED is judged on the earlier one. That is safe only
        // because the prompt asks for exactly one of the two words and
        // nothing else — not because the wait is watertight.
        await waitFor(
          "the agent reports whether the researcher's credentials were reachable",
          () => {
            autoApprove(session, events, answered);
            return /READ|DENIED/.test(said());
          },
          events,
          deadline,
          () => session.stderrTail(),
        );
        // Asserted positively rather than as the absence of READ: a refusal
        // narrated as "I could not READ it" would satisfy a negative check
        // while saying the opposite of what it looks like.
        expect(
          said(),
          `a run reached the researcher's own credentials.\nstderr: ${session.stderrTail()}`,
        ).toContain("DENIED");
      },
      { timeout: TEST_TIMEOUT_MS, retry },
    );

    it(
      "offers no skills at all",
      async () => {
        // The floor sub-project 8's catalogue is laid on. A session arriving
        // already carrying `dataviz`, `schedule` and `loop` is one where
        // "Lykeion's skills" names nothing in particular.
        const deadline = deadlineFor(TEST_TIMEOUT_MS);
        const { session, events } = await openSession(deadline);
        const answered = new Set<string>();
        session.prompt(
          "List every skill available to you, comma-separated. If you have none, reply exactly NONE.",
        );
        const said = (): string =>
          events
            .filter((event) => event.event === "assistant-text")
            .map((event) => event.text)
            .join("");
        // Waited on the turn ending rather than on any text existing at all.
        // `assistant-text` arrives in chunks, and an answer of "NONE" reaches
        // this list as "N" first: a wait for non-empty text resolves on that
        // first character and the assertion below then reads "N", failing an
        // agent whose answer was correct and merely unfinished. Observed 6/6
        // against `claude-agent-acp`, whose first chunk is reliably one
        // character — so this read as a skill leak every run on a session
        // that had no skills at all, which is the most misleading way for
        // this particular check to fail.
        //
        // `completed` rather than `assistant-text-final`: that event is only
        // emitted when a turn's last visible update was text, so an agent
        // that ends on a tool call never sends one and this would wait out
        // the whole deadline. `completed` is sent for every terminal
        // outcome, and is what three other behaviours here already wait on.
        // Cards are answered along the way for the same reason the
        // credential behaviour above answers them: a turn nobody unblocks
        // never reaches the state this now waits for.
        await waitFor(
          "the agent reports its skill set",
          () => {
            autoApprove(session, events, answered);
            return events.some((event) => event.event === "completed");
          },
          events,
          deadline,
          () => session.stderrTail(),
        );
        expect(
          said(),
          `a session was given skills nothing here handed it.\nstderr: ${session.stderrTail()}`,
        ).toContain("NONE");
      },
      { timeout: TEST_TIMEOUT_MS, retry },
    );
  });
}
