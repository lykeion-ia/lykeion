import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { ChatIcon, FlaskIcon } from "../components/icons";
import { cliIcon } from "../lib/cli-icons";
import { openTab } from "../lib/tabs";
import { useRouter } from "../router";
import { filterCommands, type Command, type Preview } from "./commands";
import "./palette.css";

/**
 * The right-hand pane: what the highlighted row would take you to.
 *
 * `aria-hidden` on purpose. Everything here restates the option the listbox has
 * already announced, and a live region would read the whole panel out again on
 * every arrow press.
 */
function PalettePreview({ preview }: { preview: Preview }) {
  return (
    <div
      className="palette-preview"
      data-testid="palette-preview"
      aria-hidden="true"
    >
      <div className="palette-preview-title">{preview.title}</div>
      {preview.subtitle !== undefined && (
        <div className="palette-preview-subtitle">{preview.subtitle}</div>
      )}
      {preview.rows.map((row) => (
        <div className="palette-preview-row" key={row.label}>
          <span>{row.label}</span>
          <span>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The mark at the right of a row: what kind of thing this is, and — for a Task —
 * what has been working on it.
 *
 * A Task that has run carries the brand of the CLI it ran on, read off its newest
 * turn; a Task nobody has run carries a chat mark, because that is what it is so
 * far — a conversation a person started. The difference is the most useful thing
 * about a row that is otherwise just a title, and it replaced a text strip that
 * only ever said "Task".
 *
 * A Research takes the Research mark. Its key used to sit here, and still does in the
 * preview beside the list, which is where a reader looks once the row is theirs.
 *
 * The glyph is `aria-hidden` with the same fact in text beside it, so the option's
 * announced name says what the picture shows.
 */
function CommandMark({ command }: { command: Command }) {
  if (command.kind === "research")
    return (
      <span className="palette-mark">
        <FlaskIcon width={13} height={13} aria-hidden="true" />
        <span className="sr-only">Research</span>
      </span>
    );
  const Brand = command.agent ? cliIcon(command.agent) : null;
  const Glyph = Brand ?? ChatIcon;
  return (
    <span className="palette-mark">
      <Glyph width={13} height={13} aria-hidden="true" />
      <span className="sr-only">
        {command.agent ? `Task, run on ${command.agent}` : "Task, not yet run"}
      </span>
    </span>
  );
}

/**
 * Light the part of a label the query matched.
 *
 * `indexOf`, not the ranker. `score()` also scores subsequence matches, which
 * have no contiguous run to point at — teaching it to return ranges so a
 * decoration could use them would complicate the one function that decides what
 * the palette FINDS, in service of the one thing that does not matter if it is
 * missing.
 */
function Label({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  const at = q === "" ? -1 : text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="palette-hit">{text.slice(at, at + q.length)}</span>
      {text.slice(at + q.length)}
    </>
  );
}

interface CommandPaletteProps {
  commands: Command[];
  /** Open what is chosen beside the current tab rather than in it — what the
   *  strip's `+` asks for. Search and ⌘K leave this off: they take you
   *  somewhere, they do not ask for somewhere else to be open. */
  inNewTab?: boolean;
  onClose: () => void;
}

/**
 * Global command palette (Cmd/Ctrl-K). A modal combobox over a scrim:
 * type to filter, arrows to move, Enter to run, Escape to close.
 * Focus is trapped on the input and restored on close.
 */
export function CommandPalette({
  commands,
  inNewTab = false,
  onClose,
}: CommandPaletteProps) {
  const { navigate } = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const results = useMemo(
    () => filterCommands(commands, query),
    [commands, query],
  );

  useEffect(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    inputRef.current?.focus();
    const restore = restoreRef.current;
    return () => restore?.focus();
  }, []);

  useEffect(() => setActive(0), [query]);

  const run = (command: Command | undefined) => {
    if (!command) return;
    if (inNewTab) openTab(command.route);
    else navigate(command.route);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(results.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(results[active] ?? results[0]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      // Focus trap: the input is the palette's only tab stop.
      e.preventDefault();
    }
  };

  const onScrimMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const activeCommand = results[active];

  return (
    <div className="palette-scrim" onMouseDown={onScrimMouseDown}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-listbox"
          aria-activedescendant={
            activeCommand ? `palette-opt-${activeCommand.id}` : undefined
          }
          aria-autocomplete="list"
          placeholder="Type a command or search…"
          spellCheck={false}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="palette-split">
          <ul
            id="palette-listbox"
            className="palette-list"
            role="listbox"
            aria-label="Commands"
          >
            {results.length === 0 && (
              <li className="palette-empty" role="presentation">
                No matching commands
              </li>
            )}
            {results.map((command, i) => (
              <li
                key={command.id}
                id={`palette-opt-${command.id}`}
                className="palette-option"
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(command)}
              >
                <span className="palette-label">
                  <Label text={command.label} query={query} />
                </span>
                <CommandMark command={command} />
              </li>
            ))}
          </ul>
          {activeCommand && <PalettePreview preview={activeCommand.preview} />}
        </div>
      </div>
    </div>
  );
}
