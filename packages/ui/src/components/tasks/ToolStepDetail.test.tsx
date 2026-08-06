import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ExecutionLogEntry } from "@lykeion/api";
import {
  ToolStepDetail,
  langForPath,
  parseWebResults,
  stepOutcome,
  stripReadLineNumbers,
  unifiedDiff,
} from "./ToolStepDetail";

const entry = (over: Partial<ExecutionLogEntry> = {}): ExecutionLogEntry => ({
  ts: 1,
  toolUseId: "tu-1",
  tool: "execute",
  input: {},
  decision: "ran",
  isError: false,
  ...over,
});

describe("langForPath", () => {
  it("maps known extensions to a bundled shiki language", () => {
    expect(langForPath("a/b/data.py")).toBe("python");
    expect(langForPath("Cargo/main.rs")).toBe("rust");
    expect(langForPath("notes.md")).toBe("markdown");
    expect(langForPath("q.SQL")).toBe("sql");
  });

  it("returns undefined for an unknown extension or no path", () => {
    expect(langForPath("archive.tar")).toBeUndefined();
    expect(langForPath("Makefile")).toBeUndefined();
    expect(langForPath(undefined)).toBeUndefined();
  });
});

describe("unifiedDiff — a real line-level diff, not all-removed-then-all-added", () => {
  it("marks only the lines that changed, keeping the rest as context", () => {
    expect(unifiedDiff("a\nb\nc", "a\nB\nc")).toBe(" a\n-b\n+B\n c");
  });

  it("handles pure insertions and deletions", () => {
    expect(unifiedDiff("a\nc", "a\nb\nc")).toBe(" a\n+b\n c");
    expect(unifiedDiff("a\nb\nc", "a\nc")).toBe(" a\n-b\n c");
  });
});

describe("stripReadLineNumbers", () => {
  it("strips `cat -n` numbering when every non-empty line carries it", () => {
    expect(stripReadLineNumbers("1\tconst a = 1;\n2\tconst b = 2;\n")).toBe(
      "const a = 1;\nconst b = 2;\n",
    );
  });

  it("leaves content untouched when it is not uniformly numbered", () => {
    const raw = "no numbers here\njust text";
    expect(stripReadLineNumbers(raw)).toBe(raw);
  });
});

describe("parseWebResults — defensive across the shapes a search can produce", () => {
  it("parses a JSON array of {title,url}", () => {
    const text = JSON.stringify([
      { title: "First", url: "https://a.example/1" },
      { title: "Second", url: "https://b.example/2" },
    ]);
    expect(parseWebResults(text)).toEqual([
      { title: "First", url: "https://a.example/1" },
      { title: "Second", url: "https://b.example/2" },
    ]);
  });

  it("parses a JSON object with a `results` array", () => {
    const text = JSON.stringify({
      results: [{ name: "Only", link: "https://c.example" }],
    });
    expect(parseWebResults(text)).toEqual([
      { title: "Only", url: "https://c.example" },
    ]);
  });

  it("parses markdown links", () => {
    const text = "See [Nature paper](https://nature.example/x) for details.";
    expect(parseWebResults(text)).toEqual([
      { title: "Nature paper", url: "https://nature.example/x" },
    ]);
  });

  it("parses a title line followed by a bare URL line", () => {
    const text = "Bridge RNA mechanism\nhttps://nature.example/article\n";
    expect(parseWebResults(text)).toEqual([
      { title: "Bridge RNA mechanism", url: "https://nature.example/article" },
    ]);
  });

  it("returns null when nothing looks like a result", () => {
    expect(parseWebResults("just a plain sentence with no links")).toBeNull();
  });
});

