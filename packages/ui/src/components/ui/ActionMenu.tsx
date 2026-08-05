import { useEffect, useRef, useState } from "react";
import type { ComponentType, ReactNode, SVGProps } from "react";
import { ArrowUpRightIcon, ChevronRightIcon } from "../icons";
import { cn } from "../../lib/utils";

export interface ActionMenuItem {
  id: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  detail?: string; // optional second line
  external?: boolean; // trailing ↗
  separatorBefore?: boolean; // divider above this item
  danger?: boolean; // irreversible — reads red, never like the rest
  onSelect?: () => void; // omitted = inert
  /**
   * A second level, opened from this row rather than fired by it. Hover opens
   * it for a pointer; click, Enter and ArrowRight open it for a keyboard —
   * a flyout that only answers to hover is one the keyboard cannot reach.
   */
  submenu?: ActionMenuItem[];
}

export interface ActionMenuProps {
  items: ActionMenuItem[];
  align?: "start" | "end"; // menu edge alignment (default "start" = left-0)
  width?: string; // tailwind width class (default "w-64")
  className?: string; // extra classes on the relative root (e.g. "shrink-0")
  children: (state: { open: boolean; toggle: () => void }) => ReactNode;
}

// Same popover chrome as the composer's settings popover
// (`.composer-popover`): 10px radius, strong hairline, 4px padding, one deep
// shadow — so every anchored menu in the app reads as the same object.
//
// Deliberately not `overflow-hidden`: a submenu flies out past this box's
// edge, and clipping to the rounded corners would cut it off. The rows carry
// their own `rounded-md` inside the 4px padding, so nothing needs the clip.
const PANEL =
  "z-30 rounded-[10px] border border-line-strong bg-surface p-1 shadow-[0_18px_48px_rgba(0,0,0,0.6)]";

// 28px row, 6px radius, 8px/6px padding — the composer popover's row metrics.
// `min-h` rather than a fixed height, so a two-line item (label + detail)
// still grows.
const ROW =
  "flex min-h-[28px] w-full items-center gap-2 rounded-md py-1 pl-2 pr-1.5 text-left hover:bg-surface-2";

/** Everything inside a menu row: icon, label, optional detail and trailing mark. */
function ItemBody({
  item,
  trailing,
}: {
  item: ActionMenuItem;
  trailing?: ReactNode;
}) {
  return (
    <>
      <item.icon
        width={14}
        height={14}
        className={cn("shrink-0", item.danger ? "text-danger" : "text-fg-subtle")}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn("text-[12px]", item.danger ? "text-danger" : "text-fg")}
        >
          {item.label}
        </span>
        {item.detail && (
          <span className="truncate text-[11px] text-fg-subtle">
            {item.detail}
          </span>
        )}
      </span>
      {item.external && (
        <ArrowUpRightIcon
          width={12}
          height={12}
          className="shrink-0 text-fg-tertiary"
        />
      )}
      {trailing}
    </>
  );
}

/** A row that owns a second level instead of an action. */
function SubmenuRow({
  item,
  width,
  close,
}: {
  item: ActionMenuItem;
  width: string;
  close: () => void;
}) {
  const [open, setOpen] = useState(false);
  // A pointer opens the flyout under the cursor, which is already where the
  // reader is looking; a keyboard has to be sent there.
  const [takeFocus, setTakeFocus] = useState(false);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open || !takeFocus) return;
    flyoutRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
    setTakeFocus(false);
  }, [open, takeFocus]);

  const cancelClose = () => {
    if (closeTimer.current === null) return;
    clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };

  // Nothing may outlive the row it belongs to.
  useEffect(() => cancelClose, []);

  const openNow = () => {
    cancelClose();
    setOpen(true);
  };

  /**
   * Leaving does not shut the flyout at once. A pointer travelling from the
   * row to the list it opened has to cross the seam between the two, and a
   * menu that closes on the first frame off the row is one you cannot
   * actually reach — you chase it and it runs. The grace period is short
   * enough to feel immediate and long enough to survive the trip.
   */
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  };

  const openWithFocus = () => {
    cancelClose();
    setTakeFocus(true);
    setOpen(true);
  };

  return (
    <div className="relative" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={openWithFocus}
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight") return;
          e.preventDefault();
          openWithFocus();
        }}
        className={cn(ROW, item.danger && "text-danger")}
      >
        <ItemBody
          item={item}
          trailing={
            <ChevronRightIcon
              width={12}
              height={12}
              className="shrink-0 text-fg-tertiary"
            />
          }
        />
      </button>

      {open && (
        <div
          ref={flyoutRef}
          role="menu"
          // Opens to the right of its parent row. `align` anchors the first
          // panel to its trigger; it does not reverse the submenu direction.
          // Flush against that edge on purpose — a gap here is dead space the
          // pointer has to cross, and crossing it leaves the row that owns the
          // flyout. Capped and scrollable: the destination list is as long as
          // the lab has Studies.
          className={cn(
            "absolute top-0 max-h-64 overflow-y-auto",
            PANEL,
            width,
            "left-full",
          )}
        >
          <MenuList
            items={item.submenu ?? []}
            width={width}
            close={close}
          />
        </div>
      )}
    </div>
  );
}

/** One level of rows. Used for the panel itself and for every flyout. */
function MenuList({
  items,
  width,
  close,
}: {
  items: ActionMenuItem[];
  width: string;
  close: () => void;
}) {
  return (
    <>
      {items.map((item) => (
        <div key={item.id}>
          {item.separatorBefore && <div className="mx-[5px] my-1 h-px bg-line" />}
          {item.submenu && item.submenu.length > 0 ? (
            <SubmenuRow item={item} width={width} close={close} />
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                item.onSelect?.();
                close();
              }}
              className={cn(ROW, item.danger && "text-danger")}
            >
              <ItemBody item={item} />
            </button>
          )}
        </div>
      ))}
    </>
  );
}

// Anchored dropdown menu — the trigger stays owned by the caller (render prop);
// this owns the popover mechanics (mousedown-outside + Escape close).
export function ActionMenu({
  items,
  align = "start",
  width = "w-64",
  className,
  children,
}: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      // Escape dismisses the whole thing, open flyout and all: one key, one
      // predictable outcome, rather than a level-at-a-time unwind.
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

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {children({ open, toggle })}

      {open && (
        <div
          role="menu"
          className={cn(
            "absolute top-full mt-2",
            PANEL,
            width,
            align === "end" ? "right-0" : "left-0",
          )}
        >
          <MenuList
            items={items}
            width={width}
            close={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

export default ActionMenu;
