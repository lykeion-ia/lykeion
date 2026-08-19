/**
 * Where signing in puts you. The rule is small and the consequences of
 * getting it wrong are not: too eager and it eats a link somebody clicked,
 * too shy and a member with no machine lands on work they cannot run.
 */

import { describe, expect, it } from "vitest";
import { createInMemoryApi, type LykeionApi, type Machine } from "@lykeion/api";
import { hasDestination, landingHash } from "./landing";

const machine = (ownerId: string): Machine => ({
  id: `rt_${ownerId}`,
  name: "Mac.lan",
  platform: "macos-aarch64",
  ownerId,
  health: "online",
  lastSeenTs: 1,
  daemonVersion: "0.1.0",
  capabilities: [],
});

/** The in-memory core with a roster this test controls. */
function apiWith(machines: Machine[]): LykeionApi {
  const base = createInMemoryApi();
  return { ...base, async listMachines() { return machines; } };
}

describe("landingHash", () => {
  it("sends a member with no machine to Machines", async () => {
    expect(await landingHash(apiWith([]))).toBe("#/machines");
  });

  it("leaves a member who has a machine where they were going", async () => {
    const api = apiWith([]);
    const me = await api.currentUser();
    expect(await landingHash(apiWith([machine(me.id)]))).toBeNull();
  });

  it("counts only your own machines, not the lab's", async () => {
    // Machines are owned: only the member who paired one can run on it. A
    // colleague's laptop is no reason to stop telling this person how to
    // add theirs.
    expect(await landingHash(apiWith([machine("u_someone_else")]))).toBe("#/machines");
  });

  it("stays out of the way when the lab cannot be asked", async () => {
    // Onboarding is worth a redirect. It is not worth swallowing somebody's
    // destination because one request did not come back.
    const base = createInMemoryApi();
    const failing: LykeionApi = {
      ...base,
      async listMachines(): Promise<Machine[]> {
        throw new Error("the lab is not answering");
      },
    };
    expect(await landingHash(failing)).toBeNull();
  });
});

describe("hasDestination", () => {
  it("treats an empty or bare hash as no destination", () => {
    expect(hasDestination("")).toBe(false);
    expect(hasDestination("#")).toBe(false);
    expect(hasDestination("#/")).toBe(false);
  });

  it("treats anything addressed as a destination to keep", () => {
    // Signing in is also what happens when somebody opens a link to a Task
    // and turns out not to be signed in. That link is a choice already made.
    expect(hasDestination("#/researches/s_1/tasks/t_2")).toBe(true);
    expect(hasDestination("#/machines")).toBe(true);
    expect(hasDestination("#/researches")).toBe(true);
  });
});
