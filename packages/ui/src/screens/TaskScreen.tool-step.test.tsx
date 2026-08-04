/**
 * The Task transcript renders a turn's ordered `stream` as tool-step
 * cards interleaved with prose.
 *
 * Three behaviours are pinned here:
 *  1. A REOPENED Task (a persisted turn carrying `stream`) draws a card
 *     with its resolved label, and the prose renders once — from the stream,
 *     not additionally from `messages`.
 *  2. A PRE-`stream` turn (no `stream` field — every record written before
 *     live streaming existed) still renders exactly as it did before: prose
 *     bubbles, no cards.
 *  3. A turn that completes LIVE keeps its cards after the next send, i.e.
 *     the finished run's stream is carried when the turn graduates into the
 *     view (without that, cards vanish the moment the researcher continues).
 *  4. A turn that lands FAILED but with a recorded stream renders as cards
 *     too — the live rendering may not disagree with the graduated/persisted
 *     one just because the turn ended badly.
 *  5. A run of >1 consecutive steps draws under a group header.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInMemoryApi } from "@lykeion/api";
import type {
  LykeionApi,
  RunEvent,
  RunHandle,
  TaskTurn,
} from "@lykeion/api";
import App from "../App";

const TASK = "t_3";
const ROUTE = `#/studies/s_cmp/tasks/${TASK}`;

/** The in-memory API with one scripted transcript for this Task. */
const apiWithTurns = (turns: TaskTurn[]): LykeionApi => {
  const base = createInMemoryApi();
  return {
    ...base,
    async getTask(taskId: string) {
      const detail = await base.getTask(taskId);
      return { ...detail, turns };
    },
  };
};

const STREAM_TURN: TaskTurn = {
  runId: "run-stream",
  ts: 1,
  prompt: "how big is the dataset?",
  messages: ["The dataset has 42 rows."],
  stream: [
    {
      kind: "step",
      entry: {
        ts: 1,
        toolUseId: "tu-1",
        tool: "Bash",
        input: { command: "wc -l data.csv" },
        decision: "ran",
        result: "42",
        isError: false,
      },
    },
    { kind: "text", text: "The dataset has 42 rows." },
  ],
  status: "ok",
  code: [],
  outputs: [],
};

/** A persisted turn whose run took two consecutive tool steps — the GROUP
 *  path (`ToolStepGroup` draws a synthesized header + step count). */
const GROUP_TURN: TaskTurn = {
  runId: "run-group",
  ts: 1,
  prompt: "count both files",
  messages: ["Both commands ran."],
  stream: [
    {
      kind: "step",
      entry: {
        ts: 1,
        toolUseId: "tu-a",
        tool: "Bash",
        input: { command: "wc -l a.csv" },
        decision: "ran",
        result: "12",
        isError: false,
      },
    },
    {
      kind: "step",
      entry: {
        ts: 2,
        toolUseId: "tu-b",
        tool: "Bash",
        input: { command: "wc -l b.csv" },
        decision: "ran",
        result: "30",
        isError: false,
      },
    },
    { kind: "text", text: "Both commands ran." },
  ],
  status: "ok",
  code: [],
  outputs: [],
};

/**
 * A run that lands FAILED but still carries a recorded stream. This is a
 * genuine shape, not a hypothetical: the run is recorded unconditionally, so
 * a soft failure (a denied permission, a rejected plan) arrives as
 * `{ event: "completed", state: { state: "failed", … }, run: <record> }` —
 * the failed state and the recorded run travel together on the one event.
 */
