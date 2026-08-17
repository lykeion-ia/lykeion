import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { adoptRoute, openTab } from "../lib/tabs";
import { routeHash, useRouter, type Route } from "../router";

interface RowLinkProps {
  to: Route;
  className?: string;
  children: ReactNode;
  ariaCurrent?: "page";
  rowRef?: (el: HTMLAnchorElement | null) => void;
  onFocus?: () => void;
  /**
   * This row's destination gets a tab of its own: the one already on it is
   * activated, or one is opened.
   *
   * What the rail's sections do. A section is a place you keep open and come
   * back to, so navigating the current tab to it would mean losing whatever was
   * there — and opening a second Inbox every time would be worse still, which is
   * why this activates rather than always opening. Rows INSIDE a screen (a Task
   * in a list, a Study in a table) leave it off: following one is going deeper
   * where you are, not opening somewhere else.
   */
  ownTab?: boolean;
}

/**
 * The one navigation primitive: a real anchor (native link role, focusable,
 * real href for the hash route) whose activation — click or Enter — goes
 * through the router instead of the browser.
 */
export function RowLink({
  to,
  className,
  children,
  ariaCurrent,
  rowRef,
  onFocus,
  ownTab = false,
}: RowLinkProps) {
  const { navigate } = useRouter();

  /** Where activation goes: this row's own tab, or the one you are in. */
  const go = () => (ownTab ? adoptRoute(to) : navigate(to));

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // Always: the `href` is the canonical hash, and letting the browser follow
    // it would reload the whole app rather than route inside it.
    e.preventDefault();
    // ⌘/Ctrl-click opens a tab in THIS app, not a second copy of it in the
    // browser. Nothing is being taken away by claiming the modifier: the
    // `preventDefault` above predates the tab strip, so a modified click has
    // always navigated in place here, and the gesture meant nothing.
    if (e.metaKey || e.ctrlKey) {
      openTab(to);
      return;
    }
    go();
  };

  /** Middle click, which in a browser's own strip opens a background tab. It
   *  arrives as `auxclick` rather than `click`, so it needs its own handler. */
  const onAuxClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 1) return;
    e.preventDefault();
    openTab(to);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      go();
    }
  };

  return (
    <a
      href={routeHash(to)}
      className={className}
      aria-current={ariaCurrent}
      onClick={onClick}
      onAuxClick={onAuxClick}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      ref={rowRef}
    >
      {children}
    </a>
  );
}
