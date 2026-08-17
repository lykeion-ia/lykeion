import { useEffect, useRef, type KeyboardEvent, type Ref } from "react";
import { CloseIcon, PlusIcon } from "../components/icons";
import { activateTab, closeTab, useTabs, type Tab } from "../lib/tabs";
import { cn } from "../lib/utils";
import { routeGlyph, routeLabel } from "./route-chrome";

/**
 * The strip: one tab per place the researcher has open, the active one lit.
 *
 * It renders from the store and nothing else. The single pill this replaced
 * resolved its own label with a `getStudy` on every route change and showed
 * "Task" until that landed — visible flicker on every Task opened. A tab's name
 * is state now, put there by whoever knew it, so the strip draws it directly.
 */
function TabPill({
  tab,
  active,
  closable,
  pillRef,
}: {
  tab: Tab;
  active: boolean;
  closable: boolean;
  /** Set on the active pill only, so the row can scroll it back into view. */
  pillRef?: Ref<HTMLDivElement>;
}) {
  // A roving tabindex: the strip is ONE stop on the way through the page rather
  // than one per open tab, and the arrow keys move inside it. Without this,
  // twelve open tabs would put twelve stops between the rail and the content.
  const entry = tab.stack[tab.index];
  const Glyph = routeGlyph(entry.route);
  // Truthiness rather than `??`: a stored label that is the empty string is not
  // a name, and a blank tab is worse than a generic one. A Study created with an
  // empty title would otherwise reach the strip as nothing at all.
  const label = entry.label || routeLabel(entry.route);

  return (
    // `presentation` so the tablist's children are the tabs themselves: this
    // wrapper only exists to sit the close control beside one.
    <div
      ref={pillRef}
      role="presentation"
      className={cn(
        // Sized to its own name, not to the row: a tab that stretched to fill
        // the width read as a banner rather than as one of several places open.
        // The ceiling truncates a long Task title; the floor keeps a shrinking
        // row from producing slivers before it starts scrolling.
        "group flex min-w-[96px] max-w-[164px] shrink items-center gap-1.5 rounded-md px-2.5 py-1 text-sub",
        active
          ? "border border-line bg-surface-2 text-fg"
          : "border border-transparent text-fg-tertiary hover:bg-surface hover:text-fg",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        // What the arrow keys activate, read off the element they land on —
        // see the note on `onKeyDown`.
        data-tab-id={tab.id}
        tabIndex={active ? 0 : -1}
        onClick={() => activateTab(tab.id)}
        onAuxClick={(e) => {
          // Middle click closes, as it does in a browser's own strip.
          if (e.button === 1 && closable) closeTab(tab.id);
        }}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <Glyph
          className={cn("shrink-0", active ? "text-accent" : "opacity-80")}
          width={14}
          height={14}
        />
        <span className="truncate">{label}</span>
      </button>
      {closable && (
        // Named for what it closes: a row of identical "Close" controls tells a
        // screen reader nothing about which tab it is on.
        <button
          type="button"
          aria-label={`Close ${label}`}
          // Reachable by Tab from its own tab, and only from there — so the
          // strip stays one stop rather than two per open place.
          tabIndex={active ? 0 : -1}
          onClick={() => closeTab(tab.id)}
          // `ml-1` completes the row's `gap-1.5` to 10px, matching the pill's
          // own `px-2.5`, so the control sits centred between the end of the
          // name and the tab's right edge rather than crowding the border.
          className="ml-1 grid h-4 w-4 shrink-0 place-items-center rounded text-fg-tertiary opacity-0 transition-opacity hover:bg-surface-3 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100"
        >
          <CloseIcon width={10} height={10} />
        </button>
      )}
    </div>
  );
}

export function TabBar({ onNewTab }: { onNewTab: () => void }) {
  const { tabs, activeId } = useTabs();
  const row = useRef<HTMLDivElement>(null);
  const activePill = useRef<HTMLDivElement>(null);

  /**
   * ⌥1–⌥9, which reach a tab from anywhere rather than only from inside the
   * strip. Bound to the window for that reason: a researcher switching tabs is
   * usually reading the content, not the row.
   *
   * ⌘T, ⌘W and ⌘1–9 are the browser's and cannot be intercepted from a page, so
   * the app does not pretend to own them. Here the index IS the store's order —
   * "the second tab" means the second one in the strip — which is why this reads
   * `tabs[n - 1]` where the arrow keys deliberately do not.
   */
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const target = tabs[n - 1];
      if (!target) return;
      e.preventDefault();
      activateTab(target.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs]);

  // Keep the tab being read on screen once the row has more tabs than width.
  // Guarded because jsdom does not implement it.
  useEffect(() => {
    activePill.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  /**
   * Arrow-key movement along the row, which is what `role="tablist"` promises
   * and what a screen reader announces on reaching it. Home and End go to the
   * ends; both arrows wrap, since a strip of tabs has no edge worth stopping at.
   *
   * Focus moves and the tab activates together. That is right for this strip and
   * not for every tablist: activating on arrow is only kind when the panel is
   * cheap to show, and here the panel is the screen the reader was heading for
   * anyway.
   *
   * The focused element is read from the DOM rather than tracked in state,
   * because focus is DOM state — mirroring it would give two answers to one
   * question. Each element carries its own tab id for the same reason: moving by
   * position and then activating `tabs[next]` would tie this to the DOM and the
   * store agreeing on order, which holds today only because every tab is
   * rendered. Reading the id off the element that was focused keeps it true
   * whatever a later strip chooses to leave out — an overflow menu, say.
   */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const els = [
      ...(row.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ??
        []),
    ];
    if (els.length === 0) return;
    const focused = els.findIndex((el) => el === document.activeElement);
    // Focus may be on the close control rather than a tab, in which case the
    // active tab is where the move starts from.
    const from =
      focused === -1
        ? Math.max(
            0,
            els.findIndex((el) => el.dataset.tabId === activeId),
          )
        : focused;
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? els.length - 1
          : e.key === "ArrowLeft"
            ? (from - 1 + els.length) % els.length
            : (from + 1) % els.length;
    e.preventDefault();
    const target = els[next];
    if (!target) return;
    target.focus();
    const id = target.dataset.tabId;
    if (id) activateTab(id);
  };

  return (
    <div
      ref={row}
      role="tablist"
      aria-label="Open tabs"
      onKeyDown={onKeyDown}
      className="flex h-[42px] shrink-0 items-center gap-1 overflow-x-auto bg-sidebar px-2.5"
    >
      {tabs.map((tab) => (
        <TabPill
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          // The last tab does not close: there is no such thing as no app.
          closable={tabs.length > 1}
          pillRef={tab.id === activeId ? activePill : undefined}
        />
      ))}
      <button
        type="button"
        aria-label="New tab"
        // Asks where to go rather than deciding: opening a tab on some fixed
        // screen made this read as "duplicate what I am looking at".
        onClick={onNewTab}
        className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-fg-tertiary transition-colors hover:bg-surface hover:text-fg"
      >
        <PlusIcon width={14} height={14} />
      </button>
    </div>
  );
}

export default TabBar;
