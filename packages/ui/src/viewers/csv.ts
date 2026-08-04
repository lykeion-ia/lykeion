/**
 * A tiny, dependency-free delimited-text parser for the TableChart viewer.
 * Handles the common cases: CRLF/LF line endings, a chosen delimiter (comma
 * or tab), and minimally-quoted fields — `"a,b"` keeps the delimiter, `""`
 * is a literal quote, and a quoted field may span newlines.
 */

/** Parse `text` into a grid of rows × cells for the given `delimiter`. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    started = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch === "\r") {
      // Swallow CR; a following LF ends the row (CRLF), a lone CR ends it too.
      if (text[i + 1] !== "\n") pushRow();
    } else {
      field += ch;
    }
  }
  // Flush a trailing field/row unless the input ended exactly on a newline.
  if (started && (field.length > 0 || row.length > 0)) pushRow();

  return rows;
}

/** Pick the delimiter for a content type (TSV → tab, else comma). */
export function delimiterFor(contentType: string): string {
  return contentType.includes("tab-separated") ? "\t" : ",";
}

/**
 * Indices of columns whose every non-empty data cell parses as a finite
 * number — the chartable columns. `dataRows` excludes the header.
 */
export function numericColumns(
  header: string[],
  dataRows: string[][],
): number[] {
  const out: number[] = [];
  for (let c = 0; c < header.length; c++) {
    let sawValue = false;
    let allNumeric = true;
    for (const r of dataRows) {
      const cell = (r[c] ?? "").trim();
      if (cell === "") continue;
      sawValue = true;
      if (!Number.isFinite(Number(cell))) {
        allNumeric = false;
        break;
      }
    }
    if (sawValue && allNumeric) out.push(c);
  }
  return out;
}
