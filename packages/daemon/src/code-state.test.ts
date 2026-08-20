import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeCodeState } from "./code-state.js";
import { freshDir as fresh } from "./test-support/fresh-dir";
import { freshRepo as repo } from "./test-support/git-repo";

describe("probeCodeState", () => {
  it("reports not_applicable where no repository backs the workspace", async () => {
    expect(await probeCodeState(fresh())).toEqual({
      status: "unavailable",
      reason: "not_applicable",
    });
  });

  it("reports not_captured for a directory that does not exist", async () => {
    // `git` cannot be started in a directory that is not there, so it never
    // ran and said nothing — the same fact as a machine with no `git` on it,
    // and the same ENOENT. "There is no repository here" is an answer only
    // something that looked can give.
    expect(await probeCodeState(join(fresh(), "gone"))).toEqual({
      status: "unavailable",
      reason: "not_captured",
    });
  });

  it("reads the branch and the commit of a clean tree", async () => {
    const dir = await repo();
    const state = await probeCodeState(dir);
    expect(state.status).toBe("available");
    if (state.status !== "available") throw new Error("unreachable");
    expect(state.value.branch).toBe("trunk");
    expect(state.value.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(state.value.dirty).toBe(false);
  });

  it("calls a tree with an uncommitted change dirty", async () => {
    const dir = await repo();
    writeFileSync(join(dir, "a.txt"), "two\n");
    const state = await probeCodeState(dir);
    if (state.status !== "available") throw new Error("expected available");
    expect(state.value.dirty).toBe(true);
  });

  it("calls a tree with an untracked file dirty", async () => {
    // An untracked file is a change the commit does not describe, which is
    // the whole question `dirty` answers.
    const dir = await repo();
    writeFileSync(join(dir, "b.txt"), "new\n");
    const state = await probeCodeState(dir);
    if (state.status !== "available") throw new Error("expected available");
    expect(state.value.dirty).toBe(true);
  });

  it("reports not_captured where this machine has no git to ask", async () => {
    // A spawn that never happened is `git` saying nothing, which is the fact
    // a timeout carries — not the answer a non-zero exit gives. A machine
    // without `git` on it would otherwise record every cell as running
    // outside a repository, which is a claim about the workspace made by
    // something that never looked at one.
    const dir = await repo();
    const path = process.env.PATH;
    // Emptied rather than unset: an unset PATH falls back to a default
    // search list on some platforms, which could still find `git`.
    process.env.PATH = fresh();
    try {
      expect(await probeCodeState(dir)).toEqual({
        status: "unavailable",
        reason: "not_captured",
      });
    } finally {
      process.env.PATH = path;
    }
  });

  it("reports not_captured rather than hanging when the probe outlives its budget", async () => {
    // Zero is `execFile`'s own sentinel for "no timeout", so it cannot stand
    // for a budget the probe outlives; a real but tiny one does, because a
    // `git` process takes several milliseconds to spawn even for a trivial
    // command.
    const dir = await repo();
    expect(await probeCodeState(dir, { timeoutMs: 1 })).toEqual({
      status: "unavailable",
      reason: "not_captured",
    });
  });
});
