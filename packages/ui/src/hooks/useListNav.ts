import { useCallback, useEffect, useRef, useState } from "react";

/** Elements whose focus should swallow list-navigation keys entirely. */
const TYPING_CONTEXT =
  "input, textarea, select, [contenteditable='true'], [role='dialog']";

/** Interactive elements that own their Enter key (rows handle themselves). */
const OWNS_ENTER = "a, button, [role='link'], [role='tab']";

/**
 * List keyboard navigation: j/k or Arrow Up/Down move a visible
 * selection (and focus), Enter opens the selection when nothing interactive
 * owns the key. Rows register themselves via `setRef` and report focus via
 * `select` so pointer and keyboard stay in sync.
 */
export function useListNav(count: number, activate: (index: number) => void) {
  const [index, setIndexState] = useState(0);
  const indexRef = useRef(0);
  const refs = useRef<(HTMLElement | null)[]>([]);
  const activateRef = useRef(activate);
  activateRef.current = activate;

  const select = useCallback((i: number) => {
    if (indexRef.current === i) return;
    indexRef.current = i;
    setIndexState(i);
  }, []);

  useEffect(() => {
    if (count > 0 && indexRef.current >= count) select(count - 1);
  }, [count, select]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (count === 0 || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest(TYPING_CONTEXT)) return;

      const isDown = e.key === "ArrowDown" || e.key === "j";
      const isUp = e.key === "ArrowUp" || e.key === "k";
      if (isDown || isUp) {
        e.preventDefault();
        const next = Math.min(
          count - 1,
          Math.max(0, indexRef.current + (isDown ? 1 : -1)),
        );
        select(next);
        const el = refs.current[next];
        el?.focus();
        el?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        if (target?.closest(OWNS_ENTER)) return;
        e.preventDefault();
        activateRef.current(indexRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [count, select]);

  const setRef = useCallback(
    (i: number) => (el: HTMLElement | null) => {
      refs.current[i] = el;
    },
    [],
  );

  return { index, select, setRef };
}
