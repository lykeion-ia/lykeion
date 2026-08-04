/**
 * The models a detected agent CLI can be run with — the source for the
 * composer's model switcher. Keyed by the CLI's stable id (the same ids ACP
 * detection reports). This is real reference data, not seeded state: `value` is
 * the argument the CLI's launcher accepts (e.g. Claude Code's `--model <value>`).
 *
 * Only CLIs whose launcher honours a model override appear here. Today that is
 * the native `claude` adapter (`--model`); every other CLI speaks ACP, which
 * exposes models dynamically per session (see the follow-up spec) — those return
 * an empty list and the switcher shows a disabled "Default".
 */
export interface CliModel {
  /** The launcher argument (Claude Code `--model` alias). */
  value: string;
  /** The label shown in the switcher. */
  label: string;
  /** A one-line note on when to reach for this model. */
  desc: string;
}

const CATALOG: Record<string, CliModel[]> = {
  // Claude Code accepts stable aliases that track the latest of each tier.
  claude: [
    { value: "opus", label: "Opus 5", desc: "For complex tasks" },
    {
      value: "sonnet",
      label: "Sonnet 5",
      desc: "Most efficient for everyday tasks",
    },
    { value: "haiku", label: "Haiku 4.5", desc: "Fastest for quick answers" },
  ],
};

/** The selectable models for a CLI id, or `[]` when it has no static catalog. */
export function modelsForCli(cliId: string | null): CliModel[] {
  return (cliId && CATALOG[cliId]) || [];
}

/** The label for a selected model value under a CLI, or null when unknown. */
export function modelLabel(
  cliId: string | null,
  value: string | null,
): string | null {
  if (!value) return null;
  return modelsForCli(cliId).find((m) => m.value === value)?.label ?? null;
}
