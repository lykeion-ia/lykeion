import { useState } from "react";
import type { ExecutionLogEntry, TurnItem } from "@lykeion/api";
import { ChevronRightIcon } from "../icons";
import { ToolStepDetail } from "./ToolStepDetail";
import { ToolStepPreview } from "./ToolStepPreview";
import { RailRow, TurnRail, type RailMarker } from "./TurnRail";

/**
 * Row/group rendering for one Execution Log entry — the "tool step" the Task
 * transcript draws for every tool a run took, as one node on the turn's
 * timeline rail (see `TurnRail`), interleaved with the prose and thinking that
 * sit on the same rail. Shared by both the live in-flight turn and the
 * persisted transcript, since TaskScreen renders each of those through this
 * same code.
 *
 * An announced call carries `decision: "pending"` until execution or a gate
 * resolves it, so this same row is also the live running state.
 */

export type StepStatus = "running" | "ok" | "blocked" | "error";

/**
 * The decisions under which a step NEVER EXECUTED — the seam refused it
 * (`"denied"`) or the researcher stopped the turn while it was at the gate
 * (`"cancelled"`) — an intention, never a history. A property of the recorded
 * decision, never of which adapter produced it. Everything else in the
 * vocabulary ("ran", "auto", "allowed-*", "orphan-executed") means the tool
 * really ran. `"pending"` is neither set: it makes no execution claim yet.
 */
const NEVER_RAN = new Set(["denied", "cancelled"]);

function neverRan(entry: ExecutionLogEntry): boolean {
  return NEVER_RAN.has(entry.decision);
}

function didRun(entry: ExecutionLogEntry): boolean {
  return entry.decision !== "pending" && !neverRan(entry);
}

/**
 * `decision` decides FIRST, then `isError`.
 *
 * That order is the whole rule, not a style choice. A denied gate's entry
 * ALWAYS ends up with `isError: true` — the CLI reports the refusal back to
 * the model as an error `tool_result`, which always merges onto the same
 * Execution Log entry as the decision that produced it. Consulting `isError`
 * first therefore drew every refusal as a red ✕, indistinguishable from a
 * crash, and left `blocked` effectively unreachable. And a `"cancelled"` step
 * carries no result — the tool never ran — whatever `isError` its entry ends
 * up with (an abandoned call may still see the adapter's own follow-up
 * report it failed): consulting `isError` first would risk drawing that as
 * an ordinary success instead of the blocked step it is.
 */
export function stepStatus(entry: ExecutionLogEntry): StepStatus {
  if (entry.decision === "pending") return "running";
  if (neverRan(entry)) return "blocked";
  if (entry.isError) return "error";
  return "ok";
}

