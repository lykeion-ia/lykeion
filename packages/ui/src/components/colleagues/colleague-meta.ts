import type { Machine, Member, Research, Task } from "@lykeion/api";

/** One colleague's row: who they are, and what the lab has them on. */
export interface ColleagueRow {
  member: Member;
  /** Assigned and not done — what the row's label reports. */
  openCount: number;
  /** Assigned and done — the numerator of the bar beside it. */
  doneCount: number;
  totalCount: number;
  /** `Research.key` for every research line they hold a Task in, in the
   *  order the research list arrived. */
  researchKeys: string[];
  machineCount: number;
}

/**
 * Fold four lists into one row per member. Pure — the screen fetches, this
 * decides, and `ColleaguesTable` only draws.
 *
 * Work is matched on `kind === "user"` and the id, never on a name: an agent
 * may be named after a person (which is why `assigneeKey` puts the two in
 * separate namespaces), and matching by name would credit that agent's Tasks
 * to the colleague it was named for.
 */
export function deriveColleagueRows(
  members: Member[],
  tasks: Task[],
  researches: Research[],
  machines: Machine[],
): ColleagueRow[] {
  const keyOf = new Map(researches.map((r) => [r.id, r.key]));
  return members.map((member) => {
    const mine = tasks.filter((task) =>
      task.assignees?.some(
        (a) => a.kind === "user" && a.userId === member.user.id,
      ),
    );
    const doneCount = mine.filter((task) => task.status === "done").length;
    // Research order, not task order: two colleagues on the same lines should
    // list them in the same sequence, and the task list's order is incidental.
    const held = new Set(mine.map((task) => task.researchId));
    const researchKeys = researches
      .filter((r) => held.has(r.id))
      .map((r) => keyOf.get(r.id)!);
    return {
      member,
      openCount: mine.length - doneCount,
      doneCount,
      totalCount: mine.length,
      researchKeys,
      machineCount: machines.filter((m) => m.ownerId === member.user.id).length,
    };
  });
}
