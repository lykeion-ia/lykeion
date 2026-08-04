import { SearchIcon } from "../icons";
import { cn } from "../../lib/utils";
import {
  CONVERSATION_CHIPS,
  type ConversationChip,
} from "../../lib/conversation-filters";

/**
 * The Inbox list's search field and chip row, in the list's own column above
 * the threads they narrow.
 *
 * The field is a filter over the list on screen, NOT the app's search: it
 * borrows the Rail's look but deliberately not its `⌘K` badge, because ⌘K
 * opens the command palette over the whole workspace. A badge here would
 * promise the key does what this field does, and it does not.
 */
export function ConversationFilters({
  query,
  onQuery,
  chip,
  onChip,
}: {
  query: string;
  onQuery: (next: string) => void;
  chip: ConversationChip;
  onChip: (next: ConversationChip) => void;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-3 px-3 pb-3">
      {/* The field box carries the focus affordance, not the input inside it:
          the global ring is drawn a pixel INSIDE its element, so on the input
          it reads as a second box within this one. The border lighting up is
          the same information without the box-in-a-box. */}
      <div className="flex h-8 items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 transition-colors duration-[120ms] focus-within:border-accent-focus">
        <SearchIcon
          className="shrink-0 text-fg-subtle"
          width={14}
          height={14}
        />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search…"
          // Labelled rather than left to the placeholder, which stops being
          // readable the moment anything is typed into the field.
          aria-label="Search conversations"
          className="h-full w-full bg-transparent text-[13px] text-fg placeholder:text-fg-subtle focus:outline-none"
        />
      </div>

      {/* `aria-pressed` rather than a radiogroup: these read as toggles, and
          the pressed one is the narrowing currently applied. */}
      <div className="flex flex-wrap gap-1.5">
        {CONVERSATION_CHIPS.map(({ id, label }) => {
          const active = id === chip;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => onChip(id)}
              className={cn(
                "rounded-full border px-2.5 py-[3px] text-[12px] transition-colors duration-[120ms]",
                active
                  ? "border-accent bg-accent/15 text-accent"
                  : "border-line text-fg-subtle hover:bg-surface hover:text-fg",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ConversationFilters;
