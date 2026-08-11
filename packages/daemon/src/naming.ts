import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startSession, type LiveSession } from "./session";

/**
 * Naming a Task, on the one machine in a lab that can talk to a model.
 *
 * A lab has no model of its own. Every bit of intelligence it reaches lives
 * behind an agent CLI that a researcher installed and signed in on their own
 * computer, so summarizing four lines of prose into four words means the same
 * thing here as running a whole turn does: launch the adapter, hold an ACP
 * session open, and ask.
 *
 * What makes this different from a turn is everything it is denied. The
 * session stands in an empty directory, is told about no tool servers, is
 * given no standing grants, and refuses every permission it is asked for. A
 * summarizer has no business reading a workspace: it has been handed the
 * whole of what it needs in the prompt, and an agent that goes looking for
 * context anyway gets a "no" and answers from what it was given. Refusing
 * rather than allowing is also what keeps this from being a way to run
 * unreviewed tool calls against a researcher's files under the cover of
 * naming a chat.
 */

/** What the summarizer is asked. Deliberately blunt about the shape of the
 *  answer, because everything it might add instead — a preamble, a list of
 *  options, a trailing offer to help — is something the lab then has to
 *  recognize and throw away. */
function namingPrompt(prompt: string): string {
  return [
    "Summarize this request as a title of at most six words.",
    "Reply with the title alone — no quotes, no trailing period, no explanation, and do not use any tools.",
    "",
    "Request:",
    prompt,
  ].join("\n");
}

/**
 * How long one naming is given, from launching the adapter to the answer.
 *
 * Comfortably inside the lab's own wait, and it has to be: this side giving
 * up first is what lets the lab be told "nothing" now rather than discovering
 * it at a deadline. Long enough for a cold `claude` on a laptop that has not
 * run one in a while.
 */
const DEFAULT_DEADLINE_MS = 25_000;

/** Where naming sessions stand: one empty directory, shared, holding nothing.
 *  Inside the working root rather than this machine's own state directory,
 *  which the boundary denies to every agent — a session whose own cwd it
 *  could not read would fail for reasons that have nothing to do with what
 *  it was asked. */
export function namingDir(workDir: string): string {
  const dir = join(workDir, "naming");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface NamingRequest {
  adapter: { command: string; args: string[] };
  agent: string;
  /** The Task's opening message — the whole of what the summarizer sees. */
  prompt: string;
  /** Where naming sessions stand. See {@link namingDir}. */
  cwd: string;
  /** This machine's own state directory, which the boundary denies. */
  dataDir: string;
  platform?: string;
  deadlineMs?: number;
  signal?: AbortSignal;
  /** Overrides the environment the adapter is spawned with — a test's way to
   *  script a stub agent. Production passes none and this process's own
   *  environment is used. */
  env?: NodeJS.ProcessEnv;
}

/**
 * One summarizer session, start to finish. Resolves with whatever the agent
 * said — raw, uncleaned; the lab is the one place that decides what counts as
 * a title — or `null` for a session that could not be opened, was refused, or
 * did not answer in time.
 *
 * Never throws. Every way this can fail is a Task keeping the name it already
 * has, and a caller that had to catch for that would be writing the same
 * `null` back.
 */
export async function summarizeTask(request: NamingRequest): Promise<string | null> {
  let said = "";
  let settle: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });

  // The deadline covers launching the adapter as well as answering, and the
  // launch is the half that can hang hardest: an ACP handshake with a program
  // that never speaks has nothing to time it out. `startSession`'s own signal
  // reaps the subprocess before it settles, which is the only way to be sure
  // nothing is left running behind a naming nobody is waiting on any more.
  const bound = new AbortController();
  const giveUp = () => {
    settle();
    bound.abort();
  };
  const timer = setTimeout(giveUp, request.deadlineMs ?? DEFAULT_DEADLINE_MS);
  timer.unref?.();
  request.signal?.addEventListener("abort", giveUp, { once: true });

  let session: LiveSession | undefined;
  try {
    session = await startSession({
      adapter: request.adapter,
      agent: request.agent,
      cwd: request.cwd,
      dataDir: request.dataDir,
      ...(request.platform === undefined ? {} : { platform: request.platform }),
      // No grants and no tool servers: the two things that would give this
      // session anything to reach beyond the words it was handed.
      grants: [],
      mcpServers: [],
      onEvent: (event) => {
        if (event.event === "assistant-text") said += event.text;
        // Anything this session asks for, it is told no. A permission card
        // and a clarifying question are both a turn stopping to wait on a
        // person, and there is no person here — left unanswered they would
        // hold the session open until the deadline and produce nothing.
        else if (event.event === "permission-card")
          session?.decide({
            action: "permission",
            requestId: event.request.id,
            decision: { decision: "deny" },
          });
        else if (event.event === "question-asked")
          session?.decide({
            action: "answer-question",
            requestId: event.request.requestId,
            answer: { selected: [] },
          });
        else if (event.event === "plan-proposed") session?.decide({ action: "reject-plan" });
        else if (event.event === "completed") settle();
      },
      onGrant: () => {
        // Nothing standing is ever granted from here: the session was opened
        // with none and refuses every card, so there is no decision to record
        // and nowhere to record it — a naming session outlives nothing.
      },
      env: request.env ?? process.env,
      signal: bound.signal,
    });
  } catch {
    // An adapter that will not start is a machine that cannot name things
    // right now. Nothing about that is worth failing a caller over.
    clearTimeout(timer);
    return null;
  }
  if (!session) {
    clearTimeout(timer);
    return null;
  }
  const live = session;

  try {
    live.prompt(namingPrompt(request.prompt));
    await finished;
  } finally {
    clearTimeout(timer);
    // Always closed, including on the deadline path — this session exists for
    // exactly one question, and a subprocess left running on a researcher's
    // laptop because an agent went quiet is the worst thing naming could do
    // to them.
    await live.close().catch(() => {});
  }

  const answer = said.trim();
  return answer.length === 0 ? null : answer;
}
