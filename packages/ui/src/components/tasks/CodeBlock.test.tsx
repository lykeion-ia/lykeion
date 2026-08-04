import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CodeBlock } from "./CodeBlock";

describe("CodeBlock", () => {
  it("the copy button writes the exact source text and shows a transient 'Copied'", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const source = "const a = 1;\nconst b = 2;";
    render(<CodeBlock code={source} />);

    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));

    expect(writeText).toHaveBeenCalledWith(source);
    await screen.findByText("Copied");
  });

  it("a `live` block renders a plain <pre> with no highlight spans", () => {
    // `lang="ts"` is a real, bundled language — proving `live` skips
    // highlighting even when the language would otherwise qualify.
    render(<CodeBlock code="const a = 1;" lang="ts" live />);

    const pre = screen.getByTestId("code-block-pre");
    expect(pre.tagName).toBe("PRE");
    expect(pre).toHaveTextContent("const a = 1;");
    expect(pre.querySelectorAll("span")).toHaveLength(0);
  });

  it("shows a language label taken from the fence's language-* class", () => {
    const { container } = render(<CodeBlock code="x" lang="widget" />);
    expect(container.querySelector(".code-block-lang")).toHaveTextContent(
      "widget",
    );
  });

  it("an unfenced block (no `lang`) shows no language label", () => {
    const { container } = render(<CodeBlock code="x" />);
    expect(container.querySelector(".code-block-lang")).toBeNull();
  });

  it("an unknown language falls back to plain rather than throwing", () => {
    expect(() =>
      render(<CodeBlock code="x = 1" lang="cobol-9000" />),
    ).not.toThrow();

    const pre = screen.getByTestId("code-block-pre");
    expect(pre.tagName).toBe("PRE");
    expect(pre).toHaveTextContent("x = 1");
    expect(pre.querySelectorAll("span")).toHaveLength(0);
  });
});
