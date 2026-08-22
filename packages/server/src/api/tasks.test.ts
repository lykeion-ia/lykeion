import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLykeionError } from "@lykeion/api";
import { openStore } from "../store/sqlite";
import { migrate, nextSeq } from "../store/migrations";
import { readConfig } from "../config";
import { createChannel } from "../channel";
import { createRunRelay } from "../run-relay";
import { createRevertRegistry } from "../run-revert";
import { createKernelListRegistry } from "../kernel-list-registry";
import { createTitleRegistry } from "../title-registry";
import { createPendingCells } from "../kernel-cells";
import { createEnvironmentSetupCoordinator } from "../environment-setup-coordinator";
import { changeRecorder } from "./changes";
import { tasksApi } from "./tasks";
import type { Deps } from "./index";
import type { Store } from "../store/store";
import { environmentSetupStore } from "../store/environment-setups";
import { openSession, recordTurn } from "../store/sessions";
import type { RunCommand } from "../run-relay";

// `conformance.test.ts` wires only `studiesConformance` and `tasksConformance`
// against this server — `taskChatConformance`, where `pinned` and
// `lastRunStatus` are actually asserted, stays unwired because its prompt-
// driven test needs `startRun`, which this server still answers
// `unsupported`. That leaves `toTask`'s handling of `pinned`, `lastRunStatus`
// and `machineId` unreached by anything that runs against a live server —
// these tests close that gap directly against `tasksApi`.

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-tasks-"));
  dirs.push(dir);
  const store = openStore(join(dir, "workspace.db"));
  opened.push(store);
  migrate(store);
  return store;
}

afterEach(() => {
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      // best effort — a stuck close must not strand the rest of cleanup.
    }
  }
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort — nothing here is worth failing an already-passed test.
    }
  }
});

const NOW = 1_800_000_000;

function addOwner(store: Store, id: string): void {
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, `${id}@lab.example`, id, "x", NOW, nextSeq(store)],
  );
  store.run(`INSERT INTO members (user_id, role, joined_ts, seq) VALUES (?, 'owner', ?, ?)`, [
    id,
    NOW,
    nextSeq(store),
  ]);
}

function depsFor(store: Store, relay?: ReturnType<typeof createRunRelay>): Deps {
  const actor = { userId: "u_owner", role: "owner" } as const;
  const channel = createChannel(store, 1000);
  const runs = relay ?? createRunRelay();
  return {
    store,
    actor,
    now: () => NOW,
    config: readConfig({}),
    // A real channel rather than a stub: it is the cheapest place to leave
    // the recorder's publish path actually exercised.
    channel,
    runs,
    reverts: createRevertRegistry(),
    kernelLists: createKernelListRegistry(), titles: createTitleRegistry(), pendingCells: createPendingCells(),
    coordinator: createEnvironmentSetupCoordinator({ store, runs, now: () => NOW }),
    changes: changeRecorder({ store, actorId: actor.userId, now: () => NOW, channel }),
  };
}

it("a Task's pinned flag reads back true when set, and is absent — not false — when it never was pinned", async () => {
  const store = freshStore();
  addOwner(store, "u_owner");
  const tasks = tasksApi(depsFor(store));

  const fresh = await tasks.createTask({ stage: "background", title: "Never pinned" });
  expect("pinned" in fresh).toBe(false);

  const pinned = await tasks.updateTask(fresh.id, { pinned: true });
  expect(pinned.pinned).toBe(true);

  const unpinned = await tasks.updateTask(fresh.id, { pinned: false });
  expect("pinned" in unpinned).toBe(false);
});

it("lastRunStatus and machineId are absent on a Task nothing has run yet, and read back once a column holds a value", async () => {
  const store = freshStore();
  addOwner(store, "u_owner");
  const tasks = tasksApi(depsFor(store));

  const created = await tasks.createTask({ stage: "background", title: "Untouched" });
  expect("lastRunStatus" in created).toBe(false);
  expect("machineId" in created).toBe(false);

  // No handler writes these two columns — recording a run needs a machine
  // this server does not have — so the write is seeded directly, the way a
  // run-recording handler would.
  store.run(`UPDATE tasks SET last_run_status = 'ok', runtime_id = 'rt_1' WHERE id = ?`, [
    created.id,
  ]);

  const after = await tasks.getTask(created.id);
  expect(after.task.lastRunStatus).toBe("ok");
  expect(after.task.machineId).toBe("rt_1");
});

