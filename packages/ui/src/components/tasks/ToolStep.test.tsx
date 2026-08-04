import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { ExecutionLogEntry, TurnItem } from "@lykeion/api";
import {
  CONTROL_PLANE_TOOLS,
  SUMMARY_MAX_LEN,
  ToolStepCard,
  ToolStepGroup,
  blocksOf,
  deterministicLabel,
  stepStatus,
  stepSummary,
} from "./ToolStep";

const entry = (over: Partial<ExecutionLogEntry> = {}): ExecutionLogEntry => ({
  ts: 1,
  toolUseId: "tu-1",
  tool: "Bash",
  input: { command: "ls -la\ncd /tmp" },
  decision: "allowed-once",
  result: "a\nb\nc",
  isError: false,
  ...over,
});

describe("deterministicLabel (tier 3 — the guaranteed baseline)", () => {
  it("labels Bash by its first command line", () => {
    expect(deterministicLabel(entry())).toBe("Ran: ls -la");
  });

  it("labels Write/Edit by the file path", () => {
    expect(
      deterministicLabel(
        entry({ tool: "Write", input: { file_path: "out.csv" } }),
      ),
    ).toBe("Wrote out.csv");
    expect(
      deterministicLabel(
        entry({ tool: "Edit", input: { file_path: "notes/a.md" } }),
      ),
    ).toBe("Wrote notes/a.md");
  });

  it("labels Read by the file path", () => {
    expect(
      deterministicLabel(
        entry({ tool: "Read", input: { file_path: "data.json" } }),
      ),
    ).toBe("Read data.json");
  });

  it("falls back to the tool name for anything else", () => {
    expect(deterministicLabel(entry({ tool: "Grep", input: {} }))).toBe("Grep");
  });

  it("labels an MCP tool by its human_description, else the bare tool name", () => {
    // run_python reaches the UI as `mcp__lykeion_kernel__run_python`; the model
    // authors a human_description per call, and that is the step's title.
    expect(
      deterministicLabel(
        entry({
          tool: "mcp__lykeion_kernel__run_python",
          input: {
            code: "df.head()",
            human_description: "Preview the DataFrame",
          },
        }),
      ),
    ).toBe("Preview the DataFrame");
    // With no description, the bare tool name from the triple — never the full
    // machine name `mcp__lykeion_kernel__run_python`.
    expect(
      deterministicLabel(
        entry({ tool: "mcp__lykeion_kernel__run_python", input: {} }),
      ),
    ).toBe("run_python");
  });

  it("never claims the past tense for a step that never executed", () => {
    // A cancelled/denied step is an intention, not a history: it is recorded
    // precisely because nothing ran. "Wrote results/out.csv" over a
    // file that was never written is the transcript lying about the record.
    for (const decision of ["denied", "cancelled"]) {
      expect(
        deterministicLabel(
          entry({
            tool: "Write",
            input: { file_path: "results/out.csv" },
            decision,
          }),
        ),
      ).toBe("Write results/out.csv");
      // `Edit`, not `Write`: the non-past form has to agree with the header a
      // GROUP of blocked Edits gets ("Edit 2 files"). Sharing `Write`'s verb
      // put "⊘ Write notes/a.md" under "Edit 2 files" in the same view.
      expect(
        deterministicLabel(
          entry({ tool: "Edit", input: { file_path: "notes/a.md" }, decision }),
        ),
      ).toBe("Edit notes/a.md");
      expect(deterministicLabel(entry({ tool: "Bash", decision }))).toBe(
        "Run: ls -la",
      );
      expect(
        deterministicLabel(entry({ tool: "Bash", input: {}, decision })),
      ).toBe("Run a command");
      // `Read` is already tenseless — it must not change either way.
      expect(
        deterministicLabel(
          entry({ tool: "Read", input: { file_path: "data.json" }, decision }),
        ),
      ).toBe("Read data.json");
      // Nor does the no-path / unknown-tool fallback carry any tense.
      expect(
        deterministicLabel(entry({ tool: "Write", input: {}, decision })),
      ).toBe("Write");
      expect(
        deterministicLabel(entry({ tool: "Grep", input: {}, decision })),
      ).toBe("Grep");
    }
  });

  it("keeps the past tense for everything that did execute", () => {
    for (const decision of ["ran", "auto", "allowed-once", "orphan-executed"]) {
      expect(
        deterministicLabel(
          entry({ tool: "Write", input: { file_path: "out.csv" }, decision }),
        ),
      ).toBe("Wrote out.csv");
      expect(deterministicLabel(entry({ decision }))).toBe("Ran: ls -la");
    }
  });
});

describe("stepStatus", () => {
  it("derives ok / blocked / error", () => {
    expect(stepStatus(entry())).toBe("ok");
    expect(stepStatus(entry({ decision: "denied" }))).toBe("blocked");
    expect(stepStatus(entry({ isError: true }))).toBe("error");
  });

  it("draws a REALISTIC denied gate as blocked, not as a crash", () => {
    // `decision: "denied"` and `isError: true` ALWAYS co-occur: the CLI
    // reports the refusal back to the model as an error `tool_result`, which
    // merges onto the same Execution Log entry. That pairing is an enforced
    // invariant, and the in-memory simulation records the same pair. So the
    // ONLY realistic denied entry is this one — deciding on `isError` first
    // made every denial a red ✕, indistinguishable from a crash, and left
    // `blocked` unreachable.
    expect(stepStatus(entry({ decision: "denied", isError: true }))).toBe(
      "blocked",
    );
  });

  it("draws a step the researcher STOPPED as blocked, never as a success", () => {
    // The cancel path pushes `decision: "cancelled"`, `isError: false`, no
    // result — the tool never ran. Falling through to "ok" drew a green ✓
    // over a write that never happened, and it persists in
    // `TaskTurn.stream`, so it reads that way on every reopen.
    expect(
      stepStatus(
        entry({
          tool: "Write",
          decision: "cancelled",
          isError: false,
          result: undefined,
        }),
      ),
    ).toBe("blocked");
  });
});