describe("ToolStepDetail — per-tool bodies", () => {
  it("execute: renders the command over its STDOUT", () => {
    render(
      <ToolStepDetail
        entry={entry({
          tool: "execute",
          input: { command: "echo hi\nls -la" },
          result: "hi\ntotal 0",
        })}
      />,
    );
    expect(screen.getByText(/ls -la/)).toBeInTheDocument();
    expect(screen.getByTestId("tool-output")).toHaveTextContent("total 0");
  });

  it("read: renders the file contents with the cat -n numbering stripped", () => {
    const { container } = render(
      <ToolStepDetail
        entry={entry({
          tool: "read",
          input: { file_path: "src/a.ts" },
          result: "1\tconst x = 1;\n2\tconst y = 2;\n",
        })}
      />,
    );
    expect(container.textContent).toContain("const x = 1;");
    // The numbering is gone — no leading "1<tab>".
    expect(container.textContent).not.toContain("1\tconst");
  });

  it("edit: renders a diff from old_string/new_string", () => {
    const { container } = render(
      <ToolStepDetail
        entry={entry({
          tool: "edit",
          input: {
            file_path: "notes.md",
            old_string: "alpha\nbeta\ngamma",
            new_string: "alpha\nBETA\ngamma",
          },
        })}
      />,
    );
    // The changed line shows as a removal AND an addition; context stays.
    expect(container.textContent).toContain("-beta");
    expect(container.textContent).toContain("+BETA");
  });

  it("edit (create): renders the written content", () => {
    render(
      <ToolStepDetail
        entry={entry({
          tool: "edit",
          input: { file_path: "out.csv", content: "a,b\n1,2" },
        })}
      />,
    );
    expect(screen.getByText(/a,b/)).toBeInTheDocument();
  });

  it("fetch (search): renders the query over a results list", () => {
    render(
      <ToolStepDetail
        entry={entry({
          tool: "fetch",
          input: { query: "DEDD recombinase", url: "" },
          result: JSON.stringify([
            { title: "Bridge RNA", url: "https://nature.example/x" },
          ]),
        })}
      />,
    );
    expect(screen.getByText("DEDD recombinase")).toBeInTheDocument();
    const results = screen.getByTestId("tool-results");
    expect(within(results).getByText("Bridge RNA")).toBeInTheDocument();
    expect(
      within(results).getByText("https://nature.example/x"),
    ).toBeInTheDocument();
  });

  it("fetch (search): falls back to raw text when results don't parse", () => {
    render(
      <ToolStepDetail
        entry={entry({
          tool: "fetch",
          input: { query: "q" },
          result: "an unstructured summary paragraph",
        })}
      />,
    );
    expect(screen.queryByTestId("tool-results")).toBeNull();
    expect(screen.getByTestId("tool-output")).toHaveTextContent(
      "an unstructured summary paragraph",
    );
  });

  it("fetch: renders the url over the fetched response", () => {
    render(
      <ToolStepDetail
        entry={entry({
          tool: "fetch",
          input: { url: "https://example.com/page" },
          result: "fetched body text",
        })}
      />,
    );
    expect(screen.getByText("https://example.com/page")).toBeInTheDocument();
    expect(screen.getByTestId("tool-output")).toHaveTextContent(
      "fetched body text",
    );
  });

  it("falls back to a generic input/output view for a kind it does not draw", () => {
    const { container } = render(
      <ToolStepDetail
        entry={entry({
          tool: "hologram",
          input: { foo: "bar" },
          result: "opaque output",
        })}
      />,
    );
    expect(container.textContent).toContain("foo");
    expect(screen.getByTestId("tool-output")).toHaveTextContent(
      "opaque output",
    );
  });

  it("uses the live stdout as the output when a running step has no result yet", () => {
    render(
      <ToolStepDetail
        entry={entry({
          tool: "execute",
          input: { command: "sleep 1" },
          result: undefined,
        })}
        stdout={"partial line"}
      />,
    );
    expect(screen.getByTestId("tool-output")).toHaveTextContent("partial line");
  });
});

