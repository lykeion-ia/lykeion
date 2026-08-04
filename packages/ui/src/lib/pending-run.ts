/**
 * A one-shot hand-off for a run started from a Study's composer: the Study
 * surface mints a Task, stashes the first prompt here, then navigates to that
 * Task's route, where the Task surface picks it up and auto-starts the run
 * (the transition from a composer on the Study page to the full chat). Keyed
 * by task id — the Task is the chat, so there is nothing else to key on.
 */
export interface PendingRun {
  prompt: string;
  planMode: boolean;
  agent: string | null;
  model: string | null;
}

const pending = new Map<string, PendingRun>();

export function stashRun(taskId: string, run: PendingRun): void {
  pending.set(taskId, run);
}

/** Take (and clear) the pending run for a Task, if any. */
export function takeRun(taskId: string): PendingRun | undefined {
  const run = pending.get(taskId);
  if (run) pending.delete(taskId);
  return run;
}
