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
  /**
   * `User.id` of every colleague in this group. Empty rather than absent, the
   * way `memberAgents` is: a group with nobody in it and a group that has not
   * been asked are the same thing here, and one spelling for it means no
   * reader has to tell them apart.
   *
   * Ids, not names — a colleague may be renamed and an Agent may be named
   * after a person, which is why assignees keep the two in separate
   * namespaces (`lib/assignee.ts`).
   */
  memberUsers: string[];
  createdTs: number;
  updatedTs: number;
}
