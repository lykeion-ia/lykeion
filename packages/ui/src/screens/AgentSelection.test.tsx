import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createInMemoryApi,
  type AgentCli,
  type AgentOption,
  type LykeionApi,
  type StartRunInput,
  type TaskTurn,
} from "@lykeion/api";
import App from "../App";
import { resetPageLoad } from "../lib/tabs-storage";

const CLIS: AgentCli[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    version: "",
    available: true,
    machineId: "rt_1",
    sessionReady: true,
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    command: "copilot --acp",
    version: "",
    available: true,
    machineId: "rt_1",
    sessionReady: true,
  },
];

// A fresh (todo, never-run) task, opened straight on its conversation.
const TODO_TASK = "#/researches/s_cmp/tasks/t_5";

/** A settled turn that ran on one named agent — the durable record the Task
 *  surface reads to know which conversation it is continuing. */
const turnOn = (agent: string): TaskTurn => ({
  runId: `run-on-${agent}`,
  origin: "user",
  sequence: 1,
  ts: 1,
  prompt: "the turn before this one",
  agent,
  messages: ["done"],
  status: "ok",
  code: [],
  outputs: [],
});

/** What an agent advertised under `model`. Built from the fixture rather than
 *  from any list kept in the UI: what a pill may offer is whatever the agent
 *  itself named, and a catalogue here would be a second source of truth. */
const modelOption = (current: string, choices: [string, string][]): AgentOption => ({
  id: "model",
  category: "model",
  currentValue: current,
  choices: choices.map(([value, label]) => ({ value, label })),
});

beforeEach(() => {
  cleanup();
  // `App` reads the stored strip once per page; this file mounts it fresh per
  // test. Adopting the incoming hash needs no reset — that is per-mount, in
  // `RouterProvider`.
  resetPageLoad();
});

