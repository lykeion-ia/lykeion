import { useState } from "react";
import { ChevronDownIcon, SearchIcon } from "../icons";
import { Toggle } from "../ui/Toggle";

export interface CapabilityItem {
  name: string;
  detail?: string;
  enabled: boolean;
}

export interface CapabilityListProps {
  items: CapabilityItem[];
  searchPlaceholder: string;
  sectionTitle: string;
  sectionSubtitle: string;
  emptyLabel: string;
  // When given, each row's switch is controlled + persists via this callback.
  onToggle?: (item: CapabilityItem, next: boolean) => void;
  loading?: boolean;
}

// The Settings-style capability list: an "All (N)" pill + search, a section
// label, and rows of name (+ detail) with an on/off switch. The "Add …" CTA
// lives in the panel's title row (see SkillsScreen), not here — and so do the
// gutter and the scroll, which the settings pane owns.
export function CapabilityList({
  items,
  searchPlaceholder,
  sectionTitle,
  sectionSubtitle,
  emptyLabel,
  onToggle,
  loading = false,
}: CapabilityListProps) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const visible = items.filter((it) => it.name.toLowerCase().includes(q));

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <span className="inline-flex h-8 shrink-0 items-center rounded-md border border-line bg-surface-2 px-2.5 text-[13px] text-fg-muted">
          All ({items.length})
        </span>
        <div className="flex h-8 flex-1 items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5">
          <SearchIcon
            width={14}
            height={14}
            className="shrink-0 text-fg-subtle"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-fg-subtle"
          />
        </div>
      </div>

      <div className="mb-1 flex items-center gap-1 text-[14px] font-medium text-fg">
        {sectionTitle}
        <ChevronDownIcon width={14} height={14} className="text-fg-subtle" />
      </div>
      <p className="mb-2 text-[12px] text-fg-subtle">{sectionSubtitle}</p>

      {items.length === 0 ? (
        loading ? null : (
          <p className="py-6 text-[13px] text-fg-subtle">{emptyLabel}</p>
        )
      ) : (
        <div>
          {visible.map((it) => (
            <div
              key={it.name}
              className="flex items-center justify-between gap-4 border-b border-line py-2.5 last:border-b-0"
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-[14px] text-fg">{it.name}</span>
                {it.detail && (
                  <span className="truncate text-[12px] text-fg-subtle">
                    {it.detail}
                  </span>
                )}
              </span>
              <Toggle
                on={it.enabled}
                onToggle={onToggle ? (next) => onToggle(it, next) : undefined}
                ariaLabel={
                  onToggle
                    ? `${it.enabled ? "Disable" : "Enable"} ${it.name}`
                    : undefined
                }
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default CapabilityList;
