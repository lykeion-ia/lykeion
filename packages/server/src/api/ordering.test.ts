import { afterAll, expect, it } from "vitest";
import { makeServerApi } from "../test-support/server-api";

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const done of cleanups.splice(0)) await done();
});

/**
 * The harness from `conformance.test.ts`, with the server's clock pinned to
 * one fixed second — the one case a real clock cannot reliably produce, so
 * it is the only way to tell a real insertion-sequence tiebreak apart from
 * an assertion that happens to pass because two real-clock writes rarely
 * land in the same second.
 */
async function makeServerApiWithFixedClock(base: number) {
  const handle = await makeServerApi(() => base);
  cleanups.push(handle.close);
  return handle.api;
}

it("puts the later of two Researches opened in one second first", async () => {
  // A real clock returns the same second for both. Without the insertion
  // sequence in the ORDER BY, the answer is whatever the page happens to
  // hold, and the assertion passes or fails by accident.
  const api = await makeServerApiWithFixedClock(1_800_000_000);
  const first = await api.createResearch({ title: "First", key: "ONE" });
  const second = await api.createResearch({ title: "Second", key: "TWO" });
  const listed = await api.listResearches();
  expect(listed.map((s) => s.id)).toEqual([second.id, first.id]);
});
