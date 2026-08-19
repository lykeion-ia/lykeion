/**
 * The contract's conformance suite. Any implementation of `LykeionApi` can be
 * held to it, which is what keeps two implementations from drifting apart:
 * a behaviour asserted here is asserted of all of them.
 *
 * Assertions must describe relationships, never literal ids or timestamps.
 * One implementation numbers ids from a counter and holds a fixed clock so
 * its tests are stable; another will not. An assertion that only one can
 * satisfy is a defect in this file, not in the implementation that fails it.
 *
 * Every test builds the content it checks — a fresh implementation starts
 * empty, so nothing here may assume seeded researches, tasks, members, or
 * inbox items exist already.
 *
 * What `makeApi()` must provide
 * -----------------------------
 * Two properties of the harness are load-bearing, and a suite run against a
 * harness that lacks either fails for reasons that have nothing to do with
 * the implementation under test:
 *
 * 1. **Isolation.** Each call returns an instance whose state is independent
 *    of every other instance this suite has made. The theme test writes on
 *    one instance and reads a second one to show a theme is personal rather
 *    than global, which only means anything if the two do not share a store.
 * 2. **An owner is signed in.** `currentUser()` must resolve to a member
 *    whose role is `"owner"`. The invite and membership tests call
 *    `createInvite`, `listInvites`, `revokeInvite` and `removeMember`, all of
 *    which the contract restricts to an owner, so an implementation that
 *    enforces that restriction rejects every one of them for anybody else.
 *
 * Neither is asserted here — a harness that breaks them makes the suite's own
 * setup unsound, which no assertion inside the suite can repair.
 *
 * The contract is split into areas, one exported function per topic, so an
 * implementation that satisfies part of it can hold itself to exactly the
 * areas it satisfies instead of all-or-nothing. `runContractConformance`
 * runs all of them, less whatever a caller names in `skip`.
 *
 * Two of the areas assert the *absence* of a machine — that machines list
 * empty and a kernel is not ready. An implementation with a real machine
 * behind it fails those, and belongs in a suite of its own rather than this
 * one. The axis these areas divide on is not how much an implementation can
 * do; it is what a lab with storage and nothing else must answer.
 */
import { describe, expect, it } from "vitest";
import type { LykeionApi } from "./api";
import { isLykeionError } from "./errors";
import type { ErrorCode } from "./errors";
import type { RunEvent } from "./run";
import { MAX_TURNS_OUTSTANDING } from "./run";
import { MAX_AVATAR_BYTES } from "./account";
import { titleFromPrompt } from "./task-title";
import type { Language } from "./machine";

/** A real 1×1 PNG, as a data URL. The avatar tests need bytes an
 *  implementation would actually accept, not a plausible-looking string. */
const PNG_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * A rejection is only useful to a caller if it says which kind it is. Every
 * implementation of the contract raises `LykeionError`, so a plain `Error`
 * reaching here is a defect in the implementation, not a looser assertion.
 */
export async function expectRejection(
  promise: Promise<unknown>,
  code: ErrorCode,
  message: RegExp,
): Promise<void> {
  await expect(promise).rejects.toThrow(message);
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isLykeionError(err) && err.code).toBe(code);
}

export function identityConformance(makeApi: () => Promise<LykeionApi>): void {
  it("reports its own identity", async () => {
    const api = await makeApi();
    const info = await api.coreInfo();
    expect(info.name).not.toBe("");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("gives every created research a distinct id", async () => {
    const api = await makeApi();
    const a = await api.createResearch({ title: "One", key: "ONE" });
    const b = await api.createResearch({ title: "Two", key: "TWO" });
    expect(a.id).not.toBe(b.id);
  });
}

export function researchesConformance(makeApi: () => Promise<LykeionApi>): void {
  describe("Researches", () => {
    it("creates a Research naming its author", async () => {
      const api = await makeApi();
      const me = await api.currentUser();
      const research = await api.createResearch({ title: "New line", key: "NEW" });
      expect(research.createdBy).toBe(me.id);
    });

    it("refuses to open a Research with no title", async () => {
      // The same rule an edit is held to. A Research created blank is
      // unfindable in every list that renders a title, and nothing
      // downstream can recover the name its author meant to give it.
      const api = await makeApi();
      const err = await api
        .createResearch({ title: "   ", key: "BLK" })
        .then(() => undefined, (e: unknown) => e);
      expect(isLykeionError(err) && err.code).toBe("invalid");
    });

    it("archiving hides a Research from the list but not from getResearch", async () => {
      const api = await makeApi();
      const research = await api.createResearch({
        title: "Archive me",
        key: "ARC",
      });
      await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Keep me",
      });
      await api.archiveResearch(research.id);
      const listed = await api.listResearches();
      expect(listed.map((s) => s.id)).not.toContain(research.id);
      const detail = await api.getResearch(research.id);
      expect(detail.research.archivedTs).toBeTypeOf("number");
      expect(detail.tasks.length).toBeGreaterThan(0);
    });

    it("archived researches come back when asked for", async () => {
      const api = await makeApi();
      const research = await api.createResearch({
        title: "Archive me",
        key: "ARC",
      });
      await api.archiveResearch(research.id);
      const all = await api.listResearches({ includeArchived: true });
      expect(all.map((s) => s.id)).toContain(research.id);
    });

    it("restoring puts it back", async () => {
      const api = await makeApi();
      const research = await api.createResearch({
        title: "Archive me",
        key: "ARC",
      });
      await api.archiveResearch(research.id);
      const restored = await api.restoreResearch(research.id);
      expect(restored.archivedTs).toBeUndefined();
      expect((await api.listResearches()).map((s) => s.id)).toContain(
        research.id,
      );
    });

    it("archiving twice, and restoring what was never archived, both hold", async () => {
      // Neither end is an error: a second archive leaves it archived and a
      // restore of a listed Research leaves it listed, so a surface can offer
      // either without first reading the state back.
      const api = await makeApi();
      const research = await api.createResearch({ title: "Twice", key: "TWI" });

      const untouched = await api.restoreResearch(research.id);
      expect(untouched.archivedTs).toBeUndefined();

      await api.archiveResearch(research.id);
      const again = await api.archiveResearch(research.id);
      expect(again.archivedTs).toBeTypeOf("number");
      expect((await api.listResearches()).map((s) => s.id)).not.toContain(
        research.id,
      );

      await api.restoreResearch(research.id);
      expect((await api.restoreResearch(research.id)).archivedTs).toBeUndefined();
      expect((await api.listResearches()).map((s) => s.id)).toContain(research.id);

      await expect(api.archiveResearch("s_nope")).rejects.toThrow();
      await expect(api.restoreResearch("s_nope")).rejects.toThrow();
    });

    it("lists researches newest first", async () => {
      const api = await makeApi();
      // Two Researches, not one — a one-element list is trivially "ordered"
      // regardless of whether the implementation sorts at all, which is
      // exactly the class of bug this suite exists to catch (a vanished
      // `.sort()` on a contract method). Only a pair can prove the newer
      // one sorts ahead of the older one.
      const older = await api.createResearch({ title: "Older", key: "OLD" });
      const newer = await api.createResearch({ title: "Newer", key: "NEW" });
      const ids = (await api.listResearches()).map((s) => s.id);
      expect(ids.slice(0, 2)).toEqual([newer.id, older.id]);
    });

    it("updateResearch renames a Research and leaves its key alone", async () => {
      const api = await makeApi();
      const research = await api.createResearch({
        title: "Original title",
        key: "UPD",
      });
      const renamed = await api.updateResearch(research.id, {
        title: "  Auditory cortex remapping  ",
      });
      expect(renamed.title).toBe("Auditory cortex remapping");
      expect(renamed.key).toBe(research.key);
      expect(
        (await api.listResearches()).find((s) => s.id === research.id)?.title,
      ).toBe("Auditory cortex remapping");

      await expect(
        api.updateResearch(research.id, { title: "   " }),
      ).rejects.toThrow();
      await expect(
        api.updateResearch("s_nope", { title: "Anything" }),
      ).rejects.toThrow();
    });

    it("updateResearch writes the agent context back, and leaves it alone when unpatched", async () => {
      const api = await makeApi();
      const research = await api.createResearch({
        title: "Context holder",
        key: "CTX",
        agentContext: "Traces are ΔF/F.",
      });

      const written = await api.updateResearch(research.id, {
        agentContext: "Traces are ΔF/F. Report counts from the summary file.",
      });
      expect(written.agentContext).toBe(
        "Traces are ΔF/F. Report counts from the summary file.",
      );
      // It is the stored Research that changed, not just the returned copy.
      expect((await api.getResearch(research.id)).research.agentContext).toBe(
        "Traces are ΔF/F. Report counts from the summary file.",
      );
      // Patching the context leaves the title where it was…
      expect(written.title).toBe("Context holder");

      // …and a patch that does not mention the context does not clear it.
      const renamed = await api.updateResearch(research.id, { title: "Renamed" });
      expect(renamed.agentContext).toBe(
        "Traces are ΔF/F. Report counts from the summary file.",
      );

      // An empty string is a real value: it clears the context.
      expect((await api.updateResearch(research.id, { agentContext: "" })).agentContext).toBe("");
    });

    it("updateResearch writes the description back, and an empty string clears it", async () => {
      const api = await makeApi();
      const research = await api.createResearch({
        title: "Described",
        key: "DSC",
        description: "Whether visual cortex reallocated to touch.",
      });

      const written = await api.updateResearch(research.id, {
        description: "Whether visual cortex reallocated to touch, in adults.",
      });
      expect(written.description).toBe(
        "Whether visual cortex reallocated to touch, in adults.",
      );
      // It is the stored Research that changed, not just the returned copy.
      expect((await api.getResearch(research.id)).research.description).toBe(
        "Whether visual cortex reallocated to touch, in adults.",
      );

      // A patch that does not mention the description does not clear it.
      expect(
        (await api.updateResearch(research.id, { title: "Renamed" })).description,
      ).toBe("Whether visual cortex reallocated to touch, in adults.");

      // An empty string is a real value: it clears the description.
      expect((await api.updateResearch(research.id, { description: "" })).description).toBe("");
    });

    it("unpinning a Research removes the flag rather than storing a false", async () => {
      // `pinned` is optional on the contract, so "not pinned" has to be one
      // state — the same rule `Task.pinned` is held to. Two implementations
      // that disagree hand two callers different answers for one Research.
      const api = await makeApi();
      const research = await api.createResearch({ title: "Pin me", key: "PNS" });
      expect("pinned" in research).toBe(false);

      const pinned = await api.updateResearch(research.id, { pinned: true });
      expect(pinned.pinned).toBe(true);
      // It is the stored Research that changed, so the list agrees with the patch.
      expect(
        (await api.listResearches()).find((s) => s.id === research.id)?.pinned,
      ).toBe(true);

      const unpinned = await api.updateResearch(research.id, { pinned: false });
      expect("pinned" in unpinned).toBe(false);
    });

    it("pinning a Research does not move it in the list — order is the reader's to group", async () => {
      // Grouping pinned Researches is presentation. The store keeps one order,
      // newest first, so every surface starts from the same sequence.
      const api = await makeApi();
      const older = await api.createResearch({ title: "Older", key: "OLD" });
      const newer = await api.createResearch({ title: "Newer", key: "NEW" });

      await api.updateResearch(older.id, { pinned: true });
      const ids = (await api.listResearches()).map((s) => s.id);
      expect(ids.slice(0, 2)).toEqual([newer.id, older.id]);
    });

    it("deleteResearch removes the Research, its Tasks, and excludes it from myWork and conversations", async () => {
      const api = await makeApi();
      const me = await api.currentUser();
      const research = await api.createResearch({ title: "Doomed", key: "DEL" });
      const other = await api.createResearch({
        title: "Untouched",
        key: "OK",
      });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Gone with it",
        assignees: [{ kind: "user", userId: me.id }],
      });
      expect((await api.getResearch(research.id)).tasks.length).toBeGreaterThan(
        0,
      );

      await api.deleteResearch(research.id);

      expect((await api.listResearches()).map((s) => s.id)).not.toContain(
        research.id,
      );
      await expect(api.getResearch(research.id)).rejects.toThrow();
      expect((await api.myWork()).every((t) => t.id !== task.id)).toBe(
        true,
      );
      expect(
        (await api.listConversations()).every(
          (c) => c.conversation.researchId !== research.id,
        ),
      ).toBe(true);

      expect((await api.getResearch(other.id)).research?.id).toBe(other.id);
      await expect(api.deleteResearch(research.id)).rejects.toThrow();
    });
  });
}