it("a Task names the agent of its newest turn, so a list can say what each is talking to", async () => {
  const store = freshStore();
  addOwner(store, "u_owner");
  const tasks = tasksApi(depsFor(store));

  const task = await tasks.createTask({ stage: "background", title: "Talks to something" });
  expect("agent" in task).toBe(false);

  // Two turns on two sessions, the way a Task that changed agent mid-life
  // reads on disk. Seeded directly for the same reason the roll-up columns
  // above are: starting a real turn needs a machine this server has not got.
  const turn = (id: string, sessionId: string, agent: string, seq: number) => {
    store.run(
      `INSERT INTO sessions (id, study_id, runtime_id, agent, opened_by, opened_ts, seq)
       VALUES (?, 's_1', 'rt_1', ?, 'u_owner', ?, ?)`,
      [sessionId, agent, NOW, nextSeq(store)],
    );
    store.run(
      `INSERT INTO turns (id, session_id, task_id, prompt, started_ts, ended_ts, status, seq)
       VALUES (?, ?, ?, 'go', ?, ?, 'ok', ?)`,
      [id, sessionId, task.id, NOW, NOW, seq],
    );
  };
  turn("turn_1", "sess_1", "claude", 1);

  expect((await tasks.getTask(task.id)).task.agent).toBe("claude");
  expect((await tasks.listTasks())[0].agent).toBe("claude");

  // The newest turn wins — not the first one, and not whichever row the
  // join happened to reach last.
  turn("turn_2", "sess_2", "cursor", 2);
  expect((await tasks.getTask(task.id)).task.agent).toBe("cursor");
  expect((await tasks.listTasks())[0].agent).toBe("cursor");
});

it("createTask names the unknown research rather than surfacing a raw foreign-key failure", async () => {
  // `tasks.study_id` is a foreign key to `studies.id`, and this store runs
  // with `PRAGMA foreign_keys = ON`. Without a check ahead of the INSERT,
  // an unknown researchId does not fail cleanly — it throws whatever SQLite's
  // own constraint-violation error looks like, which reaches the RPC layer
  // as an uncaught exception (a 500) instead of a `not-found` a caller can
  // branch on the way `updateTask` already lets one for the same mistake.
  const store = freshStore();
  addOwner(store, "u_owner");
  const tasks = tasksApi(depsFor(store));

  const err = await tasks
    .createTask({ researchId: "s_nope", stage: "background", title: "Orphaned" })
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  expect(isLykeionError(err) && err.code).toBe("not-found");
  expect((err as Error).message).toMatch(/no such research: s_nope/);

  // And nothing was written: a failed create leaves no row a later number
  // could collide with, or a later list could turn up.
  expect(await tasks.listTasks()).toEqual([]);
});

/** A Research, a machine and a Task blocked on an environment: the durable
 *  requirement a daemon files through `/daemon/kernel-env/require`, seeded
 *  through the store the same way the coordinator's own suite seeds one. */
function blockedTask(store: Store, title: string): { taskId: string; waiterId: string } {
  if (!store.get(`SELECT 1 FROM studies WHERE id = 's_1'`)) {
    store.run(
      `INSERT INTO studies (id, key, title, created_by, created_ts, updated_ts, seq)
       VALUES ('s_1', 'ENV', 'Environments', 'u_owner', ?, ?, ?)`,
      [NOW, NOW, nextSeq(store)],
    );
    store.run(
      `INSERT INTO runtimes (id, owner_id, name, platform, daemon_version, capabilities,
                             created_ts, last_seen_ts, seq)
       VALUES ('rt_1', 'u_owner', 'Mac', 'macos-aarch64', '0.1.0', '[]', ?, ?, ?)`,
      [NOW, NOW, nextSeq(store)],
    );
  }
  const seq = nextSeq(store);
  const taskId = `t_${seq}`;
  store.run(
    `INSERT INTO tasks (id, number, study_id, stage, title, status, priority, created_by,
                        created_ts, updated_ts, seq)
     VALUES (?, ?, 's_1', 'background', ?, 'todo', 'no-priority', 'u_owner', ?, ?, ?)`,
    [taskId, seq, title, NOW, NOW, seq],
  );
  const sessionId = openSession(store, {
    researchId: "s_1",
    machineId: "rt_1",
    agent: "claude",
    openedBy: "u_owner",
    openedTs: NOW,
  });
  const sourceTurnId = recordTurn(store, {
    sessionId,
    taskId,
    prompt: "analyse it",
    startedTs: NOW,
  });
  const waiter = environmentSetupStore(store).recordRequirement({
    studyId: "s_1",
    taskId,
    sessionId,
    sourceTurnId,
    sourceRunId: sourceTurnId,
    language: "r",
    environmentName: "meta-analysis-r",
    runtimeId: "rt_1",
    createdTs: NOW,
  });
  return { taskId, waiterId: waiter.id };
}