function stringField(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Tier 3 — the deterministic fallback, always available regardless of
 * adapter. This is the guaranteed baseline for the `claude` CLI, which
 * never populates `entry.title` (tier 1) by protocol: most real Tasks
 * land here or on tier 2 (narration), never tier 1.
 *
 * The TENSE follows the record: a step that ran is described in the past
 * ("Wrote results/out.csv"), a step that was refused or stopped in the
 * non-past ("Write results/out.csv") — it is a request the researcher blocked,
 * not something that happened. Claiming the past tense for a file that was
 * never written misreports the research record, and it persists in
 * `TaskTurn.stream`, so it would read that way on every reopen.
 */
export function deterministicLabel(entry: ExecutionLogEntry): string {
  const ran = didRun(entry);
  switch (entry.tool) {
    case "Bash": {
      const command = stringField(entry.input, ["command"]);
      const verb = ran ? "Ran" : "Run";
      return command
        ? `${verb}: ${command.split("\n")[0]}`
        : `${verb} a command`;
    }
    case "Write":
    case "Edit": {
      const path = stringField(entry.input, ["file_path", "path"]);
      // The past tense collapses both onto "Wrote" — what happened to the file
      // is the same either way. The NON-past keeps them apart (`entry.tool` is
      // already the verb: "Write", "Edit"), because a blocked card sits under a
      // group header built from the same tool: sharing "Write" here put
      // "⊘ Write notes/a.md" beneath "Edit 2 files" in one view.
      const verb = ran ? "Wrote" : entry.tool;
      return path ? `${verb} ${path}` : entry.tool;
    }
    case "Read": {
      // Already tenseless in both directions — nothing to vary.
      const path = stringField(entry.input, ["file_path", "path"]);
      return path ? `Read ${path}` : "Read a file";
    }
    default: {
      // An MCP tool (`mcp__<server>__<tool>`): the model authors a
      // `human_description` for the call (the notebook's
      // `execute_python_cell` requires one), so use it as the step's title.
      // Falling back, show the bare tool name from the `mcp__` triple
      // ("execute_python_cell"), never the full machine name. Model-authored,
      // like a tier-1 title, so it is used as-is — the glyph, not the tense,
      // carries whether a blocked call ran.
      if (entry.tool?.startsWith("mcp__")) {
        const description = stringField(entry.input, ["human_description"]);
        if (description) return description;
        return entry.tool.split("__").pop() || entry.tool;
      }
      return entry.tool || "Tool step";
    }
  }
}

/**
 * The tool's name as the row prints it, in bold: `entry.tool` — with an MCP
 * triple reduced to the bare tool at its end ("execute_python_cell", never
 * `mcp__notebook__execute_python_cell`), because a machine name must not reach
 * the researcher's row.
 */
export function toolName(entry: ExecutionLogEntry): string {
  const tool = entry.tool;
  if (!tool) return "Tool";
  if (tool.startsWith("mcp__")) return tool.split("__").pop() || tool;
  return tool;
}

/**
 * The step's ARGUMENT alone, with no verb and no tense: Bash's first command
 * line, Read/Write/Edit's path, an MCP call's model-authored
 * `human_description`, else the tool's own name.
 *
 * Beside [`deterministicLabel`] rather than folded into it, because the two
 * answer different questions. A LABEL is a sentence about what happened ("Wrote
 * out.csv"), and the tense in it is what says whether it did. A rail row reads
 * `tool name + argument` — the name is already the verb, so the description
 * beside it must not carry a second one.
 *
 * Dropping the tense here is a deliberate WIDENING of a rule that already
 * existed, not an oversight. `deterministicLabel` is tenseless for MCP tools
 * today, on the grounds that "the glyph, not the tense, carries whether a
 * blocked call ran". The rail extends that to every tool, and can afford to
 * only because its markers keep the bargain: `blocked` and `error` draw a GLYPH
 * rather than a differently-coloured dot, and every non-`ok` row also announces
 * its status as a word (see `RailRow`). Take either of those away and the tense
 * has to come back.
 */
export function stepArgument(entry: ExecutionLogEntry): string {
  switch (entry.tool) {
    case "Bash": {
      const command = stringField(entry.input, ["command"]);
      return command ? command.split("\n")[0] : entry.tool;
    }
    case "Write":
    case "Edit":
    case "Read": {
      const path = stringField(entry.input, ["file_path", "path"]);
      return path ?? entry.tool;
    }
    default: {
      if (entry.tool?.startsWith("mcp__")) {
        const description = stringField(entry.input, ["human_description"]);
        if (description) return description;
      }
      return toolName(entry);
    }
  }
}

/**
 * Tools that are the agent talking to its HARNESS, not work the researcher
 * asked for: `ExitPlanMode` announces "the plan is ready" (and carries the
 * whole plan as its input — the PlanCard already shows the researcher exactly
 * that), `TodoWrite` maintains the agent's own checklist (a card per update).
 * Rendering them as tool-step cards clutters every plan-mode transcript with
 * duplicates of what is already on screen.
 *
 * They are NOT dropped from the Execution Log — the audit trail records
 * everything that ran, and nothing about that changes. They are dropped from
 * the RENDER, here, keyed on the entry's normalized tool NAME: a property of
 * the data. ACP tool kinds are mapped onto this same normalized vocabulary
 * before they ever reach here, so one name-based set covers every adapter and
 * no branch on adapter/CLI id is needed (nor allowed) anywhere.
 */
export const CONTROL_PLANE_TOOLS = new Set(["ExitPlanMode", "TodoWrite"]);

/**
 * Whether this step is control-plane signalling that must not render as a
 * card (see [`CONTROL_PLANE_TOOLS`]).
 *
 * Only a step that actually RAN, ungated, is the noise this filter is about.
 * `TodoWrite` maps to `Execute("TodoWrite")` and so does reach the permission
 * engine: a DENIED or CANCELLED one is the researcher's own refusal, and
 * dropping it would leave that refusal with no trace anywhere on screen — the
 * opposite of what the filter is for. Decided with the same `neverRan`
 * predicate the status glyph and the tenses use, so the vocabulary of
 * "did this step run" lives in exactly one place.
 */
export function isControlPlaneStep(entry: ExecutionLogEntry): boolean {
  return CONTROL_PLANE_TOOLS.has(entry.tool) && didRun(entry);
}

/** Whether this step's access left the research workspace (`outsideWorkspace` —
 *  a property of the path the core recorded, never of the tool name or the
 *  adapter). */
export function leftTheWorkspace(entry: ExecutionLogEntry): boolean {
  return entry.outsideWorkspace === true;
}

/**
 * May this step take the preceding narration as its title (tier 2)?
 *
 * Two kinds of step decline it, for one shared reason: the narration would
 * be lost or would mislabel the card.
 *
 * - A CONTROL-PLANE step renders nothing at all, so a line promoted onto it
 *   would vanish from the transcript entirely.
 * - A step that LEFT THE WORKSPACE must keep its own deterministic label,
 *   which names the path it wrote ("Wrote /Users/…/.claude/plans/p.md"). It
 *   is the one card that has to stand out as "you never approved this";
 *   labelling it with a sentence that does not name it ("Here's my plan for
 *   this task.") hides exactly what it exists to show — and costs the
 *   transcript a prose block on top.
 *
 * In both cases the narration stays prose, which is the only rendering that
 * keeps it and keeps it attached to nothing it does not describe.
 */
function acceptsNarrationTitle(entry: ExecutionLogEntry): boolean {
  return !isControlPlaneStep(entry) && !leftTheWorkspace(entry);
}

/** A narration is promotable to a step's title only if it reads like a
 *  short title, not a paragraph: single line, ~80 chars or under. */
const NARRATION_MAX_LEN = 80;
function isPromotableNarration(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && t.length <= NARRATION_MAX_LEN && !t.includes("\n");
}

/**
 * How long a single-line result may be and still be echoed verbatim into
 * the summary column. Verbatim rendering is scoped to "a short single-line
 * result"; results are capped at 2000 characters, so a ~2 KB single-line JSON
 * blob is a reachable value that would otherwise blow out the column.
 * Anything longer falls through to the tool name.
 */
export const SUMMARY_MAX_LEN = 100;

/**
 * A one-line, tool-shaped summary of what a step produced: a multi-line
 * result becomes a line count, a short single-line result is shown
 * verbatim (e.g. a bare `6.0`), and a step with no result
 * yet (or one too long to be a summary) falls back to the tool name.
 *
 * Nothing on the rail draws it: a collapsed row now shows the first lines of
 * the output itself (`ToolStepPreview`'s `OUT`), which is what the summary
 * column stood in for. Kept because it is the one place that knows how to say
 * "what did this produce" in a single line, for a surface that has room for
 * exactly one.
 */
export function stepSummary(entry: ExecutionLogEntry): string {
  const result = entry.result;
  if (typeof result === "string" && result.length > 0) {
    const lines = result.split("\n");
    // A trailing newline shouldn't count as an extra blank line of output.
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length > 1) {
      return `${lines.length} lines of output`;
    }
    const value = lines[0].trim();
    if (value && value.length <= SUMMARY_MAX_LEN) return value;
  }
  return entry.tool || "Tool step";
}