export function tasksConformance(makeApi: () => Promise<LykeionApi>): void {
  describe("Tasks", () => {
    it("creates tasks with sequential per-research numbers", async () => {
      const api = await makeApi();
      const research = await api.createResearch({
        title: "Numbering",
        key: "NUM",
      });
      const first = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "First",
      });
      const second = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Second",
      });
      expect(first.number).toBe(1);
      expect(second.number).toBe(first.number + 1);
      expect(second.status).toBe("todo");
    });

    it("advances task status via updateTask", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "Status", key: "STA" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "T",
      });
      const updated = await api.updateTask(task.id, { status: "done" });
      expect(updated.status).toBe("done");
    });

    it("targetDate and labels are optional and default undefined", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "Fields", key: "FLD" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Bare",
      });
      expect(task.targetDate).toBeUndefined();
      expect(task.labels).toBeUndefined();
    });

    it("createTask accepts multiple assignees and myWork matches any of them", async () => {
      const api = await makeApi();
      const me = await api.currentUser();
      const research = await api.createResearch({
        title: "Assignees",
        key: "ASN",
      });
      const created = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Co-owned task",
        assignees: [
          { kind: "user", userId: me.id },
          { kind: "user", userId: "u_someone_else" },
        ],
      });
      expect(created.assignees).toEqual([
        { kind: "user", userId: me.id },
        { kind: "user", userId: "u_someone_else" },
      ]);
      const mine = await api.myWork();
      expect(mine.some((t) => t.id === created.id)).toBe(true);
    });

    it("updateTask patches assignees, labels, links, subtasks and targetDate", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "Editable", key: "EDT" });
      const created = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Editable task",
      });
      const updated = await api.updateTask(created.id, {
        assignees: [{ kind: "user", userId: "u_researcher" }],
        labels: ["computational"],
        links: ["https://doi.org/10.1/x"],
        targetDate: "2026-08-01",
        subtasks: [
          { title: "load", done: true },
          { title: "denoise", done: false },
        ],
      });
      expect(updated.assignees).toEqual([
        { kind: "user", userId: "u_researcher" },
      ]);
      expect(updated.labels).toEqual(["computational"]);
      expect(updated.links).toEqual(["https://doi.org/10.1/x"]);
      expect(updated.targetDate).toBe("2026-08-01");
      expect(updated.subtasks?.filter((s) => s.done)).toHaveLength(1);

      // Empty arrays clear; targetDate:null clears the date.
      const cleared = await api.updateTask(created.id, {
        assignees: [],
        labels: [],
        targetDate: null,
      });
      expect(cleared.assignees).toBeUndefined();
      expect(cleared.labels).toBeUndefined();
      expect(cleared.targetDate).toBeUndefined();
    });

    it("every Task names its author, assigned or not", async () => {
      const api = await makeApi();
      const me = await api.currentUser();
      const research = await api.createResearch({
        title: "Authorship",
        key: "AUT",
      });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Unassigned on purpose",
      });
      expect(task.assignees).toBeUndefined();
      expect(task.createdBy).toBe(me.id);
    });

    it("my work is the tasks assigned to me, not to an agent of my name", async () => {
      const api = await makeApi();
      const me = await api.currentUser();
      const research = await api.createResearch({
        title: "Mine vs agent",
        key: "MVA",
      });
      const mine = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Mine",
        assignees: [{ kind: "user", userId: me.id }],
      });
      const agents = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "An agent's",
        assignees: [{ kind: "agent", name: me.id }],
      });
      const work = await api.myWork();
      expect(work.map((t) => t.id)).toContain(mine.id);
      expect(work.map((t) => t.id)).not.toContain(agents.id);
    });

    it("myWork excludes tasks once they're done", async () => {
      const api = await makeApi();
      const me = await api.currentUser();
      const research = await api.createResearch({
        title: "Work queue",
        key: "WRK",
      });
      const open = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Open",
        assignees: [{ kind: "user", userId: me.id }],
      });
      const finished = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Finished",
        assignees: [{ kind: "user", userId: me.id }],
      });
      await api.updateTask(finished.id, { status: "done" });

      const mine = await api.myWork();
      expect(mine.map((t) => t.id)).toContain(open.id);
      expect(mine.map((t) => t.id)).not.toContain(finished.id);
    });

    it("orders my work by task number, not by which research came first", async () => {
      // Numbers restart per Research, so a low number in a Research opened later
      // has to sort ahead of a high number in one opened earlier. Building
      // the pair that way is what separates a real ordering from the order
      // the tasks happen to be stored in: `second` is created last and
      // must come first.
      const api = await makeApi();
      const me = await api.currentUser();
      const mineOf = (researchId: string, title: string) =>
        api.createTask({
          researchId,
          stage: "methods",
          title,
          assignees: [{ kind: "user", userId: me.id }],
        });

      const earlier = await api.createResearch({ title: "Earlier", key: "ERL" });
      await api.createTask({
        researchId: earlier.id,
        stage: "methods",
        title: "Someone else's",
      });
      const first = await mineOf(earlier.id, "Second number, first research");
      expect(first.number).toBe(2);

      const later = await api.createResearch({ title: "Later", key: "LTR" });
      const second = await mineOf(later.id, "First number, second research");
      expect(second.number).toBe(1);

      const ids = (await api.myWork()).map((t) => t.id);
      expect(ids.indexOf(second.id)).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    });

    it("lists every Task in the Lab, including other members' work", async () => {
      // The distinction from `myWork`, which is the reason this method
      // exists: a Task nobody has put on me still has to come back.
      const api = await makeApi();
      const me = await api.currentUser();
      const one = await api.createResearch({ title: "One", key: "ONE" });
      const two = await api.createResearch({ title: "Two", key: "TWO" });

      const mine = await api.createTask({
        researchId: one.id,
        stage: "methods",
        title: "Mine",
        assignees: [{ kind: "user", userId: me.id }],
      });
      const theirs = await api.createTask({
        researchId: two.id,
        stage: "methods",
        title: "Someone else's",
        assignees: [{ kind: "user", userId: "u_someone_else" }],
      });

      const ids = (await api.listTasks()).map((t) => t.id);
      expect(ids).toContain(mine.id);
      expect(ids).toContain(theirs.id);
      expect((await api.myWork()).map((t) => t.id)).not.toContain(theirs.id);
    });

    it("listTasks excludes done work unless asked for it", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "Done", key: "DNE" });
      const open = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Open",
      });
      const finished = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Finished",
      });
      await api.updateTask(finished.id, { status: "done" });

      const byDefault = (await api.listTasks()).map((t) => t.id);
      expect(byDefault).toContain(open.id);
      expect(byDefault).not.toContain(finished.id);

      const all = (await api.listTasks({ includeDone: true })).map(
        (t) => t.id,
      );
      expect(all).toContain(open.id);
      expect(all).toContain(finished.id);
    });

    it("a Task created with no Research is unfiled and numbers on its own run", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "Filed", key: "FIL" });
      const filed = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "In a Research",
      });
      const loose = await api.createTask({
        stage: "background",
        title: "Not yet anywhere",
      });
      const looseToo = await api.createTask({
        stage: "background",
        title: "Also nowhere",
      });

      expect(loose.researchId).toBeUndefined();
      // Its own run, not a continuation of the Research's.
      expect(looseToo.number).toBe(loose.number + 1);

      // Unfiled work belongs to the Lab: `listTasks` is the only surface
      // that has it, and no Research's detail may claim it.
      const ids = (await api.listTasks()).map((t) => t.id);
      expect(ids).toContain(loose.id);
      const inResearch = (await api.getResearch(research.id)).tasks.map((t) => t.id);
      expect(inResearch).toContain(filed.id);
      expect(inResearch).not.toContain(loose.id);
    });

    it("filing an unfiled Task into a Research moves it there", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "Home", key: "HOM" });
      const loose = await api.createTask({
        stage: "background",
        title: "Captured first, filed later",
      });

      const filed = await api.updateTask(loose.id, { researchId: research.id });

      expect(filed.researchId).toBe(research.id);
      expect((await api.getResearch(research.id)).tasks.map((t) => t.id)).toContain(
        loose.id,
      );
    });

    it("files a Task into a Research that already numbers up to that number", async () => {
      // The ordinary case, not an edge one: every Research numbers from one, so
      // an unfiled TSK-1 filed anywhere lands on a number the destination is
      // already using. Filing keeps the number, so a store that treats
      // (research, number) as a key refuses the commonest move there is.
      const api = await makeApi();
      const loose = await api.createTask({
        stage: "background",
        title: "Captured loose",
      });
      const research = await api.createResearch({ title: "Home", key: "HOM" });
      // A new Research numbers from one, so filling it up to the loose Task's
      // number is one Task on an empty lab and a handful on a lab with
      // history. Either way the collision is arranged rather than assumed.
      let resident = await api.createTask({
        researchId: research.id,
        stage: "background",
        title: "Resident 1",
      });
      while (resident.number < loose.number) {
        resident = await api.createTask({
          researchId: research.id,
          stage: "background",
          title: `Resident ${resident.number + 1}`,
        });
      }
      expect(resident.number).toBe(loose.number);

      const filed = await api.updateTask(loose.id, { researchId: research.id });

      expect(filed.researchId).toBe(research.id);
      expect(filed.number).toBe(loose.number);
      // Both hold the same number, so the order between them is the order
      // they were written in — the loose one first, since it existed before
      // the Research did.
      expect(
        (await api.getResearch(research.id)).tasks
          .filter((t) => t.number === loose.number)
          .map((t) => t.id),
      ).toEqual([loose.id, resident.id]);
    });

    it("moves a Task between Researches that both number from one", async () => {
      const api = await makeApi();
      const from = await api.createResearch({ title: "From", key: "FRM" });
      const to = await api.createResearch({ title: "To", key: "TOO" });
      const moving = await api.createTask({
        researchId: from.id,
        stage: "background",
        title: "Filed in the wrong place",
      });
      await api.createTask({ researchId: to.id, stage: "background", title: "Already there" });

      const moved = await api.updateTask(moving.id, { researchId: to.id });

      expect(moved.researchId).toBe(to.id);
      expect((await api.getResearch(to.id)).tasks).toHaveLength(2);
      expect((await api.getResearch(from.id)).tasks).toHaveLength(0);
    });

    it("refuses a Task with no title, and one filed into a Research that is not there", async () => {
      const api = await makeApi();
      const blank = await api
        .createTask({ stage: "background", title: "   " })
        .then(() => undefined, (e: unknown) => e);
      expect(isLykeionError(blank) && blank.code).toBe("invalid");

      // Not silently created unfiled: the author asked for a Research, and a
      // Task that quietly landed somewhere else is worse than a refusal.
      const nowhere = await api
        .createTask({ researchId: "s_nope", stage: "background", title: "Homeless" })
        .then(() => undefined, (e: unknown) => e);
      expect(isLykeionError(nowhere) && nowhere.code).toBe("not-found");
    });

    it("unpinning a Task removes the flag rather than storing a false", async () => {
      // `pinned` is optional on the contract, so "not pinned" has to be one
      // state. Two implementations that disagree — absent here, present and
      // false there — hand two callers different answers for one Task.
      const api = await makeApi();
      const research = await api.createResearch({ title: "Pins", key: "PIN" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "background",
        title: "Pin me",
      });

      expect("pinned" in (await api.updateTask(task.id, { pinned: true }))).toBe(true);
      const unpinned = await api.updateTask(task.id, { pinned: false });
      expect("pinned" in unpinned).toBe(false);
    });

    it("keeps a long title whole rather than trimming it to a length", async () => {
      // Callers that need a short title shorten it themselves — the composer
      // does, when it mints one from a prompt. A store that silently cuts a
      // title the author typed loses the end of it with nothing to say so.
      const api = await makeApi();
      const research = await api.createResearch({ title: "Long", key: "LNG" });
      const long = "Q".repeat(140);
      const task = await api.createTask({ researchId: research.id, stage: "background", title: long });
      expect(task.title).toBe(long);
      expect((await api.updateTask(task.id, { title: long })).title).toBe(long);
    });

    it("orders every Task by number, with the unfiled ones last", async () => {
      // Same shape as the `myWork` ordering test: a low number in a Research
      // opened later must sort ahead of a high number in one opened first,
      // which is what separates a real ordering from storage order.
      const api = await makeApi();
      const earlier = await api.createResearch({ title: "Earlier", key: "ERL" });
      await api.createTask({
        researchId: earlier.id,
        stage: "methods",
        title: "Number one",
      });
      const second = await api.createTask({
        researchId: earlier.id,
        stage: "methods",
        title: "Number two",
      });
      const later = await api.createResearch({ title: "Later", key: "LTR" });
      const firstOfLater = await api.createTask({
        researchId: later.id,
        stage: "methods",
        title: "Number one again",
      });
      const loose = await api.createTask({
        stage: "background",
        title: "Unfiled",
      });

      const ids = (await api.listTasks()).map((t) => t.id);
      expect(ids.indexOf(firstOfLater.id)).toBeLessThan(
        ids.indexOf(second.id),
      );
      // Unfiled sorts after every filed Task, however low its number.
      expect(ids.indexOf(loose.id)).toBe(ids.length - 1);
    });
  });
}

