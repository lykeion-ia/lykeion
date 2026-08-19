import { expect, it } from "vitest";
import type { Machine, Member, Research, Task } from "@lykeion/api";
import { deriveColleagueRows } from "./colleague-meta";

const member = (id: string): Member => ({
  user: { id, email: `${id}@lab.example`, displayName: id, createdTs: 0 },
  role: "member",
  joinedTs: 0,
});

const task = (id: string, researchId: string, userId: string, done: boolean): Task =>
  ({
    id,
    researchId,
    title: id,
    status: done ? "done" : "todo",
    assignees: [{ kind: "user", userId }],
  }) as unknown as Task;

const research = (id: string, key: string): Research =>
  ({ id, key, title: key }) as unknown as Research;

it("counts open and done work, and lists the researches behind it", () => {
  const rows = deriveColleagueRows(
    [member("ann")],
    [
      task("t1", "r1", "ann", true),
      task("t2", "r1", "ann", false),
      task("t3", "r2", "ann", false),
    ],
    [research("r1", "CMP"), research("r2", "RNA")],
    [],
  );
  expect(rows[0].openCount).toBe(2);
  expect(rows[0].doneCount).toBe(1);
  expect(rows[0].totalCount).toBe(3);
  expect(rows[0].researchKeys).toEqual(["CMP", "RNA"]);
});

it("ignores work assigned to an agent rather than a person", () => {
  const agentTask = {
    id: "t9",
    researchId: "r1",
    title: "t9",
    status: "todo",
    assignees: [{ kind: "agent", name: "ann" }],
  } as unknown as Task;
  const rows = deriveColleagueRows(
    [member("ann")],
    [agentTask],
    [research("r1", "CMP")],
    [],
  );
  expect(rows[0].totalCount).toBe(0);
  expect(rows[0].researchKeys).toEqual([]);
});

it("counts only the machines a colleague owns", () => {
  const machine = (id: string, ownerId: string) =>
    ({ id, name: id, ownerId }) as unknown as Machine;
  const rows = deriveColleagueRows(
    [member("ann"), member("bob")],
    [],
    [],
    [machine("m1", "ann"), machine("m2", "ann"), machine("m3", "bob")],
  );
  expect(rows[0].machineCount).toBe(2);
  expect(rows[1].machineCount).toBe(1);
});