const apiWithFailedLandedRun = (): LykeionApi => ({
  ...createInMemoryApi(),
  async startRun(): Promise<RunHandle> {
    const emitAll = (cb: (e: RunEvent) => void) => {
      cb({ event: "state", state: { state: "planning" } });
      cb({
        event: "assistant-text",
        text: "I stopped without writing it.",
        partial: false,
      });
      cb({
        event: "completed",
        state: { state: "failed", reason: "permission denied" },
        run: {
          runId: "run-failed",
          ts: 1,
          command: "write the results",
          status: "failed",
          code: [],
          outputs: [],
          stream: [
            {
              kind: "step",
              entry: {
                ts: 1,
                toolUseId: "tu-denied",
                tool: "Write",
                input: { file_path: "results/out.csv" },
                decision: "denied",
                result: "Denied by the researcher",
                isError: true,
              },
            },
            { kind: "text", text: "I stopped without writing it." },
          ],
        },
      });
    };
    return {
      runId: "run-failed",
      onEvent(cb) {
        const timer = setTimeout(() => emitAll(cb), 0);
        return () => clearTimeout(timer);
      },
      submit() {},
      close() {},
    };
  },
});

/**
 * A persisted turn from a run the researcher STOPPED at the permission card.
 * The abandoned step is recorded (`decision: "cancelled"`,
 * `isError: false`, no result) and the run lands, so this is what a reopened
 * Task reads from — forever.
 */
const CANCELLED_TURN: TaskTurn = {
  runId: "run-cancelled",
  ts: 1,
  prompt: "write the results",
  messages: ["Stopped."],
  stream: [
    {
      kind: "step",
      entry: {
        ts: 1,
        toolUseId: "tu-1",
        tool: "Write",
        input: { file_path: "results/out.csv" },
        decision: "cancelled",
        isError: false,
      },
    },
    // After the step, so it can never be promoted onto it as a tier-2 title —
    // this test is about the CARD the cancelled entry resolves to on its own.
    { kind: "text", text: "Stopped." },
  ],
  status: "failed",
  code: [],
  outputs: [],
};

/** Two WHOLE assistant messages arriving back to back — the shape the
 *  in-memory simulation reproduces. */
const PARAGRAPHS_TURN: TaskTurn = {
  runId: "run-paragraphs",
  ts: 1,
  prompt: "how big is it?",
  messages: ["Here's what I found:", "- 42 rows"],
  stream: [
    { kind: "text", text: "Here's what I found:" },
    { kind: "text", text: "- 42 rows" },
  ],
  status: "ok",
  code: [],
  outputs: [],
};

const LEGACY_TURN: TaskTurn = {
  runId: "run-legacy",
  ts: 1,
  prompt: "summarize the notes",
  messages: ["No tools were needed here."],
  status: "ok",
  code: [],
  outputs: [],
};

beforeEach(cleanup);

