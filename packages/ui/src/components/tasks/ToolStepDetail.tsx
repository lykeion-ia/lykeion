import { useState } from "react";
import type { ExecutionLogEntry, ToolOutputPart } from "@lykeion/api";
import { ChevronRightIcon } from "../icons";
import { CodeBlock } from "./CodeBlock";

/**
 * The opened body of a tool-step card: the per-kind detail a researcher
 * reveals by clicking the row (see `ToolStepCard`). One small renderer per
 * call KIND, chosen by `entry.tool` — a command over its STDOUT, an edit's
 * diff, a search's query over its results — with a generic input/output view
 * for a kind that has none.
 *
 * Everything here reads off the SAME persisted `ExecutionLogEntry` the row
 * already has: `input` (the agent's tool arguments, preserved verbatim across
 * the ACP bridge — the command, an edit's `old_string`/`new_string`, a
 * search's `query`) and `result` (what the call produced, as text or as the
 * typed pieces it arrived in). So a reopened transcript renders the full
 * detail with no extra data threaded in; `stdout` is only the live tail of a
 * step whose tool is still running, used when there is no persisted result
 * yet.
 *
 * A step never opens onto nothing. Where there is no output to draw, the body
 * says which of the reasons that is — see [`stepOutcome`].
 */

/** A string field off the entry's (object) input, or undefined. */
function strInput(entry: ExecutionLogEntry, key: string): string | undefined {
  const input = entry.input;
  if (!input || typeof input !== "object") return undefined;
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** File extension → a shiki language the `CodeBlock` bundle actually carries
 *  (anything else stays plain). Kept small and explicit, like `CodeBlock`'s own
 *  `SUPPORTED_LANGS`. */
const EXT_LANG: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  json: "json",
  rs: "rust",
  py: "python",
  sh: "bash",
  bash: "bash",
  sql: "sql",
  css: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  diff: "diff",
  patch: "diff",
};

/** The highlighter language for a path, by its extension — or undefined when
 *  there is no path or the extension isn't one we bundle a grammar for. */
export function langForPath(path?: string): string | undefined {
  if (!path) return undefined;
  const m = /\.([a-z0-9]+)$/i.exec(path.trim());
  return m ? EXT_LANG[m[1].toLowerCase()] : undefined;
}

/**
 * A line-level unified diff of `oldText` → `newText`, as `-`/`+`/space-prefixed
 * lines a `CodeBlock lang="diff"` renders. A real LCS diff (not "all removed
 * then all added"), so an Edit that touched two lines of twenty shows exactly
 * those two — the whole point of restoring `old_string`/`new_string` to the
 * Execution Log.
 */
export function unifiedDiff(oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  // Longest common subsequence of lines, bottom-up.
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`-${a[i]}`);
      i++;
    } else {
      out.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`-${a[i++]}`);
  while (j < m) out.push(`+${b[j++]}`);
  return out.join("\n");
}

/**
 * Strip the `cat -n` line numbers off a `Read` result (`"  1\t…"`), so the file
 * contents can be highlighted as the file's own language. Defensive: only when
 * EVERY non-empty line has the number+tab shape does it strip — a file whose
 * real content doesn't match is left exactly as it came.
 */
export function stripReadLineNumbers(text: string): string {
  const numbered = /^\s*\d+\t/;
  const lines = text.split("\n");
  const nonEmpty = lines.filter((l) => l.length > 0);
  if (nonEmpty.length === 0 || !nonEmpty.every((l) => numbered.test(l))) {
    return text;
  }
  return lines.map((l) => l.replace(numbered, "")).join("\n");
}

/** One web result. `title` falls back to the URL when the source names none. */
export interface WebResult {
  title: string;
  url: string;
}

/**
 * Best-effort parse of a web search's result text into a title/url list. The
 * exact shape is the agent's, not ours, so this stays defensive and tries the
 * shapes a Claude web search actually produces, in order:
 *
 *  1. JSON (the completion's structured `raw_output`): an array, or an object
 *     with a `results`/`links`/`items`/`web_search_results` array of objects
 *     carrying a url + a title/name.
 *  2. Markdown links: `[title](https://…)`.
 *  3. A title line immediately followed by a bare URL line.
 *
 * Returns null when none match, so the caller can fall back to showing the raw
 * text rather than an empty list.
 */
