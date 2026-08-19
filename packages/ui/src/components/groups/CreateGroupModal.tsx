import { useEffect, useRef, useState } from "react";
import type { Agent, NewGroup } from "@lykeion/api";
import {
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  ImageIcon,
  UserIcon,
} from "../icons";
import { agentAvatar } from "../../lib/assignee";
import { useDirectory } from "../../hooks/useDirectory";
import { UserAvatar } from "../UserAvatar";
import { cn } from "../../lib/utils";

function AgentChip({ name }: { name: string }) {
  const a = agentAvatar(name);
  return (
    <span
      className="grid h-4 w-4 shrink-0 place-items-center rounded-[5px] text-micro font-semibold text-white"
      style={{
        backgroundImage: `linear-gradient(135deg, ${a.gradient[0]}, ${a.gradient[1]})`,
      }}
    >
      {a.initial}
    </span>
  );
}

// Anchored agent dropdown — single-select (lead) or multi-select (members).
// Options are the real workspace agents; selection is by agent name.
function AgentSelect({
  agents,
  multiple,
  selected,
  onToggle,
  placeholder,
}: {
  agents: Agent[];
  multiple?: boolean;
  selected: string[];
  onToggle: (name: string) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const q = query.trim().toLowerCase();
  const visible = agents.filter((a) => a.name.toLowerCase().includes(q));
  const chosen = agents.filter((a) => selected.includes(a.name));

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-2 text-left text-ui text-fg-muted hover:bg-surface-3"
      >
        <UserIcon width={15} height={15} className="shrink-0 text-fg-subtle" />
        {chosen.length === 0 ? (
          <span className="flex-1 text-fg-subtle">{placeholder}</span>
        ) : (
          <span className="flex flex-1 flex-wrap items-center gap-1.5">
            {chosen.map((a) => (
              <span
                key={a.name}
                className="inline-flex items-center gap-1 text-fg"
              >
                <AgentChip name={a.name} />
                {a.name}
              </span>
            ))}
          </span>
        )}
        <ChevronDownIcon
          width={14}
          height={14}
          className={cn(
            "shrink-0 text-fg-subtle transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-xl">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search experts and members…"
            className="mb-1 w-full rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-ui text-fg outline-none placeholder:text-fg-subtle"
          />
          <div className="px-1.5 pb-1 pt-0.5 text-micro font-semibold uppercase tracking-[0.5px] text-fg-tertiary">
            My experts
          </div>
          {visible.length === 0 && (
            <div className="px-2 py-1.5 text-ui text-fg-subtle">
              No experts yet
            </div>
          )}
          {visible.map((a) => {
            const isSelected = selected.includes(a.name);
            return (
              <button
                key={a.name}
                type="button"
                onClick={() => {
                  onToggle(a.name);
                  if (!multiple) setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui text-fg-muted hover:bg-surface-2 hover:text-fg"
              >
                <AgentChip name={a.name} />
                <span className="flex-1">{a.name}</span>
                {isSelected && (
                  <CheckIcon
                    width={14}
                    height={14}
                    className="shrink-0 text-accent"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Anchored colleague dropdown — multi-select, keyed by `User.id`. The
 *  roster comes from the directory `ApiProvider` already fetched, so opening
 *  this modal costs no extra request. Only members still in the lab are
 *  offered: `activeMembers()` filters the offboarded out at the source. */
function ColleagueSelect({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (userId: string) => void;
}) {
  const dir = useDirectory();
  const members = dir.activeMembers();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const chosen = members.filter((m) => selected.includes(m.user.id));

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-2 text-left text-ui text-fg-muted hover:bg-surface-3"
      >
        <UserIcon width={15} height={15} className="shrink-0 text-fg-subtle" />
        {chosen.length === 0 ? (
          <span className="flex-1 text-fg-subtle">Add colleagues</span>
        ) : (
          <span className="flex flex-1 flex-wrap items-center gap-1.5">
            {chosen.map((m) => (
              <span
                key={m.user.id}
                className="inline-flex items-center gap-1 text-fg"
              >
                <UserAvatar user={m.user} size={16} />
                {m.user.displayName}
              </span>
            ))}
          </span>
        )}
        <ChevronDownIcon
          width={14}
          height={14}
          className={cn(
            "shrink-0 text-fg-subtle transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-xl">
          <div className="px-1.5 pb-1 pt-0.5 text-micro font-semibold uppercase tracking-[0.5px] text-fg-tertiary">
            Colleagues
          </div>
          {members.length === 0 && (
            <div className="px-2 py-1.5 text-ui text-fg-subtle">
              Nobody else in this lab yet
            </div>
          )}
          {members.map((m) => (
            <button
              key={m.user.id}
              type="button"
              onClick={() => onToggle(m.user.id)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              <UserAvatar user={m.user} size={16} />
              <span className="flex-1">{m.user.displayName}</span>
              {selected.includes(m.user.id) && (
                <CheckIcon
                  width={14}
                  height={14}
                  className="shrink-0 text-accent"
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface CreateGroupModalProps {
  agents: Agent[];
  onClose: () => void;
  onCreate: (input: NewGroup) => Promise<void>;
}

/** Create Group — a real create surface: persists a group with a lead and
 *  optional members chosen from the workspace agents. */
export function CreateGroupModal({
  agents,
  onClose,
  onCreate,
}: CreateGroupModalProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [leadId, setLeadId] = useState<string[]>([]);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [colleagueIds, setColleagueIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canCreate = name.trim().length > 0 && !busy;
  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim(),
        leadAgent: leadId[0],
        memberAgents: memberIds,
        memberUsers: colleagueIds,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Create group"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 className="text-read font-semibold text-fg">
            Create Group
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
          >
            <CloseIcon width={15} height={15} />
          </button>
        </div>
        <p className="px-5 text-ui text-fg-subtle">
          Create a collaborative group with a lead expert and optional
          additional members.
        </p>

        <div className="space-y-4 px-5 py-4">
          <div className="flex items-start gap-3">
            <button
              type="button"
              aria-label="Add group image"
              className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-lg border border-line bg-surface-2 text-fg-subtle hover:bg-surface-3"
            >
              <ImageIcon width={18} height={18} />
            </button>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-sub font-medium text-fg-muted">
                Name
              </span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Structural Biology Group"
                className="w-full rounded-md border border-line bg-surface-2 px-2.5 py-2 text-ui text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-sub font-medium text-fg-muted">
              Description
            </span>
            <textarea
              value={description}
              maxLength={255}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what this group is responsible for…"
              rows={2}
              className="w-full resize-none rounded-md border border-line bg-surface-2 px-2.5 py-2 text-ui text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong"
            />
            <span className="self-end text-meta text-fg-tertiary">
              {description.length} / 255
            </span>
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-sub font-medium text-fg-muted">
              Lead Expert
            </span>
            <span className="mb-1 text-sub text-fg-subtle">
              The lead receives all tasks assigned to this group and coordinates
              the team.
            </span>
            <AgentSelect
              agents={agents}
              selected={leadId}
              onToggle={(name) =>
                setLeadId((cur) => (cur[0] === name ? [] : [name]))
              }
              placeholder="Select a lead expert"
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-sub font-medium text-fg-muted">
              Additional Members{" "}
              <span className="text-fg-tertiary">(optional)</span>
            </span>
            <span className="mb-1 text-sub text-fg-subtle">
              Members the lead can delegate sub-tasks to. Can be added later.
            </span>
            <AgentSelect
              agents={agents}
              multiple
              selected={memberIds}
              onToggle={(name) =>
                setMemberIds((cur) =>
                  cur.includes(name)
                    ? cur.filter((m) => m !== name)
                    : [...cur, name],
                )
              }
              placeholder="Add experts or workspace members"
            />
          </div>

          <div className="flex flex-col gap-1">
            <span className="text-sub font-medium text-fg-muted">
              Colleagues <span className="text-fg-tertiary">(optional)</span>
            </span>
            <span className="mb-1 text-sub text-fg-subtle">
              People in this lab who work in this group. Can be added later.
            </span>
            <ColleagueSelect
              selected={colleagueIds}
              onToggle={(userId) =>
                setColleagueIds((cur) =>
                  cur.includes(userId)
                    ? cur.filter((id) => id !== userId)
                    : [...cur, userId],
                )
              }
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-ui text-fg-muted hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canCreate}
            onClick={submit}
            className="rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            Create group
          </button>
        </div>
      </div>
    </div>
  );
}

export default CreateGroupModal;
