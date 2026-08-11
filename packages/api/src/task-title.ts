/**
 * How a Task gets its name.
 *
 * A Task is a chat, and a chat is named after the message that started it.
 * There are two ways to do that and this module holds both: the cut of the
 * message itself, which is instant and always available, and the tidy-up of a
 * summarizer's answer, which is better but arrives a second or two later and
 * may not arrive at all.
 *
 * They live together, in the contract package rather than in the lab, because
 * the two are only useful against each other. The surface that sends a message
 * names the Task with `titleFromPrompt`; the lab replaces that name with a
 * summary only while it is still character-for-character what `titleFromPrompt`
 * would produce, which is how an authored name survives a summary landing on
 * top of it. A second copy of the cut, in the lab or in a screen, would put
 * that comparison one refactor away from silently never matching — and a
 * naming that silently never applies looks exactly like a summarizer that is
 * never asked.
 *
 * Every function here is pure. Nothing in this file knows what a model is.
 */

/** How much of an opening message a Task is named after. Eighty characters is
 *  a wide tab and a full row of a Task list — past it a name stops being read
 *  and starts being scanned over. */
export const PROMPT_TITLE_MAX = 80;

/** At or under this, a single-line message IS its own title: "Fix the axis
 *  labels" cannot be improved by summarizing it, and spending an agent's cold
 *  start to try would be slower and worse than doing nothing. */
export const SHORT_PROMPT_MAX = 48;

/** Longest title a summary may become. Shorter than {@link PROMPT_TITLE_MAX}
 *  on purpose: the whole point of asking for a summary is to get something a
 *  reader takes in at a glance, so a summary that needs the full width of a
 *  cut prompt has not earned its place. */
export const SUMMARY_TITLE_MAX = 60;

/** Past this, an answer is prose, not a name. A summarizer that writes a
 *  paragraph has not followed the instruction, and cutting its first sixty
 *  characters out of the middle of a sentence produces something worse than
 *  the prompt it would replace — so nothing is what it produces instead. */
const SUMMARY_REJECT_OVER = 2 * SUMMARY_TITLE_MAX;

/** Pairs a model wraps a title in when it is being helpful. Straight and
 *  curly, plus the backtick a code-shaped answer arrives in. */
const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
  ["«", "»"],
  ["**", "**"],
  ["*", "*"],
];

/** A label an answer prefixes itself with when it has read the instruction as
 *  a form to fill in. The emphasis is matched on both sides of the colon
 *  because a model puts it on either: `**Title:**` and `**Title**:` are the
 *  same gesture and arrive about as often as each other. */
const LABEL = /^\**\s*(?:title|name)\s*\**\s*[:–-]\s*\**\s*/i;

/** Punctuation a title does not end on. `?` and `!` are kept: they are part of
 *  the name a researcher would have typed themselves. */
const TRAILING = /[.,;:…]+$/;

/**
 * The name a Task takes the moment it is created — the opening message,
 * trimmed and cut to {@link PROMPT_TITLE_MAX}.
 *
 * Trimmed on both sides of the cut, and both matter. Before, or a message that
 * begins with a newline spends its eighty characters on whitespace. After,
 * because a cut that happens to land on a space would otherwise produce a name
 * ending in one — and a store that trims what it is given (every one here
 * does) would hold a title one character off from what this function returns,
 * so the comparison the lab makes before replacing a derived name with a
 * summary would never match again for exactly those prompts.
 */
export function titleFromPrompt(prompt: string): string {
  return prompt.trim().slice(0, PROMPT_TITLE_MAX).trim();
}

/**
 * Whether this message is worth asking a summarizer about.
 *
 * No for a short single-line message, which already reads as a title, and no
 * for an empty one, which has nothing in it to summarize. A line break is
 * enough to say yes however short the message is: a title never contains one,
 * and a cut that lands mid-break renders as two lines in a strip built for
 * one.
 */
export function promptNeedsSummary(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.includes("\n")) return true;
  return trimmed.length > SHORT_PROMPT_MAX;
}

/** Strip one layer of wrapping at a time, for as long as the whole string is
 *  wrapped. `**"Title"**` is two layers and arrives often enough to matter. */
function unwrap(text: string): string {
  let current = text;
  for (let peeled = true; peeled; ) {
    peeled = false;
    for (const [open, close] of WRAPPERS) {
      // `>=`, not `>`: an empty pair is exactly as much a wrapper as a full
      // one, and `""` left whole reads as a title made of two quote marks.
      // The comparison still keeps a lone `"` — which both starts and ends
      // with itself — from being unwrapped into nothing it never contained.
      if (
        current.length >= open.length + close.length &&
        current.startsWith(open) &&
        current.endsWith(close)
      ) {
        current = current.slice(open.length, current.length - close.length).trim();
        peeled = true;
        break;
      }
    }
  }
  return current;
}

/**
 * A summarizer's answer, made fit to be a title — or `null` where there is no
 * title in it and the Task should keep the name it has.
 *
 * Everything here is defence against an answer that did not do as it was
 * asked, because the alternative to defending is writing a model's throat-
 * clearing into a researcher's task list. The order matters: the first line is
 * taken before anything else so that a two-paragraph answer whose first line
 * IS the title still works, and the length check happens after the tidy-up so
 * that a well-formed title wrapped in a label and quotes is not rejected for
 * the characters that are about to be removed.
 */
export function cleanSummaryTitle(raw: string): string | null {
  const firstLine = raw.split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  if (firstLine === undefined) return null;

  const title = unwrap(unwrap(firstLine).replace(LABEL, "").trim())
    .replace(/\s+/g, " ")
    .replace(TRAILING, "")
    .trim();

  if (title.length === 0) return null;
  if (title.length > SUMMARY_REJECT_OVER) return null;
  if (title.length <= SUMMARY_TITLE_MAX) return title;

  // Over the cap but not prose: cut at the last word boundary that fits, so
  // the name ends on a word a reader recognizes rather than mid-syllable.
  // No ellipsis — this is a name, and a name that advertises being cut short
  // is the truncation this whole feature exists to stop showing.
  const cut = title.slice(0, SUMMARY_TITLE_MAX + 1);
  const boundary = cut.lastIndexOf(" ");
  const shortened = (boundary === -1 ? cut.slice(0, SUMMARY_TITLE_MAX) : cut.slice(0, boundary))
    .replace(TRAILING, "")
    .trim();
  return shortened.length === 0 ? null : shortened;
}
