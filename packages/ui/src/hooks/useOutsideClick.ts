import { useEffect, type RefObject } from "react";

/**
 * Closes an open popover/menu on any mousedown outside `ref`'s subtree.
 * `Composer`'s task-settings popover and `PermissionCard`'s scope menu
 * both dismiss this way, and one dismissal rule they share is one rule to
 * keep right.
 *
 * `active` gates the listener so it's attached only while the popover is
 * actually open — a closed popover has nothing to dismiss, and a document
 * listener per closed menu is a cost every click on the page pays.
 */
export function useOutsideClick(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active: boolean,
) {
  useEffect(() => {
    if (!active) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [active, onClose, ref]);
}
