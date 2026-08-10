import { afterEach, expect, it } from "vitest";
import type { ComponentProps } from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NotebookCell } from "@lykeion/api";
import { DirectoryContext } from "../../api/ApiContext";
import { directoryOf } from "../../lib/assignee";
import { NotebookLedger, outputSummary } from "./NotebookLedger";

afterEach(cleanup);

function cell(overrides: Partial<NotebookCell> = {}): NotebookCell {
  return {
    id: "cell",
    kernelId: "k_1",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 1,
    source: "1 + 1",
    origin: { surface: "repl", by: "u_1" },
    ok: true,
    wallMs: 4,
    ts: 1,
    outputs: [{ kind: "stream", name: "stdout", text: "2\n" }],
    ...overrides,
  };
}

function renderLedger(
  props: Partial<ComponentProps<typeof NotebookLedger>> = {},
) {
  return render(
    <DirectoryContext.Provider value={directoryOf([])}>
      <NotebookLedger
        cells={[]}
        loading={false}
        warning={null}
        autoOpenCellId={null}
        contextLabel={null}
        writable={false}
        {...props}
      />
    </DirectoryContext.Provider>,
  );
}

it("opens only a fresh researcher cell and failures until the researcher changes them", async () => {
  const user = userEvent.setup();
  const cells = [
    cell({ id: "agent", source: "agent()", origin: { surface: "agent", by: "claude" } }),
    cell({ id: "fresh", source: "fresh()", origin: { surface: "repl", by: "u_1" } }),
    cell({ id: "old-repl", source: "old_repl()", origin: { surface: "repl", by: "u_1" } }),
    cell({
      id: "error",
      source: "fails()",
      origin: { surface: "agent", by: "claude" },
      ok: false,
      outputs: [{ kind: "error", ename: "ValueError", evalue: "bad", traceback: [] }],
    }),
  ];
  const { container, rerender } = renderLedger({ cells, autoOpenCellId: "fresh" });
  const details = () => [...container.querySelectorAll<HTMLDetailsElement>("details")];

  expect(details().map((detail) => detail.open)).toEqual([false, true, false, true]);

  for (const detail of details()) {
    await user.click(within(detail).getByText(/^(output|error)/));
  }
  expect(details().map((detail) => detail.open)).toEqual([true, false, true, false]);

  rerender(
    <DirectoryContext.Provider value={directoryOf([])}>
      <NotebookLedger
        cells={cells.map((item) => ({ ...item }))}
        loading={false}
        warning={null}
        autoOpenCellId="fresh"
        contextLabel={null}
        writable={false}
      />
    </DirectoryContext.Provider>,
  );
  expect(details().map((detail) => detail.open)).toEqual([true, false, true, false]);
});

it("summarizes figures, text lines, and message-only output deterministically", () => {
  expect(outputSummary([{ kind: "stream", name: "stdout", text: "alpha\nbeta\n" }])).toBe(
    "output · 2 lines",
  );
  expect(
    outputSummary([
      {
        kind: "display_data",
        data: { "image/png": "iVBORw0KGgo=" },
        data_ref: {},
        metadata: {},
      },
    ]),
  ).toBe("output · figure");
  expect(
    outputSummary([
      { kind: "display_data", data: {}, data_ref: {}, metadata: {} },
      { kind: "execute_result", execution_count: 1, data: {}, data_ref: {} },
    ]),
  ).toBe("output · 2 messages");
});

it("shows loading, refresh warnings, and the selected context terminal row", async () => {
  const cells = [
    cell({ id: "one" }),
    cell({ id: "two" }),
    cell({ id: "three" }),
    cell({ id: "four" }),
  ];
  const { rerender } = renderLedger({ loading: true });
  expect(screen.getByText("Loading notebook…")).toBeInTheDocument();

  rerender(
    <DirectoryContext.Provider value={directoryOf([])}>
      <NotebookLedger
        cells={cells}
        loading={false}
        warning="Could not refresh the notebook. Showing the last confirmed cells."
        autoOpenCellId={null}
        contextLabel="Main agent"
        writable
      />
    </DirectoryContext.Provider>,
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Could not refresh the notebook. Showing the last confirmed cells.",
  );
  expect(screen.getByTestId("notebook-footer")).toHaveTextContent(
    "Main agent — writable · 4 cells",
  );
  await waitFor(() => expect(document.querySelectorAll(".shiki")).toHaveLength(4));
});
