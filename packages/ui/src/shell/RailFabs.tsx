import { Icon } from "../components/Icon";
import "./shell.css";

/** Which element fills the leftmost slot on a three-pane page. */
export type RailView = "nav" | "context";

/**
 * The two bottom-left circular controls.
 * Sidebar reveals the app sidebar; Chat reveals the page's own conversation
 * rail. Only one shows at a time; the active side is filled.
 */
export function RailFabs({
  view,
  onChange,
}: {
  view: RailView;
  onChange: (view: RailView) => void;
}) {
  return (
    <div className="rail-fabs" data-testid="rail-fabs">
      <button
        type="button"
        className={`rail-fab${view === "nav" ? " is-active" : ""}`}
        aria-label="Show navigation"
        aria-pressed={view === "nav"}
        title="Navigation"
        onClick={() => onChange("nav")}
      >
        <Icon name="sidebar" size={20} />
      </button>
      <button
        type="button"
        className={`rail-fab${view === "context" ? " is-active" : ""}`}
        aria-label="Show task details"
        aria-pressed={view === "context"}
        title="Task details"
        onClick={() => onChange("context")}
      >
        <Icon name="chat" size={20} />
      </button>
    </div>
  );
}