export function parseWebResults(text: string): WebResult[] | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const j: unknown = JSON.parse(trimmed);
      const arr = Array.isArray(j)
        ? j
        : ((j as Record<string, unknown>).results ??
          (j as Record<string, unknown>).links ??
          (j as Record<string, unknown>).items ??
          (j as Record<string, unknown>).web_search_results);
      if (Array.isArray(arr)) {
        const out = arr
          .filter(
            (r): r is Record<string, unknown> => !!r && typeof r === "object",
          )
          .map((r) => {
            const url = String(r.url ?? r.link ?? r.href ?? "").trim();
            const title = String(r.title ?? r.name ?? url).trim();
            return { title, url };
          })
          .filter((r) => r.url.length > 0);
        if (out.length > 0) return out;
      }
    } catch {
      // Not JSON after all — fall through to the text shapes.
    }
  }
  const md = [...text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)].map(
    (m) => ({ title: m[1].trim(), url: m[2].trim() }),
  );
  if (md.length > 0) return md;

  const lines = text.split("\n").map((l) => l.trim());
  const out: WebResult[] = [];
  const isUrl = (s: string) => /^https?:\/\//.test(s);
  for (let i = 0; i < lines.length; i++) {
    const here = lines[i];
    const next = lines[i + 1] ?? "";
    if (here.length > 0 && !isUrl(here) && isUrl(next)) {
      out.push({ title: here, url: next });
      i++;
    }
  }
  return out.length > 0 ? out : null;
}

// --- small shared bits of the opened body ---------------------------------

/** A labelled single-line field: `query   IS621 recombinase …`. */
function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div className="tool-detail-field">
      <span className="tool-detail-key">{label}</span>
      <span className="tool-detail-value">{value}</span>
    </div>
  );
}

/** A monospace output block. */
function OutputText({ text, testid }: { text: string; testid?: string }) {
  return (
    <pre className="tool-output-pre" data-testid={testid}>
      {text}
    </pre>
  );
}

/**
 * The output pane, behind its own "Hide output"/"Show output" toggle — a
 * second level of disclosure (a step opens to reveal its input + this pane;
 * the pane can be collapsed on its own so a huge STDOUT doesn't bury the next
 * step). Open by default, because a researcher who opened
 * the step wants to see what it produced; the chevron is the same one the card
 * and the group header use, so the three read as one affordance.
 */
function OutputSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="tool-output">
      <button
        type="button"
        className="tool-output-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRightIcon
          className={`tool-step-chevron${open ? " tool-step-chevron--open" : ""}`}
          width={12}
          height={12}
        />
        {open ? "Hide output" : "Show output"}
      </button>
      {open && (
        <>
          <div className="tool-output-label">{label}</div>
          {children}
        </>
      )}
    </div>
  );
}

/** The web results list: a title over its muted URL. */
function WebResultsList({ results }: { results: WebResult[] }) {
  return (
    <ul className="tool-results" data-testid="tool-results">
      {results.map((r, i) => (
        <li key={i} className="tool-result">
          <span className="tool-result-title">{r.title || r.url}</span>
          <span className="tool-result-url">{r.url}</span>
        </li>
      ))}
    </ul>
  );
}

// --- what a step produced --------------------------------------------------

/**
 * The pieces of what a step produced, whatever shape the record holds them
 * in. A text result is one text piece; a live tail is one too, so nothing
 * below has to ask whether the turn is still in flight.
 */
export function outputPartsOf(
  entry: ExecutionLogEntry,
  stdout?: string,
): ToolOutputPart[] {
  const result = entry.result;
  if (Array.isArray(result)) return result;
  if (typeof result === "string")
    return result.length > 0 ? [{ type: "text", text: result }] : [];
  return stdout ? [{ type: "text", text: stdout }] : [];
}

/**
 * Which of the states a step is in when it is opened. They are told apart
 * because they are different facts, and rendering any of them as an empty
 * region — or as one of the others — says something the record does not.
 *
 * - `output` — the call produced pieces, and they are drawn.
 * - `no-output` — the call ran to completion and produced none.
 * - `never-ran` — the call was denied at a gate, or the turn was stopped
 *   while it waited at one. Read off the decision, not off the output: a
 *   refused call may carry the reason it was refused, and that reason is not
 *   the call's output.
 * - `not-captured` — the call ended, but no output was reported for it. It
 *   may have done a great deal; none of it was recorded.
 * - `running` — the call has not ended, so nothing about its output is
 *   settled yet.
 */
export type StepOutcome =
  | "output"
  | "no-output"
  | "never-ran"
  | "not-captured"
  | "running";

export function stepOutcome(
  entry: ExecutionLogEntry,
  stdout?: string,
): StepOutcome {
  if (entry.decision === "denied" || entry.decision === "cancelled")
    return "never-ran";
  if (outputPartsOf(entry, stdout).length > 0) return "output";
  if (entry.decision === "pending") return "running";
  return entry.result === undefined ? "not-captured" : "no-output";
}

