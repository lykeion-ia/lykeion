import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// Via `import.meta.dirname`, not `new URL("..", import.meta.url)`: under jsdom
// the global URL resolves a bare `..` against the document base, not the file.
const SRC = join(import.meta.dirname, "..");

/** This file quotes the very patterns it bans, so it exempts itself. */
const SELF = join("styles", "tokens.test.ts");

const sourceFiles = (ext: RegExp) =>
  readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((rel) => ext.test(rel) && rel !== SELF)
    .map((rel) => [rel, readFileSync(join(SRC, rel), "utf8")] as const);

/** Every `path:line  text` a pattern hits, so a failure names its own fix. */
const offenders = (ext: RegExp, pattern: string) =>
  sourceFiles(ext).flatMap(([rel, body]) =>
    body
      .split("\n")
      .flatMap((line, i) =>
        new RegExp(pattern).test(line) ? [`${rel}:${i + 1}  ${line.trim()}`] : [],
      ),
  );

/** The scale, as tokens.css declares it. */
const RUNGS = [
  ["micro", "0.75rem"],
  ["meta", "0.8125rem"],
  ["sub", "0.875rem"],
  ["ui", "0.9375rem"],
  ["read", "1rem"],
  ["title", "1.1875rem"],
  ["display", "1.5rem"],
  ["hero", "2rem"],
] as const;

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

  it("defines all eight type rungs, each with a line-height", () => {
    for (const [name, size] of RUNGS) {
      expect(tokens).toMatch(new RegExp(`--type-${name}:\\s*${size};`));
      expect(tokens).toMatch(new RegExp(`--type-${name}--lh:\\s*[\\d.]+;`));
    }
  });

  it("bridges every rung into Tailwind and retires Tailwind's own scale", () => {
    // Without the reset, `text-sm` and friends keep resolving to Tailwind's
    // defaults — a second scale nothing here derives from.
    expect(tailwind).toMatch(/--text-\*:\s*initial/);
    for (const [name] of RUNGS) {
      expect(tailwind).toMatch(
        new RegExp(`--text-${name}:\\s*var\\(--type-${name}\\)`),
      );
      // Tailwind emits a line-height for every size utility whether or not one
      // is defined; unpaired, the declaration is invalid and silently inherits.
      expect(tailwind).toMatch(
        new RegExp(`--text-${name}--line-height:\\s*var\\(--type-${name}--lh\\)`),
      );
    }
  });

  it("points the conversation's size at the read rung", () => {
    expect(tokens).toMatch(/--chat-text:\s*var\(--type-read\)/);
  });

  /*
   * The rungs only hold if nothing can sidestep them. These two are the fence:
   * the scale was introduced against ~600 one-off sizes across 19 values, and
   * without a check the next hardcoded size lands unchallenged and the sprawl
   * starts over. They also close the gap `screens.css` describes above
   * `.screen-title` — a size shared across the CSS/Tailwind boundary used to be
   * hand-maintained, and is now enforced.
   */
  it("has no hardcoded font size left anywhere in the UI", () => {
    expect(offenders(/\.tsx?$/, String.raw`\btext-\[[\d.]+px\]`)).toEqual([]);
    expect(offenders(/\.css$/, String.raw`font-size:\s*[\d.]+px`)).toEqual([]);
  });

  it("has no size utility that resolves to nothing", () => {
    // Tailwind's own names are cleared above, so these render as dead classes
    // rather than as a wrong size — the harder bug to see.
    const names = "xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl";
    expect(offenders(/\.tsx?$/, String.raw`\btext-(${names})\b`)).toEqual([]);
  });
});
