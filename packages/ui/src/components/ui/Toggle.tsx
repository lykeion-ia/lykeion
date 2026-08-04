import { useState } from "react";
import { cn } from "../../lib/utils";

/**
 * Small on/off switch — Sky when on. Controlled when `onToggle` is given (the
 * caller owns `on` and persists the change); otherwise uncontrolled (flips its
 * own local state, for purely-visual uses like NewTaskModal).
 */
export function Toggle({
  on,
  onToggle,
  ariaLabel,
}: {
  on: boolean;
  onToggle?: (next: boolean) => void;
  ariaLabel?: string;
}) {
  const [internal, setInternal] = useState(on);
  const checked = onToggle ? on : internal;
  const handle = () => (onToggle ? onToggle(!on) : setInternal((c) => !c));

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={handle}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        checked ? "bg-accent" : "border border-line bg-surface-2",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all",
          checked ? "left-[18px]" : "left-0.5",
        )}
      />
    </button>
  );
}

export default Toggle;