/**
 * Which tier decided a step's title: the adapter's own (`given`), the promoted
 * narration before it (`narration`), or the deterministic fallback
 * (`deterministic`).
 *
 * It travels with the title because the ROW renders the two kinds differently:
 * the first two are model-authored prose and read as prose; the third is a
 * literal path or command and reads as one, in mono. Deciding that from the
 * title's TEXT would be a guess, and the tier is already known — `blocksOf`
 * just resolved it.
 */
export type StepSource = "given" | "narration" | "deterministic";

/** One step, its resolved title already decided by `blocksOf` (tier
 *  1/2/3), and pass-through to a bare `ToolStepCard`. */
export interface ResolvedStep {
  entry: ExecutionLogEntry;
  title: string;
  source: StepSource;
}

/** A render block: prose, or a run of consecutive tool steps with their
 *  titles already resolved (so the promotion/omission decision below can
 *  never disagree with what renders). */
export type StreamBlock =
  { kind: "text"; text: string; block?: "thinking" | "interim" | "final" | "error" }
  | { kind: "steps"; steps: ResolvedStep[] };

/**
 * Fold an arrival-order stream into ordered render blocks, resolving each
 * step's label (tier 1 `entry.title` -> tier 2 promoted narration -> tier 3
 * deterministic) exactly ONCE here — the single place that decides both
 * "is this narration a title" and "does this narration also render as its
 * own paragraph", so the two can never disagree (no-double-render).
 *
 * It is also where control-plane steps are dropped from the render (see
 * [`CONTROL_PLANE_TOOLS`]): every surface, live and persisted, folds its
 * stream through here, so one filter covers them all — while the Execution
 * Log goes on recording everything that really ran.
 *
 * EVERY text item is one whole assistant message: events flagged as partial
 * fragments (ACP's `AgentMessageChunk`) are reassembled before the record is
 * written. So each one renders as its own prose block, and nothing here joins
 * or splits them.
 *
 * This layer used to guess instead, from the text at the seam — undecidable in
 * principle: every rule that stopped two whole `claude` paragraphs from gluing
 * together ("Here's what I'll do:" + "First I read the file.") also broke a
 * real ACP chunk seam mid-word ("I read " + "42. Then I wrote it."). Each event
 * now states its own shape; the guess is gone.
 */
