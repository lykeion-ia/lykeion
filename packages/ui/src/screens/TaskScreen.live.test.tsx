/**
 * The LIVE turn: what the Task transcript shows while the run is still
 * going, before any record has landed.
 *
 * Every assertion here is MID-TURN, on purpose. The last snapshot of every turn
 * is `{}` (each `LiveTurn` field is skipped when empty), and `completed`
 * replaces the whole live surface with the run's own `stream` — so
 * a test that only checks the tail is eventually gone would pass no matter what
 * happened while the turn was running. Nothing here waits for the end of the
 * turn except the two tests that are explicitly about the end of the turn.
 *
 * The run's event stream is driven BY THE TEST, one event at a time, because
 * that is the only way to observe an intermediate state at all.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInMemoryApi } from "@lykeion/api";
import type {
  ActiveRunSnapshot,
  ChangeEvent,
  ExecutionLogEntry,
  KernelEnvDeclaration,
  LykeionApi,
  ResumedRun,
  RunEvent,
  RunHandle,
  TaskEnvironmentSetup,
  Transport,
} from "@lykeion/api";
import App from "../App";
import { ApiProvider } from "../api/ApiContext";
import { useChangeChannel } from "../hooks/useChangeChannel";
import { RouterProvider } from "../router";
import { TaskScreen } from "./TaskScreen";

const ROUTE = "#/researches/s_cmp/tasks/t_3";

/** A run whose events the test emits by hand — no scripted timeline, so every
 *  assertion below lands at a chosen point INSIDE the turn. */
function scriptedApi() {
  const subs = new Set<(e: RunEvent) => void>();
  let runNumber = 0;
  const api: LykeionApi = {
    ...createInMemoryApi(),
    async startRun(input): Promise<RunHandle> {
      const runId = `run-live-${++runNumber}`;
      return {
        // A real API never reuses a run id. Keeping the fixture faithful is
        // load-bearing now that concurrent sibling blocks are keyed by it.
        runId,
        onEvent(cb) {
          subs.add(cb);
          queueMicrotask(() =>
            cb({
              event: "snapshot",
              snapshot: {
                runId,
                sequence: runNumber + 2,
                origin: "user",
                prompt: input.prompt,
                agent: input.options.agent ?? "default",
                state: { state: "planning" },
                stream: [],
                live: {},
                reviewing: false,
                lastEventSeq: 0,
              },
            }),
          );
          return () => subs.delete(cb);
        },
        submit() {},
        detach() {},
        // What `teardown()` calls: a closed handle delivers nothing more.
        close() {
          subs.clear();
        },
      };
    },
  };
  const emit = (e: RunEvent) =>
    act(() => {
      for (const cb of [...subs]) cb(e);
    });
  return { api, emit, subs };
}

/** Send a prompt and wait until the run's stream is subscribed — from here on
 *  the turn is IN FLIGHT and nothing ends it until the test says so. */
async function startTurn() {
  const { api, emit, subs } = scriptedApi();
  const user = userEvent.setup();
  window.location.hash = ROUTE;
  render(<App api={api} />);
  await user.type(
    await screen.findByLabelText("Message the agent"),
    "which candidates responded?",
  );
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(subs.size).toBeGreaterThan(0));
  return { emit, user };
}

/**
 * An Execution Log entry as it arrives LIVE. The entry is announced once, at
 * entry creation — never again when the result merges — so a live entry
 * carries no `result` at all.
 */
const readEntry = (path: string, toolUseId = "tu-read"): ExecutionLogEntry => ({
  ts: 1,
  toolUseId,
  tool: "Read",
  input: { file_path: path },
  decision: "ran",
  isError: false,
});

const bashEntry = (command: string, toolUseId: string): ExecutionLogEntry => ({
  ts: 1,
  toolUseId,
  tool: "Bash",
  input: { command },
  decision: "ran",
  isError: false,
});

