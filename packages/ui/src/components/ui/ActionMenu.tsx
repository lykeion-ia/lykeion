import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
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
  "fixed z-30 rounded-[10px] border border-line-strong bg-surface p-1 shadow-[0_18px_48px_rgba(0,0,0,0.6)]";

// 28px row, 6px radius, 8px/6px padding — the composer popover's row metrics.
// `min-h` rather than a fixed height, so a two-line item (label + detail)
// still grows.
const ROW =
  "flex min-h-[28px] w-full items-center gap-2 rounded-md py-1 pl-2 pr-1.5 text-left hover:bg-surface-2";

/** Viewport-space offsets for a floating panel. */
type Placement = Pick<CSSProperties, "top" | "bottom" | "left">;

/**
 * Where a panel ended up: its offsets, and whether it had to turn back on
 * itself to stay on screen — which a flyout reports as `data-side` so the
 * direction it opened is observable rather than inferred from a class.
 */
interface Anchored {
  style: Placement;
  flipped: boolean;
}

/** Panel ↔ the thing it hangs off. */
const GAP = 8;
/** Panel ↔ the viewport edge, so a clamped menu never sits flush to the glass. */
const EDGE = 8;

const clamp = (v: number, lo: number, hi: number) =>
  hi < lo ? lo : Math.min(Math.max(v, lo), hi);

/**
 * Pin a floating panel to its anchor in VIEWPORT coordinates.
 *
 * Every panel here is a `position: fixed` child of `<body>` rather than an
 * absolutely positioned child of its trigger, because these menus hang off
 * rows that live inside scrolling panes — the Task sidebar's list, a screen's
 * table. A scroll container clips on BOTH axes (`overflow-y: auto` computes
 * `overflow-x` to `auto` too), so an absolutely positioned panel wider than
 * its pane was cut off at the pane's edge: the sidebar's 224px kebab menu lost
 * its leading 22px — icons and all — to the 208px list it opened in, and the
 * "Move to research" flyout, which opens past the pane's right edge, was shaved
 * to a sliver.
 *
 * `fixed` alone is not enough, which is why the panels are portaled too. A
 * fixed element answers to the viewport ONLY while nothing between it and the
 * root is a containing block — and a single `-translate-y-1/2` on some wrapper
 * makes one, silently: Tailwind compiles that to the standalone `translate`
 * property, which does not even show up in `getComputedStyle().transform`. A
 * menu that far from its trigger is not a subtle bug, and it would arrive
 * whenever someone centred an unrelated ancestor. Leaving the tree entirely is
 * the only version of this that cannot be broken from a distance.
 */
function useAnchoredPanel(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  /** "below" for a menu under its trigger, "beside" for a submenu flyout. */
  side: "below" | "beside",
  align: "start" | "end",
): Anchored {
  const [anchored, setAnchored] = useState<Anchored>({
    style: {},
    flipped: false,
  });

  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const a = anchor.getBoundingClientRect();
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (side === "below") {
        // Open downward, and only turn upward when down has genuinely run out
        // and up has the room — a menu that flips on a near miss reads as a
        // glitch.
        const flip = a.bottom + GAP + h > vh && a.top - GAP - h >= EDGE;
        setAnchored({
          flipped: flip,
          style: {
            ...(flip
              ? { bottom: vh - a.top + GAP }
              : { top: clamp(a.bottom + GAP, EDGE, vh - h - EDGE) }),
            left: clamp(
              align === "end" ? a.right - w : a.left,
              EDGE,
              vw - w - EDGE,
            ),
          },
        });
        return;
      }

      // A flyout opens to the right of its row, or to the left when the right
      // has run out. Its top tracks the row, clamped so a long destination
      // list cannot hang off either end of the screen.
      const flip = a.right + w + EDGE > vw && a.left - w - EDGE >= 0;
      setAnchored({
        flipped: flip,
        style: {
          top: clamp(a.top, EDGE, vh - h - EDGE),
          left: clamp(flip ? a.left - w : a.right, EDGE, vw - w - EDGE),
        },
      });
    };

    place();
    window.addEventListener("resize", place);
    // Capture, so a scroll in ANY ancestor pane re-pins the panel rather than
    // stranding it where the row used to be.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, side, align, anchorRef, panelRef]);

  return anchored;
}

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
          className={cn("text-sub", item.danger ? "text-danger" : "text-fg")}
        >
          {item.label}
        </span>
        {item.detail && (
          <span className="truncate text-meta text-fg-subtle">
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
  menuId,
}: {
  item: ActionMenuItem;
  width: string;
  close: () => void;
  /** Stamped on the flyout so the outside-click check knows it as ours. */
  menuId: string;
}) {
  const [open, setOpen] = useState(false);
  // A pointer opens the flyout under the cursor, which is already where the
  // reader is looking; a keyboard has to be sent there.
  const [takeFocus, setTakeFocus] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { style, flipped } = useAnchoredPanel(
    open,
    rowRef,
    flyoutRef,
    "beside",
    "start",
  );

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
        ref={rowRef}
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

      {open &&
        createPortal(
          <div
            ref={flyoutRef}
            role="menu"
            data-action-menu={menuId}
            // Opens beside its parent row — right by default, left only when
            // the right edge has run out. Flush against that edge on purpose:
            // a gap here is dead space the pointer has to cross, and crossing
            // it leaves the row that owns the flyout. Capped and scrollable:
            // the destination list is as long as the lab has Researches.
            data-side={flipped ? "left" : "right"}
            // The grace period lives on the row's wrapper, but this panel is no
            // longer inside it: `mouseenter`/`mouseleave` do not bubble, and
            // React reconstructs them from the DOM tree the pointer actually
            // crossed. So the flyout holds itself open while the pointer is on
            // it, rather than trusting an ancestor it has left.
            onMouseEnter={openNow}
            onMouseLeave={closeSoon}
            className={cn("max-h-64 overflow-y-auto", PANEL, width)}
            style={style}
          >
            <MenuList
              items={item.submenu ?? []}
              width={width}
              close={close}
              menuId={menuId}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

/** One level of rows. Used for the panel itself and for every flyout. */
function MenuList({
  items,
  width,
  close,
  menuId,
}: {
  items: ActionMenuItem[];
  width: string;
  close: () => void;
  menuId: string;
}) {
  return (
    <>
      {items.map((item) => (
        <div key={item.id}>
          {item.separatorBefore && <div className="mx-[5px] my-1 h-px bg-line" />}
          {item.submenu && item.submenu.length > 0 ? (
            <SubmenuRow
              item={item}
              width={width}
              close={close}
              menuId={menuId}
            />
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
  const panelRef = useRef<HTMLDivElement>(null);
  // Identifies this menu's panels wherever they were portaled to.
  const menuId = useId();
  const { style } = useAnchoredPanel(open, rootRef, panelRef, "below", align);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Element | null;
      if (rootRef.current?.contains(target)) return;
      // The panels are portaled, so containment no longer answers "inside or
      // outside" — the stamp does. Without this the press that opens an item
      // would first dismiss the menu it is pressing, and the click would land
      // on a node already gone: every selection swallowed.
      if (target?.closest?.(`[data-action-menu="${menuId}"]`)) return;
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
  }, [open, menuId]);

  const toggle = () => setOpen((o) => !o);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      {children({ open, toggle })}

      {open &&
        createPortal(
          <div
            ref={panelRef}
            role="menu"
            data-action-menu={menuId}
            className={cn(PANEL, width)}
            style={style}
          >
            <MenuList
              items={items}
              width={width}
              close={() => setOpen(false)}
              menuId={menuId}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

export default ActionMenu;