it("deleting a Task takes its environment requirement with it and leaves another Task's standing", async () => {
  // A Task deleted while it is blocked on a build must not leave a durable
  // requirement pointing at it: the build goes on running for whoever else
  // asked, and a waiter naming a Task that no longer exists would be resumed
  // into nothing when it settles. The neighbour's requirement is a different
  // Task's and is none of this delete's business.
  const store = freshStore();
  addOwner(store, "u_owner");
  const tasks = tasksApi(depsFor(store));
  const doomed = blockedTask(store, "Deleted mid-build");
  const survivor = blockedTask(store, "Still waiting");

  await tasks.deleteTask(doomed.taskId);

  expect(store.get(`SELECT id FROM task_env_setup_waiters WHERE id = ?`, [doomed.waiterId]))
    .toBeUndefined();
  expect(store.get(`SELECT state FROM task_env_setup_waiters WHERE id = ?`, [survivor.waiterId]))
    .toEqual({ state: "waiting" });
  // And the surviving Task itself is untouched — the delete reached exactly
  // one row in `tasks` too.
  expect((await tasks.getTask(survivor.taskId)).task.title).toBe("Still waiting");
});

it("ends a deleted Task's already-dispatched continuation and names the run to recall", async () => {
  // The waiter row cascades on `task_env_setup_waiters.task_id`, so the
  // requirement goes with the Task on its own. The TURN does not:
  // `turns.task_id` carries no foreign key, so a `queued` waiter's
  // system-origin continuation survives its Task and — before this was wired
  // through the coordinator — went on running, with no waiter left that could
  // settle it and nothing sent to the machine still working on it.
  const store = freshStore();
  addOwner(store, "u_owner");
  const runs = createRunRelay();
  const deps = depsFor(store, runs);
  const tasks = tasksApi(deps);
  const blocked = blockedTask(store, "Deleted mid-continuation");

  const setups = environmentSetupStore(store);
  const waiterRow = setups.waiter(blocked.waiterId)!;
  const continuationTurnId = recordTurn(store, {
    sessionId: waiterRow.sessionId,
    taskId: blocked.taskId,
    prompt: "The environment meta-analysis-r is ready on this machine.",
    startedTs: NOW,
    origin: "system",
    continuation: {
      kind: "environment-setup",
      waiterId: blocked.waiterId,
      sourceTurnId: waiterRow.sourceTurnId,
      environmentName: "meta-analysis-r",
      machineId: "rt_1",
    },
  });
  expect(setups.queueWaiter(blocked.waiterId, continuationTurnId, NOW)).toBe(true);

  const taken: RunCommand[] = [];
  const detach = runs.attach("rt_1", (_seq, command) => taken.push(command));

  await tasks.deleteTask(blocked.taskId);

  expect(store.get(`SELECT id FROM tasks WHERE id = ?`, [blocked.taskId])).toBeUndefined();
  expect(store.get(`SELECT id FROM task_env_setup_waiters WHERE id = ?`, [blocked.waiterId]))
    .toBeUndefined();
  // The two that the cascade could never have reached.
  expect(store.get(`SELECT status, ended_ts FROM turns WHERE id = ?`, [continuationTurnId]))
    .toEqual({ status: "cancelled", ended_ts: NOW });
  expect(taken).toEqual([{ type: "cancel", runId: continuationTurnId }]);
  detach();
});