/** The text a step produced, as one string — every text and terminal piece,
 *  concatenated in the order it arrived. This is what the views that draw
 *  file contents, STDOUT and search results read; the pieces that are not
 *  text are drawn as themselves, beside it. */
function textOf(parts: ToolOutputPart[]): string {
  return parts
    .map((part) =>
      part.type === "text" ? part.text : part.type === "terminal" ? part.output : "",
    )
    .join("");
}

function partsExcept(
  parts: ToolOutputPart[],
  drawn: ToolOutputPart["type"][],
): ToolOutputPart[] {
  return parts.filter((part) => !drawn.includes(part.type));
}

/** One piece that no view above claimed, drawn as what it is. A resource is
 *  named as a reference rather than passed off as the content it never
 *  carried, and a piece of a type nothing draws is named by that type. */
function OutputPart({ part }: { part: ToolOutputPart }) {
  switch (part.type) {
    case "diff":
      return (
        <>
          <DetailField label="path" value={part.path} />
          <CodeBlock
            code={unifiedDiff(part.oldText ?? "", part.newText)}
            lang="diff"
          />
        </>
      );
    case "resource":
      return (
        <div className="tool-detail-field" data-testid="tool-output-resource">
          <span className="tool-detail-key">resource</span>
          <span className="tool-detail-value">{part.name ?? part.uri}</span>
          <span className="tool-result-url">{part.uri}</span>
        </div>
      );
    case "other":
      return (
        <DetailField
          label="unrendered"
          value={`a ${part.blockType} the transcript cannot draw`}
        />
      );
    default:
      return null;
  }
}

/** Every piece a view did not draw itself, in arrival order. */
function OtherParts({ parts }: { parts: ToolOutputPart[] }) {
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((part, i) => (
        <OutputPart key={i} part={part} />
      ))}
    </>
  );
}

const NEVER_RAN_REASON: Record<string, string> = {
  denied: "This step never ran: it was denied at a permission gate.",
  cancelled:
    "This step never ran: the turn was stopped while it waited at a permission gate.",
};

/**
 * What a step opens onto when there is no output to draw. Each sentence
 * states a different fact, and the one that is false of this step is never
 * shown in place of the one that is true.
 */
function StepOutcomeNote({
  entry,
  outcome,
}: {
  entry: ExecutionLogEntry;
  outcome: StepOutcome;
}) {
  if (outcome === "output") return null;
  const reason =
    outcome === "never-ran" && typeof entry.result === "string" && entry.result
      ? entry.result
      : undefined;
  const text =
    outcome === "never-ran"
      ? (NEVER_RAN_REASON[entry.decision] ?? "This step never ran.")
      : outcome === "no-output"
        ? "This step ran and produced no output."
        : outcome === "running"
          ? "This step is still running."
          : "This step's output was not captured.";
  return (
    <div className="tool-detail-note" data-testid="tool-detail-note">
      <p className="tool-detail-note-text">{text}</p>
      {reason && <p className="tool-detail-note-reason">{reason}</p>}
    </div>
  );
}

// --- per-kind detail renderers ---------------------------------------------

/** `execute`: the command as a code block over its STDOUT. */
function ExecuteDetail({
  entry,
  parts,
}: {
  entry: ExecutionLogEntry;
  parts: ToolOutputPart[];
}) {
  const command = strInput(entry, "command");
  const output = textOf(parts);
  return (
    <>
      {command && <CodeBlock code={command} lang="bash" />}
      {output && (
        <OutputSection label="STDOUT">
          <OutputText text={output} testid="tool-output" />
        </OutputSection>
      )}
      <OtherParts parts={partsExcept(parts, ["text", "terminal"])} />
    </>
  );
}

/** `read`: the file contents, highlighted as the file's own language, with
 *  the `cat -n` numbering stripped so the highlighting lines up. */
function ReadDetail({
  entry,
  parts,
}: {
  entry: ExecutionLogEntry;
  parts: ToolOutputPart[];
}) {
  const path = strInput(entry, "file_path") ?? strInput(entry, "path");
  const output = textOf(parts);
  return (
    <>
      {output && (
        <CodeBlock
          code={stripReadLineNumbers(output)}
          lang={langForPath(path)}
        />
      )}
      <OtherParts parts={partsExcept(parts, ["text", "terminal"])} />
    </>
  );
}

/** `edit`: the diff the call produced, or the one its arguments describe, or
 *  the content it wrote on a create — whichever of the three the record
 *  actually carries. */
