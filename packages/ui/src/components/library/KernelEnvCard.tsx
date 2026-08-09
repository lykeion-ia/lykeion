import type { KernelEnvStatus, Language } from "@lykeion/api";
import { ChipIcon } from "../icons";
import { cn } from "../../lib/utils";

interface StateMeta {
  label: string;
  dotClass: string;
  textClass: string;
}

const STATE_META: Record<KernelEnvStatus["state"], StateMeta> = {
  ready: { label: "Ready", dotClass: "bg-success", textClass: "text-success" },
  broken: { label: "Needs setup", dotClass: "bg-warn", textClass: "text-warn" },
  absent: {
    label: "Not set up",
    dotClass: "bg-fg-tertiary",
    textClass: "text-fg-tertiary",
  },
};

function languageLabel(language: Language): string {
  return language === "r" ? "R" : "Python";
}

/**
 * One managed environment, as a row under the machines that run kernels in
 * it. Renders whatever the core reports and nothing else: `absent` on a fresh
 * install, `ready` with the resolved version and package count once
 * provisioned, `broken` for a provision that was interrupted. Read-only — the
 * Set-up action belongs to the surface a researcher is held up on, which is
 * the Notebook rail.
 */
export function KernelEnvCard({ status }: { status: KernelEnvStatus }) {
  const meta = STATE_META[status.state];
  // The language is already named beside the environment's own name, so the
  // version stands on its own here rather than repeating it.
  const facts = [
    status.version,
    status.packageCount != null ? `${status.packageCount} packages` : null,
    status.platform && status.platform !== "unknown" ? status.platform : null,
  ].filter((f): f is string => f !== null && f !== undefined);

  return (
    <div className="flex items-center gap-3 border-b border-line-soft py-2.5">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md border border-line bg-surface-2 text-fg-tertiary">
        <ChipIcon width={13} height={13} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="truncate font-mono text-meta text-fg">{status.name}</span>
          <span className="shrink-0 text-meta text-fg-tertiary">
            {languageLabel(status.language)} · {status.manager}
          </span>
        </span>
        {/* The env's own path, and nothing about who is bound to it. Whether
            a kernel is running in this environment is a fact about a kernel,
            and the rows above are where a kernel says so — a line here
            claiming the agent and the Notebook share it would be asserting a
            binding this card cannot see. */}
        {status.root && (
          <span className="truncate font-mono text-meta text-fg-tertiary">{status.root}</span>
        )}
      </div>
      {facts.length > 0 && (
        <span className="shrink-0 text-meta tabular-nums text-fg-tertiary">
          {facts.join(" · ")}
        </span>
      )}
      <span
        className={cn("inline-flex shrink-0 items-center gap-1.5 text-meta", meta.textClass)}
      >
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dotClass)} />
        {meta.label}
      </span>
    </div>
  );
}

export default KernelEnvCard;