export function taskNamingConformance(makeApi: () => Promise<LykeionApi>): void {
  describe("naming a Task after the message that started it", () => {
    // What every implementation owes here is narrow on purpose. Whether a
    // summary is produced at all depends on a machine being paired and an
    // agent CLI answering, which a conformance lab has no business requiring
    // — so nothing below asserts that a Task *was* renamed, or what it was
    // renamed to. What is held to is the shape of the answer: `null` means
    // the Task kept its name, a string means the Task now has that exact
    // name, and neither the guards nor the error are optional.

    it("answers null and changes nothing when the Task carries a name a person gave it", async () => {
      // The whole safety property of naming: a summary that lands on a Task
      // somebody has already named is dropped, not applied. Without this, a
      // researcher who renames a chat in the seconds after sending it watches
      // their name get overwritten by a machine.
      const api = await makeApi();
      const research = await api.createResearch({ title: "Naming", key: "NAM" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "background",
        title: "A name I chose myself",
      });

      expect(
        await api.nameTask({
          taskId: task.id,
          prompt:
            "Use the live Python kernel and run one cell that sets values = list(range(30)) and prints each one.",
        }),
      ).toBeNull();
      expect((await api.getTask(task.id)).task.title).toBe("A name I chose myself");
    });

    it("answers null for a message already short enough to be a title", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "Naming", key: "NA2" });
      const prompt = "Fix the axis labels";
      const task = await api.createTask({
        researchId: research.id,
        stage: "background",
        title: titleFromPrompt(prompt),
      });

      expect(await api.nameTask({ taskId: task.id, prompt })).toBeNull();
      expect((await api.getTask(task.id)).task.title).toBe(prompt);
    });

    it("agrees with itself: what it answers is what the Task is called afterwards", async () => {
      // The one case that covers an implementation which really does summarize
      // and one that cannot, without either side having to know which it is.
      const api = await makeApi();
      const research = await api.createResearch({ title: "Naming", key: "NA3" });
      const prompt =
        "Use the live Python kernel. Run one cell that sets values = list(range(30)) and prints every value on its own line.";
      const minted = titleFromPrompt(prompt);
      const task = await api.createTask({
        researchId: research.id,
        stage: "background",
        title: minted,
      });

      const answer = await api.nameTask({ taskId: task.id, prompt });
      const title = (await api.getTask(task.id)).task.title;
      if (answer === null) expect(title).toBe(minted);
      else expect(title).toBe(answer);
    });

    it("names which Task it could not find", async () => {
      const api = await makeApi();
      await expect(
        api.nameTask({ taskId: "t_nope", prompt: "whatever this was going to be about" }),
      ).rejects.toMatchObject({ code: "not-found" });
    });
  });
}

export function taskChatConformance(makeApi: () => Promise<LykeionApi>): void {
  describe("a Task is a chat", () => {
    it("a Task created without a prompt has an empty transcript", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "Empty", key: "EMP" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Nobody has spoken here",
      });
      expect(task.runCount).toBe(0);
      expect(task.lastRunStatus).toBeUndefined();
      // On no agent either: nobody has spoken here, so there is nothing this
      // Task is talking to yet.
      expect(task.agent).toBeUndefined();
      const detail = await api.getTask(task.id);
      expect(detail.turns).toEqual([]);
      expect(detail.task.id).toBe(task.id);
    });


    it("getTask resolves an unfiled Task by id alone", async () => {
      const api = await makeApi();
      const task = await api.createTask({
        stage: "background",
        title: "No home yet",
      });
      expect(task.researchId).toBeUndefined();
      const detail = await api.getTask(task.id);
      expect(detail.task.id).toBe(task.id);
      expect(detail.turns).toEqual([]);
    });

    it("getTask on an unknown id says which id", async () => {
      const api = await makeApi();
      await expectRejection(
        api.getTask("t_nope"),
        "not-found",
        /no such task: t_nope/,
      );
    });

    it("updateTask renames and pins in one call", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "Pin", key: "PIN" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Original",
      });
      const updated = await api.updateTask(task.id, {
        title: "Renamed",
        pinned: true,
      });
      expect(updated.title).toBe("Renamed");
      expect(updated.pinned).toBe(true);
    });

    it("updateTask rejects a blank title", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "Blank", key: "BLK" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Original",
      });
      await expect(
        api.updateTask(task.id, { title: "   " }),
      ).rejects.toThrow("task title must not be empty");
    });

    it("deleting a Task takes its transcript with it", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "Del", key: "DEL" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Doomed",
      });
      await api.deleteTask(task.id);
      await expect(api.getTask(task.id)).rejects.toThrow(
        `no such task: ${task.id}`,
      );
    });

    it("deleting an unknown Task is a clean error, not a silent no-op", async () => {
      const api = await makeApi();
      // Same convention as `getTask` and `updateTask`: an id nobody holds a
      // Task for is an error. A caller that deletes the wrong id has to be
      // able to tell that nothing was deleted.
      await expectRejection(
        api.deleteTask("t_nope"),
        "not-found",
        /no such task: t_nope/,
      );
    });

    it("filing an unfiled Task keeps its number and its transcript", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "File", key: "FIL" });
      const task = await api.createTask({
        stage: "background",
        title: "Filed later",
      });
      const filed = await api.updateTask(task.id, { researchId: research.id });
      expect(filed.number).toBe(task.number);
      expect(filed.researchId).toBe(research.id);
      expect((await api.getTask(task.id)).turns).toEqual([]);
    });
  });
}

