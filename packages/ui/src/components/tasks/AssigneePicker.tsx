import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Agent, Assignee } from "@lykeion/api";
import { useApi } from "../../api/ApiContext";
import { useDirectory } from "../../hooks/useDirectory";
import { useOutsideClick } from "../../hooks/useOutsideClick";
import { assigneeKey, displayName } from "../../lib/assignee";

export interface AssigneePickerProps {
  value: Assignee[];
  onChange(next: Assignee[]): void;
}

/** Space between the trigger and the popover, in CSS pixels. */
const POPOVER_GAP = 4;

interface Anchor {
  top: number;
  left: number;
}

/**
 * Choose who a Task is on. People and agents are offered in one control
 * because they go in one list, and grouped because picking a colleague and
 * queueing an agent are different intentions.
 *
 * Offboarded members are not offered. They stay rendered on Tasks that
 * already name them, so history keeps its names, but new work does not go to
 * someone who has left.
 *
 * The people come from the shared directory rather than a fetch of this
 * component's own: a board can hold many of these at once, and each one
 * asking the core for the roster again would be as many round trips as there
 * are cards.
 */
export function AssigneePicker({ value, onChange }: AssigneePickerProps) {
  const api = useApi();
  const dir = useDirectory();
  const [open, setOpen] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [anchor, setAnchor] = useState<Anchor>({ top: 0, left: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  useOutsideClick(ref, () => setOpen(false), open);

  /**
   * Both of this control's mount points are inside a dialog that clips its
   * own overflow for its rounded corners, and an in-flow popover is cut off
   * at that edge — from the New Task modal, only the first option would be
   * reachable. A viewport-positioned box is outside every ancestor's clip, so
   * the whole list stays reachable wherever the control is mounted.
   *
   * The trade is that the viewport does not move the box for us: it has to be
   * placed from the trigger's measured rect, and re-placed whenever anything
   * that scrolls the trigger moves it. Capture catches scrolls on a dialog's
   * own scrolling body, which does not bubble to `window`.
   *
   * Measuring in a layout effect keeps the placement in the same frame as the
   * open, so the popover never paints at a stale position.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const popover = popoverRef.current;
      if (!trigger || !popover) return;
      const rect = trigger.getBoundingClientRect();
      const below = rect.bottom + POPOVER_GAP;
      const height = popover.offsetHeight;
      setAnchor({
        top:
          below + height <= window.innerHeight
            ? below
            : Math.max(POPOVER_GAP, rect.top - POPOVER_GAP - height),
        left: rect.left,
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    let cancelled = false;
    api.listAgents().then(
      (list) => {
        if (!cancelled) setAgents(list);
      },
      (err: unknown) => {
        if (cancelled) return;
        console.error("[AssigneePicker] failed to load agents:", err);
        // An empty Experts group is an honest answer to a failed read; a
        // rejection nobody handles is not.
        setAgents([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const active = dir.activeMembers();
  const chosen = new Set(value.map(assigneeKey));

  const toggle = (assignee: Assignee) => {
    const key = assigneeKey(assignee);
    onChange(
      chosen.has(key)
        ? value.filter((a) => assigneeKey(a) !== key)
        : [...value, assignee],
    );
  };

  const label =
    value.length === 0
      ? "Assignees"
      : value.map((a) => displayName(a, dir)).join(", ");

  return (
    <div ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Assignees"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-line bg-surface-2 px-2 py-1 text-sub text-fg-muted hover:bg-surface-3 hover:text-fg"
      >
        {label}
      </button>
      {open && (
        <div
          ref={popoverRef}
          role="listbox"
          aria-label="Assignees"
          aria-multiselectable="true"
          style={{ position: "fixed", top: anchor.top, left: anchor.left }}
          className="z-20 w-56 rounded-md border border-line bg-surface p-1 shadow-xl"
        >
          <GroupLabel>People</GroupLabel>
          {active.map((m) => (
            <Option
              key={assigneeKey({ kind: "user", userId: m.user.id })}
              assignee={{ kind: "user", userId: m.user.id }}
              label={m.user.displayName}
              chosen={chosen}
              onToggle={toggle}
            />
          ))}
          <GroupLabel spaced>Experts</GroupLabel>
          {agents.map((a) => (
            <Option
              key={assigneeKey({ kind: "agent", name: a.name })}
              assignee={{ kind: "agent", name: a.name }}
              label={displayName({ kind: "agent", name: a.name }, dir)}
              chosen={chosen}
              onToggle={toggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The eyebrow that separates the two groups inside the popover. */
function GroupLabel({
  children,
  spaced,
}: {
  children: string;
  /** Extra space above — the second group needs it, the first does not. */
  spaced?: boolean;
}) {
  return (
    <p
      className={`${spaced ? "mt-1 " : ""}px-2 py-1 text-micro font-medium uppercase tracking-[0.4px] text-fg-tertiary`}
    >
      {children}
    </p>
  );
}

/** One selectable row. A person and an agent differ only in what they are
 *  called and how they key, so they render through the same row. */
function Option({
  assignee,
  label,
  chosen,
  onToggle,
}: {
  assignee: Assignee;
  label: string;
  chosen: Set<string>;
  onToggle(assignee: Assignee): void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={chosen.has(assigneeKey(assignee))}
      onClick={() => onToggle(assignee)}
      className="block w-full rounded px-2 py-1 text-left text-sub text-fg-muted hover:bg-surface-2 hover:text-fg aria-selected:text-fg aria-selected:font-medium"
    >
      {label}
    </button>
  );
}

export default AssigneePicker;
