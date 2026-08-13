import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/** Which edges still have tabs past the clip, and so are drawn soft. */
export type TabBandOverflow = "none" | "start" | "end" | "both";

/**
 * A row of tabs that scrolls rather than squeezing, and says so at its edges.
 *
 * Two behaviours follow from clipping a tab row, and they are the whole of what
 * this hook owns: an edge with more beyond it is reported as overflowing, so the
 * clip can be faded to read as "there is more" rather than as the end of the
 * list; and activating a tab that is off the clip scrolls it back into view, or
 * a selection made elsewhere could land on a tab the band never shows.
 *
 * Neither is specific to which tabs are in the band. Both the breadcrumb's
 * open-Task tabs and the inspector's open-Notebook tabs need them, and the two
 * strips agree on nothing else — not their markup, not their a11y model, not
 * their selected-tab styling — so this is a hook and a stylesheet class
 * (`.tab-band` in screens/task.css), never a shared component.
 *
 * The band must be `position: relative`, which `.tab-band` sets: it makes the
 * tabs' `offsetLeft` read against the band's own content origin, which is what
 * the scroll-into-view measures against.
 *
 * @param activeId  The selected tab. Each tab element in the band must carry
 *                  `data-tab-id`, and must be a direct child of the band — that
 *                  is what is measured and scrolled to.
 * @param tabs      The tab list, used only as an effect dependency: opening or
 *                  closing a tab changes what fits without resizing anything,
 *                  so the `ResizeObserver` never fires for it.
 */
export function useTabBand(
  activeId: string,
  tabs: readonly unknown[],
): {
  ref: React.RefObject<HTMLDivElement | null>;
  overflow: TabBandOverflow;
} {
  const scroller = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState<TabBandOverflow>("none");

  const readOverflow = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    // A pixel of slack at each end: a fractional content width would otherwise
    // fade an edge that has nothing whatsoever beyond it.
    const before = el.scrollLeft > 1;
    const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow(before ? (after ? "both" : "start") : after ? "end" : "none");
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    readOverflow();
    el.addEventListener("scroll", readOverflow, { passive: true });
    const observer = new ResizeObserver(readOverflow);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", readOverflow);
      observer.disconnect();
    };
  }, [readOverflow]);

  // Opening or closing a tab changes what fits without resizing anything, so
  // the observer above never fires for it.
  useEffect(() => {
    readOverflow();
  }, [readOverflow, tabs]);

  // Bring the active tab back inside the clip — by the shortest move, so a tab
  // already on screen is left exactly where the reader last saw it. Layout
  // effect, or the tab is painted off-clip for a frame first.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const tab = Array.from(el.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.dataset.tabId === activeId,
    );
    if (!tab) return;
    const start = tab.offsetLeft;
    const end = start + tab.offsetWidth;
    if (start < el.scrollLeft) el.scrollLeft = start;
    else if (end > el.scrollLeft + el.clientWidth)
      el.scrollLeft = end - el.clientWidth;
  }, [activeId, tabs]);

  return { ref: scroller, overflow };
}