/**
 * The one part of a Task's chat that a run has to produce. Separate from
 * `taskChatConformance` so an implementation with no machine behind it —
 * where `startRun` refuses rather than pretending — can still be held to
 * everything else about a Task being a chat, instead of to none of it.
 */
export function taskChatRunConformance(makeApi: () => Promise<LykeionApi>): void {
  describe("a Task's chat, once a run has spoken in it", () => {
    it("a Task minted from a prompt keeps that title through a second turn", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "Titles", key: "TTL" });
      // Minting from a composer writes the truncated prompt as the title.
      // That is the ONLY moment a prompt becomes a title: the field is
      // authored from there on, so nothing recomputes it afterwards.
      const first =
        "Motion-correct the deprivation cohort and segment ROIs from the two-photon stacks";
      const task = await api.createTask({
        researchId: research.id,
        stage: "background",
        title: first.slice(0, 80),
      });
      expect(task.title).toBe(first.slice(0, 80));

      await driveOneTurn(api, research.id, task.id, first);
      await driveOneTurn(
        api,
        research.id,
        task.id,
        "Summarize what landed and flag anything a reviewer should check",
      );

      const after = await api.getTask(task.id);
      expect(after.task.runCount).toBe(2);
      // The second turn's prompt is in the transcript and nowhere near the
      // title — a derived title would read as the last thing said.
      expect(after.task.title).toBe(task.title);
    });

    it("drives a run on the RunHandle contract alone: startRun, onEvent, submit, completion", async () => {
      // The transport-facing seam, independent of anything a Task's
      // transcript separately records about the turn (the test above) and of
      // whatever a probed CLI's own readiness eventually gates (not this
      // area's concern): after `startRun`, everything about a turn arrives
      // through `onEvent` and is answered through `submit` alone — whatever
      // gate an implementation happens to raise, answering it here has to be
      // enough to reach `completed`.
      const api = await makeApi();
      const research = await api.createResearch({ title: "Run block", key: "RUB" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Say something and stop",
      });

      const handle = await api.startRun({
        researchId: research.id,
        taskId: task.id,
        prompt: "Say something and stop",
        options: { planMode: false },
      });
      expect(handle.runId).not.toBe("");

      const completed = await new Promise<RunEvent>((resolve) => {
        handle.onEvent((e) => {
          switch (e.event) {
            case "plan-proposed":
              handle.submit({ action: "approve-plan" });
              break;
            case "permission-card":
              handle.submit({
                action: "permission",
                requestId: e.request.id,
                decision: { decision: "allow", scope: "once" },
              });
              break;
            case "question-asked":
              handle.submit({
                action: "answer-question",
                requestId: e.request.requestId,
                answer: { selected: [] },
              });
              break;
            case "completed":
              resolve(e);
              break;
            default:
              break;
          }
        });
      });
      handle.close();

      expect(completed.event).toBe("completed");
    });

    it("a settled turn keeps the agent it ran on, so a Task reopened later knows what it is talking to", async () => {
      // A Task is one continuous conversation with one agent. Reopened, its
      // composer has to offer THAT agent's models and send the next turn to
      // it — and `resumeRuns` answers only for runs still active, so a
      // settled turn is the one place the fact survives a reload.
      //
      // What is asserted is a relationship, never a literal. An
      // implementation resolves the agent itself: a caller may name none,
      // and a lab may hold several machines offering the same one. So the
      // requirement is that the turn keeps the same answer the live run
      // gave, whatever that answer was.
      const api = await makeApi();
      const research = await api.createResearch({ title: "Which agent", key: "WCH" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Run on something",
      });
      const handle = await api.startRun({
        researchId: research.id,
        taskId: task.id,
        prompt: "Run on something",
        options: { planMode: false },
      });

      // Captured inside the subscription that drives the gates, so there is
      // no window in which the run could settle before the snapshot is read.
      let runningOn: string | undefined;
      await new Promise<void>((resolve) => {
        handle.onEvent((e) => {
          switch (e.event) {
            case "snapshot":
              runningOn = e.snapshot.agent;
              break;
            case "plan-proposed":
              handle.submit({ action: "approve-plan" });
              break;
            case "permission-card":
              handle.submit({
                action: "permission",
                requestId: e.request.id,
                decision: { decision: "allow", scope: "once" },
              });
              break;
            case "question-asked":
              handle.submit({
                action: "answer-question",
                requestId: e.request.requestId,
                answer: { selected: [] },
              });
              break;
            case "completed":
              resolve();
              break;
            default:
              break;
          }
        });
      });
      handle.close();

      const detail = await api.getTask(task.id);
      const turn = detail.turns.find((t) => t.runId === handle.runId);
      expect(turn).toBeDefined();
      expect(turn!.agent).toBe(runningOn);
      expect(turn!.agent).not.toBe("");
      // And the Task itself carries the same answer, so a surface that lists
      // Tasks can say what each is on without opening every transcript to
      // find out. The newest turn is the authority, so the two can never
      // disagree — a Task naming one agent while its last turn ran on another
      // would send the next turn somewhere the conversation is not.
      expect(detail.task.agent).toBe(turn!.agent);
      const listed = (await api.listTasks()).find((t) => t.id === task.id);
      expect(listed?.agent).toBe(turn!.agent);
    });

    it("a run in flight puts its Task In Progress, and settling puts it In Review", async () => {
      // The lifecycle a board reads is driven by the work, not by a person
      // remembering to move a card: a turn in flight IS the work in progress,
      // and a turn that landed is work waiting to be checked. Without this a
      // Task sat on Todo through its own first run and jumped straight to In
      // Review, which no reader could tell from a Task nobody had started.
      const api = await makeApi();
      const research = await api.createResearch({ title: "Moves itself", key: "MVS" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Run and settle",
      });
      expect((await api.getTask(task.id)).task.status).toBe("todo");

      const handle = await api.startRun({
        researchId: research.id,
        taskId: task.id,
        prompt: "Run and settle",
        options: { planMode: false },
      });
      // Read before the run is driven — `startRun` has already recorded the
      // turn, so the Task has already moved with it.
      expect((await api.getTask(task.id)).task.status).toBe("in-progress");

      await new Promise<void>((resolve) => {
        handle.onEvent((e) => {
          switch (e.event) {
            case "plan-proposed":
              handle.submit({ action: "approve-plan" });
              break;
            case "permission-card":
              handle.submit({
                action: "permission",
                requestId: e.request.id,
                decision: { decision: "allow", scope: "once" },
              });
              break;
            case "question-asked":
              handle.submit({
                action: "answer-question",
                requestId: e.request.requestId,
                answer: { selected: [] },
              });
              break;
            case "completed":
              resolve();
              break;
            default:
              break;
          }
        });
      });
      handle.close();

      expect((await api.getTask(task.id)).task.status).toBe("in-review");
    });

    it("starting new work on a Done Task reopens it", async () => {
      // Done is where a body of work ended, not a lid on the Task. Asking it
      // for something new is the researcher saying there is more, and the
      // Task rejoins the board — otherwise the completion guard that protects
      // a Done written mid-run would keep it Done for good.
      const api = await makeApi();
      const research = await api.createResearch({ title: "Reopens", key: "ROP" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Finished, then not",
      });

      const runToCompletion = async () => {
        const handle = await api.startRun({
          researchId: research.id,
          taskId: task.id,
          prompt: "More please",
          options: { planMode: false },
        });
        await new Promise<void>((resolve) => {
          handle.onEvent((e) => {
            switch (e.event) {
              case "plan-proposed":
                handle.submit({ action: "approve-plan" });
                break;
              case "permission-card":
                handle.submit({
                  action: "permission",
                  requestId: e.request.id,
                  decision: { decision: "allow", scope: "once" },
                });
                break;
              case "question-asked":
                handle.submit({
                  action: "answer-question",
                  requestId: e.request.requestId,
                  answer: { selected: [] },
                });
                break;
              case "completed":
                resolve();
                break;
              default:
                break;
            }
          });
        });
        handle.close();
      };

      await runToCompletion();
      await api.updateTask(task.id, { status: "done" });
      expect((await api.getTask(task.id)).task.status).toBe("done");

      await runToCompletion();
      // In Review, not Done: the second run reopened the Task on the way in,
      // so its completion had something to move.
      expect((await api.getTask(task.id)).task.status).toBe("in-review");
    });

    it("detach is observer-only: the same handle can resubscribe and still complete", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "Detach and resume", key: "DAR" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Keep running while nobody observes",
      });
      const handle = await api.startRun({
        researchId: research.id,
        taskId: task.id,
        prompt: "Keep running while nobody observes",
        options: { planMode: false },
      });

      handle.detach();
      const completed = await new Promise<RunEvent>((resolve) => {
        handle.onEvent((event) => {
          switch (event.event) {
            case "plan-proposed":
              handle.submit({ action: "approve-plan" });
              break;
            case "permission-card":
              handle.submit({
                action: "permission",
                requestId: event.request.id,
                decision: { decision: "allow", scope: "once" },
              });
              break;
            case "question-asked":
              handle.submit({
                action: "answer-question",
                requestId: event.request.requestId,
                answer: { selected: [] },
              });
              break;
            case "completed":
              resolve(event);
              break;
            default:
              break;
          }
        });
      });
      handle.close();

      expect(completed.event).toBe("completed");
    });

    it("stopping a run lands it cancelled, not a failure with an invented reason", async () => {
      // A researcher's stop is not a decline of anything a plan or
      // permission gate raised, and must not read as one: `cancelled` is its
      // own terminal state, carrying no `reason` at all — inventing one for
      // an ordinary stop would misdescribe a turn nothing actually failed
      // at.
      const api = await makeApi();
      const research = await api.createResearch({ title: "Stop block", key: "STB" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Say something and stop",
      });

      const handle = await api.startRun({
        researchId: research.id,
        taskId: task.id,
        prompt: "Say something and stop",
        options: { planMode: false },
      });

      const completed = await new Promise<RunEvent>((resolve) => {
        handle.onEvent((e) => {
          switch (e.event) {
            case "plan-proposed":
            case "permission-card":
            case "question-asked":
              handle.submit({ action: "cancel" });
              break;
            case "completed":
              resolve(e);
              break;
            default:
              break;
          }
        });
      });
      handle.close();

      expect(completed.event === "completed" && completed.state.state).toBe(
        "cancelled",
      );
      expect(
        completed.event === "completed" ? "reason" in completed.state : true,
      ).toBe(false);
    });
  });
}

