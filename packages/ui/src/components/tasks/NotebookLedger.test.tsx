import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * A cell is one record with two halves, and the output half is drawn on the
 * same material as the source that produced it. Asserted against the stylesheet
 * rather than a computed style, the way the crumb band's geometry is
 * (`TaskTabStrip.test.tsx`): jsdom resolves neither `color-mix()` nor the
 * cascade that puts these tokens in reach.
 */
const notebookCss = readFileSync(
  join(import.meta.dirname, "notebook.css"),
  "utf8",
);

function rule(selector: string): string {
  const match = notebookCss.match(
    new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`),
  );
  expect(match, `no ${selector} rule in notebook.css`).not.toBeNull();
  return match![1];
}

it("draws a cell's outputs as a code surface, not as loose text under one", () => {
  const outputs = rule(".nbp-outputs");

  // A frame, on the inset ground `.code-block` uses — darker than the panel's
  // own `--sidebar`, which is what makes it read as a panel here.
  expect(outputs).toMatch(/border:\s*1px solid var\(--hairline\)/);
  expect(outputs).toMatch(/background:\s*var\(--surface-1\)/);
  expect(outputs).toMatch(/border-radius:\s*8px/);
  // An output is as long as the process that wrote it; one runaway stdout is
  // not allowed to become the whole of the ledger's scroll.
  expect(outputs).toMatch(/max-height:\s*320px/);
  expect(outputs).toMatch(/overflow-y:\s*auto/);
  // No longer indented under the disclosure: the frame lines up with the
  // source block above it.
  expect(outputs).not.toMatch(/padding:[^;]*12px/);

  // Sized to match `.code-block-pre`, so the two halves read together. A rung,
  // never a pixel count — `tokens.test.ts` polices that across the package.
  expect(rule(".nbp-out")).toMatch(/font-size:\s*var\(--type-sub\)/);
});

it("says on the cell what it installed into this kernel only", () => {
  // The spec's own words for why this is drawn rather than merely recorded:
  // "so a researcher scrolling back next week finds the answer on the cell
  // that caused it." A record only the wire can see answers nobody.
  renderLedger({ cells: [cell({ installed: ["scanpy", "anndata"] })] });
  expect(screen.getByText(/scanpy, anndata/)).toBeInTheDocument();
  // The impermanence is the fact that matters. A researcher reading this
  // next week is looking at packages that are already gone.
  expect(screen.getByText(/gone\s+when it restarts/i)).toBeInTheDocument();
});

it("says nothing on a cell that installed nothing", () => {
  // Absent is not zero, on the surface a researcher actually reads. A badge
  // saying "installed none" would appear on almost every cell in the
  // notebook and mean nothing on any of them.
  renderLedger({ cells: [cell()] });
  expect(screen.queryByText(/installed into this kernel only/i)).not.toBeInTheDocument();
});

it("says nothing for an empty install list either", () => {
  // The key should be absent rather than empty, and the wire is tested for
  // that at its own end — but this is the surface where an empty list would
  // become a visible claim, so it is refused here too rather than trusted.
  renderLedger({ cells: [cell({ installed: [] })] });
  expect(screen.queryByText(/installed into this kernel only/i)).not.toBeInTheDocument();
});
