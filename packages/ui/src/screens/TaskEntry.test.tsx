/**
 * How a Task that has never been spoken in opens.
 *
 * There is one Task surface and every Task opens on it: the conversation, with
 * an empty transcript and the docked composer. No entry screen stands in front
 * of it — a click on a Task row lands on the chat itself, not on a surface
 * asking you to start one.
 *
 * The send behaviour is asserted here too: a plain send is a NORMAL run (no
 * plan gate); "Plan first", tucked in the send button's chevron, is the
 * per-message opt-in. Asserted via an API spy on the run's `planMode` option
 * (the in-memory run simulation honours it). Role/text-based, agnostic to the
 * markup.
 */

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createInMemoryApi,
  type LykeionApi,
  type StartRunInput,
} from "@lykeion/api";
import App from "../App";

// A genuinely fresh (todo, never-run) task — the one that used to open on the
// chat-entry hero; the in-review CMP-3 task the other suites use has history.
const TODO_TASK = "#/researches/s_cmp/tasks/t_5";

/** Spy on every `startRun`'s `planMode`, driving the real in-memory run. */
function planModeSpy() {
  const api = createInMemoryApi();
  const planModes: (boolean | undefined)[] = [];
  const spied: LykeionApi = {
    ...api,
    startRun: (input: StartRunInput) => {
      planModes.push(input.options.planMode);
      return api.startRun(input);
    },
  };
  return { spied, planModes };
}

beforeEach(cleanup);

describe("a Task with nothing said in it yet", () => {
  it("opens on the conversation, not on an entry surface", async () => {
    const user = userEvent.setup();
    window.location.hash = TODO_TASK;
    render(<App api={createInMemoryApi()} />);

    // The conversation is what the Task opens on — transcript region and all,
    // empty though it is.
    const conversation = await screen.findByTestId("conversation");
    expect(within(conversation).getByTestId("conv-stream")).toBeInTheDocument();
    // …and the removed chat-entry hero is nowhere, before the first send.
    expect(
      screen.queryByRole("heading", { name: /what do you want to run/i }),
    ).not.toBeInTheDocument();

    await user.type(
      screen.getByLabelText("Message the agent"),
      "analyze the traces",
    );
    await user.click(screen.getByRole("button", { name: "Send" }));

    // A plain send is a NORMAL run — no plan gate. The turn lands in the same
    // conversation the Task opened on: the researcher's own message, then the
    // run driving straight to its first permission card (never an Approve gate).
    expect(
      await within(conversation).findByText("analyze the traces"),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: "Allow for this conversation",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /what do you want to run/i }),
    ).not.toBeInTheDocument();
  });

  it("sends a plain, normal run by default", async () => {
    const user = userEvent.setup();
    const { spied, planModes } = planModeSpy();
    window.location.hash = TODO_TASK;
    render(<App api={spied} />);

    await user.type(await screen.findByLabelText("Message the agent"), "go");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(planModes).toEqual([false]);
  });

  it("'Plan first' from the send menu opts into a plan-mode run", async () => {
    const user = userEvent.setup();
    const { spied, planModes } = planModeSpy();
    window.location.hash = TODO_TASK;
    render(<App api={spied} />);

    await user.type(await screen.findByLabelText("Message the agent"), "go");
    // The per-message opt-in lives in the send button's chevron, not the
    // settings popover.
    await user.click(screen.getByRole("button", { name: "Send options" }));
    await user.click(screen.getByRole("button", { name: "Plan first" }));

    expect(planModes).toEqual([true]);
    // …and the plan-mode run raises the researcher-facing plan gate.
    expect(
      await screen.findByRole("button", { name: "Approve" }),
    ).toBeInTheDocument();
  });
});
