/**
 * The agent named at the head of the Task surface.
 *
 * Which coding agent a Task is talking to holds for the whole page, so the
 * breadcrumb is where it belongs. What is under test is WHICH agent it names,
 * and the order is the whole rule: any history at all outranks the composer's
 * fallback, so a Task that has spoken names what spoke and never what is
 * merely installed. The two differ exactly when the Task's agent is not on
 * the machine now reading it — a Task outlives the laptop that ran it.
 *
 * Only a Task with no history of any kind falls through to the agent its
 * first turn is about to go to, which is the one case where there is no past
 * run that naming it could misreport.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  createInMemoryApi,
  type AgentCli,
  type LykeionApi,
} from "@lykeion/api";
import App from "../App";

const ROUTE = "#/studies/s_cmp/tasks/t_3";

function cli(id: string, name: string): AgentCli {
  return {
    id,
    name,
    command: id,
    version: "1",
    available: true,
    machineId: "rt_1",
    sessionReady: true,
  };
}

/** The seeded CMP-3 chat, re-recorded as having run on `agent`. */
async function apiWithTaskOn(
  agent: string,
  clis: AgentCli[],
): Promise<LykeionApi> {
  const base = createInMemoryApi();
  const seeded = await base.getTask("t_3");
  return {
    ...base,
    listAgentClis: async () => clis,
    getTask: async (taskId: string) =>
      taskId === "t_3"
        ? {
            task: { ...seeded.task, agent },
            turns: seeded.turns.map((t) => ({ ...t, agent })),
          }
        : base.getTask(taskId),
  };
}

/** The same seeded Task with nothing said in it yet: no turns, and no agent
 *  recorded against it. What a Task looks like between "New Task" and its
 *  first Send. */
async function apiWithUnrunTask(clis: AgentCli[]): Promise<LykeionApi> {
  const base = createInMemoryApi();
  const seeded = await base.getTask("t_3");
  const { agent: _neverRan, ...task } = seeded.task;
  return {
    ...base,
    listAgentClis: async () => clis,
    getTask: async (taskId: string) =>
      taskId === "t_3" ? { task, turns: [] } : base.getTask(taskId),
  };
}

/** The breadcrumb strip — the trail's own row, where the label rides. */
async function strip(): Promise<HTMLElement> {
  const trail = await screen.findByRole("navigation", { name: "Breadcrumb" });
  return trail.parentElement!;
}

afterEach(cleanup);

describe("the agent named in the Task's breadcrumb", () => {
  it("names the agent the Task ran on, not the one the composer fell back to", async () => {
    // Cursor ran the turns; only Claude is detected here. The composer must
    // still offer Claude's models — it is what a next turn could reach — and
    // the strip must still say Cursor, because that is what spoke.
    const api = await apiWithTaskOn("cursor", [cli("claude", "Claude Code")]);
    window.location.hash = ROUTE;
    render(<App api={api} />);

    const crumb = within(await strip());
    expect(await crumb.findByText("Cursor")).toBeInTheDocument();
    expect(crumb.queryByText("Claude Code")).toBeNull();
  });

  it("calls the agent what this machine's detection calls it", async () => {
    // Detected, so the name comes from the machine that found it rather than
    // from the brand table — "Claude Code", not the table's "Claude".
    const api = await apiWithTaskOn("claude", [cli("claude", "Claude Code")]);
    window.location.hash = ROUTE;
    render(<App api={api} />);

    const crumb = within(await strip());
    expect(await crumb.findByText("Claude Code")).toBeInTheDocument();
  });

  it("names the agent a Task about to run its first turn will go to", async () => {
    // Nothing has spoken here yet, so there is no past run for this to
    // misreport — and the researcher is one Send away from an agent the head
    // of the page stayed silent about. It names the one the turn will reach.
    const api = await apiWithUnrunTask([cli("claude", "Claude Code")]);
    window.location.hash = ROUTE;
    render(<App api={api} />);

    const crumb = within(await strip());
    expect(await crumb.findByText("Claude Code")).toBeInTheDocument();
  });

  it("stays silent on an unrun Task when the lab has no CLI to send to", async () => {
    // The prospect is the whole reason to name anything here, and there is
    // none: no machine of this member's is offering an agent. A placeholder
    // would promise a dispatch this lab cannot make.
    const api = await apiWithUnrunTask([]);
    window.location.hash = ROUTE;
    render(<App api={api} />);

    const crumb = within(await strip());
    await crumb.findByRole("navigation", { name: "Breadcrumb" });
    expect(crumb.queryByText("Claude Code")).toBeNull();
    expect(crumb.queryByText("Claude")).toBeNull();
  });
});
