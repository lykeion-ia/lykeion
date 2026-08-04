import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("design-token bridge", () => {
  const tokens = read("./tokens.css");
  const tailwind = read("./tailwind.css");

  it("boots to the Midnight seed accent, wired through the seed vars", () => {
    // Default seeds live in :root; Midnight is the boot default.
    expect(tokens).toMatch(/--seed-accent:\s*#d25e65/i);
    // The accent aliases resolve from the seed, so every theme re-tints them.
    expect(tokens).toMatch(/--accent:\s*var\(--seed-accent\)/i);
    expect(tokens).toMatch(/--primary:\s*var\(--seed-accent\)/i);
  });

  it("ships the five named themes, each overriding only its seeds", () => {
    for (const [id, accent] of [
      ["ash", "#475ba1"],
      ["midnight", "#d25e65"],
      ["dawn", "#a84376"],
      ["pale", "#7d57c1"],
      ["barbie", "#b8fafa"],
    ]) {
      const block = new RegExp(
        `\\[data-theme="${id}"\\]\\s*\\{[^}]*--seed-accent:\\s*${accent}`,
        "i",
      );
      expect(tokens).toMatch(block);
    }
  });

  it("defines the extra structural and semantic tokens", () => {
    for (const name of [
      "--lane",
      "--line-soft",
      "--iris",
      "--warn",
      "--danger",
      "--danger-bg",
      "--danger-fg",
    ]) {
      expect(tokens).toMatch(new RegExp(`${name}:`));
    }
  });

  it("maps utility tokens onto Lykeion vars", () => {
    for (const [tw, lyk] of [
      ["--color-surface-2", "--surface-2"],
      ["--color-fg-subtle", "--ink-subtle"],
      ["--color-line", "--hairline"],
      ["--color-accent", "--accent"],
    ]) {
      expect(tailwind).toMatch(new RegExp(`${tw}:\\s*var\\(${lyk}\\)`));
    }
  });
});
