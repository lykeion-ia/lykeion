import { useEffect, useRef, useState } from "react";
import { Calendar } from "./CalendarPopover";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  FilterIcon,
  PriorityIcon,
  SortIcon,
} from "../icons";
import {
  activeFilterCount,
  EMPTY_FILTERS,
  SORT_OPTIONS,
  type FilterDimension,
  type FilterOption,
  type FilterState,
  type SortKey,
} from "../../lib/task-filters";
import { formatTargetDate } from "../../lib/task-meta";
import { cn } from "../../lib/utils";

const SORT_LEVEL = "__sort__";

export interface FilterBarProps {
  dimensions: FilterDimension[];
  state: FilterState;
  onChange: (next: FilterState) => void;
  sortKey?: SortKey;
  onSort?: (k: SortKey) => void;
}

// Small leading visual for an option / chip: a status dot, a lead-agent
// gradient square, or the priority bars glyph.
function OptionGlyph({ option }: { option: FilterOption }) {
  if (option.swatch) {
    return (
      <span className={cn("h-2 w-2 shrink-0 rounded-full", option.swatch)} />
    );
  }
  if (option.color) {
    return (
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: option.color }}
      />
    );
  }
  if (option.gradient) {
    return (
      <span
        className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] text-[8px] font-semibold text-white"
        style={{
          backgroundImage: `linear-gradient(135deg, ${option.gradient[0]}, ${option.gradient[1]})`,
        }}
      >
        {option.label.charAt(0)}
      </span>
    );
  }
  if (option.priorityLevel) {
    return (
      <PriorityIcon
        width={13}
        height={13}
        className="shrink-0 text-fg-subtle"
      />
    );
  }
  return null;
}