describe("stepSummary (right-hand column — tool-shaped, not generic)", () => {
  it("shows a line count for multi-line output", () => {
    const result = Array.from({ length: 13 }, (_, i) => `line ${i}`).join("\n");
    expect(stepSummary(entry({ result }))).toBe("13 lines of output");
  });

  it("shows a short single-line result verbatim", () => {
    expect(stepSummary(entry({ result: "6.0" }))).toBe("6.0");
  });

  it("does not count a trailing newline as a second line", () => {
    // Real command output has this shape — `6.0\n`, not `6.0`.
    expect(stepSummary(entry({ result: "6.0\n" }))).toBe("6.0");
  });

  it("shows a single-line result verbatim up to the length cap", () => {
    const atCap = "x".repeat(SUMMARY_MAX_LEN);
    expect(stepSummary(entry({ result: atCap }))).toBe(atCap);
  });

  it("falls back to the tool name when a single-line result is too long to summarize", () => {
    // Results are capped at 2000 chars, so a ~2 KB single-line
    // JSON blob is reachable and must never be echoed into the summary
    // column — "short single-line result" is the intended scope.
    const overCap = "x".repeat(SUMMARY_MAX_LEN + 1);
    expect(stepSummary(entry({ tool: "Grep", result: overCap }))).toBe("Grep");
  });

  it("falls back to the tool name when there is no result", () => {
    expect(stepSummary(entry({ tool: "Write", result: undefined }))).toBe(
      "Write",
    );
  });
});

