import { describe, expect, it } from "vitest";
import { completeMarkdown } from "./markdown";

describe("completeMarkdown", () => {
  it("returns text with nothing dangling byte-identical", () => {
    const whole = "Strong candidates are emerging.\n\n- one\n- two\n";
    // `toBe`, not `toEqual`: this is the common case on every live snapshot
    // (~16/second, the live channel ticking every 60 ms), so it must not even
    // allocate.
    expect(completeMarkdown(whole)).toBe(whole);
  });

  it("closes an unterminated fence", () => {
    expect(completeMarkdown("```rust\nfn main() {")).toBe(
      "```rust\nfn main() {\n```",
    );
  });

  it("leaves a closed fence alone", () => {
    const closed = "```rust\nfn main() {}\n```\n";
    expect(completeMarkdown(closed)).toBe(closed);
  });

  it("closes a fence opened after a closed one", () => {
    expect(completeMarkdown("```\na\n```\n\n```ts\nconst x")).toBe(
      "```\na\n```\n\n```ts\nconst x\n```",
    );
  });

  it("closes a dangling inline code span", () => {
    expect(completeMarkdown("Call `readFile")).toBe("Call `readFile`");
  });

  it("closes a dangling bold run", () => {
    expect(completeMarkdown("This is **import")).toBe("This is **import**");
  });

  it("closes a dangling emphasis run", () => {
    expect(completeMarkdown("This is *part")).toBe("This is *part*");
  });

  it("closes dangling underscore emphasis and strong runs", () => {
    expect(completeMarkdown("a _partial")).toBe("a _partial_");
    expect(completeMarkdown("a __partial")).toBe("a __partial__");
  });

  it("does not close markers that are already balanced", () => {
    const balanced = "**bold** and *italic* and `code`";
    expect(completeMarkdown(balanced)).toBe(balanced);
  });

  it("drops a link whose target is still arriving", () => {
    expect(completeMarkdown("See [the docs](http")).toBe("See ");
    expect(completeMarkdown("See [the docs](")).toBe("See ");
  });

  it("drops a link label that has no target yet", () => {
    expect(completeMarkdown("See [the do")).toBe("See ");
  });

  it("keeps a complete link", () => {
    const link = "See [the docs](https://example.com) for more";
    expect(completeMarkdown(link)).toBe(link);
  });

  it("does not treat markers inside a fenced block as dangling", () => {
    // `**` here is C, not emphasis; and the fence is what actually needs closing.
    expect(completeMarkdown("```c\nint **p;")).toBe("```c\nint **p;\n```");
  });

  it("does not treat markers inside an inline code span as dangling", () => {
    const text = "use `a * b` here";
    expect(completeMarkdown(text)).toBe(text);
  });

  it("handles the empty string", () => {
    expect(completeMarkdown("")).toBe("");
  });

  // The false positives below are what make this safe to run on every live
  // snapshot. Each one is text an agent emits constantly, and a naive
  // marker count would corrupt all three.

  it("leaves snake_case identifiers alone", () => {
    const text = "the tool_use_id joins the log_entry";
    expect(completeMarkdown(text)).toBe(text);
  });

  it("leaves an asterisk bullet list alone", () => {
    const text = "Findings:\n\n* one\n* two\n* three\n";
    expect(completeMarkdown(text)).toBe(text);
  });

  it("leaves a GFM task list alone", () => {
    const text = "- [ ] step one\n- [x] step two\n";
    expect(completeMarkdown(text)).toBe(text);
  });

  it("leaves bare multiplication alone", () => {
    const text = "roughly 3 * 4 rows";
    expect(completeMarkdown(text)).toBe(text);
  });

  it("ignores markers left inside an earlier closed code block", () => {
    // The `**` is C inside a settled fence; only the live tail can dangle.
    const text = "```c\nint **p;\n```\n\nNow the **point";
    expect(completeMarkdown(text)).toBe(text + "**");
  });
});
