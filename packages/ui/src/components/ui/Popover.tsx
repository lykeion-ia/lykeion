import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";

export interface PopoverRenderState {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

export interface PopoverProps {
  /** Menu edge alignment (default "start" = left-0). */
  align?: "start" | "end";
  /** Extra classes on the relative root (e.g. "shrink-0"). */
  className?: string;
  /** Classes on the floating panel (width, padding). */
  panelClassName?: string;
  /** The anchor; owns its own markup via render prop. */
  trigger: (state: PopoverRenderState) => ReactNode;
  /** Popover body; `close` dismisses after a selection. */
  children: (state: { close: () => void }) => ReactNode;
}

/**
 * Anchored popover for arbitrary content (a calendar, a picker). Shares
 * `ActionMenu`'s mechanics — mousedown-outside + Escape close — but lets the
 * caller render any body instead of a fixed item list.
 */
export function Popover({
  align = "start",
  className,
  panelClassName,
  trigger,
  children,
}: PopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => setOpen((o) => !o);
  const close = () => setOpen(false);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {trigger({ open, toggle, close })}

      {open && (
        <div
          className={cn(
            "absolute top-full z-30 mt-1.5 overflow-hidden rounded-lg border border-line bg-surface shadow-xl",
            align === "end" ? "right-0" : "left-0",
            panelClassName,
          )}
        >
          {children({ close })}
        </div>
      )}
    </div>
  );
}

export default Popover;