describe("blocksOf — grouping + the no-double-render rule", () => {
  it("groups consecutive steps into one block; a lone step after a text block is its own block", () => {
    // Every step here carries an adapter title (tier 1) so narration
    // promotion never kicks in — this isolates pure grouping/boundary
    // behavior from the promotion rule (covered by its own tests below).
    const stream: TurnItem[] = [
      { kind: "text", text: "Getting started." },
      { kind: "step", entry: entry({ toolUseId: "tu-1", title: "Step one" }) },
      { kind: "step", entry: entry({ toolUseId: "tu-2", title: "Step two" }) },
      { kind: "text", text: "Now the last step." },
      {
        kind: "step",
        entry: entry({ toolUseId: "tu-3", title: "Step three" }),
      },
    ];
    const blocks = blocksOf(stream);
    expect(blocks.map((b) => b.kind)).toEqual([
      "text",
      "steps",
      "text",
      "steps",
    ]);
    expect(blocks[0].kind === "text" && blocks[0].text).toBe(
      "Getting started.",
    );
    expect(blocks[1].kind === "steps" && blocks[1].steps).toHaveLength(2);
    expect(blocks[2].kind === "text" && blocks[2].text).toBe(
      "Now the last step.",
    );
    // The text block between them must break the group: tu-3 does NOT
    // merge into the tu-1/tu-2 group even though nothing else intervenes
    // structurally in the rendered block list.
    expect(blocks[3].kind === "steps" && blocks[3].steps).toHaveLength(1);
  });

  it("tier 1: an adapter-supplied title always wins, and is never overridden by narration", () => {
    const stream: TurnItem[] = [
      { kind: "text", text: "Short narration." },
      {
        kind: "step",
        entry: entry({ title: "Computing mean of five numbers" }),
      },
    ];
    const blocks = blocksOf(stream);
    // The narration was NOT consumed (tier 1 already had a title) — it must
    // still render as its own prose block.
    expect(blocks.map((b) => b.kind)).toEqual(["text", "steps"]);
    const stepBlock = blocks[1];
    expect(stepBlock.kind === "steps" && stepBlock.steps[0].title).toBe(
      "Computing mean of five numbers",
    );
  });

  it("tier 2: a short narration immediately before the first step of a group becomes its title, and is dropped from prose", () => {
    const stream: TurnItem[] = [
      { kind: "text", text: "Let me write the file." },
      { kind: "step", entry: entry({ tool: "Write", input: {} }) },
    ];
    const blocks = blocksOf(stream);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe("steps");
    const stepBlock = blocks[0];
    expect(stepBlock.kind === "steps" && stepBlock.steps[0].title).toBe(
      "Let me write the file.",
    );
  });

  it("a text item breaks a run of steps, and is promoted onto the step that opens the new run", () => {
    const stream: TurnItem[] = [
      { kind: "step", entry: entry({ toolUseId: "tu-1" }) },
      { kind: "text", text: "Short line." },
      { kind: "step", entry: entry({ toolUseId: "tu-2" }) },
    ];
    // "Short line." sits between two steps that would otherwise be one
    // group — it still breaks the run into two blocks, and (being
    // immediately before a first-of-group step) is promoted onto tu-2.
    const blocks = blocksOf(stream);
    expect(blocks.map((b) => b.kind)).toEqual(["steps", "steps"]);
    // tu-1 precedes the narration, so it can never absorb it: tier 3.
    expect(blocks[0].kind === "steps" && blocks[0].steps[0].title).toBe(
      "Ran: ls -la",
    );
    // tu-2 opens the new run, so it does absorb it (tier 2) — and the
    // narration is therefore not also emitted as prose.
    expect(blocks[1].kind === "steps" && blocks[1].steps[0].title).toBe(
      "Short line.",
    );
  });

  it("renders consecutive text items as their own prose blocks — each is a whole message", () => {
    // The contract: ONE text item per whole assistant message, whatever
    // granularity the events arrived at (the ones flagged as partial
    // fragments are reassembled before the record is written). So adjacent
    // text items are ALWAYS separate messages, and this layer neither joins them nor
    // guesses at a seam — the guess was undecidable, since every rule that kept
    // two `claude` paragraphs apart also broke a real ACP chunk seam mid-word.
    const stream: TurnItem[] = [
      { kind: "text", text: "Here's my plan for this task." },
      { kind: "text", text: "Running the analysis." },
    ];
    const blocks = blocksOf(stream);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "text"]);
    expect(blocks[0].kind === "text" && blocks[0].text).toBe(
      "Here's my plan for this task.",
    );
    expect(blocks[1].kind === "text" && blocks[1].text).toBe(
      "Running the analysis.",
    );
  });

  it("never runs two whole messages together, whatever punctuation sits at the seam", () => {
    // The failure the old seam heuristic kept oscillating over: a lead-in and
    // the list it introduces are two whole messages, and joining them rendered
    // "Here's what I found:- 42 rows" — then promoted the run-together line
    // into a card title, deleting both messages from the transcript. Nothing
    // can join them now: they are separate items and separate blocks.
    const stream: TurnItem[] = [
      { kind: "text", text: "Here's what I found:" },
      { kind: "text", text: "- 42 rows" },
    ];
    const blocks = blocksOf(stream);
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block.kind === "text" && block.text).not.toContain(":-");
    }
  });

  it("promotes only the message IMMEDIATELY before the step: an earlier one stays prose", () => {
    // Two whole messages then a step. Each is short enough to be a title on
    // its own, so this pins WHICH one the step takes — and that the other is
    // still rendered, never silently swallowed.
    const stream: TurnItem[] = [
      { kind: "text", text: "Step one is done." },
      { kind: "text", text: "Now the second." },
      {
        kind: "step",
        entry: entry({ tool: "Read", input: { file_path: "a.txt" } }),
      },
    ];
    const blocks = blocksOf(stream);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "steps"]);
    expect(blocks[0].kind === "text" && blocks[0].text).toBe(
      "Step one is done.",
    );
    expect(blocks[1].kind === "steps" && blocks[1].steps[0].title).toBe(
      "Now the second.",
    );
  });

  it("does not promote a MULTI-LINE message, however short", () => {
    // A whole message may carry its own line breaks (a lead-in and its list).
    // That is a paragraph, not a card title — `isPromotableNarration` refuses
    // it on the newline alone, so no merge-provenance flag is needed to.
    const multiline = "Here's what I found:\n\n- 42 rows";
    expect(multiline.length).toBeLessThanOrEqual(80);
    const stream: TurnItem[] = [
      { kind: "text", text: multiline },
      {
        kind: "step",
        entry: entry({ tool: "Read", input: { file_path: "a.txt" } }),
      },
    ];
    const blocks = blocksOf(stream);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "steps"]);
    expect(blocks[0].kind === "text" && blocks[0].text).toBe(multiline);
    expect(blocks[1].kind === "steps" && blocks[1].steps[0].title).toBe(
      "Read a.txt",
    );
  });

  it("promotes a narration onto ONLY the first step of the group it opens", () => {
    // The narration must be cleared the moment it is consumed: without that,
    // every step in the run would be titled with the same line.
    const stream: TurnItem[] = [
      { kind: "text", text: "Short line." },
      { kind: "step", entry: entry({ toolUseId: "tu-1" }) },
      {
        kind: "step",
        entry: entry({
          toolUseId: "tu-2",
          tool: "Read",
          input: { file_path: "a.txt" },
        }),
      },
    ];
    const blocks = blocksOf(stream);
    expect(blocks.map((b) => b.kind)).toEqual(["steps"]);
    const group = blocks[0];
    expect(group.kind === "steps" && group.steps).toHaveLength(2);
    expect(group.kind === "steps" && group.steps[0].title).toBe("Short line.");
    // The second step gets its OWN deterministic label, never the narration.
    expect(group.kind === "steps" && group.steps[1].title).toBe("Read a.txt");
  });

  it("ignores a whitespace-only text item: it neither renders nor breaks a run of steps", () => {
    const stream: TurnItem[] = [
      { kind: "step", entry: entry({ toolUseId: "tu-1", title: "Step one" }) },
      { kind: "text", text: "  \n " },
      { kind: "step", entry: entry({ toolUseId: "tu-2", title: "Step two" }) },
    ];
    const blocks = blocksOf(stream);
    expect(blocks.map((b) => b.kind)).toEqual(["steps"]);
    expect(blocks[0].kind === "steps" && blocks[0].steps).toHaveLength(2);
  });

  it("does not let a whitespace-only item come between a message and the step it narrates", () => {
    // The blank item is dropped before the fold, so the narration still sees
    // the step as the next item and is promoted onto it — a stray "\n" from
    // the agent must not silently cost a card its title.
    const stream: TurnItem[] = [
      { kind: "text", text: "Writing the results file." },
      { kind: "text", text: "\n" },
      {
        kind: "step",
        entry: entry({ tool: "Write", input: { file_path: "out.csv" } }),
      },
    ];
    const blocks = blocksOf(stream);
    expect(blocks.map((b) => b.kind)).toEqual(["steps"]);
    expect(blocks[0].kind === "steps" && blocks[0].steps[0].title).toBe(
      "Writing the results file.",
    );
  });

  describe("control-plane steps never render as cards", () => {
    // Without this filter, `ExitPlanMode` renders as a tool-step card
    // carrying the ENTIRE plan (3 KB of markdown) as its input, directly
    // beside the PlanCard already showing the researcher that same plan;
    // `TodoWrite` produced a card per todo update. Both are the agent
    // signalling to the harness, not work the researcher asked for. They stay
    // in the Execution Log (the audit trail is unchanged) and are dropped
    // HERE, by tool name — a property of the data, so it holds for whichever
    // adapter produced the entry.
    it("drops an ExitPlanMode step, and its plan text never reaches the DOM", () => {
      const plan =
        "1. Read samples.csv\n2. Count responders\n3. Write the answer";
      const stream: TurnItem[] = [
        { kind: "text", text: "Here's the plan." },
        {
          kind: "step",
          entry: entry({
            toolUseId: "tu-plan",
            tool: "ExitPlanMode",
            input: { plan },
            decision: "auto",
            result: undefined,
          }),
        },
      ];
      const blocks = blocksOf(stream);
      expect(blocks.map((b) => b.kind)).toEqual(["text"]);

      render(
        <>
          {blocks.map((b, i) =>
            b.kind === "text" ? (
              <p key={i}>{b.text}</p>
            ) : (
              <ToolStepGroup key={i} steps={b.steps} />
            ),
          )}
        </>,
      );
      expect(screen.queryByTestId("tool-step")).toBeNull();
      expect(screen.queryByText(/Count responders/)).toBeNull();
    });

    it("drops a TodoWrite step", () => {
      const stream: TurnItem[] = [
        {
          kind: "step",
          entry: entry({
            toolUseId: "tu-todo",
            tool: "TodoWrite",
            input: {
              todos: [{ content: "read the file", status: "in_progress" }],
            },
          }),
        },
      ];
      expect(blocksOf(stream)).toEqual([]);
    });

    it("does NOT let a narration be swallowed by a step that no longer renders", () => {
      // The narration would otherwise be promoted onto the filtered step's
      // title — and that card never renders, so the line would vanish from the
      // transcript entirely. It must stay prose. Nor may it be promoted onto
      // the NEXT card: it narrates the filtered step, not the work after it
      // ("Let me update the todos." over a Bash card is a false label).
      const stream: TurnItem[] = [
        { kind: "text", text: "Let me update the todos." },
        {
          kind: "step",
          entry: entry({ toolUseId: "tu-todo", tool: "TodoWrite", input: {} }),
        },
        { kind: "step", entry: entry({ toolUseId: "tu-1", tool: "Bash" }) },
      ];
      const blocks = blocksOf(stream);
      expect(blocks.map((b) => b.kind)).toEqual(["text", "steps"]);
      expect(blocks[0].kind === "text" && blocks[0].text).toBe(
        "Let me update the todos.",
      );
      expect(blocks[1].kind === "steps" && blocks[1].steps[0].title).toBe(
        "Ran: ls -la",
      );
    });

    it("does not split a run of steps in two just because a filtered step sat between them", () => {
      // A filtered step renders NOTHING, so making it a group boundary would
      // show the researcher two groups with no visible reason for the split.
      // Prose still breaks a run — that they can see.
      const stream: TurnItem[] = [
        {
          kind: "step",
          entry: entry({ toolUseId: "tu-1", title: "Step one" }),
        },
        {
          kind: "step",
          entry: entry({ toolUseId: "tu-todo", tool: "TodoWrite", input: {} }),
        },
        {
          kind: "step",
          entry: entry({ toolUseId: "tu-2", title: "Step two" }),
        },
      ];
      const blocks = blocksOf(stream);
      expect(blocks.map((b) => b.kind)).toEqual(["steps"]);
      expect(
        blocks[0].kind === "steps" && blocks[0].steps.map((s) => s.title),
      ).toEqual(["Step one", "Step two"]);
    });

    it("keeps a control-plane step the researcher REFUSED, decision and all", () => {
      // `TodoWrite` maps to `Execute("TodoWrite")`, so it can and does reach a
      // permission gate. Filtering on the tool name alone therefore erased the
      // researcher's own refusal: a denied (or cancelled) TodoWrite rendered
      // nothing at all, leaving no trace that anything was blocked. Only a
      // control-plane step that actually RAN is noise worth dropping.
      for (const decision of ["denied", "cancelled"]) {
        const stream: TurnItem[] = [
          {
            kind: "step",
            entry: entry({
              toolUseId: "tu-todo",
              tool: "TodoWrite",
              input: { todos: [] },
              decision,
              result: undefined,
            }),
          },
        ];
        const blocks = blocksOf(stream);
        expect(blocks.map((b) => b.kind)).toEqual(["steps"]);
        expect(blocks[0].kind === "steps" && blocks[0].steps).toHaveLength(1);
        // "decision and all" is the whole point of the name: keeping the card
        // but drawing it as an ordinary success would erase the refusal just
        // as thoroughly as filtering it out did. The decision has to survive
        // onto the entry AND reach the render as `blocked` — the ⊘ glyph and
        // the blocked class, never a green ✓.
        const steps = blocks[0].kind === "steps" ? blocks[0].steps : [];
        expect(steps[0].entry.decision).toBe(decision);
        expect(stepStatus(steps[0].entry)).toBe("blocked");
        const { unmount } = render(
          <ToolStepCard entry={steps[0].entry} title={steps[0].title} />,
        );
        const card = screen.getByTestId("tool-step");
        expect(card).toHaveClass("tool-step--blocked");
        expect(card).not.toHaveClass("tool-step--ok");
        expect(within(card).getByText("⊘")).toBeInTheDocument();
        expect(within(card).queryByText("✓")).toBeNull();
        unmount();
      }
    });

    it("is decided by the tool name alone — the same set covers every adapter", () => {
      // ACP tool kinds are deliberately mapped onto this same normalized
      // vocabulary, so one name-based set is correct for both adapters and no
      // branch on adapter/CLI id is needed anywhere.
      expect([...CONTROL_PLANE_TOOLS].sort()).toEqual([
        "ExitPlanMode",
        "TodoWrite",
      ]);
    });
  });

  it("folds an empty stream to no blocks", () => {
    expect(blocksOf([])).toEqual([]);
  });

  it("opens with a steps block when the stream starts with a step", () => {
    const stream: TurnItem[] = [
      { kind: "step", entry: entry({ toolUseId: "tu-1" }) },
      { kind: "text", text: "Done." },
    ];
    const blocks = blocksOf(stream);
    expect(blocks.map((b) => b.kind)).toEqual(["steps", "text"]);
    // No narration can precede the first step: it resolves via tier 3.
    expect(blocks[0].kind === "steps" && blocks[0].steps[0].title).toBe(
      "Ran: ls -la",
    );
    expect(blocks[1].kind === "text" && blocks[1].text).toBe("Done.");
  });

  it("does not promote a long narration (over ~80 chars) — it stays prose, and the step falls to tier 3", () => {
    const long =
      "This sentence is deliberately long enough that it should never be treated as a short one-line card title by the resolver.";
    const stream: TurnItem[] = [
      { kind: "text", text: long },
      {
        kind: "step",
        entry: entry({ tool: "Read", input: { file_path: "a.txt" } }),
      },
    ];
    const blocks = blocksOf(stream);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "steps"]);
    const stepBlock = blocks[1];
    expect(stepBlock.kind === "steps" && stepBlock.steps[0].title).toBe(
      "Read a.txt",
    );
  });

  it("no-double-render, verified in the DOM: a promoted narration appears exactly once", () => {
    const stream: TurnItem[] = [
      { kind: "text", text: "Writing the results file." },
      {
        kind: "step",
        entry: entry({ tool: "Write", input: { file_path: "out.csv" } }),
      },
    ];
    const blocks = blocksOf(stream);
    render(
      <>
        {blocks.map((b, i) =>
          b.kind === "text" ? (
            <p key={i}>{b.text}</p>
          ) : (
            <ToolStepGroup key={i} steps={b.steps} />
          ),
        )}
      </>,
    );
    expect(screen.getAllByText("Writing the results file.")).toHaveLength(1);
  });
});

