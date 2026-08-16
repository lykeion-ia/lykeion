import { useEffect, useRef, useState } from "react";
import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";
import type { Agent, Machine } from "@lykeion/api";
import {
  CheckIcon,
  ChevronDownIcon,
  ChipIcon,
  CloseIcon,
  FileIcon,
  GlobeIcon,
  ImageIcon,
  LinkIcon,
  LockIcon,
  PlusIcon,
  SparkleIcon,
} from "../icons";
import { cn } from "../../lib/utils";

const MODEL_OPTIONS = [
  "Default (provider)",
  "Opus 5",
  "Sonnet 5",
  "Haiku 4.5",
];

const VISIBILITY = [
  {
    id: "workspace",
    icon: GlobeIcon,
    title: "Workspace",
    sub: "All members can assign",
  },
  {
    id: "personal",
    icon: LockIcon,
    title: "Personal",
    sub: "Only you and workspace admins can assign",
  },
] as const;

const LABEL = "text-sub font-medium text-fg-muted";
const LABEL_UPPER =
  "text-micro font-semibold uppercase tracking-[0.5px] text-fg-tertiary";
const MENU_ITEM =
  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui text-fg-muted hover:bg-surface-2 hover:text-fg";

function useCloseOnOutside(
  ref: RefObject<HTMLDivElement | null>,
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
) {
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [ref, open, setOpen]);
}