/** The run is still going: the run line is drawn and Stop still holds the
 *  composer. Asserted alongside the live content so no test below can be
 *  satisfied by end-of-turn state. */
function expectStillRunning() {
  expect(screen.getByRole("status")).toHaveTextContent(/Planning|Running/);
  expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
  expect(screen.queryByText(/Run complete|Run failed/)).toBeNull();
}

beforeEach(cleanup);

describe("the live turn", () => {
  it("restores Stop in the composer for a recovered active run", async () => {
    const base = createInMemoryApi();
    const snapshot: ActiveRunSnapshot = {
      runId: "run-recovered",
      sequence: 3,
      origin: "user",
      prompt: "continue the analysis",
      agent: "codex",
      state: { state: "executing", plan: { steps: [], raw: "" } },
      stream: [],
      live: {},
      reviewing: false,
      lastEventSeq: 0,
    };
    const recovered: ResumedRun = {
      runId: snapshot.runId,
      snapshot,
      onEvent(cb) {
        queueMicrotask(() => cb({ event: "snapshot", snapshot }));
        return () => {};
      },
      submit() {},
      detach() {},
      close() {},
    };
    const api: LykeionApi = {
      ...base,
      resumeRuns: async () => [recovered],
    };
    window.location.hash = ROUTE;
    render(<App api={api} />);

    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    // Beside it, not instead of it: typing ahead is the point.
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("renders a recovered system continuation as neutral status with ordinary assistant output", async () => {
    const base = createInMemoryApi();
    const snapshot = {
      runId: "run-system-continuation",
      sequence: 3,
      prompt:
        "The environment analysis is ready on this machine. Continue the work blocked in the source turn. Do not ask the researcher to repeat the request, and do not repeat completed work.",
      agent: "codex",
      origin: "system" as const,
      continuation: {
        kind: "environment-setup" as const,
        waiterId: "wait_1",
        sourceTurnId: "turn_source",
        environmentName: "analysis",
        machineId: "machine_1",
      },
      state: { state: "executing" as const, plan: { steps: [], raw: "" } },
      stream: [{ kind: "text" as const, text: "I am continuing the analysis now." }],
      live: {},
      reviewing: false,
      lastEventSeq: 2,
    } satisfies ActiveRunSnapshot & {
      origin: "system";
      continuation: NonNullable<import("@lykeion/api").TaskTurn["continuation"]>;
    };
    const recovered: ResumedRun = {
      runId: snapshot.runId,
      snapshot,
      onEvent(cb) {
        queueMicrotask(() => cb({ event: "snapshot", snapshot }));
        return () => {};
      },
      submit() {},
      detach() {},
      close() {},
    };
    const api: LykeionApi = { ...base, resumeRuns: async () => [recovered] };
    window.location.hash = ROUTE;
    render(<App api={api} />);

    expect(await screen.findByTestId("environment-continuation-status")).toHaveTextContent(
      "analysis is ready. Continuing the work blocked above.",
    );
    expect(
      screen.getByText("I am continuing the analysis now.").closest(".msg--assistant"),
    ).not.toBeNull();
    const live = screen.getByTestId("live-turn");
    expect(live.querySelector(".msg--user")).toBeNull();
    expect(screen.queryByText(snapshot.prompt)).not.toBeInTheDocument();
    expect(within(live).queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(within(live).queryByRole("button", { name: "Revert" })).not.toBeInTheDocument();
  });

  it("renders a tool card while the turn is still running", async () => {
    const { emit } = await startTurn();
    emit({ event: "log-entry", entry: readEntry("data.csv") });

    const card = await screen.findByTestId("tool-step");
    // The row is the tool's NAME and the argument it was called with — the
    // verb is the name, and the rail's marker says whether it ran.
    expect(within(card).getByText("Read")).toHaveClass("rail-tool");
    expect(within(card).getByText("data.csv")).toHaveClass("rail-desc");
    // No `result` has merged yet, and none is invented: no IN/OUT preview at
    // all, and no output disclosure offered.
    expect(within(card).queryByTestId("step-io")).toBeNull();
    expect(
      within(card).queryByRole("button", { name: /show output/i }),
    ).toBeNull();
    expectStillRunning();
  });

  it("streams prose into the live turn", async () => {
    const { emit } = await startTurn();
    emit({ event: "live", live: { text: "Strong candidates" } });

    const text = await screen.findByTestId("live-text");
    expect(text).toHaveTextContent("Strong candidates");
    expectStillRunning();
  });

  it("renders thinking in its own channel, never as prose", async () => {
    const { emit } = await startTurn();
    emit({
      event: "live",
      live: {
        thinking: "Let me check the responder column",
        text: "Strong candidates",
      },
    });

    const thinking = await screen.findByTestId("live-thinking");
    expect(thinking).toHaveTextContent("Let me check the responder column");
    // The prose column must not have absorbed it — separate node, separate
    // text, and not dressed as an assistant message bubble either.
    const text = screen.getByTestId("live-text");
    expect(text).toHaveTextContent(/^Strong candidates$/);
    expect(text).not.toHaveTextContent("Let me check");
    expect(thinking).not.toHaveClass("msg--assistant");
    expect(thinking.contains(text)).toBe(false);
    expectStillRunning();
  });

  it("a later snapshot REPLACES the earlier one", async () => {
    const { emit } = await startTurn();
    emit({
      event: "live",
      live: { text: "Strong cand", thinking: "Let me check" },
    });
    expect(await screen.findByTestId("live-thinking")).toHaveTextContent(
      "Let me check",
    );

    // One snapshot is the WHOLE in-flight state: the prose grew and the
    // thinking channel closed. Appending would leave "Strong candStrong
    // candidates"; merging field-wise would leave the closed thinking channel
    // on screen for the rest of the turn.
    emit({ event: "live", live: { text: "Strong candidates" } });

    const text = await screen.findByTestId("live-text");
    expect(text).toHaveTextContent(/^Strong candidates$/);
    expect(screen.getAllByText(/Strong candidates/)).toHaveLength(1);
    expect(screen.queryByText("Strong cand")).not.toBeInTheDocument();
    expect(screen.queryByTestId("live-thinking")).not.toBeInTheDocument();
    expectStillRunning();
  });

  it("routes a running tool's stdout to its own card, by toolUseId", async () => {
    // Two tools in flight at once — the shape `toolStdout` is a keyed LIST
    // for. Attaching the buffer to whichever card is at hand would put one
    // tool's output under the other's label.
    const { emit } = await startTurn();
    emit({ event: "log-entry", entry: bashEntry("wc -l a.csv", "tu-a") });
    emit({ event: "log-entry", entry: bashEntry("wc -l b.csv", "tu-b") });
    emit({
      event: "live",
      live: { toolStdout: [{ toolUseId: "tu-b", text: "42 b.csv" }] },
    });

    await screen.findByText("wc -l b.csv");
    const cardFor = (command: string) =>
      screen
        .getAllByTestId("tool-step")
        .find((c) => c.textContent?.includes(command))!;
    expect(
      within(cardFor("wc -l b.csv")).getByTestId("step-stdout"),
    ).toHaveTextContent("42 b.csv");
    expect(
      within(cardFor("wc -l a.csv")).queryByTestId("step-stdout"),
    ).toBeNull();

    // The next snapshot replaces the previous one wholesale: b's tool finished
    // and left the live channel, a's started producing. A stale tail under b
    // would be output attributed to a tool that is no longer producing any.
    emit({
      event: "live",
      live: { toolStdout: [{ toolUseId: "tu-a", text: "12 a.csv" }] },
    });
    expect(
      within(cardFor("wc -l a.csv")).getByTestId("step-stdout"),
    ).toHaveTextContent("12 a.csv");
    expect(
      within(cardFor("wc -l b.csv")).queryByTestId("step-stdout"),
    ).toBeNull();
    expectStillRunning();
  });

  it("drops the in-flight tail on the idle snapshot, and keeps the cards", async () => {
    const { emit } = await startTurn();
    emit({ event: "log-entry", entry: readEntry("data.csv") });
    emit({
      event: "live",
      live: { text: "Strong cand", thinking: "Let me check" },
    });
    // Mid-turn: the tail IS on screen. Without this the assertion below would
    // hold for a surface that never rendered a tail at all.
    expect(await screen.findByTestId("live-text")).toBeInTheDocument();
    expect(screen.getByTestId("live-thinking")).toBeInTheDocument();

    // The tail became a whole message and the channels emptied — the exact
    // payload the runner flushes at every channel boundary.
    emit({
      event: "assistant-text",
      text: "Strong candidates: 12 of 42.",
      partial: false,
    });
    emit({ event: "live", live: {} });

    expect(screen.queryByTestId("live-text")).not.toBeInTheDocument();
    expect(screen.queryByTestId("live-thinking")).not.toBeInTheDocument();
    // The message it became renders exactly once, and the card is untouched.
    expect(screen.getAllByText("Strong candidates: 12 of 42.")).toHaveLength(1);
    expect(screen.getByText("data.csv")).toBeInTheDocument();
    expectStillRunning();
  });

  it("renders nothing extra when the adapter sends no deltas (degrade path)", async () => {
    // `caps.partial_text === false` ⇒ no `live` event ever arrives. Whole
    // messages and whole steps render exactly as they do today; no channel is
    // drawn empty, and no adapter is named anywhere to make that happen.
    const { emit } = await startTurn();
    // The step first: a whole message immediately BEFORE a step is a tier-2
    // narration and becomes that card's title (`blocksOf`) — the same fold the
    // reopened view uses, and not what this test is about.
    emit({ event: "log-entry", entry: readEntry("data.csv") });
    emit({ event: "assistant-text", text: "Whole message", partial: false });

    // The text now lands inside a markdown `<p>` (`AssistantMessage`), one
    // level under the bubble itself — assert against the bubble ancestor,
    // not the exact node `findByText` resolves to.
    const bubble = await screen.findByText("Whole message");
    expect(bubble.closest(".msg--assistant")).not.toBeNull();
    expect(screen.getByText("data.csv")).toBeInTheDocument();
    expect(screen.queryByTestId("live-text")).not.toBeInTheDocument();
    expect(screen.queryByTestId("live-thinking")).not.toBeInTheDocument();
    expect(screen.queryByTestId("step-stdout")).not.toBeInTheDocument();
    expectStillRunning();
  });

  it("keeps already-started cards on screen when the researcher stops the run", async () => {
    const { emit, user } = await startTurn();
    emit({ event: "log-entry", entry: readEntry("data.csv") });
    expect(await screen.findByText("data.csv")).toBeInTheDocument();

    // Stop lives in the composer, in Send's place (see ComposerStop.test.tsx).
    await user.click(screen.getByRole("button", { name: "Stop" }));

    // `cancel()` unsubscribes and fabricates the stopped state synchronously
    // — the cards must survive it. A stopped turn lands no record here (the
    // stream is simply cut), so nothing else can put them back on screen.
    expect(await screen.findByText("Run stopped")).toBeInTheDocument();
    expect(screen.getByText("data.csv")).toBeInTheDocument();
  });

  it("carries a stopped turn's cards into the transcript when the researcher continues", async () => {
    const { emit, user } = await startTurn();
    emit({ event: "log-entry", entry: readEntry("data.csv") });
    expect(await screen.findByText("data.csv")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));

    await user.type(screen.getByLabelText("Message the agent"), "try again");
    await user.click(screen.getByRole("button", { name: "Send" }));

    // The stopped turn graduates into the view. It has no landed record, so
    // its cards can only come from what the live turn accumulated — and the
    // NEW turn starts empty, so there is exactly one.
    expect(screen.getAllByText("data.csv")).toHaveLength(1);
    expect(screen.getAllByTestId("tool-step")).toHaveLength(1);
  });
});

describe("the live channels are styled apart", () => {
  // jsdom neither lays out nor applies the app's CSS, so this reads the
  // stylesheet source — the same approach `TaskScreen.tool-step.test.tsx`
  // uses for `.msg--assistant`'s `pre-wrap`.
  const css = () =>
    readFileSync(resolve(process.cwd(), "src/screens/task.css"), "utf8");

  it("gives thinking a visually distinct treatment from prose", () => {
    const thinking = css().match(/\.live-thinking\s*\{[^}]*\}/)?.[0] ?? "";
    // Thinking is not the answer: it reads as an aside (italic, its own rule
    // down the leading edge), never as the assistant's prose. It renders raw
    // text (not markdown), so it keeps its own newlines with `pre-wrap`.
    expect(thinking).toMatch(/font-style:\s*italic/);
    expect(thinking).toMatch(/border-inline-start/);
    expect(thinking).toMatch(/white-space:\s*pre-wrap/);

    // `.live-text` wraps an `<AssistantMessage live />`, which renders
    // `.msg .msg--assistant` — the SAME markup the landed bubble does — so it
    // carries no typography of its own, and specifically no `white-space`:
    // that property inherits, and a `pre-wrap` here would reach the child's
    // markdown output while the landed bubble (no such wrapper) stays
    // `normal`, reflowing visibly the instant the turn lands.
    const text = css().match(/\.live-text\s*\{[^}]*\}/)?.[0] ?? "";
    expect(text).not.toMatch(/font-style:\s*italic/);
    expect(text).not.toMatch(/white-space/);
  });
});

