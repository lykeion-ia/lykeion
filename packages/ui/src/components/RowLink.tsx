import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { routeHash, useRouter, type Route } from "../router";

interface RowLinkProps {
  to: Route;
  className?: string;
  children: ReactNode;
  ariaCurrent?: "page";
  rowRef?: (el: HTMLAnchorElement | null) => void;
  onFocus?: () => void;
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
}: RowLinkProps) {
  const { navigate } = useRouter();

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    navigate(to);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      navigate(to);
    }
  };

  return (
    <a
      href={routeHash(to)}
      className={className}
      aria-current={ariaCurrent}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      ref={rowRef}
    >
      {children}
    </a>
  );
}
