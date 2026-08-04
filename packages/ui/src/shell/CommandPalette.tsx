import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useRouter } from "../router";
import { filterCommands, type Command } from "./commands";
import "./palette.css";

interface CommandPaletteProps {
  commands: Command[];
  onClose: () => void;
}

/**
 * Global command palette (Cmd/Ctrl-K). A modal combobox over a scrim:
 * type to filter, arrows to move, Enter to run, Escape to close.
 * Focus is trapped on the input and restored on close.
 */
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
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
    navigate(command.route);
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
              <span className="palette-label">{command.label}</span>
              <span className="palette-hint">{command.hint}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