/**
 * The completion of a build, from the researcher's seat.
 *
 * A build finishing is the one moment in this feature where the surface is
 * most tempted to shout: a modal, a toast, a control that vanishes because
 * there is nothing left to press. It does none of those. The line says the
 * agent is carrying on, and whatever the researcher was standing on stays
 * under them — which for a keyboard reader is the whole difference between
 * a calm completion and losing their place on the screen.
 */
const CONTINUING_TASK = "t_3";

const rDeclaration: KernelEnvDeclaration = {
  name: "meta-analysis-r",
  language: "r",
  manager: "conda",
  packages: ["metafor"],
  createdBy: "u_you",
  createdTs: 0,
  lockRevision: 1,
};

const installingSetup: TaskEnvironmentSetup = {
  job: {
    id: "job_1",
    machineId: "rt_1",
    machineName: "ana-macbook",
    environmentName: "meta-analysis-r",
    language: "r",
    manager: "conda",
    lockRevision: 1,
    state: "building",
    stage: "installing",
    requestedTs: 1_700_000_000,
    updatedTs: 1_700_000_000,
    log: [],
  },
};

const continuingSetup: TaskEnvironmentSetup = {
  job: { ...installingSetup.job, state: "ready", stage: "finalizing" },
  waiter: {
    id: "wait_1",
    sourceRunId: "run_src",
    sourceTurnId: "run_src",
    state: "queued",
    continuationTurnId: "run_cont",
  },
};

