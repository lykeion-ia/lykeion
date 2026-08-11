/**
 * The agent named at the head of the Task surface.
 *
 * Which coding agent a Task is talking to holds for the whole page, so the
 * breadcrumb is where it belongs. What is under test is WHICH agent it names:
 * the one the turns actually ran on, never the one the composer would fall
 * back to. The two differ exactly when the Task's agent is not installed on
 * the machine now reading it — a Task outlives the laptop that ran it.
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
    runtimeId: "rt_1",
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
});
