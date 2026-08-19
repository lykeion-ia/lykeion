import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

/**
 * The single primary action button — the accent "New …" / "Add …" CTA shared
 * across every screen header (Studies, Groups, Agents, Skills, Connectors,
 * My Tasks). One definition keeps them identical.
 */
export const primaryActionClass =
  "inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-sub font-medium text-white transition-opacity hover:opacity-90";

export function PrimaryButton({
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(primaryActionClass, className)}
      {...props}
    />
  );
}

export default PrimaryButton;
