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
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-4">
      <div className="w-full max-w-[360px]">
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