describe("Task transcript — tool-step cards", () => {
  it("renders a persisted turn's stream as a card with its resolved label", async () => {
    window.location.hash = ROUTE;
    render(<App api={apiWithTurns([STREAM_TURN])} />);

    const conversation = await screen.findByTestId("conversation");

    // Tier 3 (the deterministic label) — a `Bash` step with no adapter title
    // and no promotable narration before it.
    expect(
      await within(conversation).findByText("Ran: wc -l data.csv"),
    ).toBeInTheDocument();
    expect(within(conversation).getAllByTestId("tool-step")).toHaveLength(1);

    // The prose comes from the STREAM, not additionally from `messages` —
    // rendering both would duplicate every paragraph of a modern turn.
    expect(
      within(conversation).getAllByText("The dataset has 42 rows."),
    ).toHaveLength(1);
  });

  it("draws a STOPPED step as blocked on reopen, never as a completed success", async () => {
    // The researcher clicked Stop on the permission card: the turn ended
    // Failed{"cancelled"}, results/out.csv was never written. This card used to
    // read "✓ Wrote results/out.csv" — a green tick over a file that does not
    // exist — and, because it is persisted in `TaskTurn.stream`, it read
    // that way on every reopen forever.
    window.location.hash = ROUTE;
    render(<App api={apiWithTurns([CANCELLED_TURN])} />);

    const conversation = await screen.findByTestId("conversation");
    const step = await within(conversation).findByTestId("tool-step");
    expect(step).toHaveClass("tool-step--blocked");
    expect(step).toHaveTextContent("Write results/out.csv");
    expect(step).not.toHaveTextContent("Wrote results/out.csv");
    expect(within(step).queryByText("✓")).toBeNull();
    expect(within(step).getByText("⊘")).toBeInTheDocument();
  });

  it("renders a pre-`stream` turn exactly as before — prose, no cards", async () => {
    window.location.hash = ROUTE;
    render(<App api={apiWithTurns([LEGACY_TURN])} />);

    const conversation = await screen.findByTestId("conversation");
    const prose = await within(conversation).findByText(
      "No tools were needed here.",
    );
    // The text now lands inside a markdown `<p>` (`AssistantMessage`), one
    // level under the bubble itself — assert against the bubble ancestor,
    // not the exact node `findByText` resolves to.
    expect(prose.closest(".msg--assistant")).not.toBeNull();
    expect(within(conversation).queryAllByTestId("tool-step")).toHaveLength(0);
  });

  it("keeps a completed turn's cards after the next send", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={createInMemoryApi()} />);

    // Drive one full turn in Plan mode: "Plan first" → approve the plan →
    // allow the write. (A plain send is a normal run with no plan gate.)
    await user.type(
      await screen.findByLabelText("Message the agent"),
      "write the results",
    );
    await user.click(screen.getByRole("button", { name: "Send options" }));
    await user.click(screen.getByRole("button", { name: "Plan first" }));
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    // The split-button's default scope is "conversation" — a plain Allow
    // click, no menu interaction, grants at that scope.
    await user.click(
      await screen.findByRole("button", {
        name: "Allow for this conversation",
      }),
    );
    await screen.findByText("Run complete");

    // Exact, not "> 0": the scripted run takes exactly two tool steps — the
    // CLI's own ungated plan-file write (outside the workspace, never gated)
    // and the gated Write — so a third card here would mean a step rendered
    // twice.
    const conversation = screen.getByTestId("conversation");
    expect(within(conversation).getAllByTestId("tool-step")).toHaveLength(2);

    // The ungated one SAYS it left the workspace — the researcher never got a
    // card for it, so this marker is the only place it ever surfaces.
    const escaped = within(conversation)
      .getAllByTestId("tool-step")
      .find((el) => el.classList.contains("tool-step--outside"));
    expect(escaped).toBeDefined();
    expect(escaped).toHaveTextContent(/outside workspace/i);
    // …and it is not dressed up as a failure: the call really did succeed.
    expect(escaped).toHaveClass("tool-step--ok");
    // It keeps the deterministic label that NAMES the path, rather than
    // absorbing the narration that happens to precede it — and that narration
    // therefore still renders as prose, where it belongs. Promoting it here
    // labelled the one card that must stand out as "you never approved this"
    // with a sentence that does not name it, and cost the transcript a whole
    // prose block.
    expect(escaped).toHaveTextContent(
      "Wrote /Users/researcher/.claude/plans/load-the-dataset.md",
    );
    expect(escaped).not.toHaveTextContent("Here's my plan for this task.");
    expect(
      within(conversation).getAllByText("Here's my plan for this task."),
    ).toHaveLength(1);

    // The demo transcript, end to end. "Running the analysis." is a WHOLE
    // assistant message sitting immediately before the step (the simulation's
    // `say` keeps to the one-item-per-message contract), so tier 2
    // promotes it onto the card — and it is therefore not also rendered as
    // prose.
    const card = within(conversation)
      .getAllByTestId("tool-step")
      .find((el) => !el.classList.contains("tool-step--outside"))!;
    expect(card).toHaveTextContent("Running the analysis.");
    expect(
      within(conversation).getAllByText("Running the analysis."),
    ).toHaveLength(1);

    // A tool step is a disclosure now (collapsed by default), so the raw tool
    // input is behind a click rather than on the row — this test asserts the
    // label on the collapsed row, which the escaped card above also proves
    // carries the real `claude` Write key (`file_path`) end to end.

    // Continuing the conversation graduates the finished turn into the view —
    // its cards must survive that (the run's stream is carried across), and
    // the graduated turn must not ALSO leave a live copy behind.
    await user.type(screen.getByLabelText("Message the agent"), "now chart it");
    // Plan first again, so the new turn stops at its plan gate below.
    await user.click(screen.getByRole("button", { name: "Send options" }));
    await user.click(screen.getByRole("button", { name: "Plan first" }));

    // Exactly one card carries the graduated turn's gated Write: it survived,
    // and it was not rendered a second time by the live surface it just left.
    expect(
      within(conversation).getAllByText("Running the analysis."),
    ).toHaveLength(1);
    // The NEW turn draws its own card while it is still running — the
    // ungated plan-file write is the first thing every simulated turn does,
    // and the only step this one reaches before it stops at the plan gate. So
    // the transcript holds the graduated two plus that one, and no more.
    await waitFor(() =>
      expect(within(conversation).getAllByTestId("tool-step")).toHaveLength(3),
    );
  });

  it("renders a run of consecutive steps under a group header", async () => {
    window.location.hash = ROUTE;
    render(<App api={apiWithTurns([GROUP_TURN])} />);

    const conversation = await screen.findByTestId("conversation");
    const group = await within(conversation).findByTestId("tool-step-group");
    // A deterministic, no-LLM header: same tool twice -> "Ran 2 commands".
    expect(within(group).getByText("Ran 2 commands")).toBeInTheDocument();
    expect(within(group).getByText("2 steps")).toBeInTheDocument();
    expect(within(group).getAllByTestId("tool-step")).toHaveLength(2);
    expect(within(group).getByText("Ran: wc -l a.csv")).toBeInTheDocument();
    expect(within(group).getByText("Ran: wc -l b.csv")).toBeInTheDocument();
  });

  it("renders a FAILED turn's landed stream as cards, exactly like a completed one", async () => {
    // The run is recorded unconditionally, so a soft failure (denied
    // permission / rejected plan) lands as `Failed` WITH a stream. Gating the
    // live rendering on "completed" made such a turn show prose live and then
    // flip to cards on the next send and again on reopen.
    const user = userEvent.setup();
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={apiWithFailedLandedRun()} />);

    await user.type(
      await screen.findByLabelText("Message the agent"),
      "write the results",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    const conversation = screen.getByTestId("conversation");
    expect(
      await within(conversation).findByText(/Run failed — permission denied/),
    ).toBeInTheDocument();

    // The denied Write draws as a BLOCKED card, from the landed stream —
    // `decision: "denied"` and `isError: true` always co-occur (the CLI reports
    // the refusal back to the model as an error `tool_result`, which merges
    // onto the same entry), so deciding on `isError` first drew this as a red
    // ✕ crash and left `blocked` unreachable in practice. And the label stays
    // in the non-past: nothing was written.
    const step = within(conversation).getByTestId("tool-step");
    expect(step).toHaveClass("tool-step--blocked");
    expect(step).toHaveTextContent("Write results/out.csv");

    // …and the prose comes from that stream only — not additionally from the
    // live `messages`, which would duplicate it.
    expect(
      within(conversation).getAllByText("I stopped without writing it."),
    ).toHaveLength(1);
  });
});