function DropdownField({
  trigger,
  children,
  openUp,
}: {
  trigger: (state: { open: boolean }) => ReactNode;
  children: (close: () => void) => ReactNode;
  openUp?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useCloseOnOutside(ref, open, setOpen);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-2 text-left text-ui text-fg-muted hover:bg-surface-3"
      >
        {trigger({ open })}
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
        <div
          className={cn(
            "absolute left-0 right-0 z-20 overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-xl",
            openUp ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// Wired to the real contract: Name/Description/Instructions/Model persist via
// onCreate → upsertAgent. Connectors are REAL — Lykeion's Agent.connectors
// round-trips, and a subagent's effective connector set is narrowed
// elsewhere — so this is the one place assignment happens (agent detail is
// read-only, no edit-in-place). Machine (real listMachines, empty-safe) /
// Skills (real listSkills names) / Visibility remain decorative — Lykeion's
// Agent has no such fields yet.
export function CreateAgentModal({
  machines,
  skillNames,
  connectorNames,
  onCreate,
  onClose,
}: {
  /** The caller's OWN machines, and only those. A machine runs for the
   *  member who paired it, so offering the lab's roster here — and defaulting
   *  to the first of it — asserts an ownership that may well belong to
   *  somebody else. The mounting screen narrows before it passes. */
  machines: Machine[];
  skillNames: string[];
  connectorNames: string[];
  onCreate: (agent: Agent) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] =
    useState<(typeof VISIBILITY)[number]["id"]>("workspace");
  const [machineId, setMachineId] = useState<string>(machines[0]?.id ?? "");
  const [model, setModel] = useState(MODEL_OPTIONS[0]);
  const [instrOpen, setInstrOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [connectors, setConnectors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const machine = machines.find((r) => r.id === machineId);
  const canCreate = name.trim().length > 0 && !busy;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim(),
        systemPrompt: instructions,
        model: model === MODEL_OPTIONS[0] ? undefined : model,
        tools: [],
        connectors,
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
        aria-label="Create expert"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-[600px] flex-col rounded-xl border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 className="text-read font-semibold text-fg">Create Expert</h2>
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
          Create a new AI expert for your workspace.
        </p>

        <div className="space-y-4 overflow-y-auto px-5 py-4">
          {/* Avatar + Name */}
          <div className="flex items-start gap-3">
            <button
              type="button"
              aria-label="Add expert image"
              className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-lg border border-line bg-surface-2 text-fg-subtle hover:bg-surface-3"
            >
              <ImageIcon width={18} height={18} />
            </button>
            <label className="flex flex-1 flex-col gap-1">
              <span className={LABEL}>Name</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Deep Research Expert"
                className="w-full rounded-md border border-line bg-surface-2 px-2.5 py-2 text-ui text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong"
              />
            </label>
          </div>

          {/* Description */}
          <label className="flex flex-col gap-1">
            <span className={LABEL}>Description</span>
            <input
              value={description}
              maxLength={255}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this expert do?"
              className="w-full rounded-md border border-line bg-surface-2 px-2.5 py-2 text-ui text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong"
            />
            <span className="self-end text-meta text-fg-tertiary">
              {description.length} / 255
            </span>
          </label>

          {/* Visibility */}
          <div className="flex flex-col gap-1.5">
            <span className={LABEL}>Visibility</span>
            <div className="grid grid-cols-2 gap-2">
              {VISIBILITY.map((v) => {
                const selected = visibility === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setVisibility(v.id)}
                    aria-pressed={selected}
                    className={cn(
                      "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors",
                      selected
                        ? "border-line-strong bg-surface-2"
                        : "border-line hover:bg-surface-2",
                    )}
                  >
                    <v.icon
                      width={15}
                      height={15}
                      className={cn(
                        "mt-0.5 shrink-0",
                        selected ? "text-accent" : "text-fg-subtle",
                      )}
                    />
                    <span className="flex flex-col">
                      <span className="text-ui font-medium text-fg">
                        {v.title}
                      </span>
                      <span className="text-meta leading-snug text-fg-subtle">
                        {v.sub}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Machine (real, empty-safe) */}
          <div className="flex flex-col gap-1">
            <span className={LABEL}>Machine</span>
            <DropdownField
              trigger={() => (
                <>
                  <SparkleIcon
                    width={15}
                    height={15}
                    className="shrink-0 text-iris"
                  />
                  {machine ? (
                    <span className="flex flex-1 flex-col">
                      <span className="text-ui font-medium text-fg">
                        {machine.name}
                      </span>
                      <span className="text-meta text-fg-subtle">
                        {machine.platform}
                      </span>
                    </span>
                  ) : (
                    <span className="flex-1 text-fg-subtle">
                      No machine of yours
                    </span>
                  )}
                </>
              )}
            >
              {(close) =>
                machines.length === 0 ? (
                  <div className="px-2 py-1.5 text-sub text-fg-subtle">
                    No machine of yours is paired with this lab yet.
                  </div>
                ) : (
                  machines.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => {
                        setMachineId(r.id);
                        close();
                      }}
                      className={MENU_ITEM}
                    >
                      <SparkleIcon
                        width={15}
                        height={15}
                        className="shrink-0 text-iris"
                      />
                      <span className="flex flex-1 flex-col">
                        <span className="text-ui text-fg">{r.name}</span>
                        <span className="text-meta text-fg-subtle">
                          {r.platform}
                        </span>
                      </span>
                      {r.id === machineId && (
                        <CheckIcon
                          width={14}
                          height={14}
                          className="shrink-0 text-accent"
                        />
                      )}
                    </button>
                  ))
                )
              }
            </DropdownField>
          </div>

          {/* Model */}
          <div className="flex flex-col gap-1">
            <span className={LABEL}>Model</span>
            <DropdownField
              trigger={() => (
                <>
                  <ChipIcon
                    width={15}
                    height={15}
                    className="shrink-0 text-fg-subtle"
                  />
                  <span className="flex-1 text-fg">{model}</span>
                </>
              )}
            >
              {(close) =>
                MODEL_OPTIONS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setModel(m);
                      close();
                    }}
                    className={MENU_ITEM}
                  >
                    <span className="flex-1">{m}</span>
                    {m === model && (
                      <CheckIcon
                        width={14}
                        height={14}
                        className="shrink-0 text-accent"
                      />
                    )}
                  </button>
                ))
              }
            </DropdownField>
          </div>

          {/* Instructions → systemPrompt */}
          <div className="flex flex-col gap-1">
            <span className={LABEL_UPPER}>Instructions</span>
            {instrOpen ? (
              <textarea
                autoFocus
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Describe how this expert should work…"
                rows={4}
                className="w-full resize-none rounded-md border border-line bg-surface-2 px-2.5 py-2 text-ui text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong"
              />
            ) : (
              <button
                type="button"
                onClick={() => setInstrOpen(true)}
                className="flex w-full items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-2 text-left text-ui hover:bg-surface-3"
              >
                <FileIcon
                  width={15}
                  height={15}
                  className="shrink-0 text-fg-subtle"
                />
                <span className="flex-1 text-fg-subtle">
                  Click to write instructions…
                </span>
                <ChevronDownIcon
                  width={14}
                  height={14}
                  className="shrink-0 text-fg-subtle"
                />
              </button>
            )}
          </div>

          {/* Skills (real names, decorative) */}
          <div className="flex flex-col gap-1">
            <span className={LABEL_UPPER}>Skills</span>
            <DropdownField
              openUp
              trigger={() => (
                <>
                  <PlusIcon
                    width={15}
                    height={15}
                    className="shrink-0 text-fg-subtle"
                  />
                  {skills.length === 0 ? (
                    <span className="flex-1 text-fg-subtle">
                      Add skills from workspace
                    </span>
                  ) : (
                    <span className="flex flex-1 flex-wrap items-center gap-1">
                      {skills.map((s) => (
                        <span
                          key={s}
                          className="rounded bg-surface-3 px-1.5 py-0.5 text-meta text-fg"
                        >
                          {s}
                        </span>
                      ))}
                    </span>
                  )}
                </>
              )}
            >
              {() =>
                skillNames.length === 0 ? (
                  <div className="px-2 py-1.5 text-sub text-fg-subtle">
                    No skills in the workspace yet.
                  </div>
                ) : (
                  skillNames.map((s) => {
                    const selected = skills.includes(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() =>
                          setSkills((cur) =>
                            cur.includes(s)
                              ? cur.filter((x) => x !== s)
                              : [...cur, s],
                          )
                        }
                        className={MENU_ITEM}
                      >
                        <span className="flex-1">{s}</span>
                        {selected && (
                          <CheckIcon
                            width={14}
                            height={14}
                            className="shrink-0 text-accent"
                          />
                        )}
                      </button>
                    );
                  })
                )
              }
            </DropdownField>
          </div>

          {/* Connectors (real Agent field — narrows a subagent's effective
              connector set; this is where assignment actually happens) */}
          <div className="flex flex-col gap-1">
            <span className={LABEL_UPPER}>Connectors</span>
            <DropdownField
              openUp
              trigger={() => (
                <>
                  <LinkIcon
                    width={15}
                    height={15}
                    className="shrink-0 text-fg-subtle"
                  />
                  {connectors.length === 0 ? (
                    <span className="flex-1 text-fg-subtle">
                      Add connectors from the Lab
                    </span>
                  ) : (
                    <span className="flex flex-1 flex-wrap items-center gap-1">
                      {connectors.map((c) => (
                        <span
                          key={c}
                          className="rounded bg-surface-3 px-1.5 py-0.5 text-meta text-fg"
                        >
                          {c}
                        </span>
                      ))}
                    </span>
                  )}
                </>
              )}
            >
              {() =>
                connectorNames.length === 0 ? (
                  <div className="px-2 py-1.5 text-sub text-fg-subtle">
                    No connectors — add one in Settings › Connectors.
                  </div>
                ) : (
                  connectorNames.map((c) => {
                    const selected = connectors.includes(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        onClick={() =>
                          setConnectors((cur) =>
                            cur.includes(c)
                              ? cur.filter((x) => x !== c)
                              : [...cur, c],
                          )
                        }
                        className={MENU_ITEM}
                      >
                        <span className="flex-1">{c}</span>
                        {selected && (
                          <CheckIcon
                            width={14}
                            height={14}
                            className="shrink-0 text-accent"
                          />
                        )}
                      </button>
                    );
                  })
                )
              }
            </DropdownField>
            <p className="text-meta leading-snug text-fg-subtle">
              An expert sees only the connectors you assign here (intersected
              with what's enabled). Leave empty to inherit all enabled
              connectors.
            </p>
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
            className={cn(
              "rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity",
              canCreate ? "hover:opacity-90" : "cursor-not-allowed opacity-50",
            )}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

export default CreateAgentModal;