export function membersConformance(makeApi: () => Promise<LykeionApi>): void {
  describe("members, invites and current user", () => {
    it("currentUser is one of the members", async () => {
      const api = await makeApi();
      const me = await api.currentUser();
      const members = await api.listMembers();
      expect(members.some((m) => m.user.id === me.id)).toBe(true);
    });

    it("lists members joined-date ascending, whatever the roster holds", async () => {
      // No contract method admits a member — an invite is minted here but
      // redeemed outside the contract — so this can only check the roster
      // the implementation already has. The loop is vacuously true on a
      // one-person lab and states the real ordering on any larger one.
      const api = await makeApi();
      const members = await api.listMembers();
      for (let i = 1; i < members.length; i++) {
        expect(members[i - 1].joinedTs).toBeLessThanOrEqual(
          members[i].joinedTs,
        );
      }
    });

    it("the owner cannot be offboarded", async () => {
      // A lab with nobody who can invite or offboard is a lab nobody can
      // administer, so the last thing removal may take is the owner.
      const api = await makeApi();
      const owner = (await api.listMembers()).find(
        (m) => m.role === "owner",
      );
      expect(owner).toBeDefined();
      await expect(api.removeMember(owner!.user.id)).rejects.toThrow();
      expect(
        (await api.listMembers()).find((m) => m.user.id === owner!.user.id)
          ?.removedTs,
      ).toBeUndefined();
    });

    it("mints, lists and revokes an invite", async () => {
      const api = await makeApi();
      const invite = await api.createInvite("member");
      expect(await api.listInvites()).toHaveLength(1);
      await api.revokeInvite(invite.code);
      expect(await api.listInvites()).toEqual([]);
    });

    it("a freshly minted invite carries no redemption time", async () => {
      // Absent rather than zero or null: the field is how a surface tells a
      // code somebody has taken up from one still waiting, and a present
      // key with a falsy value reads as taken up to anything checking for
      // the property.
      const api = await makeApi();
      const invite = await api.createInvite("member");
      expect("redeemedTs" in invite).toBe(false);
    });

    it("an invite names the member who minted it and lapses after it", async () => {
      const api = await makeApi();
      const me = await api.currentUser();
      const invite = await api.createInvite("member");
      expect(invite.createdBy).toBe(me.id);
      expect(invite.expiresTs).toBeGreaterThan(invite.createdTs);
    });

    it("carries no profile picture until one is set", async () => {
      // Absent rather than empty string: every surface that draws a face
      // chooses between the picture and the initials on this key's presence,
      // and a present-but-blank one renders as a broken image.
      const api = await makeApi();
      expect("avatarUrl" in (await api.currentUser())).toBe(false);
    });

    it("setAvatar round-trips through currentUser and the roster", async () => {
      const api = await makeApi();
      await api.setAvatar(PNG_PIXEL);
      expect((await api.currentUser()).avatarUrl).toBe(PNG_PIXEL);
      // And on the roster, not just on the reader's own record: the picture
      // is part of the identity every other member sees.
      const me = await api.currentUser();
      const mine = (await api.listMembers()).find((m) => m.user.id === me.id);
      expect(mine?.user.avatarUrl).toBe(PNG_PIXEL);
    });

    it("setAvatar(null) clears the picture back to absent", async () => {
      const api = await makeApi();
      await api.setAvatar(PNG_PIXEL);
      await api.setAvatar(null);
      expect("avatarUrl" in (await api.currentUser())).toBe(false);
    });

    it("refuses a profile picture that is not an image data URL", async () => {
      // A picture that could name an arbitrary URL would report every member
      // who later loaded the roster to whoever set it.
      const api = await makeApi();
      await expect(api.setAvatar("https://example.com/face.png")).rejects.toThrow();
      await expect(api.setAvatar("data:text/html;base64,PHNjcmlwdD4=")).rejects.toThrow();
      expect("avatarUrl" in (await api.currentUser())).toBe(false);
    });

    it("refuses a profile picture larger than the contract's cap", async () => {
      const api = await makeApi();
      const huge = `data:image/png;base64,${"A".repeat(MAX_AVATAR_BYTES)}`;
      await expect(api.setAvatar(huge)).rejects.toThrow();
      expect("avatarUrl" in (await api.currentUser())).toBe(false);
    });

    it("a profile picture is personal, not the lab's", async () => {
      const api = await makeApi();
      await api.setAvatar(PNG_PIXEL);
      const other = await makeApi();
      expect((await other.currentUser()).avatarUrl).toBeUndefined();
    });
  });
}

export function conversationsUsageSettingsConformance(makeApi: () => Promise<LykeionApi>): void {
  describe("conversations, usage and settings", () => {
    it("lists conversations newest-activity first, whatever it holds", async () => {
      // Whatever is already there — nothing on a fresh core, seeded threads
      // on an implementation that starts with some. Either way the order must
      // hold; the loop is vacuously true on an empty list.
      const api = await makeApi();
      const list = await api.listConversations();
      for (let i = 1; i < list.length; i++) {
        expect(list[i - 1].conversation.updatedTs).toBeGreaterThanOrEqual(
          list[i].conversation.updatedTs,
        );
      }
    });

    it("every listed conversation names the member reading it", async () => {
      // A thread you are not in has no business in your list. Vacuous on an
      // implementation with no threads, which is the honest reading of "none
      // of the ones you are shown are somebody else's".
      const api = await makeApi();
      const me = await api.currentUser();
      for (const { conversation } of await api.listConversations()) {
        expect(
          conversation.participants.some(
            (p) => p.kind === "user" && p.userId === me.id,
          ),
        ).toBe(true);
      }
    });

    it("a listed conversation carries its last message and an unread count", async () => {
      const api = await makeApi();
      for (const summary of await api.listConversations()) {
        expect(summary.unread).toBeGreaterThanOrEqual(0);
        // A thread is opened WITH a message, so one is always there to show.
        expect(summary.lastMessage?.conversationId).toBe(
          summary.conversation.id,
        );
      }
    });

    it("getConversation rejects an id no thread answers to", async () => {
      const api = await makeApi();
      await expect(api.getConversation("c_nope")).rejects.toThrow();
    });

    it("usage carries a person axis alongside the agent axis", async () => {
      const api = await makeApi();
      const usage = await api.usage();
      expect(Array.isArray(usage.users)).toBe(true);
    });

    it("returns empty series, agents and users on a fresh core", async () => {
      const api = await makeApi();
      expect(await api.usage()).toEqual({
        series: [],
        agents: [],
        users: [],
      });
    });

    it("returns neutral defaults on a fresh core (nothing illustrative)", async () => {
      // `dataLocation` is not asserted here: `~/lykeion` is this
      // implementation's own default and a real workspace server would
      // legitimately choose its own. It's checked against the in-memory
      // implementation instead.
      const api = await makeApi();
      const s = await api.getSettings();
      expect(s.defaultModel).toBe("");
      expect(s.orgName).toBe("");
      expect(s.orgId).toBe("");
    });

    // Two instances never share a theme, which this asserts directly. It
    // does not show that one instance keeps two users' themes apart,
    // because a running instance has exactly one signed-in user (`me`,
    // fixed at construction) and the contract has no way to read or write
    // settings as anyone else from inside it — so a single-value store
    // and a per-user store would pass this test identically.
    it("theme is personal, not the lab's", async () => {
      const api = await makeApi();
      await api.setTheme("aurora");
      expect((await api.getSettings()).theme).toBe("aurora");
      const other = await makeApi();
      expect((await other.getSettings()).theme).not.toBe("aurora");
    });
  });
}

