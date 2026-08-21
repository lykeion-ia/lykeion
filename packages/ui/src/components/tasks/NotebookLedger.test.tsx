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

/**
 * Renders and waits for `CodeBlock`'s async shiki highlighter to settle on
 * every cell — the same wait `"shows loading, refresh warnings..."` already
 * does explicitly below — so a caller's synchronous assertions never race a
 * `setState` React would otherwise report outside `act`.
 */
async function renderLedger(
  props: Partial<ComponentProps<typeof NotebookLedger>> = {},
) {
  const result = render(
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
  const expectedShiki = props.loading ? 0 : (props.cells ?? []).length;
  await waitFor(() =>
    expect(document.querySelectorAll(".shiki")).toHaveLength(expectedShiki),
  );
  return result;
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
  const { container, rerender } = await renderLedger({ cells, autoOpenCellId: "fresh" });
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
  const { rerender } = await renderLedger({ loading: true });
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
 * rather than a computed style, the way the design tokens are
 * (`styles/tokens.test.ts`): jsdom resolves neither `color-mix()` nor the
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

it("says on the cell what it installed into this kernel only", async () => {
  // The spec's own words for why this is drawn rather than merely recorded:
  // "so a researcher scrolling back next week finds the answer on the cell
  // that caused it." A record only the wire can see answers nobody.
  await renderLedger({ cells: [cell({ installed: ["scanpy", "anndata"] })] });
  expect(screen.getByText(/scanpy, anndata/)).toBeInTheDocument();
  // The impermanence is the fact that matters. A researcher reading this
  // next week is looking at packages that are already gone.
  expect(screen.getByText(/gone\s+when it restarts/i)).toBeInTheDocument();
});

it("says nothing on a cell that installed nothing", async () => {
  // Absent is not zero, on the surface a researcher actually reads. A badge
  // saying "installed none" would appear on almost every cell in the
  // notebook and mean nothing on any of them.
  await renderLedger({ cells: [cell()] });
  expect(screen.queryByText(/installed into this kernel only/i)).not.toBeInTheDocument();
});

it("says nothing for an empty install list either", async () => {
  // The key should be absent rather than empty, and the wire is tested for
  // that at its own end — but this is the surface where an empty list would
  // become a visible claim, so it is refused here too rather than trusted.
  await renderLedger({ cells: [cell({ installed: [] })] });
  expect(screen.queryByText(/installed into this kernel only/i)).not.toBeInTheDocument();
});

it("renders the environment a cell ran in", async () => {
  await renderLedger({ cells: [cell({ environment: "genomics" })] });
  expect(screen.getByText("genomics")).toBeInTheDocument();
});

it("does not name the environment where it only repeats the language", async () => {
  // A Task on the default environment names it after its language, which is
  // the ordinary case rather than a corner of one. Rendering both puts the
  // same word twice in a header meant to be read at a glance.
  const { container } = await renderLedger({
    cells: [cell({ language: "python", environment: "python" })],
  });
  expect(container.querySelector(".nbp-cell-env")).toBeNull();
  expect(container.querySelector(".nbp-cell-lang")?.textContent).toBe("python");
});

it("says a tree was modified when the cell ran", async () => {
  await renderLedger({
    cells: [
      cell({
        codeState: {
          lineage: "abc12345",
          index: 3,
          git: { branch: "trunk", commit: "c".repeat(40), dirty: true },
        },
      }),
    ],
  });
  expect(screen.getByText("dirty")).toBeInTheDocument();
});

it("says a tree was clean when the cell ran", async () => {
  await renderLedger({
    cells: [
      cell({
        codeState: {
          lineage: "abc12345",
          index: 3,
          git: { branch: "trunk", commit: "c".repeat(40), dirty: false },
        },
      }),
    ],
  });
  expect(screen.getByText("clean")).toBeInTheDocument();
});

it("falls back to the lineage digest where no repository backed the cell", async () => {
  await renderLedger({ cells: [cell({ codeState: { lineage: "abc12345", index: 3 } })] });
  expect(screen.getByText("abc12345")).toBeInTheDocument();
});

it("renders no code state at all for a cell that has none", async () => {
  // A cell from before the envelope. An em dash here would be this rail
  // reporting a measurement that was never taken.
  await renderLedger({ cells: [cell({})] });
  expect(screen.queryByTestId("cell-code-state")).not.toBeInTheDocument();
});

it("names a payload this viewer cannot draw by its hash and its size", async () => {
  // A `data_ref` entry carries a sha256, a size, and whether a copy of the
  // payload reached the producing machine's store. It carries no path, so a
  // path rendered here would name a file nothing anywhere writes.
  await renderLedger({
    cells: [
      cell({
        id: "ref",
        outputs: [
          {
            kind: "display_data",
            data: { "application/pdf": "%PDF-1.7" },
            data_ref: {
              "application/pdf": { sha256: "3f2a1b09c4d5e6f7", size: 2048, stored: true },
            },
            metadata: {},
          },
        ],
      }),
    ],
    autoOpenCellId: "ref",
  });

  expect(screen.getByText("[application/pdf → 3f2a1b09, 2 KB]")).toBeInTheDocument();
});

it("names a payload whose reference says nothing by its MIME type alone", async () => {
  // Nothing between the kernel and this row reads a `data_ref` VALUE, so a
  // reference with no hash under it can arrive here. The MIME type is then
  // the only true thing this row can say, and a stand-in hash or a stand-in
  // size would be the viewer inventing a fact about a payload.
  await renderLedger({
    cells: [
      cell({
        id: "bare",
        outputs: [
          {
            kind: "display_data",
            data: { "application/pdf": "%PDF-1.7" },
            data_ref: { "application/pdf": null },
            metadata: {},
          },
        ] as unknown as NotebookCell["outputs"],
      }),
    ],
    autoOpenCellId: "bare",
  });

  expect(screen.getByText("[application/pdf]")).toBeInTheDocument();
});
