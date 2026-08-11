import { describe, expect, it } from "vitest";
import {
  PROMPT_TITLE_MAX,
  SUMMARY_TITLE_MAX,
  cleanSummaryTitle,
  promptNeedsSummary,
  titleFromPrompt,
} from "./task-title";

describe("titleFromPrompt — the name a Task carries until a summary lands", () => {
  it("is the message itself when the message is short enough to be a name", () => {
    expect(titleFromPrompt("Fix the axis labels")).toBe("Fix the axis labels");
  });

  it("trims first, so a message that starts with a newline is not named after it", () => {
    expect(titleFromPrompt("\n  Fix the axis labels  ")).toBe("Fix the axis labels");
  });

  it("cuts a long message to the cap", () => {
    const long = "a".repeat(200);
    expect(titleFromPrompt(long)).toHaveLength(PROMPT_TITLE_MAX);
  });

  it("never ends on a space, so a store that trims holds exactly what this returned", () => {
    // The cut is blind to word boundaries, so it lands on one eventually. A
    // name ending in a space and the same name trimmed are two strings, and
    // the lab compares them character-for-character before letting a summary
    // replace a derived title.
    const landsOnASpace = `${"w".repeat(PROMPT_TITLE_MAX - 1)} tail`;
    const title = titleFromPrompt(landsOnASpace);
    expect(title).toBe(title.trim());
  });

  it("is stable: naming the same message twice gives the same name", () => {
    const prompt = "  Run one cell that sets values = list(range(30)) and prints every value  ";
    expect(titleFromPrompt(prompt)).toBe(titleFromPrompt(prompt));
  });
});

describe("promptNeedsSummary — which messages are worth a model call", () => {
  it("declines a short single-line message, which is already its own title", () => {
    expect(promptNeedsSummary("Fix the axis labels")).toBe(false);
  });

  it("takes a message long enough to be cut", () => {
    expect(
      promptNeedsSummary(
        "Use the live Python kernel. Run one cell that sets values = list(range(30)) and prints every value on its own line.",
      ),
    ).toBe(true);
  });

  it("takes a short message that spans lines: a title never has a line break in it", () => {
    expect(promptNeedsSummary("Fix the labels\nthen re-run it")).toBe(true);
  });

  it("takes a short message that opens in lower case: a name opens like a name", () => {
    expect(promptNeedsSummary("which skills set have you access to?")).toBe(true);
  });

  it("declines a short question that already reads as a name — a title may ask something", () => {
    // `cleanSummaryTitle` keeps a question mark on purpose, as part of a name
    // a researcher would have typed themselves. The two have to agree: a
    // question a summary is allowed to END on is one a prompt is allowed to BE.
    expect(promptNeedsSummary("Why does the kernel stall?")).toBe(false);
  });

  it("declines one that opens on a character with no case, which says nothing either way", () => {
    expect(promptNeedsSummary("`fit.py` crashes on load")).toBe(false);
    expect(promptNeedsSummary("3 cells fail after the merge")).toBe(false);
  });

  it("declines an empty message — there is nothing to summarize", () => {
    expect(promptNeedsSummary("   ")).toBe(false);
  });
});

describe("cleanSummaryTitle — what a summarizer says, made fit to be a title", () => {
  it("keeps a well-behaved answer as it is", () => {
    expect(cleanSummaryTitle("Python kernel range check")).toBe("Python kernel range check");
  });

  it("takes the first non-empty line of a chatty answer", () => {
    expect(cleanSummaryTitle("\n\nPython kernel range check\n\nLet me know if…")).toBe(
      "Python kernel range check",
    );
  });

  it("unwraps quotes, including the curly ones a model likes", () => {
    expect(cleanSummaryTitle('"Python kernel range check"')).toBe("Python kernel range check");
    expect(cleanSummaryTitle("“Python kernel range check”")).toBe(
      "Python kernel range check",
    );
    expect(cleanSummaryTitle("`Python kernel range check`")).toBe("Python kernel range check");
  });

  it("drops a label the answer prefixed itself with", () => {
    expect(cleanSummaryTitle("Title: Python kernel range check")).toBe(
      "Python kernel range check",
    );
    expect(cleanSummaryTitle('**Title:** "Python kernel range check"')).toBe(
      "Python kernel range check",
    );
  });

  it("drops markdown emphasis around the whole title", () => {
    expect(cleanSummaryTitle("**Python kernel range check**")).toBe("Python kernel range check");
  });

  it("collapses runs of whitespace", () => {
    expect(cleanSummaryTitle("Python   kernel\trange check")).toBe("Python kernel range check");
  });

  it("drops a trailing full stop but keeps a question mark, which is part of the name", () => {
    expect(cleanSummaryTitle("Python kernel range check.")).toBe("Python kernel range check");
    expect(cleanSummaryTitle("Why does the kernel stall?")).toBe("Why does the kernel stall?");
  });

  it("cuts an over-long answer at a word boundary rather than mid-word", () => {
    const cleaned = cleanSummaryTitle(
      "Investigating the notebook kernel range printing behaviour and error",
    );
    expect(cleaned).not.toBeNull();
    expect(cleaned!.length).toBeLessThanOrEqual(SUMMARY_TITLE_MAX);
    expect(cleaned!.endsWith(" ")).toBe(false);
    expect(cleaned!.split(" ").at(-1)).not.toBe("behavio");
  });

  it("refuses a paragraph: an answer that ignored the instruction is not a title", () => {
    expect(
      cleanSummaryTitle(
        "I'd be happy to help you name this task. Based on what you have described, it sounds like you are trying to run a Python cell, so a good title might be something along these lines.",
      ),
    ).toBeNull();
  });

  it("refuses an answer with nothing in it", () => {
    expect(cleanSummaryTitle("")).toBeNull();
    expect(cleanSummaryTitle("   \n\n  ")).toBeNull();
    expect(cleanSummaryTitle('""')).toBeNull();
  });
});