export function customizationConformance(makeApi: () => Promise<LykeionApi>): void {
  describe("customization engine", () => {
    it("orders skills the way a reader does, not the way bytes do", async () => {
      // An accented name is the case that separates a locale comparison
      // from a byte-order one: byte order puts every non-ASCII letter after
      // `Z`, so a lab whose skills are not all plain ASCII would read them
      // in a different order depending on which implementation answered.
      const api = await makeApi();
      for (const name of ["Zebra", "Ärger", "apple"])
        await api.createSkill({ name, description: name, body: name });

      const listed = (await api.listSkills()).map((s) => s.name);
      const mine = listed.filter((n) => ["Zebra", "Ärger", "apple"].includes(n));
      expect(mine).toEqual(["apple", "Ärger", "Zebra"]);
    });

    it("setSkillEnabled flips a skill's enabled flag", async () => {
      const api = await makeApi();
      await api.createSkill({
        name: "scratch-skill",
        description: "A skill created for this test.",
        body: "# Scratch\n",
      });
      const before = (await api.listSkills()).find(
        (s) => s.name === "scratch-skill",
      )!;
      expect(before.enabled).toBe(true);

      await api.setSkillEnabled("scratch-skill", false);
      const after = (await api.listSkills()).find(
        (s) => s.name === "scratch-skill",
      )!;
      expect(after.enabled).toBe(false);
    });

    it("createSkill adds an enabled skill", async () => {
      const api = await makeApi();
      await api.createSkill({
        name: "gsea",
        description: "Gene-set enrichment analysis.",
        body: "# GSEA\n",
      });
      const gsea = (await api.listSkills()).find((s) => s.name === "gsea");
      expect(gsea?.enabled).toBe(true);
    });

    it("connectorCatalog returns the curated scientific databases", async () => {
      const api = await makeApi();
      const catalog = await api.connectorCatalog();
      expect(catalog.length).toBeGreaterThanOrEqual(3);
      expect(catalog.map((c) => c.name)).toContain("PubMed");
    });

    it("addConnector then listConnectors includes the new connector", async () => {
      const api = await makeApi();
      // The first catalog entry, not a name looked up by literal string —
      // a catalog with different contents still fails this test with a
      // readable assertion instead of an opaque `undefined` dereference.
      const [entry] = await api.connectorCatalog();
      await api.addConnector({
        name: entry.name,
        description: entry.description,
        server: entry.server,
        enabled: true,
        skipApprovals: false,
      });
      const names = (await api.listConnectors()).map((c) => c.name);
      expect(names).toContain(entry.name);
    });

    it("setConnectorEnabled toggles enabled and 404s on an unknown name", async () => {
      const api = await makeApi();
      await api.addConnector({
        name: "scratch-connector",
        description: "A connector created for this test.",
        server: { command: "uvx", args: ["mcp-scratch"], env: {} },
        enabled: true,
        skipApprovals: false,
      });
      await api.setConnectorEnabled("scratch-connector", false);
      const found = (await api.listConnectors()).find(
        (c) => c.name === "scratch-connector",
      );
      expect(found?.enabled).toBe(false);

      await expect(
        api.setConnectorEnabled("ghost", true),
      ).rejects.toThrow(/no such connector/i);
    });

    it("setConnectorSkipApprovals toggles skipApprovals and 404s on an unknown name", async () => {
      const api = await makeApi();
      await api.addConnector({
        name: "scratch-connector",
        description: "A connector created for this test.",
        server: { command: "uvx", args: ["mcp-scratch"], env: {} },
        enabled: true,
        skipApprovals: false,
      });
      await api.setConnectorSkipApprovals("scratch-connector", true);
      const found = (await api.listConnectors()).find(
        (c) => c.name === "scratch-connector",
      );
      expect(found?.skipApprovals).toBe(true);

      await expect(
        api.setConnectorSkipApprovals("ghost", true),
      ).rejects.toThrow(/no such connector/i);
    });
  });
}

export function groupsConformance(makeApi: () => Promise<LykeionApi>): void {
  describe("groups", () => {
    it("is empty on a fresh core", async () => {
      const api = await makeApi();
      expect(await api.listGroups()).toEqual([]);
    });

    it("a group holds colleagues alongside its experts", async () => {
      const api = await makeApi();
      const created = await api.createGroup({
        name: "Genomics Core",
        leadAgent: "atlas",
        memberAgents: ["scribe"],
        memberUsers: ["u_you"],
      });
      expect(created.memberUsers).toEqual(["u_you"]);
      const [listed] = await api.listGroups();
      expect(listed.memberUsers).toEqual(["u_you"]);
    });

    it("a group created without colleagues has an empty list, not an absent one", async () => {
      const api = await makeApi();
      const created = await api.createGroup({ name: "Bare" });
      expect(created.memberUsers).toEqual([]);
    });

    it("createGroup then listGroups includes it, newest first", async () => {
      const api = await makeApi();
      await api.createGroup({ name: "Structural Biology" });
      const second = await api.createGroup({
        name: "Climate Attribution",
        description: "Heatwave causal chains",
        leadAgent: "atlas",
        memberAgents: ["scout", "sage"],
      });
      const groups = await api.listGroups();
      expect(groups).toHaveLength(2);
      expect(groups[0].id).toBe(second.id);
      expect(groups[0].name).toBe("Climate Attribution");
      expect(groups[0].leadAgent).toBe("atlas");
      expect(groups[0].memberAgents).toEqual(["scout", "sage"]);
      expect(groups[1].description).toBe("");
    });
  });
}

export function absentCapabilityConformance(makeApi: () => Promise<LykeionApi>): void {
  describe("Machines and kernel reads answer honestly when nothing is configured", () => {
    it("listMachines returns empty on a fresh core", async () => {
      const api = await makeApi();
      expect(await api.listMachines()).toEqual([]);
    });

    it("listAgentClis returns empty on a fresh core", async () => {
      const api = await makeApi();
      expect(await api.listAgentClis()).toEqual([]);
    });

    it("kernelEnvList invents nothing beyond the starters a fresh lab may seed", async () => {
      // Not asserted as strictly empty: a real lab seeds two declarations on
      // every boot — the `python` and `r` starters (D3's "something to set
      // up rather than an empty list and no way to make one", one per
      // language this lab can build) — and those are real, declared
      // content, not a fake one. What must still never happen is a THIRD
      // name nothing here ever asked for.
      const api = await makeApi();
      const list = await api.kernelEnvList();
      // Asserted as a set, not with `.every()`: `[].every(...)` is `true`,
      // so an `every` here would pass for an implementation that listed
      // nothing AND for one that had started inventing names — which is the
      // opposite of what this test is for. A length bound is the strongest
      // claim that holds honestly across both cores, since one seeds the
      // starters and one seeds nothing.
      //
      // The stricter half — that a core seeding NOTHING lists nothing — is
      // asserted directly against the in-memory core in `index.test.ts`,
      // where the expected set is known exactly rather than having to hold
      // for every implementation at once.
      expect(list.length).toBeLessThanOrEqual(2);
      expect(
        list.map((env) => env.name).filter((name) => name !== "python" && name !== "r"),
      ).toEqual([]);
    });

    it("kernelEnvSetup refuses a machine nothing here has ever heard of", async () => {
      // A refusal, not a resolved no-op: a Setup that "succeeds" while
      // provisioning nothing leaves the surface reporting an install that
      // never happened. `machineId` names a specific machine, so the honest
      // refusal on a fresh core names that machine rather than a vaguer
      // "no runtime is connected" — a core with that machine in reach
      // answers differently, and that behaviour belongs to its own suite.
      const api = await makeApi();
      await expectRejection(api.kernelEnvSetup("rt_bogus", "python"), "not-found", /rt_bogus/);
    });

    it("kernelEnvReclaim refuses a machine nothing here has ever heard of", async () => {
      const api = await makeApi();
      await expectRejection(api.kernelEnvReclaim("rt_bogus", "python"), "not-found", /rt_bogus/);
    });
  });
}

/**
 * What an implementation with no lab of its own refuses categorically. A
 * workspace server can really pair a machine; the browser core never can,
 * whatever state it is in — there is no lab for a daemon to be vouched
 * into. That is a different shape of thing from `absentCapabilityConformance`,
 * whose reads happen to come back empty on a fresh install and would keep
 * doing so for a real backend too: `pairMachine` is an action, not a list
 * that is empty until something is added to it, so an implementation that
 * can really perform it belongs out of this area rather than failing it.
 */
export function pairingUnsupportedConformance(makeApi: () => Promise<LykeionApi>): void {
  describe("pairing is not something an implementation with no lab of its own can do", () => {
    it("pairMachine refuses — there is no lab here to vouch a daemon into", async () => {
      const api = await makeApi();
      await expectRejection(
        api.pairMachine({
          name: "a-machine",
          platform: "macos-aarch64",
          daemonVersion: "0.1.0",
          challenge: "challenge",
          redirect: "http://127.0.0.1:7420/paired",
        }),
        "unsupported",
        /.+/,
      );
    });

    it("removeMachine refuses — there is nothing paired to remove", async () => {
      const api = await makeApi();
      await expectRejection(api.removeMachine("rt_1"), "unsupported", /.+/);
    });
  });
}

/**
 * What an implementation with no machine behind it says about kernels. A
 * list that is empty is a different answer from a call that refuses, and both
 * are asserted: "nothing is running" is knowable without a machine, and
 * "run this" is not.
 */
export function kernelAxisConformance(makeApi: () => Promise<LykeionApi>): void {
  describe("kernel axis", () => {
    it("reports no running kernels rather than refusing to say", async () => {
      const api = await makeApi();
      await expect(api.listRunningKernels()).resolves.toEqual([]);
    });

    it("reports an empty notebook for a Task nothing has run", async () => {
      const api = await makeApi();
      const research = await api.createResearch({ title: "Kernel", key: "KRN" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Nothing has run here",
      });
      await expect(api.taskNotebook(task.id)).resolves.toEqual([]);
    });

    it("refuses to execute rather than pretending a kernel exists", async () => {
      const api = await makeApi();
      // The wording is deliberately unasserted: an implementation says why in
      // its own terms, and pinning the sentence here would make one
      // implementation's phrasing the contract.
      await expectRejection(api.kernelExecute("k_1", "1 + 1"), "unsupported", /./);
    });

    it("refuses to restart a kernel it does not have", async () => {
      const api = await makeApi();
      await expectRejection(api.kernelRestart("k_1"), "unsupported", /./);
    });
  });
}

/**
 * The lab's environment declarations — name, language, manager, requested
 * packages, who and when — held with nothing but storage: no path, no build
 * state, no machine. `kernelEnvSetup`, which actually provisions, is not
 * this area's concern and lives in `kernelAxisConformance` and the areas
 * that assert its absence.
 */
