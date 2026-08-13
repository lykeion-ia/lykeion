import { CloseIcon, CollapseIcon, ExpandIcon } from "../icons";
import { useTabBand } from "../../hooks/useTabBand";

export interface RightPaneTab {
  /** `"files"`, `"artifact"`, or `` `notebook:${taskId}` `` — the caller reads
   *  its own meaning back out of this in `onSelect`. */
  id: string;
  label: string;
  /** Tooltip, where the label is a shortened form of something longer: an
   *  artifact's full path, or which Task a notebook belongs to. */
  title?: string;
  closable?: boolean;
  /** What the close button says it closes. Worth stating rather than deriving
   *  from `label`: a notebook tab is named after the Task that ran it, and the
   *  conversation's own strip has a close button named after that same Task —
   *  two controls reading `Close <task>` on one screen, doing different things
   *  to different surfaces. */
  closeLabel?: string;
}

/**
 * Which tab the pane shows once the tab it IS showing is closed: the neighbour
 * after it, or the one before if it was last. `null` when nothing remains,
 * which is the caller's cue to put the inspector away — a pane is its tabs, and
 * one with an empty strip is naming nothing.
 *
 * Positional, because there is no home tab to fall back to any more. `Files`
 * used to be that answer and is now a tab like the rest, opened deliberately
 * and closed the same way.
 *
 * Pass only the tabs that can be shown where the reader already stands. Another
 * Task's notebook is reached by GOING to that Task, and closing a tab must
 * never move the screen — so such a tab is not a place the pane may fall to,
 * even while it sits on the strip.
 */
export function tabAfterClose(
  tabs: readonly RightPaneTab[],
  closedId: string,
): string | null {
  const at = tabs.findIndex((t) => t.id === closedId);
  if (at < 0) return null;
  return (tabs[at + 1] ?? tabs[at - 1])?.id ?? null;
}

/**
 * The inspector's tab strip: Files, an opened artifact, and every notebook the
 * researcher has opened in this Study.
 *
 * The notebooks are why this scrolls. Files and the artifact are one slot each,
 * but a Study holds any number of Tasks and each has a notebook, so the row has
 * to be able to outrun its own width — the same problem the breadcrumb's tab
 * band solves, and it is solved the same way, by `useTabBand` and `.tab-band`.
 *
 * The pane's own controls do NOT ride in the band. Left inside it they would
 * scroll away with the tabs, and the band's measure of what still fits would be
 * counting them as tabs; they sit in a fixed region beside it. That also keeps
 * the `tablist` honest.
 *
 * A `tablist` rather than the breadcrumb's row of pressed buttons because what
 * these name is the panel below them. Selecting one may also move the Task
 * surface underneath — another Task's notebook is read beside that Task's
 * conversation, never on top of this one's — but where the reader lands, this
 * strip is still naming the pane, and the tab that ends up marked is the one
 * whose surface is showing.
 */
export function RightPaneTabs({
  tabs,
  activeId,
  onSelect,
  onCloseTab,
  paneMode,
  onToggleFocus,
  onClosePane,
}: {
  tabs: RightPaneTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onCloseTab: (id: string) => void;
  paneMode: "split" | "focus";
  onToggleFocus: () => void;
  onClosePane: () => void;
}) {
  const { ref, overflow } = useTabBand(activeId, tabs);

  return (
    <div className="rightpane-header">
      <div
        ref={ref}
        className="tab-band rightpane-tabs"
        data-overflow={overflow}
        data-testid="rightpane-tab-band"
        role="tablist"
        aria-label="Right pane"
      >
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            // Presentational: a `tablist`'s children are its tabs, and the
            // close button is not one. `data-tab-id` goes here because this is
            // the box the band measures and scrolls to.
            <span
              key={t.id}
              role="presentation"
              data-tab-id={t.id}
              className="rightpane-tabwrap"
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className={`rightpane-tab${active ? " is-active" : ""}`}
                title={t.title}
                onClick={() => onSelect(t.id)}
              >
                {t.label}
              </button>
              {t.closable && (
                <button
                  type="button"
                  className="rightpane-tabclose"
                  aria-label={t.closeLabel ?? `Close ${t.label}`}
                  onClick={() => onCloseTab(t.id)}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path
                      d="M2.5 2.5l5 5M7.5 2.5l-5 5"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              )}
            </span>
          );
        })}
      </div>

      <div className="rightpane-actions">
        {/* Widen to the whole screen and back. The conversation is not drawn
            while this is focused, so the header stops being split and reads as
            the one bar it then is. */}
        <button
          type="button"
          className="art-icon-btn"
          aria-pressed={paneMode === "focus"}
          title={paneMode === "focus" ? "Show conversation" : "Expand panel"}
          aria-label={paneMode === "focus" ? "Show conversation" : "Expand panel"}
          onClick={onToggleFocus}
        >
          {paneMode === "focus" ? <CollapseIcon /> : <ExpandIcon />}
        </button>
        <button
          type="button"
          className="art-icon-btn rightpane-close"
          title="Close panel"
          aria-label="Close panel"
          onClick={onClosePane}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}

export default RightPaneTabs;
