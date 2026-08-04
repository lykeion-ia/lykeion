import type { ReactNode } from "react";

/**
 * The parts a settings tab body is built from — one definition, shared by the
 * tabs in `SettingsView` and by the panels that render as a tab of their own.
 *
 * Its own module for the reason `SettingsSection` is: a panel importing
 * `SettingsView` to reach a row would be importing the file that renders it.
 */

/** A settings row: a labelled fact on the left, its control hard right. */
export function Row({
  label,
  desc,
  control,
  leading,
}: {
  label: string;
  desc?: string;
  control: ReactNode;
  /**
   * Something drawn before the label — a face, a glyph. Given its own slot
   * rather than folded into `label`, because it must sit beside the whole
   * label/description block rather than on the label's first line.
   */
  leading?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-line py-4 last:border-b-0">
      <div className="flex min-w-0 items-center gap-3.5">
        {leading}
        <div className="min-w-0">
          <div className="text-[14px] text-fg">{label}</div>
          {desc && (
            <div className="mt-0.5 max-w-[420px] text-[12px] leading-snug text-fg-subtle">
              {desc}
            </div>
          )}
        </div>
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}

/**
 * The secondary control's box, as a class rather than only as a component.
 *
 * A file input's trigger has to be a `<label>` to stay a real control — a
 * button that clicks a hidden input is not one to a keyboard or a screen reader
 * — and a `<label>` cannot be an `OutlineButton`. Both take their geometry from
 * here so the two sit on one line looking like one set.
 */
export const outlineControlClass =
  "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-line-strong px-3 text-[13px] text-fg hover:bg-surface";

export function OutlineButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${outlineControlClass} disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {children}
    </button>
  );
}

/** Renders a settings value, or a neutral "Not set" when the core has no value
 *  yet (a fresh install) — never invents a placeholder value. */
export function orNotSet(value: string): string {
  return value.trim() === "" ? "Not set" : value;
}