export function environmentDeclarationsConformance(makeApi: () => Promise<LykeionApi>): void {
  describe("the lab's environment declarations", () => {
    it("declares an environment and lists back what was asked, not what got resolved", async () => {
      const api = await makeApi();
      const declared = await api.kernelEnvCreate({
        name: "crispr",
        language: "python",
        packages: ["scanpy", "anndata"],
      });
      expect(declared.name).toBe("crispr");
      expect(declared.packages).toEqual(["scanpy", "anndata"]);
      // Nothing has been resolved yet, so nothing is pinned.
      expect(declared.lockRevision).toBe(0);

      // Found by name, not by position: a real lab may already carry the
      // `python` starter alongside whatever this test just declared.
      const list = await api.kernelEnvList();
      expect(list.find((env) => env.name === "crispr")).toEqual(declared);
    });

    it("refuses a name this lab already has", async () => {
      const api = await makeApi();
      await api.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
      await expectRejection(
        api.kernelEnvCreate({ name: "crispr", language: "python", packages: ["anndata"] }),
        "conflict",
        /crispr/,
      );
    });

    it("refuses a name no machine could ever build", async () => {
      // A declaration's name becomes a directory on every machine that
      // builds it — `<workDir>/envs/<name>`, what `uv venv --clear` is
      // pointed at and what the sandbox policy is rendered around. A name
      // that cannot be one path segment is a declaration nothing in this lab
      // can ever build, and the refusal belongs in front of whoever typed it
      // rather than on a colleague's machine hours later.
      //
      // Held here, against every core, because this is one contract with one
      // answer: `kernelEnvCreate` is exposed to agents as
      // `kernel_env_create`, and a core that accepts `../etc` teaches an
      // agent a name the lab it is really working against will refuse.
      const api = await makeApi();
      for (const name of ["../etc", "my env", "", "crispr/v2"]) {
        await expectRejection(
          api.kernelEnvCreate({ name, language: "python", packages: ["scanpy"] }),
          "invalid",
          /letters, numbers, dashes and underscores/,
        );
      }
      // Refused, not merely reported: none of them is now a declaration.
      const list = await api.kernelEnvList();
      expect(list.some((env) => env.name === "../etc")).toBe(false);

      // And the check is not simply refusing everything — the shape a
      // researcher actually types still goes through.
      const declared = await api.kernelEnvCreate({
        name: "crispr_v2-final",
        language: "python",
        packages: ["scanpy"],
      });
      expect(declared.name).toBe("crispr_v2-final");
    });

    it("declares an R environment, deriving conda from the language", async () => {
      const api = await makeApi();
      const declared = await api.kernelEnvCreate({
        name: "r-stats",
        language: "r",
        packages: [],
      });
      expect(declared.language).toBe("r");
      // An R environment pins R itself, which is what makes it a conda one
      // rather than a uv one — a caller never chooses; it is derived.
      expect(declared.manager).toBe("conda");
    });

    it("refuses a language this lab cannot build, naming it", async () => {
      const api = await makeApi();
      await expectRejection(
        // Cast past the closed `Language` union the same way a real caller
        // arrives here — over the wire, where nothing has validated the
        // value against it, which is why the refusal is written in code.
        api.kernelEnvCreate({ name: "j", language: "julia" as unknown as Language, packages: [] }),
        "unsupported",
        /julia/,
      );
    });

    it("removes a declaration so it drops out of the list", async () => {
      const api = await makeApi();
      await api.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
      await api.kernelEnvDelete("crispr");
      // Not asserted against `[]`: a real lab may already carry the
      // `python` starter this test never touched. What this test is about
      // is that `crispr` itself is gone.
      const list = await api.kernelEnvList();
      expect(list.some((env) => env.name === "crispr")).toBe(false);
    });

    it("refuses to delete an environment this lab never declared, including one already deleted", async () => {
      const api = await makeApi();
      await expectRejection(api.kernelEnvDelete("bogus"), "not-found", /bogus/);

      await api.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
      await api.kernelEnvDelete("crispr");
      await expectRejection(api.kernelEnvDelete("crispr"), "not-found", /crispr/);
    });

    it("lets a deleted name be declared again, starting fresh rather than inheriting a stale pin", async () => {
      // The case two implementations of this area can quietly disagree on:
      // a store that tombstones a deleted row instead of removing it can
      // crash or resurrect an old lockfile revision here, while an
      // in-memory implementation that does a plain array delete sails
      // through. Both must answer the same way.
      const api = await makeApi();
      await api.kernelEnvCreate({ name: "crispr", language: "python", packages: ["scanpy"] });
      await api.kernelEnvDelete("crispr");

      const recreated = await api.kernelEnvCreate({
        name: "crispr",
        language: "python",
        packages: ["anndata"],
      });
      expect(recreated.packages).toEqual(["anndata"]);
      // Nothing of the deleted predecessor's lockfile survives under the
      // recreated name.
      expect(recreated.lockRevision).toBe(0);
    });
  });
}

/**
 * Opening threads and saying things in them — held separately from the reads
 * above because an implementation with no writer behind conversations answers
 * these `unsupported`, honestly, and has to be able to name what it is not
 * being held to.
 */
export function conversationWritesConformance(makeApi: () => Promise<LykeionApi>): void {
  describe("conversation writes", () => {
    /** A Research with one Task in it, which is all a thread needs to exist. */
    async function subject(api: LykeionApi) {
      const research = await api.createResearch({ title: "Talk", key: "TLK" });
      const task = await api.createTask({
        researchId: research.id,
        stage: "methods",
        title: "Something to argue about",
      });
      return { research, task };
    }

    it("opens a thread carrying its first message and its opener", async () => {
      const api = await makeApi();
      const me = await api.currentUser();
      const { research, task } = await subject(api);

      const conversation = await api.createConversation({
        researchId: research.id,
        taskId: task.id,
        participants: [{ kind: "agent", name: "reviewer" }],
        body: "Does this number hold up?",
      });

      // Named or not, the opener is in the thread they opened.
      expect(
        conversation.participants.some(
          (p) => p.kind === "user" && p.userId === me.id,
        ),
      ).toBe(true);
      // No title given, so the Task's own title names it.
      expect(conversation.title).toBe(task.title);

      const detail = await api.getConversation(conversation.id);
      expect(detail.messages.map((m) => m.body)).toEqual([
        "Does this number hold up?",
      ]);
    });

    it("refuses a thread with nothing said in it", async () => {
      const api = await makeApi();
      const { research, task } = await subject(api);
      await expect(
        api.createConversation({
          researchId: research.id,
          taskId: task.id,
          participants: [],
          body: "   ",
        }),
      ).rejects.toThrow();
    });

    it("refuses a thread about a Task that is not in the named Research", async () => {
      const api = await makeApi();
      const { task } = await subject(api);
      const elsewhere = await api.createResearch({ title: "Other", key: "OTH" });
      await expect(
        api.createConversation({
          researchId: elsewhere.id,
          taskId: task.id,
          participants: [],
          body: "wrong research",
        }),
      ).rejects.toThrow();
    });

    it("appends a posted message and floats the thread up the list", async () => {
      const api = await makeApi();
      const { research, task } = await subject(api);
      const conversation = await api.createConversation({
        researchId: research.id,
        taskId: task.id,
        participants: [],
        body: "first",
      });

      const posted = await api.postMessage(conversation.id, "second");
      expect(posted.body).toBe("second");

      const detail = await api.getConversation(conversation.id);
      // Oldest first — reading order, not arrival order reversed.
      expect(detail.messages.map((m) => m.body)).toEqual(["first", "second"]);
      expect(detail.conversation.updatedTs).toBeGreaterThan(
        conversation.updatedTs,
      );

      const listed = (await api.listConversations()).find(
        (c) => c.conversation.id === conversation.id,
      );
      expect(listed?.lastMessage?.body).toBe("second");
    });

    it("does not count your own messages as unread", async () => {
      const api = await makeApi();
      const { research, task } = await subject(api);
      const conversation = await api.createConversation({
        researchId: research.id,
        taskId: task.id,
        participants: [],
        body: "talking to myself",
      });
      await api.postMessage(conversation.id, "still talking");

      const listed = (await api.listConversations()).find(
        (c) => c.conversation.id === conversation.id,
      );
      expect(listed?.unread).toBe(0);
    });

    it("markConversationRead is idempotent and rejects an unknown id", async () => {
      const api = await makeApi();
      const { research, task } = await subject(api);
      const conversation = await api.createConversation({
        researchId: research.id,
        taskId: task.id,
        participants: [],
        body: "read me",
      });

      await api.markConversationRead(conversation.id);
      // Twice is not an error: a surface marks on every open.
      await api.markConversationRead(conversation.id);
      const listed = (await api.listConversations()).find(
        (c) => c.conversation.id === conversation.id,
      );
      expect(listed?.unread).toBe(0);

      await expect(api.markConversationRead("c_nope")).rejects.toThrow();
    });

    it("deleteTask takes the threads about it with it", async () => {
      const api = await makeApi();
      const { research, task } = await subject(api);
      const conversation = await api.createConversation({
        researchId: research.id,
        taskId: task.id,
        participants: [],
        body: "about to be orphaned",
      });

      await api.deleteTask(task.id);

      expect(
        (await api.listConversations()).every(
          (c) => c.conversation.id !== conversation.id,
        ),
      ).toBe(true);
      await expect(api.getConversation(conversation.id)).rejects.toThrow();
    });
  });
}

export interface ConformanceLab {
  owner: LykeionApi;
  /** An ordinary member of the same lab. */
  member: LykeionApi;
}

/**
 * What an ordinary member may not do. Asserted here rather than against one
 * implementation, because a rule stated in one place and not the other is a
 * rule the two will drift on with nothing to catch it.
 */
export function rolesConformance(makeLab: () => Promise<ConformanceLab>): void {
  describe("A member is refused what only an owner may do", () => {
    it("cannot mint an invite", async () => {
      const { member } = await makeLab();
      await expectRejection(member.createInvite("member"), "forbidden", /.+/);
    });

    it("cannot read the invite list", async () => {
      const { member } = await makeLab();
      await expectRejection(member.listInvites(), "forbidden", /.+/);
    });

    it("cannot offboard anybody", async () => {
      // `someone` here is the owner — the only other member either lab has
      // — so a wildcard message would pass this even for an implementation
      // that refuses the call solely because its target is the owner, not
      // because its caller is a member. Matching the caller-side rule's own
      // wording is what tells the two apart: a member removing a fellow
      // member, with the owner left out of it entirely, must fail the same
      // way and nothing here checks that it does.
      const { owner, member } = await makeLab();
      const [someone] = await owner.listMembers();
      await expectRejection(
        member.removeMember(someone.user.id),
        "forbidden",
        /only an owner/,
      );
    });

    it("still sees the roster, which is not owner-only", async () => {
      const { member } = await makeLab();
      expect((await member.listMembers()).length).toBeGreaterThan(0);
    });
  });
}