describe("ToolStepGroup — a lone step renders bare, >1 renders under a header", () => {
  it("renders a single step with no group header", () => {
    render(
      <ToolStepGroup
        steps={[{ entry: entry(), title: deterministicLabel(entry()) }]}
      />,
    );
    expect(screen.queryByTestId("tool-step-group")).toBeNull();
    expect(screen.getByTestId("tool-step")).toBeInTheDocument();
  });

  it("groups >1 consecutive steps under a header showing the step count", () => {
    const steps = [
      entry({ toolUseId: "tu-1", tool: "Bash", input: { command: "echo a" } }),
      entry({ toolUseId: "tu-2", tool: "Bash", input: { command: "echo b" } }),
    ].map((e) => ({ entry: e, title: deterministicLabel(e) }));
    render(<ToolStepGroup steps={steps} />);
    const group = screen.getByTestId("tool-step-group");
    expect(within(group).getByText("2 steps")).toBeInTheDocument();
    expect(within(group).getAllByTestId("tool-step")).toHaveLength(2);
  });

  it("collapses its child cards when the header is clicked, and re-expands", () => {
    const steps = [
      entry({ toolUseId: "tu-1", tool: "Bash", input: { command: "echo a" } }),
      entry({ toolUseId: "tu-2", tool: "Bash", input: { command: "echo b" } }),
    ].map((e) => ({ entry: e, title: deterministicLabel(e) }));
    render(<ToolStepGroup steps={steps} />);
    const group = screen.getByTestId("tool-step-group");
    const head = within(group).getByRole("button", { name: /ran 2 commands/i });

    // Default OPEN: both child cards on screen, `aria-expanded` true.
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(within(group).getAllByTestId("tool-step")).toHaveLength(2);

    // Collapse: the child cards leave the DOM; the header and its count remain.
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(within(group).queryAllByTestId("tool-step")).toHaveLength(0);
    expect(within(group).getByText("2 steps")).toBeInTheDocument();

    // Re-expand.
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(within(group).getAllByTestId("tool-step")).toHaveLength(2);
  });

  /**
   * The header tells the same kind of truth the cards below it do. A denial
   * does NOT end the turn, so a retrying agent gets refused
   * again and two consecutive blocked `Write`s are an ordinary shape — they
   * must not sit under "Wrote 2 files", the same lie `deterministicLabel`
   * already stopped telling one level down.
   */
  describe("group header tense — it never claims a run that did not happen", () => {
    const resolved = (e: ExecutionLogEntry) => ({
      entry: e,
      title: deterministicLabel(e),
    });
    // Unmounts before returning, so a test may assert on several headers
    // without `screen` queries colliding across renders.
    const headerOf = (entries: ExecutionLogEntry[]): string => {
      const { container, unmount } = render(
        <ToolStepGroup steps={entries.map(resolved)} />,
      );
      const text =
        container.querySelector(".tool-step-group-title")?.textContent ?? "";
      unmount();
      return text;
    };
    const denied = (over: Partial<ExecutionLogEntry>) =>
      entry({ decision: "denied", isError: true, ...over });

    it("keeps the past tense when every step in the group ran", () => {
      expect(
        headerOf([
          entry({
            toolUseId: "tu-1",
            tool: "Write",
            input: { file_path: "a.md" },
          }),
          entry({
            toolUseId: "tu-2",
            tool: "Write",
            input: { file_path: "b.md" },
          }),
        ]),
      ).toBe("Wrote 2 files");
      // The tenseless verb is the same header for an all-ran group.
      expect(
        headerOf([
          entry({
            toolUseId: "tu-3",
            tool: "Read",
            input: { file_path: "a.md" },
          }),
          entry({
            toolUseId: "tu-4",
            tool: "Read",
            input: { file_path: "b.md" },
          }),
        ]),
      ).toBe("Read 2 files");
    });

    it("uses the non-past verb when NOTHING in a same-tool group ran", () => {
      expect(
        headerOf([
          denied({
            toolUseId: "tu-1",
            tool: "Write",
            input: { file_path: "a.md" },
          }),
          denied({
            toolUseId: "tu-2",
            tool: "Write",
            input: { file_path: "b.md" },
          }),
        ]),
      ).toBe("Write 2 files");
      expect(
        headerOf([
          denied({
            toolUseId: "tu-3",
            tool: "Edit",
            input: { file_path: "a.md" },
          }),
          denied({
            toolUseId: "tu-4",
            tool: "Edit",
            input: { file_path: "b.md" },
          }),
        ]),
      ).toBe("Edit 2 files");
      expect(
        headerOf([
          denied({ toolUseId: "tu-5", tool: "Bash" }),
          denied({ toolUseId: "tu-6", tool: "Bash" }),
        ]),
      ).toBe("Run 2 commands");
      // A tenseless verb has nothing to vary: same header, nothing ran.
      expect(
        headerOf([
          denied({
            toolUseId: "tu-7",
            tool: "Read",
            input: { file_path: "a.md" },
          }),
          denied({
            toolUseId: "tu-8",
            tool: "Read",
            input: { file_path: "b.md" },
          }),
        ]),
      ).toBe("Read 2 files");
    });

    it("keeps a TENSELESS verb for a mixed group — it is true of every mix", () => {
      // "Read 2 files" asserts nothing about execution, so it is as true of one
      // read-and-one-refused as it is of two of either. Gating it on
      // all-ran/all-blocked threw away a correct header and replaced it with
      // "Ran 2 steps" — a past tense over a card that never ran.
      expect(
        headerOf([
          entry({
            toolUseId: "tu-1",
            tool: "Read",
            input: { file_path: "a.md" },
          }),
          denied({
            toolUseId: "tu-2",
            tool: "Read",
            input: { file_path: "b.md" },
          }),
        ]),
      ).toBe("Read 2 files");
    });

    it("asserts NO execution in the header of a mixed group whose verb carries tense", () => {
      // Some ran, some were refused. Every tensed form is false of half the
      // group — "Wrote 2 files" of the refused half, "Write 2 files" and "Run 2
      // steps" of the half that already happened — so the header claims
      // nothing at all and lets the per-card glyph and label carry the truth
      // one line below.
      expect(
        headerOf([
          entry({
            toolUseId: "tu-1",
            tool: "Write",
            input: { file_path: "a.md" },
          }),
          denied({
            toolUseId: "tu-2",
            tool: "Write",
            input: { file_path: "b.md" },
          }),
        ]),
      ).toBe("Tool steps");
      // Same when the tools disagree, so there is no verb to borrow either way.
      expect(
        headerOf([
          entry({ toolUseId: "tu-3", tool: "Bash" }),
          denied({
            toolUseId: "tu-4",
            tool: "Write",
            input: { file_path: "b.md" },
          }),
        ]),
      ).toBe("Tool steps");
    });

    it("does not repeat the right-hand count as the mixed group's title", () => {
      // The header line is title + summary. A mixed group used to render the
      // count on BOTH sides — "2 steps ... 2 steps" — which reads as a stutter
      // and makes the count ambiguous to query: `getByText("2 steps")` inside
      // the group threw on multiple matches, so no test could pin the summary
      // down. The title now names the group without counting it.
      render(
        <ToolStepGroup
          steps={[
            entry({ toolUseId: "tu-1", tool: "Bash" }),
            denied({
              toolUseId: "tu-2",
              tool: "Write",
              input: { file_path: "b.md" },
            }),
          ].map(resolved)}
        />,
      );
      const group = screen.getByTestId("tool-step-group");
      // Exactly one match — `getByText` is the assertion: it throws on 0 and on 2+.
      expect(within(group).getByText("2 steps")).toHaveClass(
        "tool-step-group-summary",
      );
      expect(within(group).getByText("Tool steps")).toHaveClass(
        "tool-step-group-title",
      );
    });

    it("keeps the neutral count non-past when NOTHING ran and the tools disagree", () => {
      // No verb to borrow (two tools), but the group is still uniformly
      // un-executed — the fallback must not say "Ran".
      expect(
        headerOf([
          denied({
            toolUseId: "tu-3",
            tool: "Write",
            input: { file_path: "a.md" },
          }),
          entry({
            toolUseId: "tu-4",
            tool: "Bash",
            decision: "cancelled",
            isError: false,
            result: undefined,
          }),
        ]),
      ).toBe("Run 2 steps");
    });

    it("keeps the past-tense count when everything ran and the tools disagree", () => {
      expect(
        headerOf([
          entry({ toolUseId: "tu-1", tool: "Bash" }),
          entry({
            toolUseId: "tu-2",
            tool: "Write",
            input: { file_path: "b.md" },
          }),
        ]),
      ).toBe("Ran 2 steps");
    });

    it("a blocked Edit card and its group header agree on the verb", () => {
      const steps = [
        denied({
          toolUseId: "tu-1",
          tool: "Edit",
          input: { file_path: "notes/a.md" },
        }),
        denied({
          toolUseId: "tu-2",
          tool: "Edit",
          input: { file_path: "notes/b.md" },
        }),
      ].map(resolved);
      render(<ToolStepGroup steps={steps} />);
      const group = screen.getByTestId("tool-step-group");
      expect(within(group).getByText("Edit 2 files")).toBeInTheDocument();
      expect(within(group).getByText("Edit notes/a.md")).toBeInTheDocument();
      expect(within(group).queryByText("Write notes/a.md")).toBeNull();
    });
  });

  it("keys two id-less steps recorded in the same millisecond distinctly", () => {
    // `note_invoked` appends an id-less call as its own standalone entry with
    // `tool_use_id: ""`, and `ts` is epoch MILLISECONDS — two such steps in one
    // tick share both, so a `toolUseId || ts` key collides and React reconciles
    // the two cards as one (losing each card's independent expand state).
    const errors: unknown[][] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args);
      });
    try {
      const steps = [
        entry({ toolUseId: "", ts: 7, input: { command: "echo a" } }),
        entry({ toolUseId: "", ts: 7, input: { command: "echo b" } }),
      ].map((e) => ({ entry: e, title: deterministicLabel(e) }));
      render(<ToolStepGroup steps={steps} />);
      const group = screen.getByTestId("tool-step-group");
      expect(within(group).getAllByTestId("tool-step")).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
    expect(
      errors.filter((e) => String(e[0]).includes("same key")),
    ).toHaveLength(0);
  });
});

