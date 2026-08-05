/**
 * Holds any ACP adapter to one set of behaviours the daemon's own session
 * pipeline depends on: that a session actually opens, that a prompt produces
 * prose, that a tool call and a permission request land the way `session.ts`
 * turns them into an `ExecutionLogEntry` and a `PermissionRequest`, that a
 * plan surfaces, and that a turn a researcher stops actually stops.
 *
 * The stub every other daemon test drives is one adapter this is pointed at.
 * Real coding-agent adapters — `claude-code-acp`, `claude-agent-acp`,
 * `codex-acp` — are the others, and they do not share the stub's timing,
 * tool names or prose. Every assertion below is written against the *shape*
 * of what an adapter produces — an event kind, a non-empty string, a
 * terminal state — never against wording only the stub would say.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@lykeion/api";
import { connectAcp } from "./acp";
import { startSession, type LiveSession } from "./session";

/** Vitest's own timeout for a single test — long enough that a real agent's
 *  reply, shaped by a model call rather than the milliseconds the stub
 *  answers in, is never mistaken for a broken adapter. One test's budget
 *  covers opening the session as well as the turn: spawning a cold CLI,
 *  handshaking and getting a session id back can itself take several seconds
 *  before the model is asked anything, and a behaviour that then has to make
 *  a tool call or produce a plan needs what is left to still be a model's
 *  worth of time. */
const TEST_TIMEOUT_MS = 60_000;

/** Behaviour 5 waits twice in series against a real model: a card appearing,
 *  then — a real adapter told to write outside its workspace can plausibly
 *  gate the same write more than once, a stat or a read of the target before
 *  the write itself — answering however many cards that takes, and only
 *  then a full turn actually finishing. `TEST_TIMEOUT_MS` split across all
 *  of that is tight; this gives it real room without lengthening the other
 *  six. */
const PERMISSION_TEST_TIMEOUT_MS = 90_000;

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

type AdapterFactory = () => { command: string; args: string[]; env?: NodeJS.ProcessEnv };

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

export function acpConformance(name: string, adapter: AdapterFactory): void {
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

    async function openSession(deadline: number): Promise<{ session: LiveSession; events: RunEvent[] }> {
      const { command, args, env } = adapter();
      const events: RunEvent[] = [];
      const starting = startSession({
        adapter: { command, args },
        cwd: workspace(),
        grants: [],
        onEvent: (event) => events.push(event),
        onGrant: () => {},
        env,
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
        const { command, args, env } = adapter();
        const connection = await connectAcp(command, args, { cwd: workspace(), env });
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
      TEST_TIMEOUT_MS,
    );

    it(
      "returns a session from session/new",
      async () => {
        const deadline = deadlineFor(TEST_TIMEOUT_MS);
        const { command, args, env } = adapter();
        const cwd = workspace();
        const connection = await connectAcp(command, args, { cwd, env });
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
      TEST_TIMEOUT_MS,
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
      TEST_TIMEOUT_MS,
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
      TEST_TIMEOUT_MS,
    );

    it(
      "raises a permission card that can be answered and lets the turn finish",
      async () => {
        const deadline = deadlineFor(PERMISSION_TEST_TIMEOUT_MS);
        const { session, events } = await openSession(deadline);
        const outside = mkdtempSync(join(tmpdir(), "lykeion-acp-conformance-outside-"));
        dirs.push(outside);
        const target = join(outside, "conformance-probe.txt");
        session.prompt(
          `Write the text "conformance" to a new file at the absolute path ${target}. ` +
            "That path is outside your working directory — ask first if your tools require it before writing there.",
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
      PERMISSION_TEST_TIMEOUT_MS,
    );

    it(
      "proposes a plan",
      async () => {
        const deadline = deadlineFor(TEST_TIMEOUT_MS);
        const { session, events } = await openSession(deadline);
        const answered = new Set<string>();
        session.prompt(
          "Before doing anything else, write out a short numbered plan — three to five steps — for how you " +
            "would approach organizing files in this directory. Present the plan and then stop without executing it.",
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
      TEST_TIMEOUT_MS,
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
      TEST_TIMEOUT_MS,
    );
  });
}