/**
 * `submitRunDecision` on a run id nobody holds — refused the same way an
 * unowned one is, by name, so a caller cannot tell "no such run" apart from
 * "not yours" from the error alone (run ids are sequential and guessable).
 * Lab-based, like `rolesConformance`, and — unlike `runDecisionConformance`
 * below — needs no live turn at all: an implementation with no machine
 * behind it can refuse an id it never held exactly as readily as one that
 * can actually run a turn, since the refusal depends on nothing a turn ever
 * produced. Always run, never gated on the machine skip.
 */
export function unknownRunConformance(makeLab: () => Promise<ConformanceLab>): void {
  describe("submitRunDecision needs no live turn to refuse an id nobody holds", () => {
    it("refuses a decision on a run id nobody holds, the same way an unowned one is refused", async () => {
      const { owner } = await makeLab();
      await expectRejection(
        owner.submitRunDecision("run_conformance_nope", { action: "cancel" }),
        "forbidden",
        /does not belong to/,
      );
    });
  });
}

/**
 * `submitRunDecision`'s remaining refusal, the one thing neither a Task's
 * chat nor a bare `RunHandle` exercises just by running a turn to
 * completion: not who started it (`unknownRunConformance`, above, covers
 * that), but a decision that would reach every Research in the lab. Lab-based,
 * like `rolesConformance`, and needs a durable run id to address. It does not
 * need an adapter to answer: global scope is rejected at the contract edge
 * before any permission request is forwarded.
 */
export function runDecisionConformance(makeLab: () => Promise<ConformanceLab>): void {
  describe("submitRunDecision's refusals addressed to a live run", () => {
    it("refuses a decision from an actor who did not start the run", async () => {
      const { owner, member } = await makeLab();
      const research = await owner.createResearch({ title: "Actor check", key: "ACT" });
      const task = await owner.createTask({
        researchId: research.id,
        stage: "background",
        title: "run me",
      });
      const handle = await owner.startRun({
        researchId: research.id,
        taskId: task.id,
        prompt: "go",
        options: { planMode: false },
      });

      await expectRejection(
        member.submitRunDecision(handle.runId, { action: "cancel" }),
        "forbidden",
        /does not belong to/,
      );
    });

    it("refuses a global-scope permission decision by name, rather than narrowing it", async () => {
      const { owner } = await makeLab();
      const research = await owner.createResearch({ title: "Global scope", key: "GLB" });
      const task = await owner.createTask({
        researchId: research.id,
        stage: "background",
        title: "run me",
      });
      const handle = await owner.startRun({
        researchId: research.id,
        taskId: task.id,
        prompt: "go",
        options: { planMode: false },
      });
      await expectRejection(
        owner.submitRunDecision(handle.runId, {
          action: "permission",
          requestId: "permission-conformance",
          decision: { decision: "allow", scope: "global" },
        }),
        "invalid",
        /every Research/,
      );
    });
  });
}

/** Active runs are discoverable only to the actor whose machine owns them.
 *  A Task may hold several at once — one working and the rest waiting behind
 *  it — and a Task's runs are its own. */
export function runResumeConformance(makeLab: () => Promise<ConformanceLab>): void {
  describe("resumeRuns discovers an owned active run", () => {
    it("takes a second turn on a Task already working, and reveals concurrent Task runs only to their owner", async () => {
      // A researcher watching a turn go the wrong way says the next thing
      // while they are thinking it, rather than waiting for the agent or
      // stopping the work to correct it. The turn is taken now and waits its
      // place; nothing about it runs beside the one already going.
      const { owner, member } = await makeLab();
      const research = await owner.createResearch({ title: "Resume", key: "RSM" });
      const task = await owner.createTask({
        researchId: research.id,
        stage: "methods",
        title: "first active turn",
      });
      const sibling = await owner.createTask({
        researchId: research.id,
        stage: "methods",
        title: "second active turn",
      });
      const first = await owner.startRun({
        researchId: research.id,
        taskId: task.id,
        prompt: "first",
        options: { planMode: false },
      });
      const queued = await owner.startRun({
        researchId: research.id,
        taskId: task.id,
        prompt: "and also this",
        options: { planMode: false },
      });
      expect(queued.runId).not.toBe(first.runId);
      const second = await owner.startRun({
        researchId: research.id,
        taskId: sibling.id,
        prompt: "second",
        options: { planMode: false },
      });

      const firstResumed = await owner.resumeRuns(task.id);
      const secondResumed = await owner.resumeRuns(sibling.id);
      // Both of the Task's turns come back, oldest first: the one working and
      // the one waiting, which is what a reload has to be able to show.
      expect(firstResumed.map((run) => run.runId)).toEqual([first.runId, queued.runId]);
      expect(secondResumed.map((run) => run.runId)).toEqual([second.runId]);
      expect(firstResumed[0]!.snapshot.prompt).toBe("first");
      expect(firstResumed[1]!.snapshot.prompt).toBe("and also this");
      expect(secondResumed[0]!.snapshot.prompt).toBe("second");
      expect(await member.resumeRuns(task.id)).toEqual([]);
      expect(await member.resumeRuns(sibling.id)).toEqual([]);

      first.detach();
      queued.detach();
      second.detach();
      for (const run of [...firstResumed, ...secondResumed]) run.detach();
    });

    it("refuses a turn past the queue's depth, naming the limit", async () => {
      // A queue is someone typing ahead, not a work backlog. Past a handful
      // it is a runaway or a mistake, and every turn waiting holds a prompt
      // the agent will act on much later than it was written.
      const { owner } = await makeLab();
      const research = await owner.createResearch({ title: "Depth", key: "DPT" });
      const task = await owner.createTask({
        researchId: research.id,
        stage: "methods",
        title: "typed ahead too far",
      });
      const started = [];
      for (let i = 0; i < MAX_TURNS_OUTSTANDING; i += 1)
        started.push(
          await owner.startRun({
            researchId: research.id,
            taskId: task.id,
            prompt: `turn ${i}`,
            options: { planMode: false },
          }),
        );

      await expect(
        owner.startRun({
          researchId: research.id,
          taskId: task.id,
          prompt: "one too many",
          options: { planMode: false },
        }),
      ).rejects.toMatchObject({ code: "conflict" });

      for (const run of started) run.detach();
    });
  });
}

/** Everything an implementation can satisfy with nothing but storage. */
const AREAS = [
  identityConformance,
  researchesConformance,
  tasksConformance,
  taskNamingConformance,
  taskChatConformance,
  membersConformance,
  conversationsUsageSettingsConformance,
  conversationWritesConformance,
  customizationConformance,
  groupsConformance,
  absentCapabilityConformance,
  pairingUnsupportedConformance,
  kernelAxisConformance,
  environmentDeclarationsConformance,
];

/** And what only an implementation that can actually run a turn can. */
const RUNTIME_AREAS = [taskChatRunConformance];

/** Every area there is. Exported so a caller can name what it is skipping,
 *  and so a test can check that nothing was written and then left off both
 *  lists — which would run nowhere and fail nothing. */
export const ALL_AREAS = [...AREAS, ...RUNTIME_AREAS];

/**
 * The whole contract, held against one implementation.
 *
 * `skip` is for an implementation that refuses a capability rather than
 * simulating it. It takes the area functions themselves, so a caller has to
 * name what it is not being held to — a boolean would cover whatever some
 * later list happened to grow, and an area could stop being run against an
 * implementation without one line changing at its call site.
 */
export function runContractConformance(
  label: string,
  makeApi: () => Promise<LykeionApi>,
  options: {
    skip?: Array<(makeApi: () => Promise<LykeionApi>) => void>;
    /** Two identities on one lab. Required: the role areas cannot be
     *  expressed without it, and making it optional would let an
     *  implementation quietly stop being held to them. */
    makeLab: () => Promise<ConformanceLab>;
    /** A lab with enough real machine state to start a turn. Defaults to
     *  `makeLab` for implementations whose ordinary conformance lab can run. */
    makeRunLab?: () => Promise<ConformanceLab>;
  },
): void {
  const skipped = new Set(options.skip ?? []);
  describe(`contract conformance — ${label}`, () => {
    for (const area of ALL_AREAS) if (!skipped.has(area)) area(makeApi);
    rolesConformance(options.makeLab);
    // Needs no live turn, so — unlike `runDecisionConformance` below — it is
    // always run, the same way `rolesConformance` always is.
    unknownRunConformance(options.makeLab);
    runDecisionConformance(options.makeRunLab ?? options.makeLab);
    runResumeConformance(options.makeRunLab ?? options.makeLab);
  });
}

/**
 * Drives one turn on a Task from `startRun` to the run landing, answering
 * whatever the implementation asks on the way: approve a proposed plan,
 * allow a permission request once, and skip a clarifying question.
 *
 * Deliberately indifferent to how the turn ends. A caller here is checking
 * what a turn does to the *Task* — its `runCount`, its title, its transcript —
 * and an implementation is free to reach that through any sequence of events
 * it likes, or none at all beyond `completed`.
 */
async function driveOneTurn(
  api: LykeionApi,
  researchId: string,
  taskId: string,
  prompt: string,
): Promise<void> {
  const handle = await api.startRun({
    researchId,
    taskId,
    prompt,
    options: { planMode: false },
  });
  await new Promise<void>((resolve) => {
    handle.onEvent((e) => {
      switch (e.event) {
        case "plan-proposed":
          handle.submit({ action: "approve-plan" });
          break;
        case "permission-card":
          handle.submit({
            action: "permission",
            requestId: e.request.id,
            decision: { decision: "allow", scope: "once" },
          });
          break;
        case "question-asked":
          // An empty selection is a deliberate skip, not a non-answer.
          handle.submit({
            action: "answer-question",
            requestId: e.request.requestId,
            answer: { selected: [] },
          });
          break;
        case "completed":
          resolve();
          break;
        default:
          break;
      }
    });
  });
  handle.close();
}
