import type { ReactNode } from "react";
import { ChevronRightIcon, FlaskIcon } from "./icons";
import { RowLink } from "./RowLink";
import { cn } from "../lib/utils";
import type { Route } from "../router";

/**
 * The breadcrumb content itself — `Studies › {page}` — rendered as a single
 * inline flex group: a two-level trail (the list, then the thing opened from
 * it). Used inline inside a detail screen's header — the Study page and the
 * Task surface both carry it, so the trail reads unchanged across the click
 * that opens a run — or wrapped by `ScreenCrumb` on index screens.
 *
 * It is a `nav` landmark: it is the page's way back up, and naming it keeps it
 * distinct from the Rail's own "Studies" link.
 *
 * `to` is what the trail's last segment names. Left off, it names the page you
 * are already on and is plain text at full strength — a link to here is no way
 * back. Given, the screen sits one level below what the segment names (the Task
 * surface naming the Study it was opened from), so the name is the link that
 * goes back up, and it answers the pointer exactly as "Studies" does: subtle
 * until hovered, no second hover language a click away from the same trail.
 */
export function CrumbTrail({ page, to }: { page: string; to?: Route }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 items-center gap-1.5 text-read"
    >
      <RowLink
        to={{ name: "studies" }}
        className="flex shrink-0 items-center gap-1.5 rounded text-fg-subtle hover:text-fg"
      >
        <FlaskIcon width={16} height={16} className="shrink-0" />
        <span>Studies</span>
      </RowLink>
      <ChevronRightIcon
        className="shrink-0 text-fg-tertiary"
        width={14}
        height={14}
      />
      {to === undefined ? (
        <span className="truncate font-medium text-fg">{page}</span>
      ) : (
        <RowLink
          to={to}
          className="truncate rounded font-medium text-fg-subtle hover:text-fg"
        >
          {page}
        </RowLink>
      )}
    </nav>
  );
}

/**
 * The row a detail screen's breadcrumb sits in — the single definition of where
 * the trail lands, so a Study page and the run opened from it put it in exactly
 * the same place.
 *
 * The height is pinned to `min-h-[56px]` — this row's `pt-3` + `pb-2.5` plus
 * the 34px of the Task surface's tab control (an `h-7` button inside a bordered
 * `p-0.5` box). Without it a strip carrying nothing but the trail collapses to
 * the trail's own line-height and the crumb rides ~7px higher than the same
 * crumb one click away. Screens hang their own controls off `children`; the
 * trail's position is not theirs to move.
 *
 * `band` opts the row into three tracks instead of a flex line — see
 * `.crumb-strip--banded` in screens/task.css for why the middle one is the
 * conversation's own measure. Padding and height are stated once, above both
 * layouts, so opting in cannot move the trail.
 */
export function CrumbStrip({
  page,
  to,
  band,
  children,
}: {
  page: string;
  /** Where the named page is, when it is not this one. See `CrumbTrail`. */
  to?: Route;
  /** Content that must sit on the reading column below the strip rather than
   *  merely after the trail. Given, the row lays out as three tracks. */
  band?: ReactNode;
  /** Controls that ride at the strip's right edge — actions, a pane toggle. */
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "min-h-[56px] items-center gap-3 px-5 pb-2.5 pt-3",
        band === undefined ? "flex" : "crumb-strip--banded",
      )}
    >
      <CrumbTrail page={page} to={to} />
      {band}
      {children !== undefined && (
        <div className="flex items-center gap-3 justify-self-end ml-auto">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Breadcrumb strip that heads an index screen, closed by a hairline separator
 * beneath it. The toolbar/board render below the line.
 */
export function ScreenCrumb({ page }: { page: string }) {
  return (
    <div className="flex shrink-0 items-center border-b border-line px-5 pb-2.5 pt-3">
      <CrumbTrail page={page} />
    </div>
  );
}

export default ScreenCrumb;
