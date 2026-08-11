import type { LykeionApi } from "@lykeion/api";

/**
 * Ask the lab to name a chat after the message that just started it.
 *
 * Deliberately returns nothing. Naming is not part of the send: the Task has
 * already been created under its prompt-derived name and the turn is already
 * on its way, and this is an improvement on that name which may take a couple
 * of seconds, may be declined, and may never come at all. A caller that
 * awaited it would be making a researcher wait on a title before their work
 * begins, and a caller that handled its failure would be writing an error
 * message about a Task that is correctly named.
 *
 * `onNamed` fires only when a name was really written. In a real lab the
 * rename also arrives on the change channel, so every other open tab repaints
 * itself; `onNamed` is for the surface that asked, which knows things the
 * channel does not — which tab in its own strip this Task is, and that it
 * should stop showing the prompt it just cut down.
 */
export function nameChatAfterFirstMessage(
  api: LykeionApi,
  taskId: string,
  prompt: string,
  /** The agent the send resolved to, so naming lands on the same machine the
   *  turn runs on. `null` — nothing selected yet — leaves the lab to pick. */
  agent: string | null,
  onNamed: (title: string) => void,
): void {
  void api.nameTask({ taskId, prompt, ...(agent === null ? {} : { agent }) }).then(
    (title) => {
      if (title !== null) onNamed(title);
    },
    () => {
      // Best effort, by design. The chat keeps the name its own first message
      // gave it, which is the name it would have had anyway.
    },
  );
}
