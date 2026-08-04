/**
 * Workspace usage analytics for the Usage screen. `UsagePoint` is one day of
 * token spend (in thousands, "K" units); `AgentUsage` rolls up per-agent
 * totals. Empty on a fresh install.
 */
export interface UsagePoint {
  day: string;
  input: number;
  output: number;
}

export interface AgentUsage {
  /** Agent name (references `Agent.name`). */
  agent: string;
  tokens: number;
  /** USD. */
  cost: number;
  timeMinutes: number;
  tasks: number;
}

/** One person's share of the lab's spend. */
export interface UserUsage {
  /** The `User.id` this rolls up. */
  userId: string;
  tokens: number;
  /** USD. */
  cost: number;
  timeMinutes: number;
  tasks: number;
}

export interface Usage {
  series: UsagePoint[];
  agents: AgentUsage[];
  /** Per-person totals. Empty until runs are attributed. */
  users: UserUsage[];
}
