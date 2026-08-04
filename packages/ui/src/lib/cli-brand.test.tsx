import { describe, expect, it } from "vitest";
import { cliBrand } from "./cli-brand";

describe("cliBrand", () => {
  it("returns a brand icon component for a known id, plus its colour", () => {
    const b = cliBrand("claude", "Claude Code");
    expect(b.icon).toBeTypeOf("function");
    expect(b.color).toBe("#d97757");
  });

  it("falls back to a null icon + name initials for an unknown id", () => {
    const b = cliBrand("totally-unknown", "Weird Tool");
    expect(b.icon).toBeNull();
    expect(b.mono).toBe("WT");
  });

  it("falls back to a 2-letter monogram for a single-word unknown name", () => {
    const b = cliBrand("zed-unknown", "Zed");
    expect(b.icon).toBeNull();
    expect(b.mono).toBe("ZE");
  });
});
