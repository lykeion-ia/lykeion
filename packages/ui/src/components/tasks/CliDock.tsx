import { useRef, type MouseEvent } from "react";
import type { AgentCli } from "@lykeion/api";
import { cliBrand } from "../../lib/cli-brand";

/**
 * A CLI's identity within the dock. A member can pair more than one
 * machine, and CLI detection is per-machine, so the same `id` (e.g.
 * "claude") can legitimately appear twice — once per machine it was found
 * on. `id` alone is therefore not unique across `clis`; this composite is.
 * Exported so a caller holding the dock's selection in its own state builds
 * and reads the same identity rather than a bare `id` that cannot tell two
 * machines' entries apart.
 */
export function cliIdentity(c: Pick<AgentCli, "id" | "runtimeId">): string {
  return `${c.runtimeId}:${c.id}`;
}

/**
 * The macOS-style CLI dock — a row of tiles, one per detected agent CLI,
 * that magnify toward the cursor. The selected CLI expands
 * to a labelled pill; unavailable CLIs are dimmed and non-selectable. This is
 * the run's agent selector; the composer's ModelSwitcher then picks the model
 * for the chosen CLI. Shows a "no CLIs detected" hint when every known CLI is
 * unavailable, rather than a wall of dimmed tiles.
 */
export function CliDock({
  clis,
  selectedId,
  onSelect,
  machineNames,
}: {
  clis: AgentCli[];
  /** A `cliIdentity()` value, not a bare `AgentCli.id` — see `cliIdentity`. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Runtime id → the machine's paired name, for the tiles' titles and the
   *  selected pill. Absent (or missing a given runtime) falls back to
   *  naming the CLI alone — the single-machine case, where no tile needs
   *  to say which machine it is on. */
  machineNames?: Record<string, string>;
}) {
  const tiles = useRef(new Map<string, HTMLElement>());
  const multiMachine = new Set(clis.map((c) => c.runtimeId)).size > 1;
  const machineNameFor = (runtimeId: string): string | undefined =>
    multiMachine ? machineNames?.[runtimeId] : undefined;

  const setTile = (id: string) => (el: HTMLElement | null) => {
    if (el) tiles.current.set(id, el);
    else tiles.current.delete(id);
  };

  // Dock magnification: scale each tile by the cursor's horizontal proximity.
  const onMove = (e: MouseEvent) => {
    const cx = e.clientX;
    tiles.current.forEach((el) => {
      const r = el.getBoundingClientRect();
      const d = Math.abs(cx - (r.left + r.width / 2));
      const t = Math.max(0, 1 - d / 150);
      el.style.transform = `scale(${1 + t * 0.6}) translateY(${-t * 7}px)`;
      el.style.zIndex = String(10 + Math.round(t * 10));
    });
  };

  const onLeave = () => {
    tiles.current.forEach((el) => {
      el.style.transform = "";
      el.style.zIndex = "";
    });
  };

  // CLI detection always returns all known agents (each with an availability
  // flag), so "nothing installed" arrives as all-unavailable, not as an empty
  // array — show a hint instead of a wall of dimmed tiles.
  if (!clis.some((c) => c.available)) {
    return (
      <div className="cli-dock cli-dock--empty" role="status">
        No agent CLIs detected — install Claude Code, Copilot, Cursor, …
      </div>
    );
  }

  const selected =
    clis.find((c) => cliIdentity(c) === selectedId) ??
    clis.find((c) => c.available) ??
    clis[0];
  const selectedIdentity = cliIdentity(selected);

  return (
    // The row holds one tile per CLI per machine, so its width climbs with
    // every machine a member pairs and passes the column it sits in. The
    // scrolling belongs to this wrapper rather than to the pill: the tiles
    // magnify out of `.cli-dock`'s own box, which a scroll container placed
    // on the pill would cut them off at.
    <div className="cli-dock-scroll">
      <div className="cli-dock" onMouseMove={onMove} onMouseLeave={onLeave}>
        {clis.map((c) => {
          const identity = cliIdentity(c);
          const machine = machineNameFor(c.runtimeId);
          const b = cliBrand(c.id, c.name);
          const Icon = b.icon;
          const glyph = Icon ? <Icon className="cli-tile-icon" /> : b.mono;
          if (identity === selectedIdentity) {
            return (
              <div key={identity} className="cli-dock-selected">
                <span
                  className="cli-tile"
                  style={{ background: b.color, color: b.fg }}
                >
                  {glyph}
                </span>
                <span className="cli-dock-name">{c.name}</span>
                {machine && (
                  <span className="cli-dock-machine">{machine}</span>
                )}
              </div>
            );
          }
          const label = machine ? `${c.name} on ${machine}` : c.name;
          return (
            <button
              key={identity}
              type="button"
              className="cli-dock-btn"
              title={c.available ? label : `${label} — not found`}
              aria-label={label}
              disabled={!c.available}
              onClick={() => c.available && onSelect(identity)}
            >
              <span
                ref={setTile(identity)}
                className="cli-tile cli-dock-tile"
                style={{
                  background: c.available ? b.color : "#2a2a30",
                  color: b.fg,
                  opacity: c.available ? 1 : 0.55,
                }}
              >
                {glyph}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default CliDock;