describe("ToolStepCard — a disclosure row", () => {
  it("renders ok/blocked/error as both a status modifier class and a glyph", () => {
    const { rerender } = render(<ToolStepCard entry={entry()} />);
    expect(screen.getByTestId("tool-step")).toHaveClass("tool-step--ok");
    expect(screen.getByText("✓")).toBeInTheDocument();
    rerender(<ToolStepCard entry={entry({ decision: "denied" })} />);
    expect(screen.getByTestId("tool-step")).toHaveClass("tool-step--blocked");
    expect(screen.getByText("⊘")).toBeInTheDocument();
    rerender(<ToolStepCard entry={entry({ isError: true })} />);
    expect(screen.getByTestId("tool-step")).toHaveClass("tool-step--error");
    expect(screen.getByText("✕")).toBeInTheDocument();
  });

  it("renders a STOPPED write as a blocked card labelled in the non-past", () => {
    // The whole failure in one assertion: plan mode, the agent asks to write
    // results/out.csv, the researcher hits Stop. Before the fix this card read
    // "✓ Wrote results/out.csv" — a green tick over a file that does not exist.
    render(
      <ToolStepCard
        entry={entry({
          tool: "Write",
          input: { file_path: "results/out.csv" },
          decision: "cancelled",
          isError: false,
          result: undefined,
        })}
      />,
    );
    const card = screen.getByTestId("tool-step");
    expect(card).toHaveClass("tool-step--blocked");
    expect(within(card).getByText("⊘")).toBeInTheDocument();
    expect(within(card).queryByText("✓")).toBeNull();
    expect(within(card).getByText("Write results/out.csv")).toBeInTheDocument();
  });

  describe("a step that left the workspace says so", () => {
    // In plan mode the `claude` CLI auto-allows its own plan-file write to
    // ~/.claude/plans/… — announced and executed with no permission request,
    // so no card could be raised for it. It CANNOT be blocked after the fact;
    // it must not pass silently either.
    const escaped = () =>
      entry({
        tool: "Write",
        input: { file_path: "/Users/x/.claude/plans/p.md" },
        decision: "ran",
        isError: false,
        result: "File created successfully",
        outsideWorkspace: true,
      });

    it("marks the card, without pretending the step failed or was blocked", () => {
      render(<ToolStepCard entry={escaped()} />);
      const card = screen.getByTestId("tool-step");
      expect(within(card).getByText(/outside workspace/i)).toBeInTheDocument();
      expect(card).toHaveClass("tool-step--outside");
      // The call SUCCEEDED: `stepStatus` is not overloaded — still ok/✓.
      expect(stepStatus(escaped())).toBe("ok");
      expect(card).toHaveClass("tool-step--ok");
      expect(within(card).getByText("✓")).toBeInTheDocument();
    });

    it("shows nothing of the sort on an ordinary in-workspace step", () => {
      render(
        <ToolStepCard
          entry={entry({ tool: "Write", input: { file_path: "out.csv" } })}
        />,
      );
      const card = screen.getByTestId("tool-step");
      expect(within(card).queryByText(/outside workspace/i)).toBeNull();
      expect(card).not.toHaveClass("tool-step--outside");
    });

    it("never takes a preceding narration as its title — it keeps the one that names the path", () => {
      // The shipped simulation's stream, exactly: prose, then the CLI's own
      // ungated plan-file write. Promoting the narration onto this card
      // labelled the one card that must stand out as "you never approved this"
      // with a sentence that does not name it — and swallowed the prose block
      // on the way. Same reasoning as a control-plane step, and the same
      // predicate.
      const stream: TurnItem[] = [
        { kind: "text", text: "Here's my plan for this task." },
        { kind: "step", entry: escaped() },
      ];
      const blocks = blocksOf(stream);
      expect(blocks.map((b) => b.kind)).toEqual(["text", "steps"]);
      expect(blocks[0].kind === "text" && blocks[0].text).toBe(
        "Here's my plan for this task.",
      );
      expect(blocks[1].kind === "steps" && blocks[1].steps[0].title).toBe(
        "Wrote /Users/x/.claude/plans/p.md",
      );
    });
  });

  it("is a disclosure whose header toggles the detail — collapsed by default", () => {
    // A tool step's header opens to reveal its detail. So the head is a
    // <button> carrying `aria-expanded`, and the row starts collapsed: nothing
    // is hidden that a click can't bring back, and a long transcript stays a
    // compact list of rows.
    render(<ToolStepCard entry={entry()} />);
    const head = screen.getByRole("button");
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("tool-step-detail")).toBeNull();
  });

  it("shows the glyph, label and tool-shaped summary on the always-visible row", () => {
    render(<ToolStepCard entry={entry({ result: "6.0" })} />);
    const card = screen.getByTestId("tool-step");
    expect(within(card).getByText("✓")).toBeInTheDocument();
    expect(within(card).getByText("Ran: ls -la")).toBeInTheDocument();
    // The summary column stands in for the output at a glance — "6.0" here, a
    // line count for multi-line output — before the row is ever opened.
    expect(within(card).getByText("6.0")).toHaveClass("tool-step-summary");
  });

  it("hides the command and its output until the row is opened, then reveals both", () => {
    render(<ToolStepCard entry={entry()} />);
    // Collapsed: neither the Bash command nor the result <pre> is on screen.
    expect(screen.queryByText(/cd \/tmp/)).toBeNull();
    expect(screen.queryByTestId("tool-output")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /ran: ls -la/i }));

    // Opened: the command (a Bash code block) and its STDOUT both appear, the
    // latter behind a "Hide output" toggle that starts open.
    expect(screen.getByText(/cd \/tmp/)).toBeInTheDocument();
    expect(screen.getByTestId("tool-output")).toHaveTextContent("a b c");
    expect(
      screen.getByRole("button", { name: /hide output/i }),
    ).toBeInTheDocument();

    // The output pane collapses on its own, independent of the row.
    fireEvent.click(screen.getByRole("button", { name: /hide output/i }));
    expect(screen.queryByTestId("tool-output")).toBeNull();
    expect(
      screen.getByRole("button", { name: /show output/i }),
    ).toBeInTheDocument();
  });

  it("uses the resolved title when one is passed, instead of re-deriving it", () => {
    render(<ToolStepCard entry={entry()} title="Custom narration title" />);
    expect(screen.getByText("Custom narration title")).toBeInTheDocument();
  });

  it("falls through to the next tier when the passed title is empty", () => {
    render(<ToolStepCard entry={entry()} title="" />);
    expect(screen.getByText("Ran: ls -la")).toBeInTheDocument();
  });
});

