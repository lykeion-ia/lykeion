import { afterEach, expect, it } from "vitest";
import { makeServerLab, type Lab } from "./test-support/test-lab";

const labs: Lab[] = [];
afterEach(async () => {
  for (const lab of labs.splice(0)) await lab.close();
});

/**
 * Read an event stream until it has yielded `count` frames, then abandon it.
 * Raw text rather than `EventSource`, which does not exist in Node — and the
 * raw framing is exactly what this file is checking.
 */
async function readFrames(
  base: string,
  cookie: string,
  count: number,
  headers: Record<string, string> = {},
): Promise<string[]> {
  const controller = new AbortController();
  const res = await fetch(`${base}/events`, {
    headers: { cookie, accept: "text/event-stream", ...headers },
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = "";
  const deadline = setTimeout(() => controller.abort(), 4000);
  try {
    while (frames.length < count) {
      // A read that never yields is what a broken replay looks like from
      // here: the deadline aborts it, and the abort must come back as the
      // frames collected so far rather than as a rejection out of the
      // helper, so the assertion reports the shortfall instead of an
      // AbortError with nothing in it.
      const chunk = await reader.read().catch(() => ({ value: undefined, done: true }));
      const { value, done } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        // Comment lines are the heartbeat, not events.
        if (!frame.startsWith(":")) frames.push(frame);
      }
    }
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
  return frames;
}

/**
 * The tip of the log right now, as a Last-Event-ID string. `makeServerLab`
 * admits a member through a real invite before handing control back, and
 * that invite is itself a recorded change — so a test cannot assume the log
 * is empty at the start and must read its way to the current head instead.
 */
async function headCursor(base: string, cookie: string): Promise<string> {
  const seen = await readFrames(base, cookie, 1, { "last-event-id": "0" });
  return /^id: (\d+)/m.exec(seen[seen.length - 1])![1];
}

it("frames each event with its sequence as the id", async () => {
  // The id line is what the browser echoes back in Last-Event-ID on its own
  // reconnect. Without it the automatic reconnect silently restarts from
  // nothing, and the client cannot tell that it did.
  const lab = await makeServerLab();
  labs.push(lab);
  const before = await headCursor(lab.base, lab.cookie);
  const research = await lab.ownerApi.createResearch({ title: "Framing", key: "FRM" });

  const frames = await readFrames(lab.base, lab.cookie, 1, { "last-event-id": before });

  expect(frames[0]).toMatch(/^id: \d+\n/);
  expect(frames[0]).toContain("event: change");
  expect(frames[0]).toContain(research.id);
});

it("resumes from Last-Event-ID, delivering exactly what was missed", async () => {
  const lab = await makeServerLab();
  labs.push(lab);
  const before = await headCursor(lab.base, lab.cookie);
  const first = await lab.ownerApi.createResearch({ title: "One", key: "ONE" });
  const seenFirst = await readFrames(lab.base, lab.cookie, 1, { "last-event-id": before });
  const cursor = /^id: (\d+)/m.exec(seenFirst[0])![1];

  const second = await lab.ownerApi.createResearch({ title: "Two", key: "TWO" });
  const third = await lab.ownerApi.createResearch({ title: "Three", key: "THR" });

  const resumed = await readFrames(lab.base, lab.cookie, 2, { "last-event-id": cursor });

  const body = resumed.join("\n");
  expect(body).toContain(second.id);
  expect(body).toContain(third.id);
  // The one it already had must not come again: a client that re-applies
  // history cannot tell a replay from a new edit.
  expect(body).not.toContain(first.id);
});

it("sends resync and no change frames when the cursor has aged out", async () => {
  const lab = await makeServerLab({ changeLogRetention: 2 });
  labs.push(lab);
  for (const key of ["ONE", "TWO", "THR", "FOR", "FIV"])
    await lab.ownerApi.createResearch({ title: key, key });

  const frames = await readFrames(lab.base, lab.cookie, 1, { "last-event-id": "1" });

  expect(frames[0]).toContain("event: resync");
  // A partial replay is worse than a refusal, because the gap is invisible
  // from the client's side.
  expect(frames[0]).not.toContain("event: change");
});

it("refuses the stream to nobody", async () => {
  const lab = await makeServerLab();
  labs.push(lab);
  const res = await fetch(`${lab.base}/events`, { headers: { accept: "text/event-stream" } });
  expect(res.status).toBe(401);
});
