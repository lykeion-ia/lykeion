import { useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { completeMarkdown } from "../../lib/markdown";
import { openExternal } from "../../lib/open-external";
import { CodeBlock } from "./CodeBlock";

/**
 * A link inside an agent's reply never navigates the app away — the click is
 * intercepted and handed to `openExternal`, which opens it in a new tab
 * instead.
 */
const MarkdownLink: Components["a"] = ({ href, children }) => (
  <a
    href={href}
    onClick={(event) => {
      event.preventDefault();
      if (href) openExternal(href);
    }}
  >
    {children}
  </a>
);

/**
 * A wide GFM table scrolls inside its own box rather than widening the whole
 * conversation column (`task.css`'s `.msg-table-wrap`), so one long row never
 * pushes the composer or the sidebar off-screen.
 */
const MarkdownTable: Components["table"] = ({ children }) => (
  <div className="msg-table-wrap">
    <table>{children}</table>
  </div>
);

/**
 * `remark-rehype` always wraps a fence — tagged *or bare* — as `<pre><code
 * class="language-x">` (a bare fence's `code` gets no class at all), and
 * never wraps inline code in a `pre`. That structural fact, not the `code`
 * element's `className`, is the reliable "this is a fenced block" signal:
 * a className check (the old approach, keyed on the `code` override) can't
 * tell a bare fence's classless `code` from genuine inline code, since both
 * carry no `language-*` class. `pre`'s presence can, unconditionally, so the
 * block-vs-inline decision — and the `CodeBlock` render — belongs here, not
 * on `code` (below, which now only ever sees inline code).
 *
 * react-markdown passes the hast `node` as an extra prop on every element
 * (`passNode: true`, unconditionally, in its own source) — the raw AST
 * `remark-rehype` built, still carrying the `language-*` class (or its
 * absence) regardless of how `code`'s React children end up rendered.
 * Reading language and source text off `node` directly — the fenced
 * block's `code` is always its one child — sidesteps needing to introspect
 * React children at all.
 */
function markdownPre(live: boolean): NonNullable<Components["pre"]> {
  return ({ node }) => {
    const codeNode = node?.children[0];
    const codeElement = codeNode?.type === "element" ? codeNode : undefined;
    const classNames = codeElement?.properties.className;
    const lang = Array.isArray(classNames)
      ? classNames
          .map((name) => /^language-(\S+)$/.exec(String(name))?.[1])
          .find((name): name is string => name !== undefined)
      : undefined;
    // Fenced content from remark carries a trailing newline that isn't part
    // of the code itself.
    const code = (codeElement?.children ?? [])
      .filter(
        (child): child is Extract<typeof child, { type: "text" }> =>
          child.type === "text",
      )
      .map((child) => child.value)
      .join("")
      .replace(/\n$/, "");
    return <CodeBlock code={code} lang={lang} live={live} />;
  };
}

const REMARK_PLUGINS = [remarkGfm];

/**
 * Every fenced block, tagged or bare, is now handled unconditionally by the
 * `pre` override above — so by the time `code` runs, it only ever sees
 * inline code (a fence's `code` is always inside a `pre`, which never
 * delegates back down to this). Rendered as a plain `<code>`, already
 * styled by `task.css`'s `.msg--assistant :where(code)` rule.
 */
const MarkdownCode: Components["code"] = ({ className, children }) => (
  <code className={className}>{children}</code>
);

/**
 * One agent reply, rendered as markdown. The single component every
 * assistant-message bubble in the app renders through — the whole-message
 * sites in `TaskScreen` and `SubagentThread`, plus the in-flight live tail —
 * so the hand-rolled
 * `<div className="msg msg--assistant">{text}</div>` that used to appear at
 * each of them (and the long comment on `task.css` explaining why they had to
 * stay identical) collapses into one render path instead.
 *
 * Two rules here are easy to "improve" wrongly, so they are spelled out:
 *
 * 1. No `rehype-raw`, ever. `react-markdown` renders no raw HTML by default,
 *    and its default `urlTransform` strips `javascript:` URLs. Agent output
 *    is not trusted input. Both defaults stay.
 * 2. `live` ⇒ `completeMarkdown` first; a recorded turn is already whole and
 *    is rendered as-is.
 *
 * It renders ONE block of a reply and carries no controls of its own. A turn's
 * `messages` are the paragraphs of a single answer, so Copy belongs to the
 * whole reply — see `AssistantReply` in TaskTranscript.tsx. Putting it here
 * would give a two-paragraph answer two Copy buttons and imply it was two
 * things the agent said.
 */
export function AssistantMessage({
  text,
  live = false,
}: {
  text: string;
  live?: boolean;
}) {
  const content = live ? completeMarkdown(text) : text;
  // `react-markdown` reprocesses whenever `components` changes identity, and
  // a literal in every render would change identity every render — but the
  // `pre` override needs `live` (a `CodeBlock` must never highlight while
  // its fence is still arriving), which a module-level constant can't see.
  // Memoizing on `[live]` is the middle ground: a stable reference across
  // the many re-renders WITHIN one turn (`live` never changes mid-turn),
  // recomputed only on the one transition that matters (live -> recorded).
  const components = useMemo<Components>(
    () => ({
      a: MarkdownLink,
      table: MarkdownTable,
      pre: markdownPre(live),
      code: MarkdownCode,
    }),
    [live],
  );
  return (
    <div className="msg msg--assistant">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