describe("Agent selection", () => {
  /**
   * The Task surface carries no agent dock — the dock lives on the Research's
   * composer, which is where a piece of work is started from. With no turn
   * behind it there is nothing for this Task to be mid-conversation with, so
   * the opening send takes the first AVAILABLE CLI: a send that silently went
   * nowhere would be worse than one that runs on the lab's default.
   *
   * That is the OPENING move only. Once a turn has landed, the Task's own
   * agent decides — see the two cases below.
   */
  it("routes the opening send from a Task nobody has spoken in yet to the first available CLI", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    const agents: (string | undefined)[] = [];
    const spied: LykeionApi = {
      ...api,
      // Claude is unavailable here, so "first available" is a real choice and
      // not just "first in the list".
      listAgentClis: async () => [
        { ...CLIS[0], available: false },
        CLIS[1],
      ],
      startRun: (input: StartRunInput) => {
        agents.push(input.options.agent);
        return api.startRun(input);
      },
    };
    window.location.hash = TODO_TASK;
    render(<App api={spied} />);

    // No dock to pick from — the Task surface offers no agent control at all.
    expect(
      screen.queryByRole("button", { name: "GitHub Copilot CLI" }),
    ).not.toBeInTheDocument();

    await user.type(await screen.findByLabelText("Message the agent"), "go");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(agents).toHaveLength(1));
    expect(agents).toEqual(["copilot"]);
  });

  /**
   * The regression this pair of tests exists for: the Task surface used to
   * resolve its CLI as "the first available one", and the lab lists them in
   * the daemon's catalogue order — so Claude was always first, and a Task
   * being worked on by any other agent had both its next turn misrouted and
   * another agent's models on its composer.
   *
   * A Task is one continuous conversation with one agent. The transcript is
   * what says which, and it is the only thing that still says so after a
   * reload: a run's snapshot is gone once the run is not active.
   */
  it("sends the next turn to the agent the last one ran on, not the lab's first CLI", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    const agents: (string | undefined)[] = [];
    const spied: LykeionApi = {
      ...api,
      // Both available, Claude first — exactly the order the daemon's
      // catalogue produces, and the shape the old resolution got wrong.
      listAgentClis: async () => CLIS,
      async getTask(taskId: string) {
        const detail = await api.getTask(taskId);
        return { ...detail, turns: [turnOn("copilot")] };
      },
      startRun: (input: StartRunInput) => {
        agents.push(input.options.agent);
        return api.startRun(input);
      },
    };
    window.location.hash = TODO_TASK;
    render(<App api={spied} />);

    await user.type(await screen.findByLabelText("Message the agent"), "and again");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(agents).toHaveLength(1));
    expect(agents).toEqual(["copilot"]);
  });

  it("lists the models of the agent the Task is talking to", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    const spied: LykeionApi = {
      ...api,
      // Only the agent this Task is NOT on advertises Claude's models, so a
      // pill reading one of them can only mean the wrong CLI was resolved.
      listAgentClis: async () => [
        { ...CLIS[0]!, options: [modelOption("opus", [["opus", "Opus"], ["sonnet", "Sonnet"]])] },
        { ...CLIS[1]!, options: [modelOption("gpt-5.6-sol", [["gpt-5.6-sol", "GPT-5.6-Sol"], ["gpt-5.5", "GPT-5.5"]])] },
      ],
      async getTask(taskId: string) {
        const detail = await api.getTask(taskId);
        return { ...detail, turns: [turnOn("copilot")] };
      },
    };
    window.location.hash = TODO_TASK;
    render(<App api={spied} />);

    const pill = await screen.findByRole("button", { name: /^Model:/ });
    expect(pill).toHaveAccessibleName("Model: GPT-5.6-Sol");

    await user.click(pill);
    const menu = screen.getByRole("listbox", { name: "Models" });
    expect(within(menu).getByRole("option", { name: "GPT-5.5" })).toBeInTheDocument();
    // The other agent's catalogue is not merged in from anywhere.
    expect(within(menu).queryByRole("option", { name: "Opus" })).not.toBeInTheDocument();
  });

  /**
   * A send from the STUDY composer takes a different path to the same
   * effect: `ResearchScreen.send()` mints a Task, stashes the prompt (and the
   * CLI) via `stashRun`, and navigates to the Task surface, where
   * `useTaskRun`'s deferred handoff (`useTaskRun.ts:96-111`) auto-starts it.
   * The dock's own resolved CLI id, not the raw dock-selection state, is
   * what has to survive that whole handoff and reach `startRun`.
   */
  it("routes a Research composer send to the effective CLI by default", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    const agents: (string | undefined)[] = [];
    const spied: LykeionApi = {
      ...api,
      listAgentClis: async () => CLIS,
      startRun: (input: StartRunInput) => {
        agents.push(input.options.agent);
        return api.startRun(input);
      },
    };
    window.location.hash = "#/researches/s_cmp";
    render(<App api={spied} />);

    // No click in the dock — Claude Code is the default-selected pill.
    await user.type(
      await screen.findByLabelText("Message the agent"),
      "go",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(agents).toHaveLength(1));
    expect(agents).toEqual(["claude"]);
  });

  it("routes a Research composer send to the CLI picked in the dock", async () => {
    const user = userEvent.setup();
    const api = createInMemoryApi();
    const agents: (string | undefined)[] = [];
    const spied: LykeionApi = {
      ...api,
      listAgentClis: async () => CLIS,
      startRun: (input: StartRunInput) => {
        agents.push(input.options.agent);
        return api.startRun(input);
      },
    };
    window.location.hash = "#/researches/s_cmp";
    render(<App api={spied} />);

    await user.click(
      await screen.findByRole("button", { name: "GitHub Copilot CLI" }),
    );
    await user.type(screen.getByLabelText("Message the agent"), "go");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(agents).toHaveLength(1));
    expect(agents).toEqual(["copilot"]);
  });
});