export function FilterBar({
  dimensions,
  state,
  onChange,
  sortKey,
  onSort,
}: FilterBarProps) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<string | null>(null); // null = root; dim key | SORT_LEVEL
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function dismiss() {
      setOpen(false);
      setLevel(null);
    }
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        dismiss();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") dismiss();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setLevel(null);
  }

  const count = activeFilterCount(state);

  function toggleOption(dimKey: string, optionId: string) {
    const current = state.values[dimKey] ?? [];
    const next = current.includes(optionId)
      ? current.filter((id) => id !== optionId)
      : [...current, optionId];
    onChange({ ...state, values: { ...state.values, [dimKey]: next } });
  }

  function setDate(date?: string) {
    onChange({ ...state, targetDate: date });
    close();
  }

  function clearAll() {
    onChange(EMPTY_FILTERS);
    close();
  }

  // Active-filter chips (one per selected value + a target-date chip + a
  // non-default sort chip).
  const chips: {
    key: string;
    label: string;
    glyph?: FilterOption;
    onRemove: () => void;
  }[] = [];
  for (const dim of dimensions) {
    if (dim.kind !== "select") continue;
    for (const id of state.values[dim.key] ?? []) {
      const opt = dim.options?.find((o) => o.id === id);
      chips.push({
        key: `${dim.key}:${id}`,
        label: opt?.label ?? id,
        glyph: opt,
        onRemove: () => toggleOption(dim.key, id),
      });
    }
  }
  if (state.targetDate) {
    chips.push({
      key: "targetDate",
      label: `Due ≤ ${formatTargetDate(state.targetDate)}`,
      onRemove: () => onChange({ ...state, targetDate: undefined }),
    });
  }
  if (onSort && sortKey && sortKey !== "updated") {
    const label = SORT_OPTIONS.find((s) => s.id === sortKey)?.label ?? sortKey;
    chips.push({
      key: "sort",
      label: `Sort: ${label}`,
      onRemove: () => onSort("updated"),
    });
  }

  const activeDim =
    level && level !== SORT_LEVEL
      ? dimensions.find((d) => d.key === level)
      : null;

  return (
    <>
      <div ref={rootRef} className="relative">
        <button
          type="button"
          onClick={() => (open ? close() : setOpen(true))}
          aria-haspopup="menu"
          aria-expanded={open}
          className={cn(
            // h-8 (not py-1.5) so the trigger is the same 32px as the toolbar's
            // other controls (calendar, import/export, view toggle). With the
            // row's items-center that keeps the Filter button on the same
            // baseline whether the row holds only the FilterBar (Studies) or a
            // full toolbar (My Tasks) — otherwise the taller My Tasks row
            // centres this shorter button a couple px below its Studies twin.
            "inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 text-[12.5px] transition-colors hover:bg-surface-3",
            count > 0 ? "text-fg" : "text-fg-subtle",
          )}
        >
          <FilterIcon width={14} height={14} />
          Filter
          {count > 0 && (
            <span className="grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
              {count}
            </span>
          )}
        </button>

        {open && (
          <div
            role="menu"
            className="absolute left-0 top-full z-30 mt-1.5 w-60 overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-xl"
          >
            {/* Root level — list of dimensions + Sort by + Clear all */}
            {level === null && (
              <>
                {dimensions.map((dim) => {
                  const selected = state.values[dim.key]?.length ?? 0;
                  const isDate = dim.kind === "date";
                  const dateActive = isDate && state.targetDate;
                  return (
                    <button
                      key={dim.key}
                      type="button"
                      onClick={() => setLevel(dim.key)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-fg-muted hover:bg-surface-2 hover:text-fg"
                    >
                      <dim.icon
                        width={15}
                        height={15}
                        className="shrink-0 text-fg-subtle"
                      />
                      <span className="flex-1">{dim.label}</span>
                      {selected > 0 && (
                        <span className="text-[11px] text-fg-tertiary">
                          {selected}
                        </span>
                      )}
                      {dateActive && (
                        <span className="text-[11px] text-fg-tertiary">
                          {formatTargetDate(state.targetDate!)}
                        </span>
                      )}
                      <ChevronRightIcon
                        width={14}
                        height={14}
                        className="shrink-0 text-fg-tertiary"
                      />
                    </button>
                  );
                })}

                {onSort && (
                  <>
                    <div className="my-1 h-px bg-line" />
                    <button
                      type="button"
                      onClick={() => setLevel(SORT_LEVEL)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-fg-muted hover:bg-surface-2 hover:text-fg"
                    >
                      <SortIcon
                        width={15}
                        height={15}
                        className="shrink-0 text-fg-subtle"
                      />
                      <span className="flex-1">Sort by</span>
                      <span className="text-[11px] text-fg-tertiary">
                        {
                          SORT_OPTIONS.find(
                            (s) => s.id === (sortKey ?? "updated"),
                          )?.label
                        }
                      </span>
                      <ChevronRightIcon
                        width={14}
                        height={14}
                        className="shrink-0 text-fg-tertiary"
                      />
                    </button>
                  </>
                )}

                {count > 0 && (
                  <>
                    <div className="my-1 h-px bg-line" />
                    <button
                      type="button"
                      onClick={clearAll}
                      className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-[13px] text-danger hover:bg-surface-2"
                    >
                      Clear all filters
                    </button>
                  </>
                )}
              </>
            )}

            {/* Drill-in header (shared by select + date + sort levels) */}
            {level !== null && (
              <div className="mb-1 flex items-center gap-1.5 border-b border-line px-1 pb-1.5">
                <button
                  type="button"
                  aria-label="Back"
                  onClick={() => setLevel(null)}
                  className="grid h-6 w-6 place-items-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
                >
                  <ChevronLeftIcon width={14} height={14} />
                </button>
                <span className="text-[13px] font-medium text-fg">
                  {level === SORT_LEVEL ? "Sort by" : activeDim?.label}
                </span>
              </div>
            )}

            {/* Select dimension options */}
            {activeDim?.kind === "select" &&
              activeDim.options?.map((opt) => {
                const selected =
                  state.values[activeDim.key]?.includes(opt.id) ?? false;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => toggleOption(activeDim.key, opt.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-fg-muted hover:bg-surface-2 hover:text-fg"
                  >
                    <OptionGlyph option={opt} />
                    <span className={cn("flex-1", selected && "text-fg")}>
                      {opt.label}
                    </span>
                    {selected && (
                      <CheckIcon
                        width={14}
                        height={14}
                        className="shrink-0 text-accent"
                      />
                    )}
                    <span className="w-4 shrink-0 text-right text-[11px] text-fg-tertiary">
                      {opt.count}
                    </span>
                  </button>
                );
              })}

            {/* Date dimension → calendar */}
            {activeDim?.kind === "date" && (
              <Calendar value={state.targetDate} onSelect={setDate} />
            )}

            {/* Sort options */}
            {level === SORT_LEVEL &&
              SORT_OPTIONS.map((opt) => {
                const selected = (sortKey ?? "updated") === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      onSort?.(opt.id);
                      setLevel(null);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-fg-muted hover:bg-surface-2 hover:text-fg"
                  >
                    <span className={cn("flex-1", selected && "text-fg")}>
                      {opt.label}
                    </span>
                    {selected && (
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

      {chips.map((chip) => (
        <span
          key={chip.key}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 py-1 pl-2 pr-1 text-[12px] text-fg-muted"
        >
          {chip.glyph && <OptionGlyph option={chip.glyph} />}
          {chip.label}
          <button
            type="button"
            aria-label={`Remove ${chip.label}`}
            onClick={chip.onRemove}
            className="grid h-4 w-4 place-items-center rounded text-fg-tertiary hover:bg-surface-3 hover:text-fg"
          >
            <CloseIcon width={11} height={11} />
          </button>
        </span>
      ))}
    </>
  );
}

export default FilterBar;