describe("assistant prose — one bubble per whole message", () => {
  it("renders two whole messages as two bubbles, never run together", async () => {
    window.location.hash = ROUTE;
    render(<App api={apiWithTurns([PARAGRAPHS_TURN])} />);

    const conversation = await screen.findByTestId("conversation");
    // Each recorded text item IS a whole message, so each gets its own bubble
    // — the lead-in and the list it introduces can no longer be glued into
    // "Here's what I found:- 42 rows" by a seam guess.
    const bubbles = conversation.querySelectorAll(".msg--assistant");
    expect(bubbles).toHaveLength(2);
    expect(bubbles[0].textContent).toBe("Here's what I found:");
    // `AssistantMessage` parses "- 42 rows" as markdown, so the bubble holds
    // a real `<li>` — the `-` is list syntax, not text, and the rendered
    // `textContent` no longer carries it.
    expect(
      within(bubbles[1] as HTMLElement).getByRole("listitem"),
    ).toHaveTextContent("42 rows");
    // No BUBBLE runs them together (the whole conversation's `textContent`
    // concatenates its children, so it would read ":-" whatever the markup).
    for (const bubble of bubbles) {
      expect(bubble.textContent).not.toContain(":-");
    }
  });

  it("lets markdown own a single message's internal line breaks", async () => {
    // One whole message routinely carries its OWN line breaks (a lead-in and
    // its bullets can arrive as a single `AssistantText` from the `claude`
    // adapter). The bubble used to fake this with its own `white-space:
    // pre-wrap` over a raw string; `AssistantMessage` now parses the text as
    // markdown instead, so the lead-in and its bullets render as a real
    // `<p>` and a real `<ul>`/`<li>` inside the one bubble — no CSS
    // whitespace hack required, and `task.css` no longer declares one.
    const EMBEDDED_LIST_TURN: TaskTurn = {
      runId: "run-embedded-list",
      ts: 1,
      prompt: "how big is it?",
      messages: ["Here's what I found:\n- 42 rows\n- 3 exceptions"],
      status: "ok",
      code: [],
      outputs: [],
    };
    window.location.hash = ROUTE;
    render(<App api={apiWithTurns([EMBEDDED_LIST_TURN])} />);

    const conversation = await screen.findByTestId("conversation");
    const bubbles = conversation.querySelectorAll(".msg--assistant");
    expect(bubbles).toHaveLength(1);
    expect(
      within(bubbles[0] as HTMLElement).getByText("Here's what I found:")
        .tagName,
    ).toBe("P");
    const items = within(bubbles[0] as HTMLElement).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "42 rows",
      "3 exceptions",
    ]);
  });
});

