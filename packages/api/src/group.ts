/**
 * A Group — a collaborative unit with a lead Agent and optional additional
 * members. Lead/members reference `Agent.name` (agents are name-keyed; there
 * is no agent id).
 */
export interface Group {
  id: string;
  name: string;
  description: string;
  /** Agent name of the lead; undefined until one is assigned. */
  leadAgent?: string;
  /** Agent names of additional members. */
  memberAgents: string[];
  createdTs: number;
  updatedTs: number;
}
