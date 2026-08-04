/**
 * A coding-agent CLI detected on the researcher's machine — the ACP backend a
 * run can be routed to (Claude Code, Codex, Gemini, Copilot, Cursor, …). Real-
 * data-ready: the in-memory implementation detects none (returns empty); a
 * real implementation would probe PATH for known ACP agents and report which
 * are installed. camelCase on the wire. No CLIs are ever seeded — an install
 * with nothing detected is empty.
 */
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
}