describe("tool-step cards keep their height in the transcript column", () => {
  // The bug: on REOPEN a tool step rendered "so thin it renders nothing", while
  // the same step looked right live. Cause is a flex interaction, not the data.
  //
  // A reopened turn's `StreamView` renders each block as a DIRECT flex child of
  // `.conv-column` (`display: flex; flex-direction: column`, its height capped
  // by the `.conv-stream` scroller): a lone step is a bare `.tool-step`, a run
  // is a `.tool-step-group`. Both cards set `overflow: hidden`, and a flex item
  // whose overflow is not `visible` has an automatic minimum size of 0 — so with
  // the default `flex-shrink: 1` they collapse toward zero height the instant the
  // transcript overflows the column, while prose bubbles (no `overflow: hidden`,
  // min-height = content) hold their size and absorb none of the squeeze. The
  // live turn escapes it only because it sits inside `.conv-live`, a wrapper that
  // is not itself `overflow: hidden` and so keeps its content height. Pinning
  // `flex-shrink: 0` on both cards makes them keep full height in every flex
  // parent — reopened exactly like live.
  //
  // jsdom neither lays out nor applies the app's CSS, so this reads the
  // stylesheet source, the same approach `TaskScreen.live.test.tsx` uses.
  const css = readFileSync(
    resolve(process.cwd(), "src/screens/task.css"),
    "utf8",
  );
  const toolStep = css.match(/^\.tool-step\s*\{[^}]*\}/m)?.[0] ?? "";
  const toolStepGroup = css.match(/^\.tool-step-group\s*\{[^}]*\}/m)?.[0] ?? "";

  it("does not let a lone `.tool-step` shrink below its content", () => {
    expect(toolStep).toMatch(/flex-shrink:\s*0/);
  });

  it("does not let a `.tool-step-group` shrink below its content", () => {
    expect(toolStepGroup).toMatch(/flex-shrink:\s*0/);
  });
});

/**
 * A landed run REFETCHES the persisted transcript, so the view and the record
 * agree straight away rather than only after a remount.
 *
 * The bug this pins: the turn the researcher just watched used to live only in
 * this mount's ephemeral state, because a landed run refreshed the sidebar and
 * nothing else. The persisted transcript — what a later open replays — was first
 * read on some unrelated remount, so any disagreement between the two surfaced as
 * a transcript that changed (cards appearing, or vanishing) when the conversation
 * was reopened. Refetching on landing closes that window, and absorbing the turn
 * must render it ONCE, not twice.
 */
