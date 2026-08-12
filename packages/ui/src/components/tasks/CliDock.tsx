import { useRef, type MouseEvent } from "react";
import type { AgentCli } from "@lykeion/api";
import { cliBrand } from "../../lib/cli-brand";

/**
 * A CLI's identity within the dock. A member can pair more than one
 * machine, and CLI detection is per-machine, so the same `id` (e.g.
 * "claude") can arrive once per machine. The dock renders one representative
 * per id, but its selected representative still needs a machine-stable key.
 * Exported so callers build and read that identity consistently.
 */
export function cliIdentity(c: Pick<AgentCli, "id" | "runtimeId">): string {
  return `${c.runtimeId}:${c.id}`;
}

/**
 * The macOS-style CLI dock — a row of tiles, one per detected agent CLI,
 * that magnify toward the cursor. The selected CLI expands to a labelled
 * pill; a CLI that cannot actually run a session is dimmed, non-selectable,
 * and names why in its tile's title — installed but with no working ACP
 * adapter reads differently than never installed at all, and the reason
 * says which. This is the run's agent selector; the composer's
 * ModelSwitcher then picks the model for the chosen CLI. Shows a "no CLIs
 * detected" hint when nothing on the machine can run one, rather than a
 * wall of dimmed tiles.
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
  const rank = (cli: AgentCli) =>
    cli.sessionReady ? 2 : cli.available ? 1 : 0;
  // An agent whose CLI is not on this machine is not this researcher's
  // concern. The catalogue lists thirteen so phases 2 and 3 have a roadmap; a
  // dock rendering all thirteen would be a wall of tiles nobody can act on,
  // and the one that does need a minute of their time would be lost in it.
  // Filter before the rank contest so only usable entries compete for a
  // representative. An agent is usable if either the CLI is on PATH (available)
  // or the adapter can run (sessionReady).
  const representatives = new Map<string, AgentCli>();
  for (const cli of clis) {
    if (!cli.available && !cli.sessionReady) continue;
    const current = representatives.get(cli.id);
    if (!current || rank(cli) > rank(current)) representatives.set(cli.id, cli);
  }
  const visibleClis = [...representatives.values()];
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

  // Show the empty state only when there is truly nothing to show: no installed
  // agents at all. An installed agent that cannot yet run a session (e.g. not
  // signed in) still gets a tile carrying its reason — this is the fallback
  // sign-in surface for whoever skipped the pairing page.
  if (visibleClis.length === 0) {
    return (
      <div className="cli-dock cli-dock--empty" role="status">
        No agent CLIs detected — install Claude Code or Codex
      </div>
    );
  }

  const selectedCliId = selectedId?.slice(selectedId.indexOf(":") + 1);
  const selected =
    visibleClis.find((c) => cliIdentity(c) === selectedId && c.sessionReady) ??
    visibleClis.find((c) => c.id === selectedCliId && c.sessionReady) ??
    visibleClis.find((c) => c.sessionReady) ??
    null;
  const selectedIdentity = selected ? cliIdentity(selected) : null;

  return (
    // The row holds one tile per CLI kind. It can still outgrow a narrow
    // composer, so scrolling belongs to this wrapper rather than to the pill:
    // the tiles magnify out of `.cli-dock`'s own box, which a scroll container
    // placed on the pill would cut off.
    <div className="cli-dock-scroll">
      <div className="cli-dock" onMouseMove={onMove} onMouseLeave={onLeave}>
        {visibleClis.map((c) => {
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
          const reason = c.sessionReadyReason ?? "cannot run a session";
          return (
            <button
              key={identity}
              type="button"
              className="cli-dock-btn"
              title={c.sessionReady ? label : `${label} — ${reason}`}
              aria-label={label}
              disabled={!c.sessionReady}
              onClick={() => c.sessionReady && onSelect(identity)}
            >
              <span
                ref={setTile(identity)}
                className="cli-tile cli-dock-tile"
                style={{
                  background: c.sessionReady ? b.color : "#2a2a30",
                  color: b.fg,
                  opacity: c.sessionReady ? 1 : 0.55,
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
