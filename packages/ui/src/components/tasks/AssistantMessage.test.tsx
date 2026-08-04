import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AssistantMessage } from "./AssistantMessage";
import { openExternal } from "../../lib/open-external";

vi.mock("../../lib/open-external", () => ({
  openExternal: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(openExternal).mockClear();
});

describe("AssistantMessage", () => {
  it("renders a `- item` line as an <li>, not literal text", () => {
    render(<AssistantMessage text="- item" />);
    const item = screen.getByRole("listitem");
    expect(item).toHaveTextContent("item");
    expect(screen.queryByText("- item")).toBeNull();
  });

  it("renders a GFM table as a <table>", () => {
    const md = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    render(<AssistantMessage text={md} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("renders `<script>alert(1)</script>` as literal text and creates no element", () => {
    const { container } = render(
      <AssistantMessage text="<script>alert(1)</script>" />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("with `live`, text ending `**bold` renders a <strong>", () => {
    render(<AssistantMessage text="Look at this: **bold" live />);
    const strong = screen.getByText("bold");
    expect(strong.tagName).toBe("STRONG");
  });

  it("without `live`, the same text renders the asterisks literally", () => {
    render(<AssistantMessage text="Look at this: **bold" />);
    expect(document.querySelector("strong")).toBeNull();
    expect(screen.getByText(/\*\*bold/)).toBeInTheDocument();
  });

  it("a link click calls the opener and does not navigate", () => {
    const before = window.location.href;
    render(<AssistantMessage text="[docs](https://example.com/docs)" />);
    const link = screen.getByRole("link", { name: "docs" });
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(window.location.href).toBe(before);
  });

  it("a bare fence (no language tag) renders a CodeBlock, not inline <code>", () => {
    const md = ["```", "const a = 1;", "```"].join("\n");
    const { container } = render(<AssistantMessage text={md} />);
    expect(screen.getByTestId("code-block-pre")).toBeInTheDocument();
    // An inline `<code>` would sit directly under the message div with no
    // `.code-block` wrapper; a real CodeBlock always has one.
    expect(container.querySelector(".code-block")).toBeInTheDocument();
  });

  it("a language-tagged fence renders a CodeBlock with that language's label", () => {
    const md = ["```ts", "const a: number = 1;", "```"].join("\n");
    const { container } = render(<AssistantMessage text={md} />);
    expect(screen.getByTestId("code-block-pre")).toBeInTheDocument();
    expect(container.querySelector(".code-block-lang")).toHaveTextContent("ts");
  });

  it("inline `code` stays a plain <code>, not a CodeBlock", () => {
    const { container } = render(<AssistantMessage text="call `foo()` now" />);
    expect(screen.queryByTestId("code-block-pre")).toBeNull();
    expect(container.querySelector(".code-block")).toBeNull();
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent("foo()");
  });
});

/**
 * The final summary's `~1 MB → reference by name` contract.
 *
 * Splitting it honestly: the AGENT decides which deliverables are linked and
 * which are named (it is the only side that knows the sizes), and this renderer
 * owes it faithfulness — a linked file must be clickable, and a file the agent
 * deliberately left as a bare monospace name must NOT be turned back into a link
 * by some helpful autolinking. Silently linking a >1 MB file would undo the
 * instruction the agent honoured.
 */
describe("final summary — files referenced by name are never re-linked", () => {
  const SUMMARY = [
    "## Key deliverables",
    "",
    "- [kinome_genes.csv](artifacts/kinome_genes.csv) — 522 genes",
    "- `final_kinome_library.csv` — 3.4 MB",
    "- `oligo_pool_synthesis.csv` — 2.1 MB",
    "",
    "Per your instruction, the two files larger than ~1 MB are referenced by",
    "name rather than linked; both are saved as artifacts.",
  ].join("\n");

  it("renders the small file as a clickable link", () => {
    render(<AssistantMessage text={SUMMARY} />);
    const link = screen.getByRole("link", { name: "kinome_genes.csv" });
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalled();
  });

  it("renders the >1 MB files as monospace names, and as no link at all", () => {
    render(<AssistantMessage text={SUMMARY} />);
    for (const name of ["final_kinome_library.csv", "oligo_pool_synthesis.csv"]) {
      // Present, and inline code — as plain monospace names.
      const node = screen.getByText(name);
      expect(node.tagName.toLowerCase()).toBe("code");
      // And emphatically not a link: no anchor anywhere carries that name.
      expect(screen.queryByRole("link", { name })).toBeNull();
      expect(node.closest("a")).toBeNull();
    }
    // Exactly one link in the whole summary — the one the agent wrote.
    expect(screen.getAllByRole("link")).toHaveLength(1);
  });

  it("keeps the compliance sentence as readable prose", () => {
    render(<AssistantMessage text={SUMMARY} />);
    expect(
      screen.getByText(/referenced by\s+name rather than linked/),
    ).toBeInTheDocument();
  });
});
