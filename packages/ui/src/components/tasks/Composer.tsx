import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Toggle } from "../ui/Toggle";
import { NotebookIcon } from "../icons";
import { useOutsideClick } from "../../hooks/useOutsideClick";

/**
 * The rich composer card — a rounded card with a multiline textarea and a
 * toolbar (attach · task settings · [CLI switcher] · send).
 *
 * Two placements share one component:
 * - `hero`   — big, centered, first-message surface (empty conversation).
 * - `docked` — compact, pinned to the bottom of an open thread.
 *
 * The task-settings popover is presentational for now (local state),
 * matching the design; wiring it to real run options is a later step.
 */
export interface ComposerProps {
  variant: "hero" | "docked";
  /**
   * Called with the trimmed prompt when the user sends. `opts.planMode` is the
   * per-message send mode: the plain Send button (and Enter) send with it
   * `false` — a normal run — while the split send button's "Plan first" item
   * sends with it `true`, gating the run through plan → approve → execute.
   * Omitted is treated as a normal run.
   */
  onSend: (text: string, opts?: { planMode?: boolean }) => void;
  disabled?: boolean;
  /**
   * Shown above the input, and blocks sending while it is set. A composer
   * that looks ready when nothing behind it can run promises something the
   * lab cannot deliver, and the researcher's prompt goes nowhere.
   */
  blocker?: ReactNode;
  placeholder?: string;
  /** Right-group slot for the CLI switcher. */
  switcher?: ReactNode;
  /**
   * A run is live — send is replaced by Stop in the same spot, the one place
   * the researcher is already looking. It stays enabled while the rest of the
   * composer is `disabled`, so a hung run is always escapable from here.
   */
  running?: boolean;
  /** Stops the live run. Send only becomes Stop when this is wired. */
  onStop?: () => void;
  /**
   * Controlled draft text. Supply BOTH `draft` and `onDraftChange` to make the
   * parent own the composer's text (e.g. the Task surface refilling it from
   * an Edit action, or holding it while the Research picker is up) — the internal
   * `useState` is bypassed entirely in that case. Supplying only one of the two
   * is treated as uncontrolled, so a caller that passes neither (`ResearchScreen`)
   * needs no change at all.
   */
  draft?: string;
  /** Setter for the controlled draft — see `draft`. */
  onDraftChange?: (text: string) => void;
  /** Attached to the `<textarea>` in addition to the internal ref, so a
   *  controlling parent can imperatively focus it (e.g. after Edit refills
   *  the draft). */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Open the Notebook rail tab (the Research's live shared kernel). When wired, a
   *  Notebook button appears in the composer footer. */
  onOpenNotebook?: () => void;
  /** Trigger-character sources for in-composer references (`@`/`#`/`/`). Only
   *  non-empty sources are offered — see [`MentionSource`]. */
  mentions?: MentionSource[];
}

const MAX_TEXTAREA_PX = 200;

/** One thing a mention menu can insert. */
export interface MentionItem {
  /** Shown in the menu, and what gets inserted after the trigger. */
  label: string;
  /** Optional second line (a description, a row count, a date). */
  description?: string;
}

/**
 * A trigger character and the real things it offers — `@` artifacts, `#`
 * tasks, `/` skills.
 *
 * The SCREEN supplies `items`, because only it knows what actually exists: the
 * Task's own artifacts, the Research's other Tasks, the configured skills. This
 * component owns the trigger detection, the menu and the insertion, and offers a
 * trigger ONLY when its source is non-empty — so a researcher is never shown an
 * affordance that would open an empty list.
 */
export interface MentionSource {
  trigger: "@" | "#" | "/";
  /** The menu's heading, e.g. "Artifacts". */
  label: string;
  items: MentionItem[];
}

/**
 * The active mention query: which source the caret is inside, and the partial
 * word typed after its trigger.
 *
 * A trigger only counts at the start of a word (start of text, or after
 * whitespace) — so an email address, a `#` in a shell command, or a path like
 * `a/b` never opens a menu. `null` when the caret is not in a mention.
 */
function mentionAt(
  text: string,
  caret: number,
  sources: MentionSource[],
): { source: MentionSource; query: string; start: number } | null {
  // Walk back from the caret to the trigger, stopping at whitespace.
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (/\s/.test(ch)) return null;
    const source = sources.find((s) => s.trigger === ch);
    if (source) {
      const atWordStart = i === 0 || /\s/.test(text[i - 1]);
      if (!atWordStart) return null;
      return { source, query: text.slice(i + 1, caret), start: i };
    }
  }
  return null;
}

interface TaskSettings {
  delegation: boolean;
  autoReview: boolean;
  memory: boolean;
}