describe("Task transcript refresh on landing", () => {
  const LANDED_STEP = {
    ts: 1,
    toolUseId: "tu-landed",
    tool: "Bash",
    input: { command: "wc -l kinases.csv" },
    decision: "ran" as const,
    result: "518",
    isError: false,
  };

  /** Writes the turn into the transcript just before `completed`, the way the
   *  core records a run before it sends the terminal event. */
  const apiThatPersistsOnLanding = (): LykeionApi => {
    const persisted: TaskTurn[] = [];
    const record = {
      runId: "run-landed",
      ts: 1,
      command: "count the kinases",
      status: "ok" as const,
      code: [],
      outputs: [],
      stream: [
        { kind: "step" as const, entry: LANDED_STEP },
        { kind: "text" as const, text: "There are 518." },
      ],
    };
    const base = createInMemoryApi();
    return {
      ...base,
      async getTask(taskId: string) {
        const detail = await base.getTask(taskId);
        return { ...detail, turns: [...persisted] };
      },
      async startRun(): Promise<RunHandle> {
        const emitAll = (cb: (e: RunEvent) => void) => {
          cb({ event: "state", state: { state: "planning" } });
          cb({ event: "log-entry", entry: LANDED_STEP });
          cb({ event: "assistant-text", text: "There are 518.", partial: false });
          persisted.push({
            runId: record.runId,
            ts: 1,
            prompt: "count the kinases",
            messages: ["There are 518."],
            stream: record.stream,
            status: "ok",
            code: [],
            outputs: [],
          });
          cb({ event: "completed", state: { state: "completed" }, run: record });
        };
        return {
          runId: record.runId,
          onEvent(cb) {
            const timer = setTimeout(() => emitAll(cb), 0);
            return () => clearTimeout(timer);
          },
          submit() {},
          close() {},
        };
      },
    };
  };

  it("shows the landed turn's card exactly once, from the refetched transcript", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={apiThatPersistsOnLanding()} />);

    await user.type(
      await screen.findByLabelText("Message the agent"),
      "count the kinases",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    const conversation = await screen.findByTestId("conversation");
    // The step drew a card (tier 3, the deterministic label)...
    await waitFor(() =>
      expect(
        within(conversation).getAllByText("Ran: wc -l kinases.csv").length,
      ).toBeGreaterThan(0),
    );
    // ...exactly one, with one prose block: refetching the transcript must not
    // add a second copy of the turn beside the live one.
    await waitFor(() => {
      expect(within(conversation).getAllByTestId("tool-step")).toHaveLength(1);
      expect(
        within(conversation).getAllByText("Ran: wc -l kinases.csv"),
      ).toHaveLength(1);
      expect(
        within(conversation).getAllByText("There are 518."),
      ).toHaveLength(1);
    });
  });

  it("keeps a turn that landed no record, since the transcript will never carry it", async () => {
    const user = userEvent.setup();
    // A run that completes WITHOUT a record (a stopped turn): the transcript stays
    // empty, so the ephemeral copy is all the researcher has and must survive.
    const base = createInMemoryApi();
    const api: LykeionApi = {
      ...base,
      async getTask(taskId: string) {
        const detail = await base.getTask(taskId);
        return { ...detail, turns: [] };
      },
      async startRun(): Promise<RunHandle> {
        const emitAll = (cb: (e: RunEvent) => void) => {
          cb({ event: "state", state: { state: "planning" } });
          cb({ event: "log-entry", entry: LANDED_STEP });
          cb({
            event: "completed",
            state: { state: "failed", reason: "stopped" },
          });
        };
        return {
          runId: "run-stopped",
          onEvent(cb) {
            const timer = setTimeout(() => emitAll(cb), 0);
            return () => clearTimeout(timer);
          },
          submit() {},
          close() {},
        };
      },
    };
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={api} />);

    await user.type(
      await screen.findByLabelText("Message the agent"),
      "count the kinases",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The card the stopped turn drew stays on screen.
    await waitFor(() =>
      expect(screen.getAllByText("Ran: wc -l kinases.csv")).toHaveLength(1),
    );
  });
});

