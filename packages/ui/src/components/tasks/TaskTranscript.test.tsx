import { render, screen } from "@testing-library/react";
import type { TaskTurn } from "@lykeion/api";
import { describe, expect, it } from "vitest";
import { TaskTranscript, groupTaskTurns } from "./TaskTranscript";

const turn = (over: Partial<TaskTurn> = {}): TaskTurn => ({
  runId: "run_1",
  ts: 1,
  prompt: "segment the ROIs",
  messages: ["Done — 512 ROIs."],
  status: "ok",
  code: [],
  outputs: [],
  ...over,
});

describe("grouping a transcript's turns", () => {
  it("nests a subagent turn under the plain turn before it", () => {
    const groups = groupTaskTurns([
      turn({ runId: "run_1" }),
      turn({ runId: "run_2", subagent: "statistician" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].turn.runId).toBe("run_1");
    expect(groups[0].subagents.map((t) => t.runId)).toEqual(["run_2"]);
  });

  it("renders an orphaned subagent turn rather than dropping it", () => {
    const groups = groupTaskTurns([
      turn({ runId: "run_1", subagent: "statistician" }),
    ]);
    expect(groups.map((g) => g.turn.runId)).toEqual(["run_1"]);
  });
});

describe("the transcript", () => {
  it("renders each persisted turn's prompt and reply", () => {
    render(<TaskTranscript history={[turn()]} viewTurns={[]} />);
    expect(screen.getByText("segment the ROIs")).toBeInTheDocument();
    expect(screen.getByText("Done — 512 ROIs.")).toBeInTheDocument();
  });

  it("renders a turn finished in this view alongside the persisted ones", () => {
    render(
      <TaskTranscript
        history={[turn()]}
        viewTurns={[
          { prompt: "and the drift?", messages: ["Corrected."], status: "ok" },
        ]}
      />,
    );
    expect(screen.getByText("and the drift?")).toBeInTheDocument();
    expect(screen.getByText("Corrected.")).toBeInTheDocument();
  });

  it("draws a subagent turn under its parent, not as its own bubble", () => {
    render(
      <TaskTranscript
        history={[
          turn({ runId: "run_1" }),
          turn({
            runId: "run_2",
            subagent: "statistician",
            prompt: "fit the tuning curves",
          }),
        ]}
        viewTurns={[]}
      />,
    );
    expect(screen.getByText("fit the tuning curves")).toBeInTheDocument();
    expect(screen.getByText("statistician")).toBeInTheDocument();
  });

  it("renders nothing for an empty transcript", () => {
    const { container } = render(
      <TaskTranscript history={[]} viewTurns={[]} />,
    );
    // Nothing at all — not an empty wrapper, not a placeholder. A Task nobody
    // has spoken in is the centered chat entry, and the transcript must leave
    // the column to it.
    expect(container).toBeEmptyDOMElement();
  });
});