/** A transport whose workspace change stream this test drives by hand — the
 *  same shape `useChangeChannel.test.tsx` uses to drive the hook. */
function controllableTransport() {
  let push: ((event: ChangeEvent) => void) | undefined;
  const transport: Transport = {
    request: async () => null,
    openEvents(_cursor, onEvent) {
      push = onEvent;
      return () => {};
    },
    openRun: () => () => {},
  };
  return {
    transport,
    /** One real change frame of the kind the server records for a setup. */
    pushEnvironmentSetupChanged(seq: number) {
      act(() => push!({ seq, kind: "environment-setup-changed", payload: {} }));
    },
  };
}

/** `App`'s own `ChangeChannel`, which is not exported — the same one line. */
function ChangeChannel({ transport }: { transport: Transport }) {
  useChangeChannel(transport);
  return null;
}

/**
 * Flushes the pending reads and NOTHING else — microtasks only, no clock.
 *
 * This is what makes the pushed frame attributable. `NotebookPanel` also polls,
 * every 1500ms (`NotebookPanel.tsx:226`), so a `waitFor` after the push would
 * be satisfied by that poll and would prove nothing about the frame. Three
 * awaited microtasks take microseconds; a real interval cannot fire inside one.
 */
async function settleReads() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

it("says the agent is continuing when a build lands, and moves nobody's focus to say it", async () => {
  // `TaskScreen` is mounted directly rather than through `App`, for the reason
  // `TaskScreen.refetch.test.tsx` mounts it directly: `App` hands its provider
  // a `transport` of `undefined` whenever an `api` is injected
  // (`App.tsx:122-124`), which makes `useChangeChannel` a no-op and leaves a
  // test with no way to push anything. Composed here from the same three
  // pieces `App` composes, so the frame travels the path a real one travels.
  const user = userEvent.setup();
  let setups: TaskEnvironmentSetup[] = [installingSetup];
  const api: LykeionApi = {
    ...createInMemoryApi(),
    kernelEnvList: async () => [rDeclaration],
    taskNotebook: async () => [],
    listRunningKernels: async () => [],
    listMachines: async () => [
      {
        id: "rt_1",
        name: "ana-macbook",
        ownerId: "u_you",
        platform: "macos-aarch64",
        daemonVersion: "0.1.0",
        health: "online",
        lastSeenTs: 1,
        capabilities: [],
      },
    ],
    computeSnapshot: async () => [
      {
        machineId: "rt_1",
        environments: [
          {
            state: "absent",
            name: "meta-analysis-r",
            language: "r",
            manager: "conda",
            platform: "macos-aarch64",
            root: "/x/envs/meta-analysis-r",
          },
        ],
      },
    ],
    taskEnvironmentSetups: async () => setups,
  };
  const driver = controllableTransport();

  window.location.hash = `#/researches/s_cmp/tasks/${CONTINUING_TASK}`;
  render(
    <ApiProvider api={api}>
      <ChangeChannel transport={driver.transport} />
      <RouterProvider>
        <TaskScreen researchId="s_cmp" taskId={CONTINUING_TASK} />
      </RouterProvider>
    </ApiProvider>,
  );
  const open = await screen.findByRole("button", { name: "Open notebook" });
  await waitFor(() => expect(open).toBeEnabled());
  await user.click(open);
  const bar = within(await screen.findByTestId("environment-bar")).getByRole("status");
  await waitFor(() => expect(bar).toHaveTextContent("Installing packages"));

  // The researcher is standing on the button they pressed, which is where a
  // build leaves whoever started it.
  const action = within(screen.getByTestId("environment-bar")).getByRole("button", {
    name: /meta-analysis-r on ana-macbook/,
  });
  action.focus();
  expect(document.activeElement).toBe(action);

  // The build is done on the server and this Task's turn is queued behind it.
  setups = [continuingSetup];

  // Nothing has told the surface yet. This assertion is what makes the next
  // one mean something: without it the panel's own poll would deliver the
  // change a moment later and the push below would be proving nothing.
  await settleReads();
  expect(bar).toHaveTextContent("Installing packages");

  // Now the server pushes the frame it records for a setup change.
  driver.pushEnvironmentSetupChanged(1);
  await settleReads();

  // Both facts on the one line, and nothing else happened: no dialog, no
  // alert, and — the load-bearing one — the same element still has focus. The
  // button is still mounted, so it never vanished from under the finger that
  // pressed it; it is only called something else now.
  expect(bar).toHaveTextContent("Agent continuing…");
  expect(bar).toHaveTextContent("Ready");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(action);
  expect(action).toHaveAccessibleName(/Rebuild meta-analysis-r on ana-macbook/);
});