const Chevron = () => (
  <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
    <path
      d="M3.5 2 6.5 5 3.5 8"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export function Composer({
  variant,
  onSend,
  disabled = false,
  blocker,
  placeholder,
  switcher,
  running = false,
  onStop,
  draft,
  onDraftChange,
  inputRef,
  onOpenNotebook,
  mentions,
}: ComposerProps) {
  const [internalText, setInternalText] = useState("");
  // Controlled only when BOTH `draft` and `onDraftChange` are supplied —
  // supplying just one falls back to the internal state, so an accidental
  // partial wire-up never silently drops keystrokes.
  const text =
    draft !== undefined && onDraftChange !== undefined ? draft : internalText;
  const setText =
    draft !== undefined && onDraftChange !== undefined
      ? onDraftChange
      : setInternalText;
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The per-message send-mode menu (the send button's chevron). "Plan first"
  // is a per-message opt-in — deliberately NOT a persistent setting in the
  // settings popover, so the default stays a plain normal run.
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  // Caret position, tracked so a mention menu knows which word it is inside.
  const [caret, setCaret] = useState(0);
  // Which match is highlighted; Enter takes it, so a mention can be completed
  // without leaving the keyboard.
  const [mentionIndex, setMentionIndex] = useState(0);
  const [settings, setSettings] = useState<TaskSettings>({
    delegation: false,
    autoReview: true,
    memory: false,
  });
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  const sendMenuRef = useRef<HTMLDivElement>(null);

  // Close each popover on an outside click.
  useOutsideClick(settingsRef, () => setSettingsOpen(false), settingsOpen);
  useOutsideClick(sendMenuRef, () => setSendMenuOpen(false), sendMenuOpen);

  // A `blocker` stops a send exactly where `disabled` already does — Enter,
  // the Send button, and the split send's "Plan first" item all route
  // through `submit`/`canSend`, so gating here is the one place that has to
  // change for both a live run and a lab with nothing to run on.
  const blocked = disabled || blocker != null;

  const submit = (planMode = false) => {
    const trimmed = text.trim();
    if (!trimmed || blocked) return;
    onSend(trimmed, { planMode });
    setText("");
    setSendMenuOpen(false);
    if (ref.current) ref.current.style.height = "auto";
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // A mention menu owns the keyboard while it is open: Enter COMPLETES the
    // mention rather than sending the message, which is what makes the
    // affordance usable without reaching for the mouse. Escape dismisses it and
    // hands Enter back.
    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(matches[Math.min(mentionIndex, matches.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Collapse by moving the caret out of the mention word.
        setCaret(-1);
        return;
      }
    }
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  };

  // `onChange` only fires for keystrokes — it never runs when a controlling
  // parent sets `text` itself (Edit refilling the draft from a past prompt).
  // Recomputing height here too, keyed on the resolved text, covers that
  // path as well; for the uncontrolled/typed case it just repeats what
  // `onChange` already did, harmlessly.
  useEffect(() => {
    if (ref.current) autoGrow(ref.current);
  }, [text]);

  const canSend = !blocked && text.trim() !== "";
  const showStop = running && !!onStop;

  // Only sources that actually have something to offer.
  const liveSources = (mentions ?? []).filter((s) => s.items.length > 0);
  const active = mentionAt(text, caret, liveSources);
  const matches = active
    ? active.source.items
        .filter((i) =>
          i.label.toLowerCase().includes(active.query.toLowerCase()),
        )
        .slice(0, 8)
    : [];
  const mentionOpen = active !== null && matches.length > 0;

  /** Replace the partial mention with the chosen label, and keep typing. */
  const insertMention = (item: MentionItem) => {
    if (!active) return;
    const before = text.slice(0, active.start);
    const after = text.slice(caret);
    const inserted = `${active.source.trigger}${item.label} `;
    const next = `${before}${inserted}${after}`;
    setText(next);
    const at = before.length + inserted.length;
    // Put the caret after what we inserted, on the next frame (the textarea
    // still holds the pre-update value until React commits).
    requestAnimationFrame(() => {
      if (!ref.current) return;
      ref.current.focus();
      ref.current.setSelectionRange(at, at);
      setCaret(at);
    });
  };

  return (
    <div className={`composer-card composer-card--${variant}`}>
      {blocker != null && (
        <div className="composer-blocker" role="status">
          {blocker}
        </div>
      )}
      <textarea
        ref={(el) => {
          ref.current = el;
          if (inputRef) inputRef.current = el;
        }}
        className="composer-textarea"
        rows={variant === "hero" ? 3 : 1}
        aria-label="Message the agent"
        // Every affordance named here is real: `@`/`#`/`/` open the mention
        // menu (see `mentions`), and ⌘K is bound app-wide in `Shell`. A screen
        // that supplies no `mentions` overrides this with its own placeholder
        // rather than advertising triggers that would open nothing.
        placeholder={
          placeholder ??
          "Ask anything — @ for artifacts, # for tasks, / for skills, ⌘K to search…"
        }
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setMentionIndex(0);
          autoGrow(e.target);
        }}
        // Clicking or arrowing around moves the caret out of (or into) a
        // mention word without changing the text, so the menu must follow.
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
      />

      {mentionOpen && active && (
        <div
          className="mention-menu"
          role="listbox"
          aria-label={active.source.label}
          data-testid="mention-menu"
        >
          <div className="mention-menu-head">{active.source.label}</div>
          {matches.map((item, i) => (
            <button
              key={item.label}
              type="button"
              role="option"
              aria-selected={i === Math.min(mentionIndex, matches.length - 1)}
              className={`mention-item${
                i === Math.min(mentionIndex, matches.length - 1)
                  ? " is-active"
                  : ""
              }`}
              // `onMouseDown`, not `onClick`: the textarea must not lose focus
              // before the insertion runs.
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(item);
              }}
            >
              <span className="mention-item-label">{item.label}</span>
              {item.description && (
                <span className="mention-item-desc">{item.description}</span>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="composer-toolbar">
        <div className="composer-tools">
          <button
            type="button"
            className="composer-icon-btn"
            title="Attach file"
            aria-label="Attach file"
            disabled={disabled}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M12.5 7.4 8.1 11.8a2.6 2.6 0 0 1-3.7-3.7l4.6-4.6a1.7 1.7 0 0 1 2.4 2.4L6.7 10.6a0.85 0.85 0 0 1-1.2-1.2l4-4"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          <div className="composer-settings" ref={settingsRef}>
            <button
              type="button"
              className="composer-icon-btn composer-settings-btn"
              title="Task settings"
              aria-label="Task settings"
              aria-expanded={settingsOpen}
              disabled={disabled}
              onClick={() => setSettingsOpen((o) => !o)}
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                <rect
                  x="2"
                  y="2"
                  width="4.3"
                  height="4.3"
                  rx="1"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <rect
                  x="8.7"
                  y="2"
                  width="4.3"
                  height="4.3"
                  rx="1"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <rect
                  x="2"
                  y="8.7"
                  width="4.3"
                  height="4.3"
                  rx="1"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
                <rect
                  x="8.7"
                  y="8.7"
                  width="4.3"
                  height="4.3"
                  rx="1"
                  stroke="currentColor"
                  strokeWidth="1.2"
                />
              </svg>
              <span className="composer-settings-dot" aria-hidden="true" />
            </button>

            {settingsOpen && (
              <div className="composer-popover" role="menu">
                <div className="cpop-row">
                  <span className="cpop-label">Delegation</span>
                  <Toggle
                    on={settings.delegation}
                    onToggle={(v) =>
                      setSettings((s) => ({ ...s, delegation: v }))
                    }
                    ariaLabel="Delegation"
                  />
                </div>
                <div className="cpop-row">
                  <span className="cpop-label">Auto-review</span>
                  <Toggle
                    on={settings.autoReview}
                    onToggle={(v) =>
                      setSettings((s) => ({ ...s, autoReview: v }))
                    }
                    ariaLabel="Auto-review"
                  />
                </div>
                <button type="button" className="cpop-select">
                  <span className="cpop-label">Reviewer model</span>
                  <span className="cpop-value">
                    Default <Chevron />
                  </span>
                </button>
                <div className="cpop-row">
                  <span className="cpop-label">Memory</span>
                  <Toggle
                    on={settings.memory}
                    onToggle={(v) => setSettings((s) => ({ ...s, memory: v }))}
                    ariaLabel="Memory"
                  />
                </div>
                <div className="cpop-divider" />
                <button type="button" className="cpop-select">
                  <span className="cpop-label">Specialist</span>
                  <span className="cpop-value">
                    None <Chevron />
                  </span>
                </button>
                <button type="button" className="cpop-select">
                  <span className="cpop-label">Compute</span>
                  <span className="cpop-value">
                    Local <Chevron />
                  </span>
                </button>
              </div>
            )}
          </div>

          {onOpenNotebook && (
            <button
              type="button"
              className="composer-icon-btn"
              title="Notebook — the Research's shared kernels"
              aria-label="Open notebook"
              disabled={disabled}
              onClick={onOpenNotebook}
            >
              <NotebookIcon />
            </button>
          )}
        </div>

        <div className="composer-tools">
          {switcher}
          {showStop ? (
            <button
              type="button"
              className="composer-send composer-send--stop"
              title="Stop"
              aria-label="Stop"
              onClick={onStop}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect
                  x="4.75"
                  y="4.75"
                  width="6.5"
                  height="6.5"
                  rx="1.5"
                  fill="currentColor"
                />
              </svg>
            </button>
          ) : null}
          {(
            <div className="composer-send-group" ref={sendMenuRef}>
              <button
                type="button"
                className="composer-send composer-send--split"
                title="Send"
                aria-label="Send"
                onClick={() => submit(false)}
                disabled={!canSend}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 13V3.5M8 3.5 4.5 7M8 3.5 11.5 7"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="composer-send-caret"
                title="Send options"
                aria-label="Send options"
                aria-expanded={sendMenuOpen}
                disabled={disabled}
                onClick={() => setSendMenuOpen((o) => !o)}
              >
                <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                  <path
                    d="M2.5 6.5 5 3.5 7.5 6.5"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>

              {sendMenuOpen && (
                <div className="composer-send-menu" role="menu">
                  <button
                    type="button"
                    className="csend-item"
                    aria-label="Plan first"
                    onClick={() => submit(true)}
                    disabled={!canSend}
                  >
                    <span className="csend-item-label">Plan first</span>
                    <span className="csend-item-desc">
                      Review a plan before running
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Composer;