describe("ToolStepDetail — every step opens onto something true", () => {
  it("renders both text blocks of an output that carried two", () => {
    render(
      <ToolStepDetail
        entry={entry({
          tool: "execute",
          input: { command: "run" },
          result: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        })}
      />,
    );
    const output = screen.getByTestId("tool-output");
    expect(output).toHaveTextContent("first");
    expect(output).toHaveTextContent("second");
  });

  it("draws a diff part as a diff over the path it names", () => {
    const { container } = render(
      <ToolStepDetail
        entry={entry({
          tool: "edit",
          input: {},
          result: [
            {
              type: "diff",
              path: "/data/notes.md",
              oldText: "alpha\nbeta\ngamma",
              newText: "alpha\nBETA\ngamma",
            },
          ],
        })}
      />,
    );
    expect(container.textContent).toContain("/data/notes.md");
    expect(container.textContent).toContain("-beta");
    expect(container.textContent).toContain("+BETA");
  });

  it("draws a terminal part's output", () => {
    render(
      <ToolStepDetail
        entry={entry({
          tool: "execute",
          input: { command: "ls" },
          result: [{ type: "terminal", output: "12 rows" }],
        })}
      />,
    );
    expect(screen.getByTestId("tool-output")).toHaveTextContent("12 rows");
  });

  it("names a resource link as a reference rather than drawing it as content", () => {
    const { container } = render(
      <ToolStepDetail
        entry={entry({
          tool: "read",
          input: {},
          result: [
            { type: "resource", uri: "file:///data/counts.csv", name: "counts.csv" },
          ],
        })}
      />,
    );
    expect(container.textContent).toContain("file:///data/counts.csv");
    expect(screen.getByTestId("tool-output-resource")).toBeInTheDocument();
  });

  it("names a part type it cannot draw rather than leaving a blank", () => {
    const { container } = render(
      <ToolStepDetail
        entry={entry({
          tool: "other",
          input: {},
          result: [{ type: "other", blockType: "hologram" }],
        })}
      />,
    );
    expect(container.textContent).toContain("hologram");
  });

  it("says a step ran and produced nothing, rather than showing an empty region", () => {
    const { container } = render(
      <ToolStepDetail entry={entry({ tool: "execute", input: {}, result: "" })} />,
    );
    expect(container.textContent).toMatch(/produced no output/i);
  });

  it("says a step's output was not captured, which is not the same as none", () => {
    const { container } = render(
      <ToolStepDetail entry={entry({ tool: "execute", input: {}, decision: "ran" })} />,
    );
    expect(container.textContent).toMatch(/not captured/i);
    expect(container.textContent).not.toMatch(/produced no output/i);
  });

  it("says a denied step never ran", () => {
    const { container } = render(
      <ToolStepDetail
        entry={entry({ tool: "edit", input: {}, decision: "denied", isError: true })}
      />,
    );
    expect(container.textContent).toMatch(/never ran/i);
    expect(container.textContent).toMatch(/denied/i);
  });

  it("tells a step stopped at the gate apart from one that was denied there", () => {
    const { container } = render(
      <ToolStepDetail
        entry={entry({ tool: "edit", input: {}, decision: "cancelled", isError: true })}
      />,
    );
    expect(container.textContent).toMatch(/never ran/i);
    expect(container.textContent).toMatch(/stopped/i);
  });

  it("renders a body for a step carrying neither input nor output", () => {
    const { container } = render(
      <ToolStepDetail entry={entry({ tool: "other", input: {} })} />,
    );
    expect(container.textContent?.trim()).not.toBe("");
  });
});

describe("stepOutcome — the four states, told apart", () => {
  it("keeps a call that produced nothing apart from one whose output was lost", () => {
    expect(stepOutcome(entry({ result: "" }))).toBe("no-output");
    expect(stepOutcome(entry({ result: [] }))).toBe("no-output");
    expect(stepOutcome(entry({}))).toBe("not-captured");
  });

  it("reads a call that never ran off its decision, whatever the record holds", () => {
    expect(
      stepOutcome(entry({ decision: "denied", result: "auto-refused" })),
    ).toBe("never-ran");
    expect(stepOutcome(entry({ decision: "cancelled" }))).toBe("never-ran");
  });

  it("calls a step with parts an output, live or persisted", () => {
    expect(stepOutcome(entry({ result: "12 rows" }))).toBe("output");
    expect(stepOutcome(entry({ result: [{ type: "terminal", output: "x" }] }))).toBe(
      "output",
    );
    expect(stepOutcome(entry({ decision: "pending" }), "live tail")).toBe("output");
  });

  it("does not call a running step's missing output lost", () => {
    expect(stepOutcome(entry({ decision: "pending" }))).toBe("running");
  });
});
