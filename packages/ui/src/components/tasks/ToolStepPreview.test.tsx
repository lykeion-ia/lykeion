import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { act, render, screen, fireEvent, within } from "@testing-library/react";
import { createInMemoryApi, type ExecutionLogEntry } from "@lykeion/api";
import { ApiProvider } from "../../api/ApiContext";
import { ToolStepPreview } from "./ToolStepPreview";
import { ToolStepCard } from "./ToolStep";

/**
 * The collapsed row's IN/OUT pane: what a step DID, without opening it.
 *
 * The whole point is that it says something TRUE about the step and nothing
 * more — so most of what is pinned here is what it declines to draw: a refused
 * call's refusal reason (which is not output), a result the row is already
 * showing in full, and anything at all once the row is open.
 */

const entry = (over: Partial<ExecutionLogEntry> = {}): ExecutionLogEntry => ({
  ts: 1,
  toolUseId: "tu-1",
  tool: "Bash",
  input: { command: "wc -l data.csv" },
  decision: "allowed-once",
  result: "42 data.csv",
  isError: false,
  ...over,
});

describe("ToolStepPreview", () => {
  it("draws the argument over what the call produced", () => {
    render(<ToolStepPreview entry={entry()} input="wc -l data.csv" />);
    expect(screen.getByTestId("step-io")).toBeInTheDocument();
    expect(screen.getByText("wc -l data.csv")).toHaveClass("step-io-in");
    expect(screen.getByText("42 data.csv")).toHaveClass("step-io-out");
  });

  it("draws only the half it has", () => {
    const { rerender, container } = render(<ToolStepPreview entry={entry()} />);
    expect(container.querySelector(".step-io-in")).toBeNull();
    expect(screen.getByText("42 data.csv")).toBeInTheDocument();

    rerender(
      <ToolStepPreview
        entry={entry({ result: undefined })}
        input="wc -l data.csv"
      />,
    );
    expect(screen.getByText("wc -l data.csv")).toBeInTheDocument();
    expect(container.querySelector(".step-io-out")).toBeNull();
  });

  it("renders nothing at all when it has neither", () => {
    const { container } = render(
      <ToolStepPreview entry={entry({ result: undefined })} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("does not pass a REFUSED call's reason off as output", () => {
    // `decision: "denied"` and `isError: true` always co-occur, and the refusal
    // reason merges onto the entry as its `result`. It is not what the call
    // produced — the call produced nothing, because it never ran. The opened
    // detail states it as a reason; the preview declines to draw it.
    for (const decision of ["denied", "cancelled"]) {
      const { container, unmount } = render(
        <ToolStepPreview
          entry={entry({
            decision,
            isError: true,
            result: "Permission to run this command was denied.",
          })}
        />,
      );
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("shows a still-running tool's live tail in the same OUT row", () => {
    // A live entry carries no `result` (it is announced once, and the result
    // merges later with no second announcement), so the tail IS the output as
    // far as the row is concerned — same place, same treatment.
    render(
      <ToolStepPreview
        entry={entry({ decision: "ran", result: undefined })}
        stdout={"line one\nline two"}
      />,
    );
    const tail = screen.getByTestId("step-stdout");
    expect(tail.tagName).toBe("PRE");
    expect(tail).toHaveClass("step-io-out", "step-stdout");
    expect(tail.textContent).toBe("line one\nline two");
  });

  it("does not label a LANDED result as a live tail", () => {
    // `step-stdout` means "still arriving". A landed result wearing that hook
    // would make the live tests pass over a turn that finished minutes ago.
    render(<ToolStepPreview entry={entry()} />);
    expect(screen.queryByTestId("step-stdout")).toBeNull();
  });

  it("drops the trailing newline real output ends with", () => {
    // A blank final line costs a quarter of a four-line pane. Leading
    // whitespace is content and stays.
    render(<ToolStepPreview entry={entry({ result: "  indented\n" })} />);
    expect(screen.getByText("indented").textContent).toBe("  indented");
  });
});

describe("the OUT pane is clamped, and fades rather than cuts", () => {
  // jsdom neither lays out nor applies the app's CSS, so this reads the
  // stylesheet source — the approach `TaskScreen.live.test.tsx` uses.
  const css = readFileSync(
    resolve(process.cwd(), "src/screens/task.css"),
    "utf8",
  );
  const rule = css.match(/^\.step-io-out\s*\{[^}]*\}/m)?.[0] ?? "";

  it("caps the pane at a few lines", () => {
    expect(rule).toMatch(/max-height:\s*var\(--io-clamp\)/);
    expect(rule).toMatch(/overflow:\s*hidden/);
  });

  it("fades the clamped edge instead of cutting it", () => {
    // A hard edge reads as "that is all of it", which is the one thing this
    // pane must not say — the whole output is one click away.
    expect(rule).toMatch(/mask-image:\s*linear-gradient/);
    // Measured from the top in ABSOLUTE lengths, not percentages: output
    // shorter than the clamp must not fade at all, and a percentage would fade
    // the last 40% of a one-line pane.
    expect(rule).not.toMatch(/mask-image:[^;]*%/);
  });
});

describe("the preview and the opened detail never both draw", () => {
  it("gives way to the detail when the row is opened, and comes back", async () => {
    render(
      <ApiProvider api={createInMemoryApi()}>
        <ToolStepCard entry={entry()} />
      </ApiProvider>,
    );
    expect(screen.getByTestId("step-io")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-step-detail")).toBeNull();

    const head = screen.getByRole("button", { name: /wc -l data\.csv/i });
    fireEvent.click(head);
    // Opening the row mounts `ToolStepDetail`, which fetches its own cells —
    // flushed here so that fetch settles inside this test's act, not after.
    await act(async () => {});

    // Opened: the full detail, and the preview is gone — the two carry the same
    // content, and the row must not show it twice.
    const detail = screen.getByTestId("tool-step-detail");
    expect(within(detail).getByTestId("tool-output")).toHaveTextContent(
      "42 data.csv",
    );
    expect(screen.queryByTestId("step-io")).toBeNull();
    expect(screen.getAllByText("42 data.csv")).toHaveLength(1);

    fireEvent.click(head);
    expect(screen.getByTestId("step-io")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-step-detail")).toBeNull();
  });

  it("moves a live tail into the detail rather than drawing it in both", async () => {
    render(
      <ApiProvider api={createInMemoryApi()}>
        <ToolStepCard
          entry={entry({ decision: "ran", result: undefined })}
          stdout="still arriving"
        />
      </ApiProvider>,
    );
    expect(screen.getByTestId("step-stdout")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /wc -l data\.csv/i }));
    // Opening the row mounts `ToolStepDetail`, which fetches its own cells —
    // flushed here so that fetch settles inside this test's act, not after.
    await act(async () => {});
    expect(screen.queryByTestId("step-stdout")).toBeNull();
    expect(screen.getAllByText(/still arriving/)).toHaveLength(1);
  });
});
