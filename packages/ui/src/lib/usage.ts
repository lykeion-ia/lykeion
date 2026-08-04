import type { AgentUsage } from "@lykeion/api";
import { agentAvatar } from "./assignee";

/** Presentation row for the Leaderboard — real per-agent usage projected into
 *  a deterministic avatar plus formatted figures and a bar fraction. */
export interface LeaderboardRow {
  agentId: string;
  name: string;
  initial: string;
  gradient: [string, string];
  tokens: string;
  frac: number;
  cost: string;
  time: string;
  tasks: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatDuration(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = Math.round(totalMinutes % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/** Map real per-agent usage into leaderboard rows, highest-tokens first. The
 *  bar fraction is normalized against the top agent. */
export function toLeaderboardRows(agents: AgentUsage[]): LeaderboardRow[] {
  const sorted = agents.slice().sort((a, b) => b.tokens - a.tokens);
  const max = Math.max(0, ...sorted.map((a) => a.tokens));
  return sorted.map((a) => {
    const av = agentAvatar(a.agent);
    return {
      agentId: a.agent,
      name: av.label,
      initial: av.initial,
      gradient: av.gradient,
      tokens: formatTokens(a.tokens),
      frac: max > 0 ? a.tokens / max : 0,
      cost: `$${a.cost.toFixed(2)}`,
      time: formatDuration(a.timeMinutes),
      tasks: a.tasks,
    };
  });
}