/**
 * The Task surface reports live plan progress above its composer — `Step N of
 * M`, with the Notebook pill that opens the inspector on the live kernel.
 */
describe("Task run strip", () => {
  it("reports Step N of M from the executing plan", async () => {
    const user = userEvent.setup();
    const api: LykeionApi = {
      ...createInMemoryApi(),
      async startRun(): Promise<RunHandle> {
        const emitAll = (cb: (e: RunEvent) => void) => {
          // An executing plan whose second step the agent reports in progress.
          cb({
            event: "state",
            state: {
              state: "executing",
              plan: {
                steps: [
                  { title: "Build the kinome set", done: true, status: "completed" },
                  { title: "Score guides", done: false, status: "in_progress" },
                  { title: "Plan sequencing depth", done: false, status: "pending" },
                ],
                raw: "",
              },
            },
          });
        };
        return {
          runId: "run-strip",
          onEvent(cb) {
            const timer = setTimeout(() => emitAll(cb), 0);
            return () => clearTimeout(timer);
          },
          submit() {},
          close() {},
        };
      },
    };
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={api} />);

    await user.type(
      await screen.findByLabelText("Message the agent"),
      "design the screen",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    const strip = await screen.findByTestId("run-strip");
    expect(strip).toHaveTextContent("Step 2 of 3");

    // The Notebook pill opens the inspector on the live kernel.
    await user.click(within(strip).getByRole("button", { name: /notebook/i }));
    expect(
      await screen.findByRole("tab", { name: "Notebook" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("shows no strip for a plain run with no plan steps", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={createInMemoryApi()} />);

    await user.type(
      await screen.findByLabelText("Message the agent"),
      "just answer this",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    // A normal run executes under a synthesized EMPTY plan, which is not
    // researcher-facing progress — so the strip stays away entirely.
    await waitFor(() => expect(screen.queryByTestId("run-strip")).toBeNull());
  });
});

/**
 * The Task surface's right-hand inspector — a wide pane with
 * Files · [open artifact] · Notebook.
 *
 * It opens only on the manual toggle (never mid-run on its own), lists the
 * artifacts this CHAT produced across all its turns, and opens one into a
 * viewer tab beside the Notebook.
 */
describe("Task inspector pane", () => {
  const TURN_WITH_ARTIFACTS: TaskTurn = {
    runId: "run-art",
    ts: 1,
    prompt: "build the kinome set",
    messages: ["Done."],
    stream: [{ kind: "text", text: "Done." }],
    status: "ok",
    code: [{ path: "scripts/build.py", size: 120 }],
    outputs: [{ path: "results/kinome_genes.csv", size: 4096 }],
  };

  it("stays closed until the researcher opens it", async () => {
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={apiWithTurns([TURN_WITH_ARTIFACTS])} />);
    // The transcript renders; the pane does not.
    await screen.findByTestId("conversation");
    expect(screen.queryByTestId("artifacts-panel")).toBeNull();
  });

  it("lists the conversation's own artifacts when opened", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={apiWithTurns([TURN_WITH_ARTIFACTS])} />);

    await user.click(
      await screen.findByRole("button", { name: /panel|inspector/i }),
    );
    const panel = await screen.findByTestId("artifacts-panel");
    expect(panel).toHaveTextContent("kinome_genes.csv");
    expect(panel).toHaveTextContent("build.py");
  });

  it("opens an artifact into its own tab beside the Notebook", async () => {
    const user = userEvent.setup();
    window.location.hash = "#/studies/s_cmp/tasks/t_3";
    render(<App api={apiWithTurns([TURN_WITH_ARTIFACTS])} />);

    await user.click(
      await screen.findByRole("button", { name: /panel|inspector/i }),
    );
    await user.click(await screen.findByText("kinome_genes.csv"));
    // The opened artifact gets a tab, and the Notebook tab is still there.
    expect(
      await screen.findByRole("tab", { name: "kinome_genes.csv" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Notebook" })).toBeInTheDocument();
  });
});