export function blocksOf(streamIn: TurnItem[]): StreamBlock[] {
  // A whitespace-only text item is not prose at all: it must neither render as
  // an empty paragraph nor break a run of steps. Dropping it up front (rather
  // than skipping it in the loop) also keeps the one-item lookahead below
  // honest — the step after a blank item is still the step this message
  // narrates.
  const stream = streamIn.filter(
    (item) => item.kind !== "text" || item.text.trim() !== "",
  );
  const blocks: StreamBlock[] = [];
  // Set only when the text item just processed was consumed as the very
  // next step's title — cleared as soon as it's used (or skipped over).
  let pendingNarration: string | undefined;
  // A text item ALWAYS ends a run of consecutive steps, whether or not it
  // renders as its own block — a promoted narration is omitted from
  // `blocks`, but it must still break the group, or the step that absorbs
  // it as a title would wrongly merge into the group before it.
  let startNewGroup = true;

  for (let i = 0; i < stream.length; i++) {
    const item = stream[i];
    if (item.kind === "text") {
      pendingNarration = undefined;
      startNewGroup = true;
      const next = stream[i + 1];
      // Only the step immediately following a text item can ever be
      // "first of its group" (any text item ends the prior run of steps),
      // so no separate first-of-group check is needed here.
      //
      // Some steps decline a narration title (see `acceptsNarrationTitle`) —
      // and the narration does not skip past such a step to the next card
      // either. Both directions would lose the researcher something true:
      // promoting onto a filtered step would delete the line from the
      // transcript entirely (that card never renders), and promoting onto the
      // step AFTER it would put a line that narrates this step ("Let me update
      // the todos.") over unrelated work. It stays prose — the only rendering
      // that keeps it, and keeps it attached to nothing it does not describe.
      const promotable =
        item.block === undefined &&
        next?.kind === "step" &&
        acceptsNarrationTitle(next.entry) &&
        !next.entry.title &&
        isPromotableNarration(item.text);
      if (promotable) {
        pendingNarration = item.text.trim();
        continue; // becomes the next step's title below — omit from prose.
      }
      blocks.push({ kind: "text", text: item.text, ...(item.block === undefined ? {} : { block: item.block }) });
    } else {
      if (isControlPlaneStep(item.entry)) {
        // Renders nothing — and therefore changes nothing else either. It
        // does not break the run of steps around it: a group boundary the
        // researcher can see no reason for (nothing renders between the two
        // groups) is worse than one group, and the invisible bookkeeping call
        // that caused it is exactly what this filter says is not worth
        // showing. Prose still breaks a run, because prose is visible.
        //
        // `pendingNarration` cannot be set here: it is only ever set when the
        // NEXT item is a non-control-plane step (see the promotion check
        // above), so a filtered step can never swallow one.
        continue;
      }
      const narration = pendingNarration;
      pendingNarration = undefined;
      // One expression per tier, resolved in the same order and by the same
      // `||` — an empty title is no title — so the tier recorded in `source`
      // can never disagree with the title beside it.
      const source: StepSource = item.entry.title
        ? "given"
        : narration
          ? "narration"
          : "deterministic";
      const title =
        item.entry.title || narration || deterministicLabel(item.entry);
      const resolved: ResolvedStep = { entry: item.entry, title, source };
      const last = blocks[blocks.length - 1];
      if (!startNewGroup && last && last.kind === "steps") {
        last.steps.push(resolved);
      } else {
        blocks.push({ kind: "steps", steps: [resolved] });
      }
      startNewGroup = false;
    }
  }
  return blocks;
}