function EditDetail({
  entry,
  parts,
}: {
  entry: ExecutionLogEntry;
  parts: ToolOutputPart[];
}) {
  const diffs = parts.filter((part) => part.type === "diff");
  if (diffs.length > 0) {
    return (
      <>
        <OtherParts parts={partsExcept(parts, ["text", "terminal"])} />
        <ResultSection parts={parts} />
      </>
    );
  }
  const path = strInput(entry, "file_path") ?? strInput(entry, "path");
  const oldStr = strInput(entry, "old_string");
  const newStr = strInput(entry, "new_string");
  const content = strInput(entry, "content");
  if (oldStr !== undefined || newStr !== undefined) {
    return (
      <>
        <CodeBlock code={unifiedDiff(oldStr ?? "", newStr ?? "")} lang="diff" />
        <OtherParts parts={partsExcept(parts, ["text", "terminal"])} />
      </>
    );
  }
  if (content) {
    return (
      <>
        <CodeBlock code={content} lang={langForPath(path)} />
        <OtherParts parts={partsExcept(parts, ["text", "terminal"])} />
      </>
    );
  }
  return (
    <>
      <ResultSection parts={parts} />
      <OtherParts parts={partsExcept(parts, ["text", "terminal"])} />
    </>
  );
}

function ResultSection({ parts }: { parts: ToolOutputPart[] }) {
  const output = textOf(parts);
  if (!output) return null;
  return (
    <OutputSection label="RESULT">
      <OutputText text={output} testid="tool-output" />
    </OutputSection>
  );
}

/** `search` and `fetch`: a search carries a `query` and renders its results
 *  list; a fetch carries a `url` and renders what came back. */
function LookupDetail({
  entry,
  parts,
}: {
  entry: ExecutionLogEntry;
  parts: ToolOutputPart[];
}) {
  const query = strInput(entry, "query") ?? strInput(entry, "pattern");
  const url = strInput(entry, "url");
  const output = textOf(parts);
  const results = output ? parseWebResults(output) : null;
  return (
    <>
      {query ? (
        <DetailField label="query" value={query} />
      ) : (
        url && <DetailField label="url" value={url} />
      )}
      {results && results.length > 0 ? (
        <WebResultsList results={results} />
      ) : (
        output && (
          <OutputSection label={query ? "RESULTS" : "RESPONSE"}>
            <OutputText text={output} testid="tool-output" />
          </OutputSection>
        )
      )}
      <OtherParts parts={partsExcept(parts, ["text", "terminal"])} />
    </>
  );
}

/** Any kind without a view of its own — and any record whose `tool` predates
 *  the kind vocabulary: the raw input as JSON over the output. */
function GenericDetail({
  entry,
  parts,
}: {
  entry: ExecutionLogEntry;
  parts: ToolOutputPart[];
}) {
  const input = entry.input;
  const hasInput =
    !!input && typeof input === "object" && Object.keys(input).length > 0;
  const output = textOf(parts);
  return (
    <>
      {hasInput && (
        <CodeBlock code={JSON.stringify(input, null, 2)} lang="json" />
      )}
      {output && (
        <OutputSection label="OUTPUT">
          <OutputText text={output} testid="tool-output" />
        </OutputSection>
      )}
      <OtherParts parts={partsExcept(parts, ["text", "terminal"])} />
    </>
  );
}

/**
 * The opened detail for one step, dispatched by the call's KIND — the
 * adapter's own classification of what the call is, which is the same
 * vocabulary whichever adapter produced it. A value outside that vocabulary
 * is a record written before `tool` carried a kind, and draws the generic
 * view.
 *
 * The pieces of the output resolve once here — the persisted `result` when
 * the step has landed, otherwise the live `stdout` tail — so every view
 * treats "what the call produced" the same way whether the turn is live or
 * reopened.
 */
export function ToolStepDetail({
  entry,
  stdout,
}: {
  entry: ExecutionLogEntry;
  stdout?: string;
}) {
  const outcome = stepOutcome(entry, stdout);
  // A call that never ran produced nothing. Whatever its record carries is
  // the reason it was refused, which the note below states as the reason it
  // is rather than drawing it as output the call never produced.
  const parts = outcome === "never-ran" ? [] : outputPartsOf(entry, stdout);
  return (
    <>
      {detailBody(entry, parts)}
      <StepOutcomeNote entry={entry} outcome={outcome} />
    </>
  );
}

function detailBody(entry: ExecutionLogEntry, parts: ToolOutputPart[]) {
  switch (entry.tool) {
    case "execute":
      return <ExecuteDetail entry={entry} parts={parts} />;
    case "read":
      return <ReadDetail entry={entry} parts={parts} />;
    case "edit":
      return <EditDetail entry={entry} parts={parts} />;
    case "search":
    case "fetch":
      return <LookupDetail entry={entry} parts={parts} />;
    default:
      return <GenericDetail entry={entry} parts={parts} />;
  }
}
