import type { KernelEnvStatus } from "@lykeion/api";
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

/**
 * The managed Python environment's status card — Lykeion's own uv-provisioned
 * interpreter, shared by the agent and the Notebook. Renders whatever the core
 * reports: `absent` on a fresh install (nothing faked), `ready` with the
 * resolved version + package count once provisioned. The Set-up action itself
 * lands with the Notebook surface (K4); this is the read-only status.
 */
export function KernelEnvCard({ status }: { status: KernelEnvStatus }) {
  const meta = STATE_META[status.state];
  const facts = [
    status.python ? `Python ${status.python}` : null,
    status.packageCount != null ? `${status.packageCount} packages` : null,
    status.platform && status.platform !== "unknown" ? status.platform : null,
  ].filter((f): f is string => f !== null);

  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-line bg-surface p-4">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-line bg-surface-2 text-fg-subtle">
        <ChipIcon width={16} height={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-fg">
            Managed Python environment
          </span>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 text-[12px]",
              meta.textClass,
            )}
          >
            <span
              className={cn("h-2 w-2 shrink-0 rounded-full", meta.dotClass)}
            />
            {meta.label}
          </span>
        </div>
        <p className="mt-0.5 text-[12px] leading-relaxed text-fg-subtle">
          Lykeion&rsquo;s own isolated interpreter and scientific stack — the
          agent and your Notebook share it, and every run records its exact
          packages.
        </p>
        {facts.length > 0 && (
          <p className="mt-1 text-[12px] text-fg-muted">{facts.join(" · ")}</p>
        )}
        {status.root && (
          <p className="mt-1 truncate font-mono text-[11px] text-fg-tertiary">
            {status.root}
          </p>
        )}
      </div>
    </div>
  );
}

export default KernelEnvCard;
