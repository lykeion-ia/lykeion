import { useState } from "react";
import type { ExecutionLogEntry } from "@lykeion/api";
import { ChevronRightIcon } from "../icons";
import { CodeBlock } from "./CodeBlock";

/**
 * The opened body of a tool-step card: the per-tool detail a researcher reveals
 * by clicking the row (see `ToolStepCard`). One small renderer per tool, chosen
 * by `entry.tool` — a Bash command over its STDOUT, an Edit's diff, a web
 * search's query over its results — with a generic input/output view for
 * anything unrecognised.
 *
 * Everything here reads off the SAME persisted `ExecutionLogEntry` the row
 * already has: `input` (the agent's tool arguments, preserved verbatim across
 * the ACP bridge — the command, an Edit's `old_string`/`new_string`, a
 * search's `query`) and `result` (the tool's real output text, captured from
 * the completion's content). So a reopened transcript renders the full detail
 * with no extra data threaded in; `stdout` is only the live tail of a step
 * whose tool is still running, used when there is no persisted result yet.
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

// --- per-tool detail renderers --------------------------------------------

/** Bash: the command as a code block over its STDOUT. */
function BashDetail({
  entry,
  output,
}: {
  entry: ExecutionLogEntry;
  output?: string;
}) {
  const command = strInput(entry, "command");
  return (
    <>
      {command && <CodeBlock code={command} lang="bash" />}
      {output && (
        <OutputSection label="STDOUT">
          <OutputText text={output} testid="tool-output" />
        </OutputSection>
      )}
    </>
  );
}

/** Read: the file contents, highlighted as the file's own language, with the
 *  `cat -n` numbering stripped so the highlighting lines up. */
function ReadDetail({
  entry,
  output,
}: {
  entry: ExecutionLogEntry;
  output?: string;
}) {
  const path = strInput(entry, "file_path");
  if (!output) return null;
  return (
    <CodeBlock code={stripReadLineNumbers(output)} lang={langForPath(path)} />
  );
}

/** Write / Edit (edits map to `Write` via the ACP bridge): a diff when the call
 *  carried `old_string`/`new_string`, the written content on a create, else the
 *  confirmation result. */
function WriteDetail({
  entry,
  output,
}: {
  entry: ExecutionLogEntry;
  output?: string;
}) {
  const path = strInput(entry, "file_path");
  const oldStr = strInput(entry, "old_string");
  const newStr = strInput(entry, "new_string");
  const content = strInput(entry, "content");
  if (oldStr !== undefined || newStr !== undefined) {
    return (
      <CodeBlock code={unifiedDiff(oldStr ?? "", newStr ?? "")} lang="diff" />
    );
  }
  if (content) {
    return <CodeBlock code={content} lang={langForPath(path)} />;
  }
  return output ? (
    <OutputSection label="RESULT">
      <OutputText text={output} testid="tool-output" />
    </OutputSection>
  ) : null;
}

/** WebFetch — and web SEARCH, which the ACP bridge maps here too. A search
 *  carries a `query` and renders its results list; a fetch carries a `url` and
 *  renders the fetched text. */
function WebFetchDetail({
  entry,
  output,
}: {
  entry: ExecutionLogEntry;
  output?: string;
}) {
  const query = strInput(entry, "query");
  const url = strInput(entry, "url");
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
    </>
  );
}

/** Grep/search: the pattern over its matches. */
function GrepDetail({
  entry,
  output,
}: {
  entry: ExecutionLogEntry;
  output?: string;
}) {
  const pattern = strInput(entry, "pattern") ?? strInput(entry, "query");
  return (
    <>
      {pattern && <DetailField label="pattern" value={pattern} />}
      {output && (
        <OutputSection label="MATCHES">
          <OutputText text={output} testid="tool-output" />
        </OutputSection>
      )}
    </>
  );
}

/** Anything without a bespoke view: the raw input as JSON over the output. */
function GenericDetail({
  entry,
  output,
}: {
  entry: ExecutionLogEntry;
  output?: string;
}) {
  const input = entry.input;
  const hasInput =
    !!input && typeof input === "object" && Object.keys(input).length > 0;
  if (!hasInput && !output) return null;
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
    </>
  );
}

/**
 * The opened detail for one step, dispatched by tool name. `output` resolves
 * once here — the persisted `result` when the step has landed, otherwise the
 * live `stdout` tail — so every renderer treats "the tool's output" the same
 * way whether the turn is live or reopened.
 */
export function ToolStepDetail({
  entry,
  stdout,
}: {
  entry: ExecutionLogEntry;
  stdout?: string;
}) {
  const output =
    entry.result && entry.result.length > 0 ? entry.result : stdout;
  switch (entry.tool) {
    case "Bash":
      return <BashDetail entry={entry} output={output} />;
    case "Read":
      return <ReadDetail entry={entry} output={output} />;
    case "Write":
      return <WriteDetail entry={entry} output={output} />;
    case "WebFetch":
      return <WebFetchDetail entry={entry} output={output} />;
    case "Grep":
      return <GrepDetail entry={entry} output={output} />;
    default:
      return <GenericDetail entry={entry} output={output} />;
  }
}
