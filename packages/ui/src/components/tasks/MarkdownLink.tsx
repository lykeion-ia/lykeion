import { useCallback, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import type { Components } from "react-markdown";
import { FileIcon, GlobeIcon } from "../icons";
import { linkTargetOf } from "../../lib/link-target";
import { openExternal } from "../../lib/open-external";

/** Where the URL box sits relative to the link, and how far from the edges. */
const TIP_GAP = 6;
const TIP_MAX_W = 340;
const TIP_MARGIN = 12;
/** Below this much room overhead, the box goes under the link instead. */
const TIP_FLIP_AT = 96;

type TipAt = { left: number; top: number; below: boolean };

/**
 * A link inside an agent's reply.
 *
 * Nothing in this app styles a bare anchor — Tailwind's preflight resets `a` to
 * `color: inherit; text-decoration: inherit` — so before this component a
 * citation was indistinguishable from the prose around it. What makes it a link
 * is stated here and in `task.css`'s `.msg-link` rules:
 *
 * - a favicon, so the reader recognises the source before reading the label;
 * - `--link-fg`, underlined on hover;
 * - the full URL on hover, because a link labelled "source" says nothing about
 *   where it goes and the address bar is not available to check it in;
 * - a click that opens a new tab and never navigates the app away.
 *
 * The favicon is asked of the cited site itself. That request is the reason
 * `linkTargetOf` is narrow: only `http(s)` reaches the network, so an artifact
 * path or a `mailto:` renders a local glyph and stays silent. A site that
 * declares its icon only in HTML has no `/favicon.ico` to serve; the `onError`
 * fallback below is the normal case for those, not an exception.
 */
export const MarkdownLink: Components["a"] = ({ href, children }) => {
  const target = linkTargetOf(href);
  // Keyed by URL rather than a bare boolean so a component instance reused for
  // a different link (react-markdown reuses the tree across a streaming turn)
  // does not inherit the previous one's failure.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [tip, setTip] = useState<TipAt | null>(null);
  const tipId = useId();

  const show = useCallback((element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    const below = rect.top < TIP_FLIP_AT;
    setTip({
      // Clamped so a link near the right edge does not push the box off-screen.
      left: Math.max(
        TIP_MARGIN,
        Math.min(rect.left, window.innerWidth - TIP_MAX_W - TIP_MARGIN),
      ),
      top: below ? rect.bottom + TIP_GAP : rect.top - TIP_GAP,
      below,
    });
  }, []);

  // The transcript scrolls out from under a hovered link without the pointer
  // moving, which would leave the box stranded over unrelated text. Capture
  // phase because `.conv-stream` scrolls, not the window, and a scroll event
  // does not bubble. Bound only while a box is open.
  useEffect(() => {
    if (!tip) return;
    const close = () => setTip(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [tip]);

  const faviconBroken =
    target.kind === "external" && failedFor === target.favicon;

  return (
    <a
      href={href}
      className={`msg-link msg-link--${target.kind}`}
      aria-describedby={tip && href ? tipId : undefined}
      onClick={(event) => {
        event.preventDefault();
        if (href) openExternal(href);
      }}
      // React synthesises enter/leave from `mouseover`/`mouseout`; focus keeps
      // the same information reachable from the keyboard.
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseLeave={() => setTip(null)}
      onFocus={(event) => show(event.currentTarget)}
      onBlur={() => setTip(null)}
    >
      {/* Decorative in every branch: the link text is the accessible name, and
          a glyph that repeated it would be read out twice. */}
      {target.kind === "external" && !faviconBroken ? (
        <img
          className="msg-link-icon"
          src={target.favicon}
          alt=""
          aria-hidden="true"
          width={14}
          height={14}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedFor(target.favicon)}
        />
      ) : target.kind === "external" ? (
        // Same 14px box as the image, so the swap costs no reflow.
        <GlobeIcon className="msg-link-icon" width={14} height={14} />
      ) : (
        <FileIcon className="msg-link-icon" width={14} height={14} />
      )}
      {children}
      {tip &&
        href &&
        createPortal(
          <span
            id={tipId}
            role="tooltip"
            className="msg-link-tip"
            data-below={tip.below ? "" : undefined}
            style={{ left: tip.left, top: tip.top }}
          >
            {href}
          </span>,
          document.body,
        )}
    </a>
  );
};
