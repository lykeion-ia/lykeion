import { useEffect, useRef, useState } from "react";

/**
 * The in-place rename editor — a row's title swapped for an input. Enter or
 * blur commits, Escape cancels, and a blank title cancels rather than blanking
 * the row (the core rejects a blank rename too).
 *
 * Shared by the sidebar's task rows and the Researches table: the blur/Escape
 * race below is subtle enough that a second copy would drift out of step.
 */
export function InlineRename({
  title,
  label,
  className,
  onCommit,
  onCancel,
}: {
  /** The current title — seeds the input and is selected on mount. */
  title: string;
  /** Accessible name for the input, e.g. `Rename Photoreceptors`. */
  label: string;
  className?: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  // Escape must not also reach the blur handler and commit — the keydown sets
  // this first, and blur checks it.
  const cancelled = useRef(false);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const commit = () => {
    const next = value.trim();
    if (!next) onCancel();
    else onCommit(next);
  };

  return (
    <input
      ref={inputRef}
      className={className}
      aria-label={label}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (!cancelled.current) commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelled.current = true;
          onCancel();
        }
      }}
    />
  );
}

export default InlineRename;
