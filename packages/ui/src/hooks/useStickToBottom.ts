import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/**
 * Past this many pixels from the bottom, a scroll counts as "away" — enough
 * slack to absorb rounding noise near the edge without being so wide that a
 * researcher who scrolled up even a little keeps getting yanked back down.
 */
const UNPIN_THRESHOLD_PX = 40;

/**
 * Stick-to-bottom for a scrolling transcript: pinned by default, it follows
 * `dep` to the bottom for as long as the researcher hasn't scrolled away, and
 * never fights a scroll that leaves the bottom.
 *
 * `dep` is a content signature (not the content itself) — pass something that
 * changes on every growth of the thing that should pull the view down (e.g. a
 * live reply streaming token by token). Every change re-scrolls, but ONLY
 * while `pinned`.
 *
 * jsdom lays out nothing — `scrollHeight`/`clientHeight` read 0 forever — so
 * both the pin/unpin math and the scroll-to-bottom action read the element's
 * OWN properties at the moment they run, rather than caching layout, which
 * is what lets a test drive this with synthetic values.
 */
export function useStickToBottom<T extends HTMLElement>(
  dep: unknown,
): {
  ref: RefObject<T | null>;
  pinned: boolean;
  jumpToLatest: () => void;
} {
  const ref = useRef<T | null>(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  // The element the scroll listener is CURRENTLY attached to, so the effect
  // below can tell "still the same node" from "the ref just started (or
  // stopped) pointing at a mounted element" without depending on `ref`
  // itself — a plain `useRef` never triggers a re-render when `.current`
  // changes, so there is no dependency to put in an array here.
  const attachedRef = useRef<T | null>(null);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight - el.clientHeight;
  }, []);

  // New content pulls the view down — but only for a researcher who hasn't
  // scrolled away to read something older. Runs on mount too: a reopened
  // Task lands pinned, at the bottom, like any chat surface.
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [dep, scrollToBottom]);

  // Stable identity (deps `[]`, reads `ref.current` fresh on every call) so
  // the attach/detach effect below can add and remove THE SAME function
  // reference no matter which render each side runs on — `removeEventListener`
  // silently no-ops on a mismatched reference, so a per-render closure would
  // leak the previous listener instead of replacing it.
  const handleScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distanceFromBottom <= UNPIN_THRESHOLD_PX);
  }, []);

  // The user's own scroll is the one signal that can pin or unpin: leaving
  // the ~40px slack releases the pin, coming back re-pins — unprompted, no
  // `jumpToLatest` call required.
  //
  // No dependency array: this checks EVERY render whether the ref's element
  // has changed and only then re-subscribes. That's not optional polish — a
  // screen that renders a loading placeholder before its real tree (i.e.
  // every screen backed by an async fetch) mounts this hook once while
  // `ref.current` is still null, then swaps in the real, scrollable element
  // on a later render of the SAME component instance. A `[]`-deps effect
  // fires exactly once, sees `null`, and never gets another chance — the
  // listener would silently never attach.
  useEffect(() => {
    const el = ref.current;
    if (el === attachedRef.current) return;
    attachedRef.current?.removeEventListener("scroll", handleScroll);
    el?.addEventListener("scroll", handleScroll);
    attachedRef.current = el;
  });

  // True unmount only — the effect above intentionally has no cleanup of its
  // own (returning one would fire on every render, undoing the "only
  // reattach when the element changes" check above).
  useEffect(() => {
    return () =>
      attachedRef.current?.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  const jumpToLatest = useCallback(() => {
    setPinned(true);
    scrollToBottom();
  }, [scrollToBottom]);

  return { ref, pinned, jumpToLatest };
}