/**
 * A step whose tool is STILL RUNNING.
 *
 * Two facts about the live channel shape everything here:
 *  1. A log entry is announced ONCE, at entry creation, and NOT again when the
 *     tool's result merges in — a second announcement would append a duplicate
 *     card. So a card that appears live carries no `result` at all until the
 *     run lands.
 *  2. A running tool's stdout arrives on the `LiveTurn` snapshot, keyed by
 *     `toolUseId` because tools execute concurrently. The card must show ITS
 *     buffer, never another tool's.
 */
describe("ToolStepCard — a RUNNING step (live stdout)", () => {
  /** What the surface actually holds mid-turn: an announced call, no result. */
  const runningEntry = (
    toolUseId: string,
    command = "wc -l data.csv",
  ): ExecutionLogEntry =>
    entry({
      toolUseId,
      tool: "Bash",
      input: { command },
      decision: "ran",
      result: undefined,
    });

  const stdoutPre = (text: string) => (_: string, node: Element | null) =>
    node?.tagName === "PRE" && node.textContent === text;

  it("streams a running tool's stdout inline under the collapsed row", () => {
    render(
      <ToolStepCard entry={runningEntry("t1")} stdout={"line one\nline two"} />,
    );
    const pre = screen.getByText(stdoutPre("line one\nline two"));
    expect(pre).toBeInTheDocument();
    // Output arriving right now is the point of the card, so it shows inline
    // under the row WITHOUT the researcher opening it — the row is collapsed
    // (`aria-expanded=false`) and the live tail sits below it, not behind the
    // disclosure. Opening the row would move that same output into the detail
    // body; nothing renders it twice.
    expect(screen.getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByTestId("tool-step-detail")).toBeNull();
  });

  it("shows no stdout block when the adapter supplies none", () => {
    render(<ToolStepCard entry={runningEntry("t1")} />);
    expect(screen.queryByTestId("step-stdout")).not.toBeInTheDocument();
  });

  it("renders a result-less running step without inventing a result for it", () => {
    // The entry has no `result` yet (it merges later, with no second
    // announcement), so nothing may promise one: no "Show output" text, and
    // the summary falls back to the tool name rather than echoing the live tail.
    render(<ToolStepCard entry={runningEntry("t1")} stdout="partial output" />);
    const card = screen.getByTestId("tool-step");
    expect(within(card).getByText("Bash")).toHaveClass("tool-step-summary");
    expect(screen.queryByText(/show output/i)).toBeNull();
    // The live tail is shown inline on the always-visible row.
    expect(screen.getByText(stdoutPre("partial output"))).toBeInTheDocument();
  });

  it("gives each grouped step its own stdout, matched by toolUseId", () => {
    // Two tools in flight at once (the ACP shape `toolStdout` exists for):
    // only the one the buffer belongs to may show it.
    const steps = [
      runningEntry("t1", "wc -l a.csv"),
      runningEntry("t2", "wc -l b.csv"),
    ].map((e) => ({ entry: e, title: deterministicLabel(e) }));
    render(
      <ToolStepGroup
        steps={steps}
        stdoutFor={(id) => (id === "t2" ? "42 b.csv" : undefined)}
      />,
    );
    const cards = screen.getAllByTestId("tool-step");
    const a = cards.find((c) => c.textContent?.includes("wc -l a.csv"))!;
    const b = cards.find((c) => c.textContent?.includes("wc -l b.csv"))!;
    expect(within(b).getByTestId("step-stdout")).toHaveTextContent("42 b.csv");
    expect(within(a).queryByTestId("step-stdout")).toBeNull();
  });
});

