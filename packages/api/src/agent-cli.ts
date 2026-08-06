/**
 * A coding-agent CLI detected on the researcher's machine — the ACP backend a
 * run can be routed to (Claude Code, Codex, Gemini, Copilot, Cursor, …). Real-
 * data-ready: the in-memory implementation detects none (returns empty); a
 * real implementation would probe PATH for known ACP agents and report which
 * are installed, and which of those can actually be reached over ACP.
 * camelCase on the wire. No CLIs are ever seeded — an install with nothing
 * detected is empty.
 */
/**
 * One thing an agent lets a session change about how it works — its model,
 * its reasoning effort, its own mode. Normalised from what the session
 * advertised, so nothing downstream knows which of the two wire mechanisms
 * produced it, including the setter.
 */
export interface AgentOption {
  id: string;
  /** "model", "thought_level", "mode", … — what the option governs. */
  category: string;
  /** Absent when the session named no current value, never `null`. */
  currentValue?: string;
  choices: Array<{ value: string; label: string; description?: string }>;
}

export interface AgentCli {
  id: string;
  name: string;
  /** The launch command probed on PATH (e.g. "claude", "gemini"). */
  command: string;
  /** Detected version, or "" when unknown / not installed. */
  version: string;
  /** Whether the CLI is installed and launchable on this machine. */
  available: boolean;
  /** The machine this command was found on. */
  runtimeId: string;
  /** Whether a run can actually be started against this CLI: its ACP adapter
   *  resolved on PATH and answered `initialize`. A CLI can be `available`
   *  and still not be this — the adapter that speaks ACP for it is a
   *  separate program, found and asked separately. */
  sessionReady: boolean;
  /** Why `sessionReady` is false, in words a researcher can act on — the
   *  adapter's own refusal when it has one, or that no adapter was found at
   *  all. Absent when `sessionReady` is true: nothing needs explaining. */
  sessionReadyReason?: string;
  /**
   * What this agent advertised when a session was opened with it. EMPTY when
   * it advertised nothing — a valid agent may offer no choice at all —
   * ABSENT when no session could be opened to ask, which is a different fact
   * and never rendered as the first.
   *
   * Per agent and per machine, for the same reason `sessionReady` is: a
   * machine can hold two adapters that answer differently.
   */
  options?: AgentOption[];
}