/** Deterministic, no-LLM synthesis of a group header's left-hand text —
 *  "Ran 2 commands" for a run of same-tool steps, a generic count
 *  otherwise. The right-hand summary is always the step count ("N steps"),
 *  handled separately by `ToolStepGroup`.
 *
 *  Always plural: `groupHeaderText` is only ever reached with n > 1, since
 *  `ToolStepGroup` returns a bare card for a lone step before it.
 *
 *  Tense follows the record, exactly as in `deterministicLabel` — and via the
 *  same `neverRan` predicate, so the header can never disagree with the cards
 *  it sits over. Two consecutive REFUSED `Write`s are an ordinary shape (a
 *  denial does not end the turn, so a retrying agent is simply refused again),
 *  and "Wrote 2 files" over two ⊘ cards is the same lie the card labels
 *  already stopped telling. */
const GROUP_VERB_RAN: Record<string, (n: number) => string> = {
  Bash: (n) => `Ran ${n} commands`,
  Write: (n) => `Wrote ${n} files`,
  Edit: (n) => `Edited ${n} files`,
  Read: (n) => `Read ${n} files`,
};

const GROUP_VERB_BLOCKED: Record<string, (n: number) => string> = {
  Bash: (n) => `Run ${n} commands`,
  Write: (n) => `Write ${n} files`,
  Edit: (n) => `Edit ${n} files`,
  // Already tenseless, like `deterministicLabel`'s Read branch.
  Read: (n) => `Read ${n} files`,
};

/** Whether the steps in a group agree about having executed. */
type GroupMix = "all-ran" | "none-ran" | "mixed";

/**
 * The tool-specific header for a group that agrees on its tool, or undefined
 * when no verb in the tables is true of the whole group.
 *
 * A MIXED group (some ran, some refused) may only use a verb that reads the
 * SAME either way — `Read`, whose past and non-past forms are identical, and
 * which therefore asserts nothing about execution at all. That is not a
 * special case for one tool: it falls straight out of the two tables agreeing,
 * so any future tenseless verb inherits it without a third table to keep in
 * sync. A verb that does carry tense is false of half the group whichever form
 * it takes, so the caller drops to a count that claims nothing.
 */
function groupVerb(
  tool: string,
  count: number,
  mix: GroupMix,
): string | undefined {
  const past = GROUP_VERB_RAN[tool]?.(count);
  const nonPast = GROUP_VERB_BLOCKED[tool]?.(count);
  if (past === undefined || nonPast === undefined) return undefined;
  if (mix === "all-ran") return past;
  if (mix === "none-ran") return nonPast;
  return past === nonPast ? past : undefined;
}

function groupHeaderText(steps: ResolvedStep[]): string {
  const ranCount = steps.filter((s) => didRun(s.entry)).length;
  const blockedCount = steps.filter((s) => neverRan(s.entry)).length;
  const mix: GroupMix =
    blockedCount === steps.length
      ? "none-ran"
      : ranCount === steps.length
        ? "all-ran"
        : "mixed";
  const tools = new Set(steps.map((s) => s.entry.tool));
  if (tools.size === 1) {
    const verb = groupVerb(steps[0].entry.tool, steps.length, mix);
    if (verb) return verb;
  }
  // The neutral fallback carries a tense too, so it takes the same rule the
  // cards below it do. All ran: "Ran" is true of the group. None ran: it must
  // stay non-past. MIXED: neither is true, so the title drops the verb
  // entirely and names the group instead of describing it — "Ran 2 steps" over
  // a group half of which was refused is the same lie the per-card labels
  // already stopped telling, and the glyph on each card carries the per-step
  // truth one line below.
  //
  // It does NOT count, either: the count is already the right-hand summary on
  // this same line (`ToolStepGroup`), and repeating it rendered "2 steps …
  // 2 steps" — a stutter, and two identical strings one line apart that no
  // `getByText` could tell apart.
  if (mix === "mixed") return "Tool steps";
  return `${mix === "none-ran" ? "Run" : "Ran"} ${steps.length} steps`;
}

