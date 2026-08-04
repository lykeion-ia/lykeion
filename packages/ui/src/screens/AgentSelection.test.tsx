import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createInMemoryApi,
  type AgentCli,
  type LykeionApi,
  type StartRunInput,
} from "@lykeion/api";
import App from "../App";

const CLIS: AgentCli[] = [
  {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    version: "",
    available: true,
    runtimeId: "rt_1",
  },
  {
    id: "copilot",
    name: "GitHub Copilot CLI",
    command: "copilot --acp",
    version: "",
    available: true,
    runtimeId: "rt_1",
  },
];

// A fresh (todo, never-run) task, opened straight on its conversation.
const TODO_TASK = "#/studies/s_cmp/tasks/t_5";

beforeEach(cleanup);

describe("Agent selection", () => {
  /**
   * The Task surface carries no agent dock — the dock lives on the Study's
   * composer, which is where a piece of work is started from. A send made
   * from the Task's own composer therefore takes the first AVAILABLE CLI
   * rather than a per-Task choice: there is no control here to make one, and
   * a send that silently went nowhere would be worse than one that runs on
   * the lab's default.
   */
  it("routes a send from the Task composer to the first available CLI", async () => {
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
   * A send from the STUDY composer takes a different path to the same
   * effect: `StudyScreen.send()` mints a Task, stashes the prompt (and the
   * CLI) via `stashRun`, and navigates to the Task surface, where
   * `useTaskRun`'s deferred handoff (`useTaskRun.ts:96-111`) auto-starts it.
   * The dock's own resolved CLI id, not the raw dock-selection state, is
   * what has to survive that whole handoff and reach `startRun`.
   */
  it("routes a Study composer send to the effective CLI by default", async () => {
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
    window.location.hash = "#/studies/s_cmp";
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

  it("routes a Study composer send to the CLI picked in the dock", async () => {
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
    window.location.hash = "#/studies/s_cmp";
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
