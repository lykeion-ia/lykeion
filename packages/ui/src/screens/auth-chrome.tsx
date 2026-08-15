import type { ReactNode } from "react";
import { cn } from "../lib/utils";

/**
 * The pieces the account-doorway screens are built from — sign-in, setup,
 * join — plus PairScreen, which borrows the same chrome-less presentation
 * for a different reason: it stands in for the workbench rather than
 * gating it. None of the shell's own chrome — rail, header, panels — fits
 * any of them, and without one shared definition they would drift into
 * four different front doors.
 */

export function AuthShell({
  title,
  subtitle,
  children,
  framed = true,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  /**
   * Whether this shell owns the whole window.
   *
   * True everywhere it is the only thing on screen — signing in, joining by
   * invite, approving a machine. False inside the setup wizard, which already
   * centres its content in a full-height column with a footer under it: a
   * second `min-h-screen` in there makes the page taller than the window and
   * pushes that footer, and with it the progress strip, below the fold. The
   * strip is the one thing on those screens that says how far along the
   * researcher is, and it was invisible on exactly the step that needed it.
   */
  framed?: boolean;
}) {
  return (
    <div className={framed ? "grid min-h-screen place-items-center bg-canvas px-4" : undefined}>
      {/* The narrow measure is this shell's own, for when it owns the window:
          a sign-in form centred in an empty page reads better at 360px than
          at full width. Inside the wizard it is wrong twice over — the column
          around it is already 560px and already centred, so a narrower block
          sits against its left edge while the dots below centre on the
          column, and every other step of the flow fills that column. */}
      <div className={framed ? "w-full max-w-[360px]" : "w-full"}>
        <h1 className="text-title font-semibold tracking-[-0.2px] text-fg">{title}</h1>
        <p className="mb-5 mt-1 text-ui text-fg-muted">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  type,
  value,
  onChange,
  autoFocus,
  hint,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-meta font-medium uppercase tracking-[0.4px] text-fg-tertiary">{label}</span>
      <input
        type={type}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-line bg-surface-2 px-2 py-1.5 text-ui text-fg outline-none focus:border-line-strong focus-visible:outline-none!"
      />
      {hint && <span className="text-meta text-fg-subtle">{hint}</span>}
    </label>
  );
}

export function SubmitButton({
  busy,
  idle,
  working,
}: {
  busy: boolean;
  idle: string;
  working: string;
}) {
  return (
    <button
      type="submit"
      disabled={busy}
      className={cn(
        "mt-1 rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity",
        busy ? "cursor-not-allowed opacity-40" : "hover:opacity-90",
      )}
    >
      {busy ? working : idle}
    </button>
  );
}