/** One tool step, as a node on the turn's rail: a marker, the tool's NAME in
 *  bold, and a muted description beside it — `Bash  find . -name '*.css'`. The
 *  whole row is a disclosure the researcher clicks to reveal the step's detail
 *  (its command over STDOUT, an Edit's diff, a web search's query over its
 *  results — see `ToolStepDetail`). Collapsed by default, so a turn of many
 *  steps stays a list of rows on one rail rather than a stack of boxes.
 *
 *  Collapsed, the row carries a clamped `IN`/`OUT` preview beneath it
 *  (`ToolStepPreview`) — so the transcript says what each step DID without
 *  anything being opened. Open, the preview gives way to the full detail, which
 *  carries the same content: nothing is drawn in both places.
 *
 *  `title`/`source` are the already-resolved label and the tier that decided it
 *  (from `blocksOf`). Used standalone there is no stream context for tier 2, so
 *  the tier is read off the entry: an adapter title is `given`, anything else
 *  falls to `deterministic`.
 *
 *  `stdout` is THIS tool's live output while it is still running (the caller
 *  matched it by `toolUseId`), and is never persisted. It reaches the preview's
 *  `OUT` row as the step's output, exactly as a landed result would. */
export function ToolStepCard({
  entry,
  title,
  source,
  stdout,
}: {
  entry: ExecutionLogEntry;
  title?: string;
  source?: StepSource;
  stdout?: string;
}) {
  const [open, setOpen] = useState(false);
  const status = stepStatus(entry);
  /**
   * The step's access left the research workspace. It is drawn as its OWN
   * affordance, deliberately not folded into `stepStatus`: the call ran and
   * succeeded, so it is neither an error nor blocked, and saying otherwise
   * would be as false as the green marker this chip exists to qualify. An agent
   * CLI can execute such an access with no permission request ever reaching
   * the seam (plan mode's auto-allow), so this chip is the only place the
   * researcher ever learns it happened.
   */
  const outside = leftTheWorkspace(entry);
  const name = toolName(entry);
  // `||`, not `??`, and for the same reason as in `blocksOf`: an empty
  // title is no title, and must fall through to the next tier.
  const given = title || entry.title;
  const tier: StepSource = source ?? (given ? "given" : "deterministic");
  const derived = tier === "deterministic";
  const argument = stepArgument(entry);
  // A derived row describes itself with the bare argument, set in mono because
  // that is what it is — a literal path or command. A model-authored title
  // (the adapter's, or the promoted narration) is prose, and is set as prose.
  const description = derived ? argument : given || deterministicLabel(entry);
  // The name is already on the row: an MCP call that authored no description of
  // its own resolves to exactly it, and printing it twice says nothing the
  // second time.
  const describes = description !== name;
  // The `IN` line carries the literal argument UNDER a model-authored
  // description. On a derived row the description already is that argument, so
  // the line would repeat it verbatim one line down; and an argument that came
  // out as the bare tool name adds nothing the name has not already said.
  const input = derived || argument === name ? undefined : argument;

  return (
    <RailRow
      marker={status}
      testid="tool-step"
      className={`tool-step tool-step--${status}${
        outside ? " tool-step--outside" : ""
      }${open ? " tool-step--open" : ""}`}
    >
      {/* The whole row toggles the detail below it. `aria-expanded` carries the
          state — the same affordance the group header and the "Show output"
          toggle use. */}
      <button
        type="button"
        className="tool-step-head"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="rail-tool">{name}</span>
        {describes && (
          <>
            {/* A real space between the two, so the row's text reads as
                "Write results/out.csv" to a screen reader and to anything else
                that takes it — the gap between them is CSS, and CSS is not
                text. A whitespace-only node between flex items is not rendered,
                so it costs no layout. */}{" "}
            <span className={`rail-desc${derived ? " rail-desc--mono" : ""}`}>
              {description}
            </span>
          </>
        )}
        {outside && (
          // Beside the description, which yields first when space is tight (see
          // task.css): this must never be the part that gets truncated away.
          <span
            className="tool-step-outside"
            title="This access fell outside the research workspace, and ran without a permission card."
          >
            outside workspace
          </span>
        )}
      </button>
      {open ? (
        <div className="tool-step-detail" data-testid="tool-step-detail">
          <ToolStepDetail entry={entry} stdout={stdout} />
        </div>
      ) : (
        <ToolStepPreview
          entry={entry}
          {...(input ? { input } : {})}
          {...(stdout ? { stdout } : {})}
        />
      )}
    </RailRow>
  );
}

