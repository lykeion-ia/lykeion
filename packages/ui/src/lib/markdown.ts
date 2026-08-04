/**
 * Close the constructs a mid-stream chunk can leave dangling, so a partial
 * token renders as the thing it is *becoming* rather than as broken syntax or,
 * worse, a construct that swallows the rest of the message.
 *
 * Applied ONLY to the live channel. A recorded turn is already whole, and
 * running this over it would be a chance to corrupt text that is already
 * correct.
 *
 * This is a string transform with no parser, and it is a display nicety — NOT
 * a security boundary. Sanitisation is `react-markdown`'s default behaviour
 * (no raw HTML, `javascript:` URLs stripped), which `AssistantMessage` keeps.
 *
 * The common case — nothing dangling — returns the input unchanged, by
 * reference. The live channel ticks every 60 ms, so this runs ~16 times a
 * second per in-flight turn and must not allocate when there is nothing to do.
 */
export function completeMarkdown(text: string): string {
  if (!text) return text;

  // ── Fenced code first. Inside a fence nothing else is markup: a `**` there
  // is C, not emphasis, and the only thing that can dangle is the fence.
  const fence = openFence(text);
  if (fence !== null) {
    return text + (text.endsWith("\n") ? "" : "\n") + fence;
  }

  // Everything before the last CLOSED fence is settled markdown; only the tail
  // after it can still be mid-token. Scoping to the tail also keeps markers
  // that live inside earlier code blocks out of the counts.
  const split = closedFenceEnd(text);
  const head = text.slice(0, split);
  const tail = text.slice(split);

  const completed = completeInline(tail);
  return completed === tail ? text : head + completed;
}

/**
 * The closing fence a still-open block needs (e.g. "```"), or `null` when the
 * text does not end inside one. A closer must match its opener's character and
 * be at least as long, per CommonMark.
 */
function openFence(text: string): string | null {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    const marker = m[1];
    if (open === null) {
      open = marker;
    } else if (
      marker[0] === open[0] &&
      marker.length >= open.length &&
      // A closing fence carries no info string.
      /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)
    ) {
      open = null;
    }
  }
  return open === null ? null : open;
}

/** Index just past the last CLOSED fence, or 0 when there is none. */
function closedFenceEnd(text: string): number {
  const lines = text.split("\n");
  let open: string | null = null;
  let end = 0;
  let offset = 0;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      const marker = m[1];
      if (open === null) {
        open = marker;
      } else if (marker[0] === open[0] && marker.length >= open.length) {
        open = null;
        end = offset + line.length + 1; // +1 for the newline
      }
    }
    offset += line.length + 1;
  }
  return Math.min(end, text.length);
}

/**
 * Close (or drop) the inline constructs dangling at the end of one prose run.
 *
 * Works against a MASK of the input in which inline-code spans are blanked out
 * but kept the same length — so indices still line up with the original, and a
 * `*` or `[` inside `` `a * b` `` is never mistaken for markup.
 */
function completeInline(text: string): string {
  let masked = maskCodeSpans(text);

  // A link whose target is still arriving renders as visible garbage
  // ("[the docs](http"), so drop the fragment rather than close it — there is
  // nothing to close it WITH until the URL finishes.
  const cut = incompleteLinkAt(masked);
  if (cut >= 0) {
    text = text.slice(0, cut);
    if (!text) return text;
    masked = maskCodeSpans(text);
  }

  let out = text;
  // Innermost first: a run closes in reverse of the order it opened.
  if (isOdd(markerRuns(masked, "*", 2))) out += "**";
  if (isOdd(markerRuns(masked, "*", 1))) out += "*";
  if (isOdd(markerRuns(masked, "_", 2))) out += "__";
  if (isOdd(markerRuns(masked, "_", 1))) out += "_";

  const ticks = openCodeSpan(text);
  if (ticks > 0) out += "`".repeat(ticks);

  return out;
}

const isOdd = (n: number) => n % 2 === 1;

/**
 * Blank out every inline-code span, preserving length. An unclosed span blanks
 * to the end of the text — everything after an opening backtick is code until
 * proven otherwise.
 */
function maskCodeSpans(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      out += text[i];
      i += 1;
      continue;
    }
    const run = runLength(text, i, "`");
    const close = findRun(text, i + run, "`", run);
    if (close < 0) {
      // Unclosed — the rest is code. `openCodeSpan` reports what to append.
      return out + " ".repeat(text.length - i);
    }
    out += " ".repeat(close + run - i);
    i = close + run;
  }
  return out;
}

/** The length of an unclosed inline-code span's opening run, or 0. */
function openCodeSpan(text: string): number {
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    const run = runLength(text, i, "`");
    const close = findRun(text, i + run, "`", run);
    if (close < 0) return run;
    i = close + run;
  }
  return 0;
}

/**
 * How many times `marker` opens or closes a run of exactly `width` in `masked`.
 * An odd count means one is still open.
 *
 * Two shapes are skipped because they are not emphasis at all, and closing them
 * would corrupt correct text:
 * - an intraword `_` (`tool_use_id` is an identifier, not three toggles);
 * - a lone `*` that is a bullet marker or a bare multiplication sign, both of
 *   which are surrounded by whitespace where an emphasis opener never is.
 */
function markerRuns(masked: string, marker: "*" | "_", width: 1 | 2): number {
  let count = 0;
  let i = 0;
  while (i < masked.length) {
    if (masked[i] !== marker) {
      i += 1;
      continue;
    }
    const run = runLength(masked, i, marker);
    const before = masked[i - 1] ?? "";
    const after = masked[i + run] ?? "";
    const skip =
      (marker === "_" && isWord(before) && isWord(after)) ||
      (marker === "*" && run === 1 && isSpace(before) && isSpace(after));
    if (!skip) {
      count += width === 2 ? Math.floor(run / 2) : run % 2;
    }
    i += run;
  }
  return count;
}

/**
 * The index of a `[` that begins a link still being typed, or -1.
 *
 * Only the LAST `[` can be mid-token in a stream. A `]` not followed by `(` is
 * left alone: that is a GFM task-list checkbox (`- [ ] step`) or a literal
 * bracket, and truncating there would eat every checklist an agent emits.
 */
function incompleteLinkAt(masked: string): number {
  const open = masked.lastIndexOf("[");
  if (open < 0) return -1;
  const rest = masked.slice(open);
  const close = rest.indexOf("]");
  if (close < 0) return open; // no label end yet
  if (rest[close + 1] !== "(") return -1; // not a link
  return rest.indexOf(")", close) < 0 ? open : -1;
}

function runLength(text: string, from: number, ch: string): number {
  let n = 0;
  while (text[from + n] === ch) n += 1;
  return n;
}

/** The index of the next run of EXACTLY `width` `ch`s at or after `from`. */
function findRun(
  text: string,
  from: number,
  ch: string,
  width: number,
): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] !== ch) continue;
    const run = runLength(text, i, ch);
    if (run === width) return i;
    i += run - 1;
  }
  return -1;
}

const isWord = (ch: string) => /[A-Za-z0-9]/.test(ch);
const isSpace = (ch: string) => ch === "" || /\s/.test(ch);
