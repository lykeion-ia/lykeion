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
  sequence: over.sequence ?? 1,
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

  it("renders persisted typed blocks in arrival order inside one turn", () => {
    render(
      <TaskTranscript
        history={[turn({
          stream: [
            { kind: "text", text: "Visible plan", block: "thought" },
            { kind: "text", text: "Starting analysis", block: "interim" },
            { kind: "step", entry: { ts: 2, toolUseId: "py-1", tool: "python", input: {}, decision: "ran", result: "failed", isError: true } },
            { kind: "text", text: "Recovered result", block: "final" },
            { kind: "text", text: "Turn warning", block: "error" },
          ],
        })]}
        viewTurns={[]}
      />,
    );
    const kinds = Array.from(document.querySelectorAll("[data-block-kind]"))
      .map((node) => node.getAttribute("data-block-kind"));
    expect(kinds).toEqual(["thought", "interim", "tool", "final", "error"]);
    expect(screen.getByTestId("turn-block-thought")).not.toHaveAttribute("open");
    expect(screen.getByRole("alert")).toHaveTextContent("Turn warning");
    expect(screen.getAllByText("segment the ROIs")).toHaveLength(1);
  });

  it("renders legacy untyped stream prose safely", () => {
    render(<TaskTranscript history={[turn({ stream: [{ kind: "text", text: "Legacy prose" }] })]} viewTurns={[]} />);
    expect(screen.getByTestId("turn-block-interim")).toHaveTextContent("Legacy prose");
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

  it("orders an interleaved live turn before a later nested subagent", () => {
    render(
      <TaskTranscript
        history={[
          turn({
            runId: "run-parent",
            sequence: 1,
            prompt: "parent at sequence one",
          }),
          turn({
            runId: "run-subagent",
            sequence: 3,
            subagent: "statistician",
            prompt: "subagent at sequence three",
          }),
        ]}
        viewTurns={[]}
        liveTurns={[
          {
            runId: "run-live",
            sequence: 2,
            content: <div>live at sequence two</div>,
          },
        ]}
      />,
    );

    const parent = screen.getByText("parent at sequence one");
    const live = screen.getByText("live at sequence two");
    const subagent = screen.getByText("subagent at sequence three");
    expect(
      parent.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      live.compareDocumentPosition(subagent) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("preserves an unacknowledged cancellation warning after history reconciliation", () => {
    render(
      <TaskTranscript
        history={[turn({ runId: "run_1", status: "failed" })]}
        viewTurns={[]}
        terminalStatusByRunId={{
          run_1: { state: "cancelled", unacknowledged: true },
        }}
      />,
    );

    expect(
      screen.getByText(
        "The agent has not confirmed it stopped — it may still be running.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Run failed")).not.toBeInTheDocument();
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
