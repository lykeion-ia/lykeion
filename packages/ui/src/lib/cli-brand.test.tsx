import { describe, expect, it } from "vitest";
import { cliBrand, cliInk } from "./cli-brand";

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

describe("cliInk", () => {
  it("gives a hued brand its own colour to be drawn in", () => {
    expect(cliInk("claude")).toBe("#d97757");
  });

  // The point of the map, and the thing a well-meaning edit would undo by
  // copying `COLORS` across wholesale: these three are TILE fills — white,
  // white and black — and a mark drawn in one of them disappears into the page
  // it stands on. Null sends them back to the reader's own ink, which is what
  // a black-or-white brand mark should follow anyway.
  it("has no ink for a brand whose mark is black or white", () => {
    expect(cliInk("codex")).toBeNull();
    expect(cliInk("openclaw")).toBeNull();
    expect(cliInk("pi")).toBeNull();
  });

  it("has no ink for an id it does not know", () => {
    expect(cliInk("totally-unknown")).toBeNull();
  });
});
