import { useEffect, useState, type ReactNode } from "react";
import type { HighlighterCore } from "shiki/core";
import { CheckIcon, CopyIcon } from "../icons";

/**
 * The fine-grained shiki bundle: an explicit language set plus one dark
 * theme, not the default `shiki` package (megabytes of grammars for
 * languages this app never renders). Anything outside this set — an
 * unrecognised fence info-string, a typo, a language nobody asked for —
 * simply never reaches the highlighter and stays plain; see `supported`
 * below.
 *
 * Kept in sync BY HAND with the `import("shiki/langs/*.mjs")` list in
 * `loadHighlighter` below — one entry here with no matching import there
 * means that language is "supported" but never actually loaded (and shiki
 * throws on the missing grammar); one import there with no entry here means
 * that language is bundled but never reachable (`supported` gates it out
 * before `codeToHtml` runs). Add a language to BOTH lists, or neither.
 */
const SUPPORTED_LANGS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "rust",
  "python",
  // The notebook's second kernel language — a Study can run Python and R side
  // by side, and each cell renders under its own grammar.
  "r",
  "bash",
  "sql",
  "css",
  "html",
  "markdown",
  "diff",
] as const;

const SUPPORTED_LANG_SET: ReadonlySet<string> = new Set(SUPPORTED_LANGS);

const THEME = "github-dark";

/**
 * Created once, behind a module-level lazy promise, and only on first
 * demand: nothing here runs at module evaluation, so importing `CodeBlock`
 * never costs first paint. Every dynamic `import()` below is spelled out
 * individually (rather than templated over `SUPPORTED_LANGS`) so the
 * bundler can statically resolve each one.
 */
let highlighterPromise: Promise<HighlighterCore> | null = null;

function loadHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] =
        await Promise.all([
          import("shiki/core"),
          import("shiki/engine/javascript"),
        ]);
      return createHighlighterCore({
        themes: [import("shiki/themes/github-dark.mjs")],
        // Kept in sync BY HAND with `SUPPORTED_LANGS` above — see the
        // comment there. Each import is spelled out individually (see the
        // class comment on `highlighterPromise`), so adding a language here
        // means adding both a new `import(...)` line AND a new entry in
        // `SUPPORTED_LANGS`.
        langs: [
          import("shiki/langs/ts.mjs"),
          import("shiki/langs/tsx.mjs"),
          import("shiki/langs/js.mjs"),
          import("shiki/langs/jsx.mjs"),
          import("shiki/langs/json.mjs"),
          import("shiki/langs/rust.mjs"),
          import("shiki/langs/python.mjs"),
          import("shiki/langs/r.mjs"),
          import("shiki/langs/bash.mjs"),
          import("shiki/langs/sql.mjs"),
          import("shiki/langs/css.mjs"),
          import("shiki/langs/html.mjs"),
          import("shiki/langs/markdown.mjs"),
          import("shiki/langs/diff.mjs"),
        ],
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return highlighterPromise;
}

/** How long the copy button reads "Copied" before reverting. */
const COPIED_RESET_MS = 1500;

/**
 * One fenced code block from an agent's reply: a copy affordance that works
 * immediately, and syntax highlighting that upgrades in behind it once shiki
 * resolves — never the other way around.
 *
 * *Highlight only closed fences.* `live` is the in-flight tail of a turn
 * still arriving (`AssistantMessage`'s `live` prop, threaded down through
 * the `code` override in its `components` map): a fence in there may not be
 * closed yet, and `completeMarkdown` synthesises a closer for it just so it
 * *parses*, not because it's finished code. Re-tokenising that on every live
 * snapshot — the live channel ticks every 60 ms — is the perf failure this
 * whole design avoids, so a `live` block, and any block whose language isn't
 * in the bundle above, never calls shiki at all; it renders the plain `<pre>`
 * and stays there.
 */
export function CodeBlock({
  code,
  lang,
  live = false,
  lineNumbers = false,
  meta,
}: {
  code: string;
  lang?: string;
  live?: boolean;
  /**
   * A numbered gutter down the left of the code. Off by default: a fenced
   * block inside an answer is prose, and numbering it invites a reader to
   * cite a line of something nobody can run. A notebook cell is the other
   * case — it ran, its failures name line numbers, and the gutter is what
   * makes those names resolvable.
   */
  lineNumbers?: boolean;
  /**
   * What stands to the left of Copy in the block's own header, in place of
   * the bare language name. A caller with more to say about this block than
   * its grammar — which cell it is, who ran it — says it here rather than
   * in a second row above, so the language is named once on screen instead
   * of twice.
   */
  meta?: ReactNode;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const supported = lang !== undefined && SUPPORTED_LANG_SET.has(lang);

  useEffect(() => {
    if (live || !supported) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    loadHighlighter()
      .then((highlighter) => {
        if (cancelled) return;
        try {
          setHtml(highlighter.codeToHtml(code, { lang: lang!, theme: THEME }));
        } catch {
          // Belt-and-braces: `supported` already keeps every language shiki
          // wasn't given outside this path, but a grammar can still choke on
          // some input. Stay plain rather than let a highlighter error reach
          // the render.
          setHtml(null);
        }
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang, live, supported]);

  async function handleCopy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_RESET_MS);
  }

  return (
    <div className={`code-block${lineNumbers ? " code-block--numbered" : ""}`}>
      <div className="code-block-head">
        {meta ?? (lang && <span className="code-block-lang">{lang}</span>)}
        <button
          type="button"
          className="code-block-copy"
          onClick={() => void handleCopy()}
        >
          {copied ? (
            <>
              <CheckIcon width={12} height={12} />
              Copied
            </>
          ) : (
            <>
              <CopyIcon width={12} height={12} />
              Copy
            </>
          )}
        </button>
      </div>
      {html !== null ? (
        <div
          className="code-block-pre"
          data-testid="code-block-pre"
          // shiki's `codeToHtml` escapes the code it renders — this is
          // highlighter-generated markup, not agent-authored HTML, and is
          // unrelated to the no-`rehype-raw` rule in `AssistantMessage`.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="code-block-pre" data-testid="code-block-pre">
          {/* The numbered gutter is drawn by a CSS counter over per-line
              elements, and the highlighter emits exactly those. This is the
              unhighlighted path, so it emits them too — otherwise a cell in a
              grammar this build does not bundle, or one still waiting on the
              highlighter, would lose its numbering the moment it needed it
              most, which is when something has gone wrong with it. */}
          {lineNumbers ? (
            <code>
              {code.replace(/\n$/, "").split("\n").map((line, i) => (
                <span className="line" key={i}>
                  {line}
                  {"\n"}
                </span>
              ))}
            </code>
          ) : (
            <code>{code}</code>
          )}
        </pre>
      )}
    </div>
  );
}