/**
 * The golden transcript — one pass over the whole tool vocabulary,
 * asserting that nothing machine-facing reaches the researcher's row.
 *
 * Every leak below is a real failure mode this suite guards against:
 * `Tool: ExitPlanMode` and `Tool: TodoWrite` as a
 * right-hand summary, `select:TodoWrite` as a `ToolSearch` query, a bare
 * `switch_mode` tag, and raw JSON in the row. The individual suppression rules
 * are tested above; this pins the WHOLE transcript at once, so a new tool added
 * to the vocabulary cannot reintroduce a leak that no single-rule test covers.
 */
describe("golden transcript — no machine-facing text in the step rows", () => {
  const GOLDEN: TurnItem[] = [
    { kind: "text", text: "I'll start by understanding the workspace." },
    {
      kind: "step",
      entry: entry({
        toolUseId: "g1",
        tool: "Bash",
        input: { command: "ls -la" },
        result: "a.txt",
      }),
    },
    // The agent's own harness chatter: both are control-plane and must not draw.
    {
      kind: "step",
      entry: entry({
        toolUseId: "g2",
        tool: "ExitPlanMode",
        input: { plan: "1. Build the kinome set\n2. Score guides" },
        result: "Tool: ExitPlanMode",
      }),
    },
    {
      kind: "step",
      entry: entry({
        toolUseId: "g3",
        tool: "TodoWrite",
        input: { query: "select:TodoWrite" },
        result: "Tool: TodoWrite",
      }),
    },
    {
      kind: "step",
      entry: entry({
        toolUseId: "g4",
        tool: "Write",
        input: { file_path: "results/kinome.csv" },
        result: "wrote 518 rows",
      }),
    },
    {
      kind: "step",
      entry: entry({
        toolUseId: "g5",
        tool: "mcp__lykeion_kernel__run_python",
        input: { human_description: "Scoring on-target activity" },
        result: "done",
      }),
    },
    { kind: "text", text: "Both done." },
  ];

  /** Every rendered step row, as the researcher reads it. */
  const rowTexts = (): string[] => {
    const blocks = blocksOf(GOLDEN);
    render(
      <>
        {blocks.map((b, i) =>
          b.kind === "steps" ? <ToolStepGroup key={i} steps={b.steps} /> : null,
        )}
      </>,
    );
    return screen.getAllByTestId("tool-step").map((el) => el.textContent ?? "");
  };

  it("draws only the researcher-facing steps, dropping the control-plane ones", () => {
    // Bash + Write + the MCP call. ExitPlanMode and TodoWrite render nothing.
    expect(rowTexts()).toHaveLength(3);
  });

  it("never shows a `Tool: X` echo, a `select:` query, or raw JSON braces", () => {
    for (const text of rowTexts()) {
      expect(text).not.toMatch(/Tool:\s/);
      expect(text).not.toContain("select:");
      expect(text).not.toContain("{");
      expect(text).not.toContain('"');
      // The machine name of an MCP triple never surfaces either.
      expect(text).not.toContain("mcp__");
    }
  });

  it("labels every visible row with prose, never a bare internal tag", () => {
    const rows = rowTexts();
    // The first step is preceded by promotable narration, so tier 2 wins and the
    // row reads as that sentence rather than the tier-3 command — the whole point
    // of the promotion, and prose either way.
    expect(rows.some((t) => t.includes("understanding the workspace"))).toBe(
      true,
    );
    // Each remaining row carries its own human label: the path, the
    // model-authored MCP description.
    expect(rows.some((t) => t.includes("Wrote results/kinome.csv"))).toBe(true);
    expect(rows.some((t) => t.includes("Scoring on-target activity"))).toBe(
      true,
    );
    // And no row is JUST a tag the agent's harness uses internally.
    for (const tag of ["switch_mode", "ExitPlanMode", "TodoWrite"]) {
      expect(rows.some((t) => t.trim() === tag)).toBe(false);
    }
  });

  it("keeps both control-plane tools in the suppression set", () => {
    // The set is the single source of truth the transcript above relies on.
    expect([...CONTROL_PLANE_TOOLS].sort()).toEqual([
      "ExitPlanMode",
      "TodoWrite",
    ]);
  });
});