/** Renders one render block's worth of consecutive steps: a lone step
 *  renders bare (no group chrome); a run of >1
 *  steps groups under a synthesized header ("Ran 2 commands") with the
 *  step count on the right ("2 steps").
 *
 *  `stdoutFor` resolves ONE step's live output from its `toolUseId`. It is a
 *  lookup, not a value, because tools run concurrently: a group can hold two
 *  steps executing at once, and each must show only its own buffer. Absent
 *  (every persisted turn, and every adapter that streams no tool output) no
 *  card shows any. */
export function ToolStepGroup({
  steps,
  stdoutFor,
}: {
  steps: ResolvedStep[];
  stdoutFor?: (toolUseId?: string) => string | undefined;
}) {
  if (steps.length === 0) return null;
  if (steps.length === 1) {
    const only = steps[0];
    return (
      <ToolStepCard
        entry={only.entry}
        title={only.title}
        source={only.source}
        stdout={stdoutFor?.(only.entry.toolUseId)}
      />
    );
  }
  return <ToolStepGroupCard steps={steps} stdoutFor={stdoutFor} />;
}

/**
 * The rail marker for a whole group: the WORST thing that happened inside it.
 *
 * A header can never read calmer than the steps folded under it — collapsed,
 * it is the only row on screen, and a green dot over a group containing a
 * refusal would hide exactly the thing the researcher needs to see. Ordered so
 * a failure outranks a refusal, which outranks work still in flight.
 */
function groupMarker(steps: ResolvedStep[]): RailMarker {
  const statuses = steps.map((s) => stepStatus(s.entry));
  if (statuses.includes("error")) return "error";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("running")) return "running";
  return "ok";
}

/** The multi-step case of [`ToolStepGroup`]: a disclosure whose header row
 *  collapses the child rows. Split out so the collapse
 *  `useState` is only ever reached on the >1 path — the lone-step and empty
 *  cases return before it, and never call a hook they don't use. Default OPEN:
 *  nothing that renders today gets hidden on first paint; the researcher folds
 *  a group away, they are never handed it folded.
 *
 *  The header is a node on the OUTER rail; the open body indents by one rail
 *  column and puts its children on a nested, dimmer one, so a folded run reads
 *  as one event in the turn and an unfolded one as its own small timeline
 *  hanging off that event. */
function ToolStepGroupCard({
  steps,
  stdoutFor,
}: {
  steps: ResolvedStep[];
  stdoutFor?: (toolUseId?: string) => string | undefined;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="tool-step-group" data-testid="tool-step-group">
      <RailRow marker={groupMarker(steps)} className="tool-step-group-row">
        {/* A disclosure header: the chevron rotates to point down when open,
            and the whole row toggles the group body. `aria-expanded` carries
            the state the chevron shows. */}
        <button
          type="button"
          className="tool-step-group-head"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          <ChevronRightIcon
            className={`tool-step-chevron${open ? " tool-step-chevron--open" : ""}`}
            width={13}
            height={13}
          />
          <span className="tool-step-group-title">{groupHeaderText(steps)}</span>
          <span className="tool-step-group-summary">{steps.length} steps</span>
        </button>
      </RailRow>
      {open && (
        <div className="tool-step-group-body">
          <TurnRail nested>
            {/* The index is part of the key, not a substitute for the id: an
                id-less call (`note_invoked` appends it with `tool_use_id: ""`) or
                an orphan entry falls back to `ts`, and `ts` is epoch MILLISECONDS —
                two such steps in one tick would otherwise share a key and be
                reconciled as one row. */}
            {steps.map((s, i) => (
              <ToolStepCard
                key={`${i}:${s.entry.toolUseId || s.entry.ts}`}
                entry={s.entry}
                title={s.title}
                source={s.source}
                stdout={stdoutFor?.(s.entry.toolUseId)}
              />
            ))}
          </TurnRail>
        </div>
      )}
    </div>
  );
}
