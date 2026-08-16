import {
  LykeionError,
  cleanSummaryTitle,
  promptNeedsSummary,
  titleFromPrompt,
  type LykeionApi,
} from "@lykeion/api";
import type { Deps } from "./index";
import type { Store } from "../store/store";
import { nextSeq } from "../store/migrations";
import { healthFor } from "../machine-health";
import { resolveMachineForAgent } from "./sessions";

export type TaskNamingApi = Pick<LykeionApi, "nameTask">;

/** The Task's own name right now, or `undefined` for a Task that is not
 *  there. Read twice per naming — once before the ask and once after the
 *  answer — because the seconds in between are a researcher's to type in. */
function titleOf(store: Store, taskId: string): string | undefined {
  const row = store.get(`SELECT title FROM tasks WHERE id = ?`, [taskId]);
  return row === undefined ? undefined : (row.title as string);
}

/**
 * Naming a Task after the message that started it.
 *
 * This is the one method in the contract whose ordinary answer is "nothing
 * happened". Everything it depends on is allowed to be missing — a machine to
 * ask, a machine that is awake, a CLI that answers, an answer that is usable,
 * a Task still carrying the name this was asked about — and none of those
 * absences is an error, because the Task is already correctly named and the
 * whole of this feature is an improvement on that. So the body reads as a run
 * of guards that each return `null`, and only the last few lines write
 * anything.
 *
 * It is kept out of `tasks.ts` deliberately. Everything there is storage — a
 * write, a read back, a number. This reaches off the machine, waits on a
 * person's laptop, and has an opinion about what a title should look like;
 * folding that in beside `createTask` would put the one method that can take
 * thirty seconds in the same file as the ones that cannot take a millisecond.
 */
export function taskNamingApi(deps: Deps): TaskNamingApi {
  const { store, actor, now, runs, titles } = deps;
  const { record } = deps.changes;
  return {
    async nameTask(input) {
      const before = titleOf(store, input.taskId);
      if (before === undefined)
        throw new LykeionError("not-found", `no such task: ${input.taskId}`);

      // The name this Task would have been given by the surface that sent the
      // message. Everything below compares against it: it is what makes "the
      // Task still carries a derived name" a question with an answer, rather
      // than a flag on the row that a rename would have to remember to clear.
      const derived = titleFromPrompt(input.prompt);
      if (!promptNeedsSummary(input.prompt)) return null;
      if (before !== derived) return null;

      const resolved = resolveMachineForAgent(store, input.agent, actor.userId);
      // Three ways there is no machine to ask, and all three are the same
      // answer. Not an error even for the ownership one, which `startRun`
      // does refuse over: a run a colleague's machine could have taken is
      // work that did not happen, while a naming that does not happen costs
      // a Task nothing but a better name.
      if (!resolved) return null;
      if (resolved.ownerId !== actor.userId) return null;
      if (healthFor(resolved.lastSeenTs, now()) === "offline") return null;

      const requestId = `ntreq_${nextSeq(store)}`;
      // `deliverNow`, never `enqueue`. A naming that cannot be delivered this
      // second should not be delivered later: by the time a machine next
      // connects, the Task has been named — by its prompt, or by a person —
      // and a summary arriving then is at best redundant and at worst a
      // rename nobody asked for, of a chat they have since moved on from.
      const delivered = runs.deliverNow(resolved.machineId, {
        type: "name-task",
        runId: requestId,
        taskId: input.taskId,
        prompt: input.prompt,
        agent: resolved.agent,
      });
      if (!delivered) return null;

      const answered = await titles.await(resolved.machineId, requestId);
      if (answered === null) return null;
      const title = cleanSummaryTitle(answered);
      if (title === null) return null;

      // Read the Task again rather than trusting `before`. The await above is
      // seconds long, and those seconds are exactly when a researcher renames
      // the chat they have just started, or deletes it — either way what they
      // did wins over what a machine was in the middle of suggesting.
      return store.tx(() => {
        const current = titleOf(store, input.taskId);
        if (current === undefined || current !== derived) return null;
        if (title === current) return null;
        store.run(`UPDATE tasks SET title = ?, updated_ts = ? WHERE id = ?`, [
          title,
          now(),
          input.taskId,
        ]);
        // The ordinary Task change, not one of its own: every surface already
        // re-reads on this, so the tab strip and the Task list rename
        // themselves with nothing new to teach them.
        record("task-updated", { taskId: input.taskId });
        return title;
      });
    },
  };
}
