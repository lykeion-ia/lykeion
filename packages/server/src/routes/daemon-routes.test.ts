import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../store/sqlite";
import { migrate, nextSeq } from "../store/migrations";
import { handleDaemonRoute, resolveMachine } from "./daemon-routes";
import { changeRecorder } from "../api/changes";
import { createChannel } from "../channel";
import { hashSecret } from "../auth";
import { environmentStore } from "../store/environments";
import { createRunRelay, type RunCommand, type RunRelay } from "../run-relay";
import {
  createEnvironmentSetupCoordinator,
  type EnvironmentSetupCoordinator,
} from "../environment-setup-coordinator";
import { environmentSetupStore } from "../store/environment-setups";
import { openSession, recordTurn } from "../store/sessions";
import type { Store } from "../store/store";
import {
  environmentLockfileFingerprint,
  environmentPackageFingerprint,
} from "@lykeion/api/environment-setup-evidence";

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-daemon-routes-"));
  dirs.push(dir);
  const store = openStore(join(dir, "workspace.db"));
  opened.push(store);
  migrate(store);
  return store;
}

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = 1_800_000_000;

function recorderFor(store: Store) {
  return changeRecorder({ store, actorId: null, now: () => NOW, channel: createChannel(store, 1000) });
}

function post(
  store: Store,
  path: string,
  body: unknown,
  authorization?: string,
  now: number = NOW,
  // A real relay rather than a stub, and fresh per call: nothing is
  // attached to it by default, so a route that dispatches a command to a
  // machine nothing is listening on gets exactly what a disconnected machine
  // gives — which is a state this route has to survive rather than throw
  // from, since it has already written the declaration.
  runs: RunRelay = createRunRelay(),
  coordinator: EnvironmentSetupCoordinator = createEnvironmentSetupCoordinator({
    store,
    runs,
    now: () => now,
  }),
) {
  return handleDaemonRoute({
    store,
    changes: recorderFor(store),
    method: "POST",
    path,
    body,
    authorization,
    now,
    coordinator,
    runs,
  });
}

function changeLogCount(store: Store): number {
  return store.get(`SELECT COUNT(*) AS c FROM change_log`)!.c as number;
}

function changeLogEntries(store: Store): Array<{ kind: string; actorId: string | null }> {
  return store.all(`SELECT kind, actor_id FROM change_log ORDER BY seq ASC`).map((row) => ({
    kind: row.kind as string,
    actorId: row.actor_id as string | null,
  }));
}

function machineRow(store: Store, machineId: string) {
  return store.get(`SELECT * FROM runtimes WHERE id = ?`, [machineId])!;
}

function cliRows(store: Store, machineId: string) {
  return store.all(
    `SELECT cli_id, name, command, version, available FROM runtime_clis WHERE runtime_id = ? ORDER BY seq ASC`,
    [machineId],
  );
}

/** A member and a paired machine, inserted directly so a test can hand
 *  `resolveMachine` a token whose plaintext it controls. */
function insertPairedMachine(store: Store, token: string): { machineId: string; ownerId: string } {
  const ownerId = `u_${nextSeq(store)}`;
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq) VALUES (?, ?, ?, ?, ?, ?)`,
    [ownerId, `${ownerId}@lab.example`, "Owner", "irrelevant", NOW, nextSeq(store)],
  );
  store.run(`INSERT INTO members (user_id, role, joined_ts, seq) VALUES (?, 'member', ?, ?)`, [
    ownerId,
    NOW,
    nextSeq(store),
  ]);
  const machineId = `rt_${nextSeq(store)}`;
  store.run(
    `INSERT INTO runtimes (id, owner_id, name, platform, daemon_version, capabilities, created_ts, last_seen_ts, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [machineId, ownerId, "a-machine", "macos-aarch64", "0.1.0", "[]", NOW, NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO machine_tokens (token_hash, runtime_id, owner_id, created_ts, seq) VALUES (?, ?, ?, ?, ?)`,
    [hashSecret(token), machineId, ownerId, NOW, nextSeq(store)],
  );
  return { machineId, ownerId };
}

function insertTask(store: Store, ownerId: string): void {
  store.run(
    `INSERT INTO studies (id, key, title, created_by, created_ts, updated_ts, seq)
     VALUES ('s_setup', 'SETUP', 'Setup', ?, ?, ?, ?)`,
    [ownerId, NOW, NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO tasks
       (id, number, study_id, stage, title, status, priority, created_by,
        created_ts, updated_ts, seq)
     VALUES ('t_setup', 1, 's_setup', 'background', 'Setup', 'todo', 'no-priority',
             ?, ?, ?, ?)`,
    [ownerId, NOW, NOW, nextSeq(store)],
  );
}

function insertRequirementSource(
  store: Store,
  machineId: string,
  ownerId: string,
): { runId: string; sessionId: string } {
  insertTask(store, ownerId);
  const sessionId = openSession(store, {
    researchId: "s_setup",
    machineId,
    agent: "claude",
    openedBy: ownerId,
    openedTs: NOW,
  });
  const runId = recordTurn(store, {
    sessionId,
    taskId: "t_setup",
    prompt: "analyze the atacseq data",
    startedTs: NOW,
  });
  environmentStore(store).declare({
    name: "atacseq",
    language: "python",
    manager: "uv",
    packages: ["scanpy"],
    createdBy: ownerId,
    createdTs: NOW,
  });
  return { runId, sessionId };
}

it("returns undefined for a path it does not own, so routing can fall through", () => {
  const store = freshStore();
  const result = post(store, "/daemon/does-not-exist", {});
  expect(result).toBeUndefined();
});

it("resolveMachine is undefined with no authorization header at all", () => {
  const store = freshStore();
  expect(resolveMachine(store, undefined)).toBeUndefined();
});

it("resolveMachine is undefined for a header that is not a bearer token", () => {
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  expect(resolveMachine(store, "Basic dXNlcjpwYXNz")).toBeUndefined();
  expect(resolveMachine(store, "Bearer")).toBeUndefined();
});

it("resolveMachine is undefined for a token nothing issued", () => {
  const store = freshStore();
  expect(resolveMachine(store, "Bearer not-a-real-token")).toBeUndefined();
});

it("resolveMachine names the machine and owner behind a token that was actually issued", () => {
  const store = freshStore();
  const { machineId, ownerId } = insertPairedMachine(store, "a-real-token");
  expect(resolveMachine(store, "Bearer a-real-token")).toEqual({ machineId, ownerId });
});

it("resolveMachine refuses a token whose machine has been removed, even if the token itself was not revoked", () => {
  // Belt and suspenders: `removeMachine` revokes the token too, but this is
  // what still refuses the caller if that second write were ever missed.
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  store.run(`UPDATE runtimes SET removed_ts = ? WHERE id = ?`, [NOW, machineId]);
  expect(resolveMachine(store, "Bearer a-real-token")).toBeUndefined();
});

it("resolveMachine refuses a token whose owner has left the lab, even if the token itself was not revoked", () => {
  // The same belt and suspenders, for offboarding: `removeMember` revokes
  // every token the departing member's machines held, but this is what
  // still refuses the caller if that write were ever missed or raced.
  const store = freshStore();
  const { ownerId } = insertPairedMachine(store, "a-real-token");
  store.run(`UPDATE members SET removed_ts = ? WHERE user_id = ?`, [NOW, ownerId]);
  expect(resolveMachine(store, "Bearer a-real-token")).toBeUndefined();
});

it("heartbeat refuses a caller with no token", () => {
  const store = freshStore();
  const result = post(store, "/daemon/heartbeat", {});
  expect(result).toEqual({ status: 401, json: { error: expect.any(String) } });
});

it("heartbeat accepts a caller with a valid machine token", () => {
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  const result = post(store, "/daemon/heartbeat", {}, "Bearer a-real-token");
  expect(result!.status).toBe(200);
});

it("records one unattached exact-source requirement without starting setup", () => {
  const store = freshStore();
  const { machineId, ownerId } = insertPairedMachine(store, "a-real-token");
  const source = insertRequirementSource(store, machineId, ownerId);
  const runs = createRunRelay();
  const taken: RunCommand[] = [];
  runs.attach(machineId, (_seq, command) => taken.push(command));
  const coordinator = createEnvironmentSetupCoordinator({ store, runs, now: () => NOW + 1 });

  const first = post(
    store,
    "/daemon/kernel-env/require",
    { runId: source.runId, sessionId: source.sessionId, environmentName: "atacseq" },
    "Bearer a-real-token",
    NOW + 1,
    runs,
    coordinator,
  );
  const duplicate = post(
    store,
    "/daemon/kernel-env/require",
    { runId: source.runId, sessionId: source.sessionId, environmentName: "atacseq" },
    "Bearer a-real-token",
    NOW + 2,
    runs,
    coordinator,
  );

  expect(first).toEqual({ status: 200, json: { waiterId: expect.any(String) } });
  expect(duplicate).toEqual(first);
  const waiters = store.all(`SELECT * FROM task_env_setup_waiters`);
  expect(waiters).toHaveLength(1);
  expect(waiters[0]).toMatchObject({
    job_id: null,
    task_id: "t_setup",
    session_id: source.sessionId,
    source_turn_id: source.runId,
    source_run_id: source.runId,
    environment_name: "atacseq",
    runtime_id: machineId,
    state: "waiting",
  });
  expect(environmentSetupStore(store).nonterminalJobs()).toEqual([]);
  expect(taken).toEqual([]);
});

it("refuses an environment requirement without the exact live source session and machine", () => {
  const store = freshStore();
  const firstMachine = insertPairedMachine(store, "first-token");
  const source = insertRequirementSource(store, firstMachine.machineId, firstMachine.ownerId);
  const otherMachine = insertPairedMachine(store, "other-token");

  expect(
    post(
      store,
      "/daemon/kernel-env/require",
      { runId: "run_missing", sessionId: source.sessionId, environmentName: "atacseq" },
      "Bearer first-token",
    )!.status,
  ).toBe(403);
  expect(
    post(
      store,
      "/daemon/kernel-env/require",
      { runId: source.runId, sessionId: "sess_wrong", environmentName: "atacseq" },
      "Bearer first-token",
    )!.status,
  ).toBe(403);
  expect(
    post(
      store,
      "/daemon/kernel-env/require",
      { runId: source.runId, sessionId: source.sessionId, environmentName: "atacseq" },
      "Bearer other-token",
    )!.status,
  ).toBe(403);
  expect(otherMachine.machineId).not.toBe(firstMachine.machineId);
  expect(store.get(`SELECT COUNT(*) AS count FROM task_env_setup_waiters`)!.count).toBe(0);
});

it("refuses a ready environment and a source older than the newest user turn", () => {
  const store = freshStore();
  const { machineId, ownerId } = insertPairedMachine(store, "a-real-token");
  const source = insertRequirementSource(store, machineId, ownerId);
  const envs = environmentStore(store);
  expect(envs.writeLock("atacseq", "scanpy==1\n", NOW, ["scanpy"])).toBe(1);
  const declaration = envs.get("atacseq") as
    | (NonNullable<ReturnType<ReturnType<typeof environmentStore>["get"]>> & {
        declarationGenerationId?: string;
      })
    | undefined;
  store.run(`UPDATE runtimes SET environments = ? WHERE id = ?`, [
    JSON.stringify([
      {
        state: "ready",
        name: "atacseq",
        language: "python",
        manager: "uv",
        platform: "macos-aarch64",
        root: "/work/envs/atacseq",
        lockRevision: 1,
        setupRequestId: "envsetup_atacseq_ready",
        lockfileFingerprint: environmentLockfileFingerprint("scanpy==1\n"),
        packageFingerprint: environmentPackageFingerprint(["scanpy"]),
        declarationCreatedTs: NOW,
        declarationGenerationId: declaration!.declarationGenerationId,
      },
    ]),
    machineId,
  ]);
  expect(
    post(
      store,
      "/daemon/kernel-env/require",
      { runId: source.runId, sessionId: source.sessionId, environmentName: "atacseq" },
      "Bearer a-real-token",
    )!.status,
  ).toBe(409);

  store.run(`UPDATE runtimes SET environments = NULL WHERE id = ?`, [machineId]);
  recordTurn(store, {
    sessionId: source.sessionId,
    taskId: "t_setup",
    prompt: "newer direction",
    startedTs: NOW + 1,
  });
  expect(
    post(
      store,
      "/daemon/kernel-env/require",
      { runId: source.runId, sessionId: source.sessionId, environmentName: "atacseq" },
      "Bearer a-real-token",
    )!.status,
  ).toBe(409);
  expect(store.get(`SELECT COUNT(*) AS count FROM task_env_setup_waiters`)!.count).toBe(0);
});

it("requires an environment when the machine's ready status is for a stale revision", () => {
  const store = freshStore();
  const { machineId, ownerId } = insertPairedMachine(store, "a-real-token");
  const source = insertRequirementSource(store, machineId, ownerId);
  store.run(`UPDATE runtimes SET environments = ? WHERE id = ?`, [
    JSON.stringify([
      {
        state: "ready",
        name: "atacseq",
        language: "python",
        manager: "uv",
        platform: "macos-aarch64",
        root: "/work/envs/atacseq",
        lockRevision: 99,
      },
    ]),
    machineId,
  ]);

  expect(
    post(
      store,
      "/daemon/kernel-env/require",
      { runId: source.runId, sessionId: source.sessionId, environmentName: "atacseq" },
      "Bearer a-real-token",
    ),
  ).toEqual({ status: 200, json: { waiterId: expect.any(String) } });
});

it("requires a redeclared same-name environment when ready belongs to its deleted generation", () => {
  const store = freshStore();
  const { machineId, ownerId } = insertPairedMachine(store, "a-real-token");
  const source = insertRequirementSource(store, machineId, ownerId);
  const envs = environmentStore(store);
  expect(envs.writeLock("atacseq", "scanpy==1\n", NOW, ["scanpy"])).toBe(1);
  store.run(`UPDATE runtimes SET environments = ? WHERE id = ?`, [
    JSON.stringify([
      {
        state: "ready",
        name: "atacseq",
        language: "python",
        manager: "uv",
        platform: "macos-aarch64",
        root: "/work/envs/atacseq",
        lockRevision: 1,
      },
    ]),
    machineId,
  ]);
  envs.remove("atacseq");
  envs.declare({
    name: "atacseq",
    language: "python",
    manager: "uv",
    packages: ["anndata"],
    createdBy: ownerId,
    createdTs: NOW + 1,
  });

  expect(
    post(
      store,
      "/daemon/kernel-env/require",
      { runId: source.runId, sessionId: source.sessionId, environmentName: "atacseq" },
      "Bearer a-real-token",
    ),
  ).toEqual({ status: 200, json: { waiterId: expect.any(String) } });
});

it("requires an equal-timestamp redeclared rev0 environment when ready has the old opaque generation", () => {
  const store = freshStore();
  const { machineId, ownerId } = insertPairedMachine(store, "a-real-token");
  const source = insertRequirementSource(store, machineId, ownerId);
  const envs = environmentStore(store);
  const oldGeneration = (envs.get("atacseq") as ReturnType<typeof envs.get> & {
    declarationGenerationId?: string;
  })?.declarationGenerationId;
  store.run(`UPDATE runtimes SET environments = ? WHERE id = ?`, [
    JSON.stringify([
      {
        state: "ready",
        name: "atacseq",
        language: "python",
        manager: "uv",
        platform: "macos-aarch64",
        root: "/work/envs/atacseq",
        lockRevision: 0,
        declarationCreatedTs: NOW,
        declarationGenerationId: oldGeneration,
      },
    ]),
    machineId,
  ]);
  envs.remove("atacseq");
  envs.declare({
    name: "atacseq",
    language: "python",
    manager: "uv",
    packages: ["anndata"],
    createdBy: ownerId,
    createdTs: NOW,
  });

  expect(
    post(
      store,
      "/daemon/kernel-env/require",
      { runId: source.runId, sessionId: source.sessionId, environmentName: "atacseq" },
      "Bearer a-real-token",
    ),
  ).toEqual({ status: 200, json: { waiterId: expect.any(String) } });
});

it("treats a legacy ready status without a declaration generation as non-authoritative", () => {
  const store = freshStore();
  const { machineId, ownerId } = insertPairedMachine(store, "a-real-token");
  const source = insertRequirementSource(store, machineId, ownerId);
  store.run(`UPDATE runtimes SET environments = ? WHERE id = ?`, [
    JSON.stringify([
      {
        state: "ready",
        name: "atacseq",
        language: "python",
        manager: "uv",
        platform: "macos-aarch64",
        root: "/work/envs/atacseq",
        lockRevision: 0,
      },
    ]),
    machineId,
  ]);

  expect(
    post(
      store,
      "/daemon/kernel-env/require",
      { runId: source.runId, sessionId: source.sessionId, environmentName: "atacseq" },
      "Bearer a-real-token",
    ),
  ).toEqual({ status: 200, json: { waiterId: expect.any(String) } });
});

it("heartbeat refuses a revoked token", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  store.run(`UPDATE machine_tokens SET revoked_ts = ? WHERE runtime_id = ?`, [NOW, machineId]);
  const result = post(store, "/daemon/heartbeat", {}, "Bearer a-real-token");
  expect(result).toEqual({ status: 401, json: { error: expect.any(String) } });
});

it("exchange refuses a body missing a code or a verifier", () => {
  const store = freshStore();
  expect(post(store, "/daemon/pair/exchange", { verifier: "v" })!.status).toBe(400);
  expect(post(store, "/daemon/pair/exchange", { code: "c" })!.status).toBe(400);
  expect(post(store, "/daemon/pair/exchange", {})!.status).toBe(400);
});

it("heartbeat moves last_seen_ts, and touches nothing else about the machine", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  const before = machineRow(store, machineId);
  const later = NOW + 30;

  const result = post(store, "/daemon/heartbeat", {}, "Bearer a-real-token", later);

  expect(result!.status).toBe(200);
  const after = machineRow(store, machineId);
  expect(after.last_seen_ts).toBe(later);
  expect(after.platform).toBe(before.platform);
  expect(after.daemon_version).toBe(before.daemon_version);
  expect(after.capabilities).toBe(before.capabilities);
  expect(after.name).toBe(before.name);
});

it("a heartbeat never records a change-log entry, no matter how many arrive", () => {
  // `usePromise` folds the global data version into every screen's
  // dependencies, so a heartbeat that published would make every screen in
  // every open browser in the lab re-read every fifteen seconds, per
  // machine.
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");

  // Asserted inside the loop, not just at the end: a token that stopped
  // resolving would 401 before ever reaching `record`, and a count of zero
  // would look identical to five successful, unpublished heartbeats.
  for (let i = 0; i < 5; i++) {
    expect(post(store, "/daemon/heartbeat", {}, "Bearer a-real-token")!.status).toBe(200);
  }

  expect(changeLogCount(store)).toBe(0);
});

it("report refuses a caller with no token", () => {
  const store = freshStore();
  const result = post(store, "/daemon/report", {
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    capabilities: [],
    clis: [],
  });
  expect(result).toEqual({ status: 401, json: { error: expect.any(String) } });
});

it("report refuses a body missing platform, daemonVersion, or a clis array", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  const before = machineRow(store, machineId);
  const full = { platform: "macos-aarch64", daemonVersion: "0.1.0", capabilities: [], clis: [] };

  // A field misnamed the way a build regression would misname it —
  // `daemon_version` instead of `daemonVersion` — must be refused outright,
  // not silently read as absent and written over what is already stored.
  expect(post(store, "/daemon/report", { ...full, platform: undefined }, "Bearer a-real-token")!.status).toBe(
    400,
  );
  expect(post(store, "/daemon/report", { ...full, daemonVersion: "" }, "Bearer a-real-token")!.status).toBe(400);
  expect(post(store, "/daemon/report", { ...full, clis: "not-an-array" }, "Bearer a-real-token")!.status).toBe(
    400,
  );
  expect(post(store, "/daemon/report", {}, "Bearer a-real-token")!.status).toBe(400);

  // None of those refused calls touched the machine at all.
  expect(machineRow(store, machineId)).toEqual(before);
  expect(changeLogCount(store)).toBe(0);
});

it("a report with a duplicate cli id in one body keeps the first occurrence, rather than failing", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  const body = {
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    capabilities: [],
    clis: [
      { id: "claude", name: "Claude Code", command: "claude", version: "1.0.0", available: true },
      { id: "claude", name: "Claude Code", command: "claude", version: "9.9.9", available: false },
    ],
  };

  expect(post(store, "/daemon/report", body, "Bearer a-real-token")!.status).toBe(200);

  const rows = cliRows(store, machineId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ cli_id: "claude", version: "1.0.0" });
});

it("report replaces the machine's CLI rows wholesale", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  const firstBody = {
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    capabilities: [],
    clis: [
      { id: "claude", name: "Claude Code", command: "claude", version: "1.0.0", available: true },
      { id: "codex", name: "Codex", command: "codex", version: "", available: false },
    ],
  };
  expect(post(store, "/daemon/report", firstBody, "Bearer a-real-token")!.status).toBe(200);
  expect(cliRows(store, machineId).map((r) => r.cli_id)).toEqual(["claude", "codex"]);

  const secondBody = {
    ...firstBody,
    clis: [{ id: "gemini", name: "Gemini", command: "gemini", version: "2.0.0", available: true }],
  };
  expect(post(store, "/daemon/report", secondBody, "Bearer a-real-token")!.status).toBe(200);
  const rows = cliRows(store, machineId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.cli_id).toBe("gemini");
});

it("report moves last_seen_ts, the same as a heartbeat does", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  const later = NOW + 120;

  const result = post(
    store,
    "/daemon/report",
    { platform: "macos-aarch64", daemonVersion: "0.1.0", capabilities: [], clis: [] },
    "Bearer a-real-token",
    later,
  );

  expect(result!.status).toBe(200);
  expect(machineRow(store, machineId).last_seen_ts).toBe(later);
});

it("a report that changes nothing records no change-log entry, and one that changes the CLI set records exactly one", () => {
  const store = freshStore();
  const { ownerId } = insertPairedMachine(store, "a-real-token");
  const body = {
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    capabilities: [],
    clis: [{ id: "claude", name: "Claude Code", command: "claude", version: "1.0.0", available: true }],
  };

  // The machine starts out with no CLI rows at all, so this first report —
  // reporting one — changes the set, and is the one entry.
  expect(post(store, "/daemon/report", body, "Bearer a-real-token")!.status).toBe(200);
  expect(changeLogCount(store)).toBe(1);
  // The kind and the actor are what a subscriber and an owner's inbox
  // actually read — a count alone would pass just as well if either were
  // wrong, or if the entry were attributed to nobody.
  expect(changeLogEntries(store)).toEqual([{ kind: "runtime-clis-changed", actorId: ownerId }]);

  // The identical report a second time changes nothing this lab did not
  // already know, so the count does not move.
  expect(post(store, "/daemon/report", body, "Bearer a-real-token")!.status).toBe(200);
  expect(changeLogCount(store)).toBe(1);
});

it("a report records the one entry when a known id's version changes, with the id set unchanged", () => {
  // The id set alone is not what `cliSetChanged` compares on — a build
  // bump on a CLI that was already known must be caught even though no id
  // was added or removed.
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  const body = {
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    capabilities: [],
    clis: [{ id: "claude", name: "Claude Code", command: "claude", version: "2.1.220", available: true }],
  };
  expect(post(store, "/daemon/report", body, "Bearer a-real-token")!.status).toBe(200);
  expect(changeLogCount(store)).toBe(1);

  const bumped = { ...body, clis: [{ ...body.clis[0]!, version: "2.2.0" }] };
  expect(post(store, "/daemon/report", bumped, "Bearer a-real-token")!.status).toBe(200);
  expect(changeLogCount(store)).toBe(2);
});

it("a report records the one entry when a known id's availability flips, with the id and version unchanged", () => {
  // Same id, same version, but the command stopped running (or started) —
  // still a fact the id set on its own cannot represent.
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  const body = {
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    capabilities: [],
    clis: [{ id: "claude", name: "Claude Code", command: "claude", version: "1.0.0", available: true }],
  };
  expect(post(store, "/daemon/report", body, "Bearer a-real-token")!.status).toBe(200);
  expect(changeLogCount(store)).toBe(1);

  const flipped = { ...body, clis: [{ ...body.clis[0]!, available: false }] };
  expect(post(store, "/daemon/report", flipped, "Bearer a-real-token")!.status).toBe(200);
  expect(changeLogCount(store)).toBe(2);
});

it("a report records the one entry when an agent fills in options it could not name before", () => {
  // The case the composer is built on. A probe that reaches an adapter but
  // cannot open a throwaway session — a cold start, a CLI not signed in —
  // reports the agent `sessionReady` with its options UNKNOWN. The probe five
  // minutes later opens one and reports the whole catalogue. Id, version,
  // availability and readiness are identical across the two, so a comparison
  // blind to the options calls the second report a repeat of the first: the
  // row is rewritten, nothing is announced, and every page open at the time
  // keeps offering a bare *Default* against an agent with a catalogue to
  // give. The daemon's own `cliFingerprint` counts the options for exactly
  // this reason; the lab's gate has to agree, or the report the daemon took
  // care to send dies here.
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  const unknown = {
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    capabilities: [],
    clis: [
      { id: "codex", name: "Codex", command: "codex", version: "1.0.0", available: true, sessionReady: true },
    ],
  };
  expect(post(store, "/daemon/report", unknown, "Bearer a-real-token")!.status).toBe(200);
  expect(changeLogCount(store)).toBe(1);

  const answered = {
    ...unknown,
    clis: [
      {
        ...unknown.clis[0]!,
        options: [
          {
            id: "model",
            category: "model",
            currentValue: "gpt-5.6-sol",
            choices: [{ value: "gpt-5.6-sol", label: "GPT-5.6-Sol" }],
          },
        ],
      },
    ],
  };
  expect(post(store, "/daemon/report", answered, "Bearer a-real-token")!.status).toBe(200);
  expect(changeLogCount(store)).toBe(2);

  // And the same answer again is not news, so the gate stays shut on a report
  // that repeats what the lab already holds.
  expect(post(store, "/daemon/report", answered, "Bearer a-real-token")!.status).toBe(200);
  expect(changeLogCount(store)).toBe(2);
});

it("keeps the catalogue a machine already reported when a later probe could not ask", () => {
  // The bug a researcher meets as the model picker emptying itself for no
  // reason they did anything to cause.
  //
  // A probe that reaches an adapter but cannot open a throwaway session
  // reports the agent ready with its options UNKNOWN, and it is an ordinary
  // outcome: `session/new` against a real CLI authenticates and enumerates,
  // it is slow enough to sit near the probe's own timeout, and it is slowest
  // exactly when the machine is busy — which is when somebody is using this
  // product. The daemon is careful about it and reports nothing rather than
  // nothing-found. Written straight through, that care is undone here: the
  // row is rewritten with NULL, the whole catalogue this lab already had is
  // gone, and the composer falls back to a bare *Default* until some later
  // probe happens to succeed.
  //
  // Unknown is the ABSENCE of information. It cannot be allowed to replace
  // information, so a report that says nothing about what an agent offers
  // leaves standing whatever the lab was last told.
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  const base = {
    id: "codex",
    name: "Codex",
    command: "codex",
    version: "1.0.0",
    available: true,
    sessionReady: true,
  };
  const options = [
    {
      id: "model",
      category: "model",
      currentValue: "gpt-5.6-sol",
      choices: [{ value: "gpt-5.6-sol", label: "GPT-5.6-Sol" }],
    },
  ];
  const envelope = (clis: unknown[]) => ({
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    capabilities: [],
    clis,
  });

  expect(
    post(store, "/daemon/report", envelope([{ ...base, options }]), "Bearer a-real-token")!.status,
  ).toBe(200);
  expect(changeLogCount(store)).toBe(1);

  // The next probe reaches the adapter and gets no session out of it.
  expect(
    post(store, "/daemon/report", envelope([base]), "Bearer a-real-token")!.status,
  ).toBe(200);

  const stored = store.get(`SELECT options FROM runtime_clis WHERE cli_id = 'codex'`)!;
  expect(JSON.parse(stored.options as string)).toEqual(options);
  // And nothing was announced, because as far as this lab is concerned
  // nothing about the agent changed — which is the same thing the row now
  // says.
  expect(changeLogCount(store)).toBe(1);
});

it("lets an agent that genuinely offers nothing say so, over a catalogue it used to have", () => {
  // The other half of the rule, and the reason this cannot simply be "never
  // overwrite". An agent that advertised an EMPTY list has answered the
  // question — it opened a session and offered nothing — and that answer has
  // to land, or an agent that drops its options keeps advertising a
  // catalogue it no longer has.
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  const base = {
    id: "codex",
    name: "Codex",
    command: "codex",
    version: "1.0.0",
    available: true,
    sessionReady: true,
  };
  const envelope = (clis: unknown[]) => ({
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    capabilities: [],
    clis,
  });

  post(
    store,
    "/daemon/report",
    envelope([{ ...base, options: [{ id: "model", category: "model", choices: [{ value: "m", label: "M" }] }] }]),
    "Bearer a-real-token",
  );
  expect(changeLogCount(store)).toBe(1);

  expect(
    post(store, "/daemon/report", envelope([{ ...base, options: [] }]), "Bearer a-real-token")!.status,
  ).toBe(200);

  const stored = store.get(`SELECT options FROM runtime_clis WHERE cli_id = 'codex'`)!;
  expect(JSON.parse(stored.options as string)).toEqual([]);
  expect(changeLogCount(store)).toBe(2);
});

it("a report records the one entry when an agent's options change under an unchanged id, version and readiness", () => {
  // A provider ships a model and the adapter starts advertising it. Nothing
  // else about the agent moved, and a researcher with the page open is the
  // one person who needs to know.
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  const option = (choices: Array<{ value: string; label: string }>) => ({
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    capabilities: [],
    clis: [
      {
        id: "codex",
        name: "Codex",
        command: "codex",
        version: "1.0.0",
        available: true,
        sessionReady: true,
        options: [{ id: "model", category: "model", choices }],
      },
    ],
  });
  const before = option([{ value: "gpt-5.5", label: "GPT-5.5" }]);
  expect(post(store, "/daemon/report", before, "Bearer a-real-token")!.status).toBe(200);
  expect(changeLogCount(store)).toBe(1);

  const after = option([
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
  ]);
  expect(post(store, "/daemon/report", after, "Bearer a-real-token")!.status).toBe(200);
  expect(changeLogCount(store)).toBe(2);
});

it("a report records the one entry when only the platform, daemon version, or capabilities differ", () => {
  const store = freshStore();
  // Matches exactly what `insertPairedMachine` already stored — platform,
  // daemon version, capabilities, and an empty CLI set — so this first call
  // changes nothing at all.
  insertPairedMachine(store, "a-real-token");
  const body = { platform: "macos-aarch64", daemonVersion: "0.1.0", capabilities: [], clis: [] };
  expect(post(store, "/daemon/report", body, "Bearer a-real-token")!.status).toBe(200);
  expect(changeLogCount(store)).toBe(0);

  expect(
    post(store, "/daemon/report", { ...body, daemonVersion: "0.2.0" }, "Bearer a-real-token")!.status,
  ).toBe(200);
  expect(changeLogCount(store)).toBe(1);
});

it("a report records the one entry when a machine's own memory or core count changes, and none for repeating the same figures", () => {
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  const body = {
    platform: "macos-aarch64",
    daemonVersion: "0.1.0",
    capabilities: [],
    clis: [],
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    cores: 8,
  };
  // `insertPairedMachine` leaves total_memory_bytes/cores NULL, so a first
  // report naming them is itself a change — the same way a first report
  // naming a platform is.
  expect(post(store, "/daemon/report", body, "Bearer a-real-token")!.status).toBe(200);
  expect(changeLogCount(store)).toBe(1);

  // The identical figures again record nothing further.
  expect(post(store, "/daemon/report", body, "Bearer a-real-token")!.status).toBe(200);
  expect(changeLogCount(store)).toBe(1);

  // A changed core count — a resized VM, the case that actually happens —
  // is its own entry, the same as a changed platform would be.
  expect(
    post(store, "/daemon/report", { ...body, cores: 16 }, "Bearer a-real-token")!.status,
  ).toBe(200);
  expect(changeLogCount(store)).toBe(2);
});

it("stores NULL for the kernel floor when a report says nothing about it, never a 0 standing in for unasked", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  const body = { platform: "macos-aarch64", daemonVersion: "0.1.0", capabilities: [], clis: [] };

  // No `kernels` field at all — the shape of a daemon built before this
  // report existed. NULL, not 0: a 0 here would tell a researcher this
  // machine failed a check that never ran.
  expect(post(store, "/daemon/report", body, "Bearer a-real-token")!.status).toBe(200);
  expect(machineRow(store, machineId).kernels_ready).toBeNull();
  expect(machineRow(store, machineId).kernels_reason).toBeNull();
  expect(machineRow(store, machineId).process_visibility).toBeNull();

  // Checked and failed: 0, with the reason a person reads.
  expect(
    post(
      store,
      "/daemon/report",
      { ...body, kernels: { ready: false, reason: "uv is not installed, and Lykeion starts kernels with it" } },
      "Bearer a-real-token",
    )!.status,
  ).toBe(200);
  expect(machineRow(store, machineId).kernels_ready).toBe(0);
  expect(machineRow(store, machineId).kernels_reason).toBe(
    "uv is not installed, and Lykeion starts kernels with it",
  );

  // Checked and ready: 1, with no reason to carry.
  expect(
    post(store, "/daemon/report", { ...body, kernels: { ready: true } }, "Bearer a-real-token")!.status,
  ).toBe(200);
  expect(machineRow(store, machineId).kernels_ready).toBe(1);
  expect(machineRow(store, machineId).kernels_reason).toBeNull();

  // The other half of the same column's rule, and the half nothing asserted:
  // a sentence that was reported is stored as itself. Without this, a report
  // handler that read `processVisibility` and dropped it on the floor would
  // pass every assertion above — they all say only that an unreported one is
  // NULL, which never storing anything satisfies perfectly.
  expect(
    post(
      store,
      "/daemon/report",
      {
        ...body,
        kernels: { ready: true },
        processVisibility:
          "macOS reports memory and processor use for a process Lykeion started itself.",
      },
      "Bearer a-real-token",
    )!.status,
  ).toBe(200);
  expect(machineRow(store, machineId).process_visibility).toBe(
    "macOS reports memory and processor use for a process Lykeion started itself.",
  );
});

it("a report records the one entry when the kernel floor or the process-visibility line changes, and none for repeating either", () => {
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  const body = { platform: "macos-aarch64", daemonVersion: "0.1.0", capabilities: [], clis: [] };

  expect(
    post(
      store,
      "/daemon/report",
      { ...body, kernels: { ready: false, reason: "uv is not installed" }, processVisibility: "macOS says so" },
      "Bearer a-real-token",
    )!.status,
  ).toBe(200);
  expect(changeLogCount(store)).toBe(1);

  // The identical answer again records nothing further.
  expect(
    post(
      store,
      "/daemon/report",
      { ...body, kernels: { ready: false, reason: "uv is not installed" }, processVisibility: "macOS says so" },
      "Bearer a-real-token",
    )!.status,
  ).toBe(200);
  expect(changeLogCount(store)).toBe(1);

  // Gaining uv is its own entry — the whole reason `reportIfChanged`'s own
  // fingerprint had to be widened for this.
  expect(
    post(
      store,
      "/daemon/report",
      { ...body, kernels: { ready: true }, processVisibility: "macOS says so" },
      "Bearer a-real-token",
    )!.status,
  ).toBe(200);
  expect(changeLogCount(store)).toBe(2);

  // And the visibility line moving on its own — a machine remounted with
  // `hidepid`, or a daemon upgraded onto a platform that has been checked.
  // Every post above carries the same sentence, so without this one the
  // `process_visibility` clause could be deleted from `metaChanged` outright
  // and the whole test would still pass under its own name.
  expect(
    post(
      store,
      "/daemon/report",
      {
        ...body,
        kernels: { ready: true },
        processVisibility: "Linux reports these through /proc",
      },
      "Bearer a-real-token",
    )!.status,
  ).toBe(200);
  expect(changeLogCount(store)).toBe(3);
});

it("names which of the Researches and Tasks a machine asked about are gone", () => {
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  const ownerId = store.get(`SELECT id FROM users LIMIT 1`)!.id as string;
  store.run(
    `INSERT INTO studies (id, key, title, created_by, created_ts, updated_ts, seq)
     VALUES ('s_here', 'HERE', 'Here', ?, ?, ?, ?)`,
    [ownerId, NOW, NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO tasks (id, study_id, number, title, status, priority, stage, created_by,
                        created_ts, updated_ts, seq)
     VALUES ('t_here', 's_here', 1, 'Here', 'todo', 'normal', 'inbox', ?, ?, ?, ?)`,
    [ownerId, NOW, NOW, nextSeq(store)],
  );

  const result = post(
    store,
    "/daemon/workspaces",
    { studyIds: ["s_here", "s_gone"], taskIds: ["t_here", "t_gone"] },
    "Bearer a-real-token",
  );

  expect(result).toEqual({ status: 200, json: { studyIds: ["s_gone"], taskIds: ["t_gone"] } });
});

it("lists every declaration this lab holds to a machine it recognizes, lab-wide rather than owner-scoped", () => {
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  environmentStore(store).declare({
    name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: NOW,
  });
  const result = post(store, "/daemon/kernel-envs", {}, "Bearer a-real-token");
  expect(result!.status).toBe(200);
  const body = result!.json as { declarations: Array<{ name: string }> };
  expect(body.declarations.map((d) => d.name)).toEqual(["crispr"]);
});

it("refuses to list declarations to a machine it does not know", () => {
  const store = freshStore();
  const result = post(store, "/daemon/kernel-envs", {}, "Bearer not-a-token");
  expect(result?.status).toBe(401);
});

/** A durable setup job outstanding on `machineId` for `requestId`, asked to
 *  RESOLVE `name` from `resolvedFrom` — the one shape `/daemon/kernel-env/lock`
 *  accepts a pin under. Left `requested`, which is exactly what a machine
 *  mid-build leaves.
 *
 *  `resolvedFrom` is what this lab asked that machine to resolve FROM, and it
 *  is present because the lock route is only ever reached legitimately on the
 *  resolving branch. The replay shape is `materializingJob` below, named
 *  rather than spelled as an absent argument: a default parameter is applied
 *  to an explicit `undefined` too, so "pass nothing here" could not have
 *  expressed it. */
function resolvingJob(
  store: Store,
  machineId: string,
  requestId: string,
  name: string,
  resolvedFrom: string[] = ["scanpy"],
): void {
  physicalJob(store, machineId, requestId, name, resolvedFrom);
}

/** The same, for a machine asked to MATERIALIZE a pin this lab already holds:
 *  outstanding, addressed to this machine, naming this environment, and
 *  carrying no request to resolve anything — which is what a replay leaves. */
function materializingJob(
  store: Store,
  machineId: string,
  requestId: string,
  name: string,
): void {
  physicalJob(store, machineId, requestId, name, undefined);
}

function physicalJob(
  store: Store,
  machineId: string,
  requestId: string,
  name: string,
  resolvedFrom: string[] | undefined,
): void {
  const declaration = environmentStore(store).get(name);
  if (declaration === undefined)
    throw new Error(`this fixture needs ${name} declared before a job can be asked for it`);
  environmentSetupStore(store).requestPhysicalJob({
    runtimeId: machineId,
    environmentName: name,
    language: declaration.language,
    manager: declaration.manager,
    lockRevision: declaration.lockRevision,
    declarationGenerationId: declaration.declarationGenerationId!,
    declarationCreatedTs: NOW,
    requestId,
    requestedTs: NOW,
    ...(resolvedFrom === undefined ? {} : { resolvedFrom }),
  });
}

it("binds a durable lock only under its own declaration generation, and stores what it was resolved from", () => {
  const store = freshStore();
  const { machineId, ownerId } = insertPairedMachine(store, "a-real-token");
  insertTask(store, ownerId);
  const declaration = environmentStore(store).declare({
    name: "durable", language: "python", manager: "uv", packages: ["scanpy"], createdTs: NOW,
  });
  environmentSetupStore(store).requestJob({
    studyId: "s_setup",
    taskId: "t_setup",
    runtimeId: machineId,
    environmentName: "durable",
    language: "python",
    manager: "uv",
    lockRevision: 0,
    declarationGenerationId: declaration.declarationGenerationId!,
    declarationCreatedTs: NOW,
    requestId: "envsetup_durable",
    requestedBy: ownerId,
    requestedTs: NOW,
    requestedPackages: ["scanpy"],
    resolvedFrom: ["scanpy"],
  });
  const runs = createRunRelay();
  const coordinator = createEnvironmentSetupCoordinator({ store, runs, now: () => NOW });

  const stale = post(
    store,
    "/daemon/kernel-env/lock",
    {
      requestId: "envsetup_durable",
      name: "durable",
      declarationGenerationId: "envgen_stale",
      lockfile: "scanpy==1.9.0\n",
    },
    "Bearer a-real-token",
    NOW,
    runs,
    coordinator,
  );
  expect(stale?.status).toBe(403);
  expect(environmentStore(store).get("durable")!.lockRevision).toBe(0);

  const result = post(
    store,
    "/daemon/kernel-env/lock",
    {
      requestId: "envsetup_durable",
      name: "durable",
      declarationGenerationId: declaration.declarationGenerationId,
      lockfile: "scanpy==1.9.0\n",
    },
    "Bearer a-real-token",
    NOW,
    runs,
    coordinator,
  );

  expect(result).toEqual({ status: 200, json: { lockRevision: 1 } });
  expect(environmentStore(store).readLockRequest("durable", 1)).toEqual(["scanpy"]);
  expect(environmentSetupStore(store).jobByRequest("envsetup_durable")).toMatchObject({
    lockRevision: 1,
    declarationCreatedTs: NOW,
    resolvedFrom: ["scanpy"],
  });
});

it("writes a lockfile and answers with the revision it became", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  const declaration = environmentStore(store).declare({
    name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: NOW,
  });
  resolvingJob(store, machineId, "envsetup_1", "crispr", ["scanpy"]);
  const result = post(
    store,
    "/daemon/kernel-env/lock",
    {
      requestId: "envsetup_1",
      name: "crispr",
      declarationGenerationId: declaration.declarationGenerationId,
      lockfile: "scanpy==1.9.0\n",
    },
    "Bearer a-real-token",
    NOW,
  );
  expect(result).toEqual({ status: 200, json: { lockRevision: 1 } });
  expect(environmentStore(store).get("crispr")!.lockRevision).toBe(1);
  expect(environmentStore(store).readLock("crispr", 1)).toBe("scanpy==1.9.0\n");
  // And the pin can say what it was resolved from, which is the fact every
  // other machine's replay-or-resolve decision turns on: a revision this lab
  // cannot name the request for widens `planFor` to `resolve` for the whole
  // lab.
  expect(environmentStore(store).readLockRequest("crispr", 1)).toEqual(["scanpy"]);
});

it("reconciles a durable setup only from a matching ready machine report", () => {
  const store = freshStore();
  const { machineId, ownerId } = insertPairedMachine(store, "a-real-token");
  insertTask(store, ownerId);
  const envs = environmentStore(store);
  envs.declare({
    name: "reported", language: "python", manager: "uv", packages: ["scanpy"], createdTs: NOW,
  });
  envs.writeLock("reported", "scanpy==1.9.0\n", NOW, ["scanpy"]);
  const requested = environmentSetupStore(store).requestJob({
    studyId: "s_setup",
    taskId: "t_setup",
    runtimeId: machineId,
    environmentName: "reported",
    language: "python",
    manager: "uv",
    lockRevision: 1,
    declarationGenerationId: envs.get("reported")!.declarationGenerationId!,
    declarationCreatedTs: NOW,
    requestId: "envsetup_reported",
    requestedBy: ownerId,
    requestedTs: NOW,
    requestedPackages: ["scanpy"],
  });
  const runs = createRunRelay();
  const coordinator = createEnvironmentSetupCoordinator({ store, runs, now: () => NOW });
  const report = (environments?: unknown[]) =>
    post(
      store,
      "/daemon/report",
      {
        platform: "macos-aarch64",
        daemonVersion: "0.1.0",
        clis: [],
        ...(environments === undefined ? {} : { environments }),
      },
      "Bearer a-real-token",
      NOW,
      runs,
      coordinator,
    );

  expect(report()!.status).toBe(200);
  expect(environmentSetupStore(store).job(requested.job.id)!.state).toBe("requested");
  for (const state of ["absent", "broken"] as const) {
    expect(report([{
      state,
      name: "reported",
      language: "python",
      manager: "uv",
      platform: "macos-aarch64",
      root: "/work/envs/reported",
      lockRevision: 1,
    }])!.status).toBe(200);
    expect(environmentSetupStore(store).job(requested.job.id)!.state).toBe("requested");
  }
  expect(report([{
    state: "ready",
    name: "reported",
    language: "python",
    manager: "uv",
    platform: "macos-aarch64",
    root: "/work/envs/reported",
    lockRevision: 1,
    setupRequestId: requested.job.requestId,
    lockfileFingerprint: environmentLockfileFingerprint("scanpy==1.9.0\n"),
    packageFingerprint: environmentPackageFingerprint(["scanpy"]),
    declarationGenerationId: envs.get("reported")!.declarationGenerationId,
    declarationCreatedTs: NOW,
  }])!.status).toBe(200);
  expect(environmentSetupStore(store).job(requested.job.id)!.state).toBe("ready");
});

it("refuses a lockfile from a machine this lab asked only to REPLAY a pin it already holds", () => {
  // The materialize branch hands a machine this lab's own lockfile and asks
  // it to build from that text; `oneSetup` records the difference by sending
  // no `resolvedFrom` with the ask. Such a machine resolves nothing, so it
  // has no pin of its own to post — and a pin accepted from it could not
  // name what it was resolved from, which is exactly the state `planFor`
  // answers by widening EVERY OTHER machine in this lab to `resolve`. One
  // materialize-only machine would turn D4 off lab-wide for this
  // environment, durably, with nothing saying so.
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  const envs = environmentStore(store);
  envs.declare({
    name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: NOW,
  });
  // Revision 1 is already pinned, which is what makes a replay the plan.
  envs.writeLock("crispr", "scanpy==1.9.0\n", NOW, ["scanpy"]);

  // Outstanding, addressed to this machine, naming this environment — and
  // asked to replay, not to resolve.
  materializingJob(store, machineId, "envsetup_9", "crispr");
  const result = post(
    store,
    "/daemon/kernel-env/lock",
    {
      requestId: "envsetup_9",
      name: "crispr",
      declarationGenerationId: envs.get("crispr")!.declarationGenerationId,
      lockfile: "scanpy==9.9.9\n",
    },
    "Bearer a-real-token",
    NOW,
  );

  expect(result!.status).toBe(403);
  // Nothing moved: not the revision, not the text, not the change log. The
  // refusal is not merely a status code.
  expect(envs.get("crispr")!.lockRevision).toBe(1);
  expect(envs.readLock("crispr", 1)).toBe("scanpy==1.9.0\n");
  expect(envs.readLock("crispr", 2)).toBeUndefined();
  expect(changeLogEntries(store).map((e) => e.kind)).not.toContain("environment-lock-written");
});

it("refuses a lockfile from a machine this lab never asked to set that environment up", () => {
  // A pin is the one thing every OTHER machine later replays verbatim (D4),
  // so a bearer token alone must not be enough to write one: it proves some
  // paired machine is calling, never that it is the one this lab asked. A
  // machine allowed to pin unasked would not merely spoil its own build, it
  // would repin the environment lab-wide and have every colleague reproduce
  // it faithfully.
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  environmentStore(store).declare({
    name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: NOW,
  });
  // Nothing outstanding: this machine was never asked.
  const result = post(
    store,
    "/daemon/kernel-env/lock",
    {
      requestId: "envsetup_1",
      name: "crispr",
      declarationGenerationId: environmentStore(store).get("crispr")!.declarationGenerationId,
      lockfile: "scanpy==9.9.9\n",
    },
    "Bearer a-real-token",
    NOW,
  );
  expect(result!.status).toBe(403);
  // And nothing was written — the refusal is not merely a status code.
  expect(environmentStore(store).get("crispr")!.lockRevision).toBe(0);
  expect(environmentStore(store).readLock("crispr", 1)).toBeUndefined();
});

it("refuses to write a lockfile for a name this lab no longer declares, rather than throwing on the raw foreign key", () => {
  // Asked for `gone` and answering about `gone`: the declaration was deleted
  // underneath a resolve that was already in flight, which is the race this
  // refusal exists for — not a machine reaching for a name it was never sent.
  // Refused rather than allowed to reach `kernel_env_locks`' own foreign key,
  // which would surface as a throw rather than an answer.
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  const declaration = environmentStore(store).declare({
    name: "gone", language: "python", manager: "uv", packages: ["x"], createdTs: NOW,
  });
  resolvingJob(store, machineId, "envsetup_1", "gone", ["x"]);
  store.run(`DELETE FROM kernel_envs WHERE name = 'gone'`);

  const result = post(
    store,
    "/daemon/kernel-env/lock",
    {
      requestId: "envsetup_1",
      name: "gone",
      declarationGenerationId: declaration.declarationGenerationId,
      lockfile: "x==1\n",
    },
    "Bearer a-real-token",
    NOW,
  );
  expect(result!.status).toBe(403);
  expect(store.all(`SELECT revision FROM kernel_env_locks WHERE name = 'gone'`)).toEqual([]);
});

it("refuses a pin naming an environment other than the one this machine was asked to build", () => {
  // The residue left by binding on machine + request alone: a machine
  // legitimately building `crispr` still has an outstanding ask, and during
  // that window it could post a pin for `atlas` — an environment it was
  // never sent anywhere near. A pin is durable and lab-wide, so that is not
  // one machine spoiling its own build, it is one machine repinning a
  // colleague's environment and having every later machine replay it.
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  const envs = environmentStore(store);
  envs.declare({
    name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: NOW,
  });
  envs.declare({
    name: "atlas", language: "python", manager: "uv", packages: ["anndata"], createdTs: NOW,
  });

  // Asked for `crispr`, and only `crispr`.
  resolvingJob(store, machineId, "envsetup_1", "crispr");
  const result = post(
    store,
    "/daemon/kernel-env/lock",
    {
      requestId: "envsetup_1",
      name: "atlas",
      declarationGenerationId: envs.get("atlas")!.declarationGenerationId,
      lockfile: "anndata==9.9.9\n",
    },
    "Bearer a-real-token",
    NOW,
  );

  expect(result!.status).toBe(403);
  // Nothing written, for either name — the refusal is not merely a status.
  expect(envs.get("atlas")!.lockRevision).toBe(0);
  expect(envs.readLock("atlas", 1)).toBeUndefined();
  expect(envs.get("crispr")!.lockRevision).toBe(0);
  expect(changeLogEntries(store).map((e) => e.kind)).not.toContain("environment-lock-written");
});

it("refuses a lockfile post whose body omits the requestId, the name or the lockfile", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  const envs = environmentStore(store);
  envs.declare({
    name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: NOW,
  });
  const complete = { requestId: "envsetup_1", name: "crispr", lockfile: "scanpy==1.9.0\n" };

  // Authenticated, and holding a real outstanding ask, so each of these
  // reaches the body check rather than stopping at the 401 above it.
  resolvingJob(store, machineId, "envsetup_1", "crispr");
  for (const omitted of ["requestId", "name", "lockfile"] as const) {
    const body: Record<string, string> = { ...complete };
    delete body[omitted];
    const result = post(
      store,
      "/daemon/kernel-env/lock",
      body,
      "Bearer a-real-token",
      NOW,
    );
    expect(result!.status).toBe(400);
    expect((result!.json as { error: string }).error).toMatch(/requestId, a name and a lockfile/);
  }
  expect(envs.get("crispr")!.lockRevision).toBe(0);
});

it("refuses to write a lockfile for a machine it does not know", () => {
  const store = freshStore();
  const result = post(store, "/daemon/kernel-env/lock", { name: "x", lockfile: "y" }, "Bearer not-a-token");
  expect(result?.status).toBe(401);
});

it("a report's environments field is stored, NULL when the field is absent rather than an invented empty array", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  const body = { platform: "macos-aarch64", daemonVersion: "0.1.0", capabilities: [], clis: [] };

  post(store, "/daemon/report", body, "Bearer a-real-token");
  expect(machineRow(store, machineId).environments).toBeNull();

  const status = {
    state: "ready", name: "python", language: "python", manager: "uv",
    platform: "macos-aarch64", root: "/work/envs/python", version: "3.12.7",
    packageCount: 6, lockRevision: 1,
  };
  post(store, "/daemon/report", { ...body, environments: [status] }, "Bearer a-real-token");
  expect(JSON.parse(machineRow(store, machineId).environments as string)).toEqual([status]);
});

it("keeps what a machine last reported holding when a later report carries no environments at all", () => {
  // The daemon omits the field rather than sending an empty one when it
  // could not build the list — `main.ts` does exactly that when
  // `fetchKernelEnvDeclarations` fails, and still sends the report because
  // the fingerprint differs. Overwriting here would blank a machine that has
  // reported honestly many times, and it would then read as "has not
  // reported" on the Machines screen: the precise ambiguity this column was
  // persisted to remove. Absent means "could not say", never "holds none".
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  const body = { platform: "macos-aarch64", daemonVersion: "0.1.0", capabilities: [], clis: [] };
  const status = {
    state: "ready", name: "python", language: "python", manager: "uv",
    platform: "macos-aarch64", root: "/work/envs/python", version: "3.12.7",
    packageCount: 6, lockRevision: 1,
  };

  post(store, "/daemon/report", { ...body, environments: [status] }, "Bearer a-real-token");
  expect(JSON.parse(machineRow(store, machineId).environments as string)).toEqual([status]);
  const afterFirst = changeLogCount(store);

  // A report that says nothing about environments changes nothing.
  post(store, "/daemon/report", body, "Bearer a-real-token");
  expect(JSON.parse(machineRow(store, machineId).environments as string)).toEqual([status]);
  // And is not announced as a change, since the column never moved.
  expect(changeLogCount(store)).toBe(afterFirst);
});

it("a report records a change when environments differ, and none for repeating the same report", () => {
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  const body = { platform: "macos-aarch64", daemonVersion: "0.1.0", capabilities: [], clis: [] };
  const status = {
    state: "ready", name: "python", language: "python", manager: "uv",
    platform: "macos-aarch64", root: "/work/envs/python", version: "3.12.7",
    packageCount: 6, lockRevision: 1,
  };

  post(store, "/daemon/report", body, "Bearer a-real-token");
  expect(changeLogCount(store)).toBe(0);

  post(store, "/daemon/report", { ...body, environments: [status] }, "Bearer a-real-token");
  expect(changeLogCount(store)).toBe(1);

  // The identical report again — no second entry.
  post(store, "/daemon/report", { ...body, environments: [status] }, "Bearer a-real-token");
  expect(changeLogCount(store)).toBe(1);
});

it("refuses to say anything about workspaces to a machine it does not know", () => {
  const store = freshStore();
  const result = post(store, "/daemon/workspaces", { studyIds: ["s_1"] }, "Bearer not-a-token");
  expect(result?.status).toBe(401);
});

/**
 * An environment declared on an agent's ask, once its researcher has allowed
 * it on a card.
 *
 * The card is raised on the machine, in front of a person; this route is
 * what that approval becomes in the lab. What it has to get right is WHO the
 * declaration belongs to, because the only thing authenticating this call is
 * a machine token — and a machine is not a person.
 */

/** A member, and one open session of theirs on `machineId`. Inserted
 *  directly, so a test can choose whose session is on whose machine — which
 *  is the whole of what this route decides. */
function insertSession(
  store: Store,
  sessionId: string,
  machineId: string,
  openedBy: string,
  endedTs?: number,
): void {
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq) VALUES (?, ?, ?, ?, ?, ?)`,
    [openedBy, `${openedBy}@lab.example`, openedBy, "irrelevant", NOW, nextSeq(store)],
  );
  store.run(`INSERT INTO members (user_id, role, joined_ts, seq) VALUES (?, 'member', ?, ?)`, [
    openedBy,
    NOW,
    nextSeq(store),
  ]);
  store.run(
    `INSERT INTO sessions (id, study_id, runtime_id, agent, opened_by, opened_ts, ended_ts, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, "s_1", machineId, "claude", openedBy, NOW, endedTs ?? null, nextSeq(store)],
  );
}

it("declares an environment under the session's own researcher, not the machine's owner", () => {
  // The token names the machine; only the session names the person. A lab
  // that read the owner off the token would file a visiting colleague's
  // environment — and the change a lab reads — under whoever happens to own
  // the laptop it was asked on.
  const store = freshStore();
  const { machineId, ownerId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_1", machineId, "u_ben");
  expect(ownerId).not.toBe("u_ben");

  const result = post(
    store,
    "/daemon/kernel-env/create",
    { sessionId: "se_1", name: "crispr", packages: ["scanpy"] },
    "Bearer a-real-token",
  );

  expect(result!.status).toBe(200);
  const declaration = environmentStore(store).get("crispr")!;
  expect(declaration.createdBy).toBe("u_ben");
  expect(declaration.packages).toEqual(["scanpy"]);
  expect(declaration.language).toBe("python");
  expect(changeLogEntries(store)).toContainEqual({
    kind: "environment-created",
    actorId: "u_ben",
  });
});

it("declares an R environment when the daemon asks for one, with R's own manager", () => {
  // The whole of the agent-facing R path, at the end that writes. Until this
  // phase the route hard-coded `language: "python"`, so an agent asked for an
  // R environment got a Python one wearing that name — a plausible wrong
  // object, which is worse than a refusal because nothing downstream can tell
  // it apart from the right one.
  //
  // The manager is asserted rather than the language alone: `conda` is what
  // makes this a real R environment on every machine that later builds it,
  // and it is DERIVED here from the language rather than sent, so a language
  // that arrived and was ignored would still show up as `uv`.
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_1", machineId, "u_ben");

  const result = post(
    store,
    "/daemon/kernel-env/create",
    { sessionId: "se_1", name: "rstats", packages: ["ggplot2"], language: "r" },
    "Bearer a-real-token",
  );

  expect(result!.status).toBe(200);
  const declaration = environmentStore(store).get("rstats")!;
  expect(declaration.language).toBe("r");
  expect(declaration.manager).toBe("conda");
});

it("refuses a language this lab has no provisioner for, and writes nothing", () => {
  // By value, in code. Nothing between the agent and this route validates an
  // argument against a schema, and the two guards before this one (the host's
  // and the daemon's) are not a reason to omit the third: this route is
  // reachable from anything holding a machine token, and what it does is
  // WRITE.
  //
  // Measured, so it is not overstated: with this route's own guard deleted
  // the store is STILL untouched — `declareEnvironment` refuses an unknown
  // language by value too, and answers 422. So what this route's guard adds
  // is the status and a sentence naming the offending value, and what this
  // test pins is both halves: the contract this endpoint answers with, and
  // the write that does not happen. The nothing-written half would pass
  // against the deeper guard alone, and says so here rather than reading as
  // proof of a guard it does not exercise.
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_1", machineId, "u_ben");

  // A DIFFERENT name per case, against one store. Sharing one would mean
  // that if the first value leaked past the guard and was written, every
  // later case would come back 400 for the wrong reason — a name collision,
  // which is 409 — and the test would still be green on four of five while
  // pointing at the wrong guard.
  for (const [i, wrong] of ["ruby", "Python", 7, null, ["r"]].entries()) {
    const result = post(
      store,
      "/daemon/kernel-env/create",
      { sessionId: "se_1", name: `nope${i}`, packages: [], language: wrong },
      "Bearer a-real-token",
    );
    expect(result!.status).toBe(400);
  }

  // Not one of them wrote a declaration or a change.
  expect(environmentStore(store).list()).toEqual([]);
  expect(changeLogEntries(store).map((entry) => entry.kind)).not.toContain(
    "environment-created",
  );
});

it("refuses to declare an environment for a session belonging to another machine", () => {
  // A bearer token proves that SOME paired machine is calling and nothing
  // more. Without this check, any machine in the lab could declare
  // environments attributed to any colleague by naming their session — and
  // every other machine would go on to build whatever it named.
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  const other = insertPairedMachine(store, "another-machine-token");
  insertSession(store, "se_theirs", other.machineId, "u_ben");

  const result = post(
    store,
    "/daemon/kernel-env/create",
    { sessionId: "se_theirs", name: "crispr", packages: ["scanpy"] },
    "Bearer a-real-token",
  );

  expect(result!.status).toBe(403);
  // Nothing written — the refusal is not merely a status code.
  expect(environmentStore(store).list()).toEqual([]);
  expect(changeLogEntries(store).map((entry) => entry.kind)).not.toContain(
    "environment-created",
  );
});

it("refuses to declare an environment for a session that has ended", () => {
  // Nobody is watching a session that has ended, so nobody answered a card
  // for this — whatever the machine asking believes.
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_over", machineId, "u_ben", NOW - 10);

  const result = post(
    store,
    "/daemon/kernel-env/create",
    { sessionId: "se_over", name: "crispr", packages: ["scanpy"] },
    "Bearer a-real-token",
  );

  expect(result!.status).toBe(403);
  expect(environmentStore(store).list()).toEqual([]);
});

it("refuses to declare an environment to a machine it does not know", () => {
  const store = freshStore();
  const result = post(
    store,
    "/daemon/kernel-env/create",
    { sessionId: "se_1", name: "crispr", packages: [] },
    "Bearer not-a-token",
  );
  expect(result!.status).toBe(401);
});

it("refuses a create whose body omits the session, the name or the package list", () => {
  // An absent package list is not an empty one: an environment holding only
  // its interpreter is something a caller says, not something inferred from
  // a field nobody sent.
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_1", machineId, "u_ben");
  const complete = { sessionId: "se_1", name: "crispr", packages: ["scanpy"] };

  for (const omitted of ["sessionId", "name", "packages"] as const) {
    const body: Record<string, unknown> = { ...complete };
    delete body[omitted];
    expect(post(store, "/daemon/kernel-env/create", body, "Bearer a-real-token")!.status).toBe(
      400,
    );
  }
  // A list holding something that is not a package name is refused whole,
  // never filtered down to the entries that are — a filtered list is a
  // declaration nobody wrote, pinned for every machine in the lab.
  expect(
    post(
      store,
      "/daemon/kernel-env/create",
      { ...complete, packages: ["scanpy", 7] },
      "Bearer a-real-token",
    )!.status,
  ).toBe(400);
  expect(environmentStore(store).list()).toEqual([]);
});

it("takes an environment holding only its interpreter", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_1", machineId, "u_ben");

  const result = post(
    store,
    "/daemon/kernel-env/create",
    { sessionId: "se_1", name: "bare", packages: [] },
    "Bearer a-real-token",
  );

  expect(result!.status).toBe(200);
  expect(environmentStore(store).get("bare")!.packages).toEqual([]);
});

it("refuses a name this lab already declares, in the lab's own words", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_1", machineId, "u_ben");
  environmentStore(store).declare({
    name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: NOW,
  });

  const result = post(
    store,
    "/daemon/kernel-env/create",
    { sessionId: "se_1", name: "crispr", packages: ["anndata"] },
    "Bearer a-real-token",
  );

  expect(result!.status).toBe(409);
  // The researcher has just approved this card; the reason is the whole of
  // what makes the refusal actionable.
  expect((result!.json as { error: string }).error).toMatch(/already has an environment named crispr/);
  // And the declaration that was already there is untouched.
  expect(environmentStore(store).get("crispr")!.packages).toEqual(["scanpy"]);
});

/**
 * Packages added to an environment this lab already declares — the other
 * verb, and the first operation on this wire that changes something already
 * running.
 *
 * Each of these names its own environment. `inFlightSetups` in
 * `api/environments.ts` coalesces on `${machineId}:${name}` at module scope,
 * and nothing settles the builds these dispatch, so two tests sharing a name
 * on identically-numbered machines would have the second silently join the
 * first's outstanding build.
 */

/** A machine paired, holding one open session, with a declaration already in
 *  this lab and a relay attached so what the route dispatches is observable.
 *  Everything these tests share, since not one of them is about pairing.
 *
 *  `pinned` is what this lab's current lockfile was resolved FROM, for a test
 *  that needs a declaration whose pin still answers it. Omitted leaves
 *  `lockRevision` at 0, which is a declaration NOTHING in the lab has built
 *  yet — and which `planFor` therefore reads as still owing a build.
 *
 *  The session holds a LIVE turn, because that is the state `manage_packages`
 *  is called from: the tool runs mid-turn, and the turn is what says which
 *  Task an add belongs to and therefore whose interest chases the build. */
function labWithEnvironment(
  name: string,
  packages: string[],
  pinned?: string[],
): {
  store: Store;
  machineId: string;
  taskId: string;
  taken: RunCommand[];
  runs: RunRelay;
  detach: () => void;
} {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_1", machineId, "u_ben");
  insertTask(store, "u_ben");
  recordTurn(store, {
    sessionId: "se_1",
    taskId: "t_setup",
    prompt: "add what this needs",
    startedTs: NOW,
  });
  environmentStore(store).declare({
    name, language: "python", manager: "uv", packages, createdBy: "u_ben", createdTs: NOW,
  });
  if (pinned !== undefined)
    environmentStore(store).writeLock(name, `${pinned.join("==1\n")}==1\n`, NOW, pinned);
  const runs = createRunRelay();
  const taken: RunCommand[] = [];
  const detach = runs.attach(machineId, (_seq, command) => {
    taken.push(command);
  });
  return { store, machineId, taskId: "t_setup", taken, runs, detach };
}

it("appends packages to a declaration and never replaces what it already held", () => {
  // `manage_packages` ADDS. A call that replaced would silently uninstall
  // everything it did not happen to mention — an agent asking for `scanpy`
  // taking `numpy` out of every machine in the lab, with a card that said
  // nothing about `numpy` at all.
  const lab = labWithEnvironment("append", ["numpy", "pandas"]);

  const result = post(
    lab.store,
    "/daemon/kernel-env/packages",
    { sessionId: "se_1", name: "append", packages: ["scanpy"] },
    "Bearer a-real-token",
    NOW,
    lab.runs,
  );

  expect(result!.status).toBe(200);
  // The order the declaration already had, then what was genuinely new, in
  // the order it was asked for.
  expect(environmentStore(lab.store).get("append")!.packages).toEqual([
    "numpy", "pandas", "scanpy",
  ]);
  expect((result!.json as { added: string[] }).added).toEqual(["scanpy"]);
  // Recorded under the SESSION's researcher, never the machine's owner: the
  // token names a machine, and only the session names a person.
  expect(changeLogEntries(lab.store)).toContainEqual({
    kind: "environment-packages-added",
    actorId: "u_ben",
  });
  lab.detach();
});

it("adds only what is genuinely new, and rebuilds nothing when that is nothing", () => {
  // Not an error — it is the state the caller asked for, already reached.
  // But it must not bump the declaration or send a build either: a rebuild
  // ends every kernel in that environment, and doing that for a call that
  // changed nothing would take a researcher's namespace for no reason at all.
  //
  // Pinned from exactly what it declares, which is what makes this the state
  // where there really is nothing to do. A declaration this lab has never
  // resolved is a different fact — see the retry test below — and asserting
  // "no build" against one would be asserting it of the wrong thing.
  const lab = labWithEnvironment("noop", ["numpy", "scanpy"], ["numpy", "scanpy"]);
  const before = changeLogCount(lab.store);

  const result = post(
    lab.store,
    "/daemon/kernel-env/packages",
    { sessionId: "se_1", name: "noop", packages: ["scanpy", "numpy"] },
    "Bearer a-real-token",
    NOW,
    lab.runs,
  );

  expect(result!.status).toBe(200);
  expect((result!.json as { added: string[]; building: boolean }).added).toEqual([]);
  expect((result!.json as { building: boolean }).building).toBe(false);
  // No duplicate, no reordering, and nothing announced.
  expect(environmentStore(lab.store).get("noop")!.packages).toEqual(["numpy", "scanpy"]);
  expect(changeLogCount(lab.store)).toBe(before);
  // And no build. This is the assertion that matters: the answer's own
  // `building: false` is a claim, and the relay is the fact.
  expect(lab.taken).toEqual([]);
  lab.detach();
});

it("asks for the build again when this lab's pin is behind what it declares, so a failed build can be retried", () => {
  // The state a failed build leaves, and it is reachable through a network
  // blip: `scanpy` was appended to the declaration, the build that was
  // dispatched for it never landed, so the pin still answers `["numpy"]`
  // alone. Nothing renders that state — `KernelEnvCard`'s "a revision behind"
  // compares the declaration's own `lockRevision` against a machine's, and
  // that never moved either — and `envs.addPackages` answers `added: []` for
  // a package already declared. Without this, an agent asking again is told
  // nothing was added and nothing is building, the package is still not
  // installed anywhere, and no call this branch ships can start a build for
  // it: the declaration sits permanently ahead of every machine in the lab.
  const lab = labWithEnvironment("retried", ["numpy", "scanpy"], ["numpy"]);
  const before = changeLogCount(lab.store);

  const result = post(
    lab.store,
    "/daemon/kernel-env/packages",
    { sessionId: "se_1", name: "retried", packages: ["scanpy"] },
    "Bearer a-real-token",
    NOW,
    lab.runs,
  );

  expect(result!.status).toBe(200);
  // Nothing was added, because nothing was new — the answer stays honest
  // about the declaration.
  expect((result!.json as { added: string[] }).added).toEqual([]);
  // And nothing was written: no duplicate in the declaration, no change-log
  // row for an append that did not happen.
  expect(environmentStore(lab.store).get("retried")!.packages).toEqual(["numpy", "scanpy"]);
  expect(changeLogCount(lab.store)).toBe(before + 1);
  // But a build IS running, and the relay is the fact behind the claim.
  expect((result!.json as { building: boolean }).building).toBe(true);
  const setup = lab.taken.find((command) => command.type === "kernel-env-setup");
  expect(setup).toBeDefined();
  expect(setup!.name).toBe("retried");
  // Resolving, not replaying: the pin does not answer this declaration, which
  // is the whole reason this build was owed.
  expect(setup!.packages).toEqual(["numpy", "scanpy"]);
  // And the reason a displaced kernel's ending carries is true of what
  // happened — nothing was added by this call.
  expect(setup!.reason).toBe("retried already declared scanpy and had not been built with them here yet");
  lab.detach();
});

it("asks the calling machine to rebuild, carrying why in words", () => {
  // The rebuild goes to the machine whose bearer token authenticated this
  // call — a machine rebuilding its own copy, so no cross-machine
  // authorization question arises. The reason rides the command so the
  // machine can carry it into the ending of every kernel it displaces.
  const lab = labWithEnvironment("rebuilt", ["numpy"]);

  post(
    lab.store,
    "/daemon/kernel-env/packages",
    { sessionId: "se_1", name: "rebuilt", packages: ["scanpy"] },
    "Bearer a-real-token",
    NOW,
    lab.runs,
  );

  const setup = lab.taken.find((command) => command.type === "kernel-env-setup");
  expect(setup).toBeDefined();
  expect(setup!.name).toBe("rebuilt");
  expect(setup!.reason).toBe("scanpy was added to rebuilt");
  // Resolved, not replayed: nothing is pinned yet, and the packages it
  // carries are the declaration as it now stands.
  expect(setup!.packages).toEqual(["numpy", "scanpy"]);
  lab.detach();
});

it("says both packages when two were added, so the ending reads as a sentence", () => {
  const lab = labWithEnvironment("twoadded", []);

  post(
    lab.store,
    "/daemon/kernel-env/packages",
    { sessionId: "se_1", name: "twoadded", packages: ["scanpy", "anndata"] },
    "Bearer a-real-token",
    NOW,
    lab.runs,
  );

  const setup = lab.taken.find((command) => command.type === "kernel-env-setup")!;
  expect(setup.reason).toBe("scanpy, anndata were added to twoadded");
  lab.detach();
});

it("refuses to add packages to a name this lab does not declare", () => {
  // 404 rather than a create in disguise. `manage_packages` adds to what
  // exists; declaring a new name is a different request, asked on a
  // differently-worded card, and answering it here would install software
  // under a question the researcher was never shown.
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_1", machineId, "u_ben");

  const result = post(
    store,
    "/daemon/kernel-env/packages",
    { sessionId: "se_1", name: "never-declared", packages: ["scanpy"] },
    "Bearer a-real-token",
  );

  expect(result!.status).toBe(404);
  expect((result!.json as { error: string }).error).toMatch(/never-declared/);
  expect(environmentStore(store).list()).toEqual([]);
});

it("refuses to add packages for a session belonging to another machine", () => {
  // The same reasoning the create route's own check rests on, and it bites
  // harder here: without it any paired machine could install software into
  // any environment in the lab by naming a colleague's session id.
  const store = freshStore();
  insertPairedMachine(store, "a-real-token");
  const other = insertPairedMachine(store, "another-machine-token");
  insertSession(store, "se_theirs", other.machineId, "u_ben");
  environmentStore(store).declare({
    name: "theirs", language: "python", manager: "uv", packages: ["numpy"], createdTs: NOW,
  });

  const result = post(
    store,
    "/daemon/kernel-env/packages",
    { sessionId: "se_theirs", name: "theirs", packages: ["scanpy"] },
    "Bearer a-real-token",
  );

  expect(result!.status).toBe(403);
  // Nothing written — the refusal is not merely a status code.
  expect(environmentStore(store).get("theirs")!.packages).toEqual(["numpy"]);
});

it("refuses to add packages for a session that has ended, and to a machine it does not know", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_over", machineId, "u_ben", NOW - 10);
  environmentStore(store).declare({
    name: "ended", language: "python", manager: "uv", packages: ["numpy"], createdTs: NOW,
  });
  const body = { sessionId: "se_over", name: "ended", packages: ["scanpy"] };

  expect(post(store, "/daemon/kernel-env/packages", body, "Bearer a-real-token")!.status).toBe(403);
  expect(post(store, "/daemon/kernel-env/packages", body, "Bearer not-a-token")!.status).toBe(401);
  expect(environmentStore(store).get("ended")!.packages).toEqual(["numpy"]);
});

it("refuses an add of nothing, and one whose list holds something that is not a name", () => {
  // An EMPTY list is refused here where a create takes one: an environment
  // holding only its interpreter is something a caller can mean, and an ADD
  // of nothing is not. A list holding a non-name is refused whole rather
  // than filtered, because what gets installed on every machine in this lab
  // has to be what the researcher was shown.
  const lab = labWithEnvironment("refusals", ["numpy"]);
  const complete = { sessionId: "se_1", name: "refusals", packages: ["scanpy"] };

  for (const body of [
    { ...complete, packages: [] },
    { ...complete, packages: ["scanpy", 7] },
    { ...complete, packages: ["scanpy", ""] },
    { ...complete, packages: "scanpy" },
    { sessionId: "se_1", packages: ["scanpy"] },
    { name: "refusals", packages: ["scanpy"] },
  ]) {
    expect(
      post(
        lab.store,
        "/daemon/kernel-env/packages",
        body,
        "Bearer a-real-token",
        NOW,
        lab.runs,
      )!.status,
    ).toBe(400);
  }
  expect(environmentStore(lab.store).get("refusals")!.packages).toEqual(["numpy"]);
  expect(lab.taken).toEqual([]);
  lab.detach();
});

async function untilCommand(
  taken: RunCommand[],
  matches: (command: RunCommand) => boolean,
  what: string,
): Promise<RunCommand> {
  const start = Date.now();
  for (;;) {
    const found = taken.find(matches);
    if (found) return found;
    if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it("builds the packages of a second add that arrived while the first was still building", async () => {
  // The failure this whole re-check exists for, driven exactly as it happens:
  // *add scanpy*, then *add anndata* while the first build is still running.
  // Builds coalesce — two `uv venv --clear` runs over one directory is worse —
  // so the second add dispatches nothing of its own. Without the re-check it is
  // answered `building: true`, is in NO build on any machine, and every kernel
  // in the environment then restarts announcing only *scanpy*. Under a
  // `conversation` grant the second call raises no card at all, so it goes
  // through with nothing in front of the researcher.
  const lab = labWithEnvironment("coalesced", ["numpy"]);
  const coordinator = createEnvironmentSetupCoordinator({
    store: lab.store,
    runs: lab.runs,
    now: () => NOW,
  });
  const add = (packages: string[]) =>
    post(
      lab.store,
      "/daemon/kernel-env/packages",
      { sessionId: "se_1", name: "coalesced", packages },
      "Bearer a-real-token",
      NOW,
      lab.runs,
      coordinator,
    );

  expect(add(["scanpy"])!.status).toBe(200);
  const first = await untilCommand(
    lab.taken,
    (command) => command.type === "kernel-env-setup",
    "the first build",
  );
  expect(first.packages).toEqual(["numpy", "scanpy"]);

  // The second add, while that build is still outstanding. It dispatches
  // nothing — it joins.
  expect(add(["anndata"])!.status).toBe(200);
  expect(lab.taken.filter((command) => command.type === "kernel-env-setup")).toHaveLength(1);

  // Now the machine finishes the first build the way a real daemon does: it
  // pins what it was asked to resolve, then reports.
  post(
    lab.store,
    "/daemon/kernel-env/lock",
    {
      requestId: first.runId,
      name: "coalesced",
      declarationGenerationId: first.declarationGenerationId,
      lockfile: "numpy==1\nscanpy==1\n",
    },
    "Bearer a-real-token",
    NOW,
    lab.runs,
    coordinator,
  );
  coordinator.settle(lab.machineId, first.runId, {
    ok: true,
    status: {
      state: "ready", name: "coalesced", language: "python", manager: "uv",
      platform: "macos-aarch64", root: "/work/envs/coalesced", version: "3.12.7",
      packageCount: 2, lockRevision: 1,
      setupRequestId: first.runId,
      lockfileFingerprint: environmentLockfileFingerprint("numpy==1\nscanpy==1\n"),
      packageFingerprint: environmentPackageFingerprint(["numpy", "scanpy"]),
      declarationGenerationId: environmentStore(lab.store).get("coalesced")!
        .declarationGenerationId,
      declarationCreatedTs: NOW,
    },
  }, () => {});

  // A SECOND build, carrying the package the first one was never told about.
  const second = await untilCommand(
    lab.taken,
    (command) => command.type === "kernel-env-setup" && command.runId !== first.runId,
    "the second build",
  );
  // Resolved, not replayed: the pin the first build wrote answers a request
  // this declaration has already grown past.
  expect(second.lockfile).toBeUndefined();
  expect(second.packages).toEqual(["numpy", "scanpy", "anndata"]);
  // The FIRST sentence wins. The job this second add joined was already
  // running under `scanpy`'s, and that is the build actually in flight — its
  // command is dispatched and cannot be rewritten. A later add only fills a
  // silence (see `nameReasonIfUnsaid`), it does not overwrite. So the kernels
  // this round restarts are told about `scanpy` while it is `anndata` they
  // are being rebuilt for: the packages are right, the sentence names the
  // round that started it. Giving each add its own would need a reason per
  // interest, which is a column this table does not have.
  expect(second.reason).toBe("scanpy was added to coalesced");
  lab.detach();
});

it("puts an agent's add on the Task's own environment bar, as a setup with no waiter", () => {
  // What the researcher sees. An agent adding packages mid-turn starts a real
  // build on their machine, and before this it was invisible: the build ran,
  // kernels restarted, and nothing on the Task said why. The add is recorded
  // as this Task's INTEREST in the job, which is what `taskEnvironmentSetups`
  // projects, so the bar shows it the same way it shows a Setup press.
  //
  // And no WAITER. A waiter is what mints a continuation, and `manage_packages`
  // runs inside a turn that is still going — a continuation for it would be a
  // second active run on one Task.
  const lab = labWithEnvironment("visible", ["numpy"]);

  expect(
    post(
      lab.store,
      "/daemon/kernel-env/packages",
      { sessionId: "se_1", name: "visible", packages: ["scanpy"] },
      "Bearer a-real-token",
      NOW,
      lab.runs,
    )!.status,
  ).toBe(200);

  const projected = environmentSetupStore(lab.store).forTask(lab.taskId);
  expect(projected).toHaveLength(1);
  expect(projected[0]!.job).toMatchObject({
    environmentName: "visible",
    machineId: lab.machineId,
    state: "requested",
  });
  // Visible, and not continuing anything.
  expect(projected[0]!.waiter).toBeUndefined();
  expect(lab.store.all(`SELECT id FROM task_env_setup_waiters`)).toEqual([]);
  lab.detach();
});

it("covers an add whose turn ended, on a build it joined and could not otherwise be carried onto", () => {
  // The compound case, and the one an interest-less add loses SILENTLY.
  //
  // A build is already running for this machine and environment, so the add
  // joins it (`created: false`) and dispatches nothing of its own. The build it
  // joined was planned before these packages existed. If the add files no
  // interest, `uncoveredInterests` has nothing to carry onto another round when
  // that build settles — and nothing anywhere says so: the environment bar
  // reads "Ready" off the machine's status, `KernelEnvCard`'s "a revision
  // behind" badge compares lock revisions a joined build leaves equal, and no
  // passive surface compares the declaration's packages against what was built.
  // The researcher is told their packages were added; no machine holds them.
  //
  // The turn ends between the researcher answering the card and this call
  // landing, which is the narrow race that used to take the interest away. The
  // session still names its Task — it serves exactly one — so the add is
  // attributed and covered.
  const lab = labWithEnvironment("raced", ["numpy"]);
  const coordinator = createEnvironmentSetupCoordinator({
    store: lab.store,
    runs: lab.runs,
    now: () => NOW,
  });

  // A build already in flight, started by a Setup press on this Task, by the
  // member who paired the machine.
  const owner = lab.store.get(`SELECT owner_id FROM runtimes WHERE id = ?`, [lab.machineId])!
    .owner_id as string;
  const inFlight = coordinator.request(
    { taskId: lab.taskId, machineId: lab.machineId, environmentName: "raced" },
    { userId: owner, role: "owner" },
    () => {},
  );
  const first = lab.taken.filter((command) => command.type === "kernel-env-setup");
  expect(first).toHaveLength(1);
  expect(first[0]!.packages).toEqual(["numpy"]);

  // The turn ends underneath the card the researcher already answered.
  lab.store.run(`UPDATE turns SET ended_ts = ?, status = 'done' WHERE session_id = 'se_1'`, [NOW]);

  expect(
    post(
      lab.store,
      "/daemon/kernel-env/packages",
      { sessionId: "se_1", name: "raced", packages: ["scanpy"] },
      "Bearer a-real-token",
      NOW,
      lab.runs,
      coordinator,
    )!.status,
  ).toBe(200);

  // It joined: still one command, and the interest is on the job it joined.
  expect(lab.taken.filter((command) => command.type === "kernel-env-setup")).toHaveLength(1);
  const interests = lab.store.all(
    `SELECT task_id, requested_packages FROM kernel_env_setup_interests`,
  );
  expect(interests).toHaveLength(1);
  expect(interests[0]!.task_id).toBe(lab.taskId);
  expect(JSON.parse(interests[0]!.requested_packages as string)).toEqual(["numpy", "scanpy"]);

  // Now the build it joined finishes, having covered only `numpy` — the list
  // it was planned from, before the add existed. It pins what it resolved,
  // then reports, the way a real daemon does.
  const job = environmentSetupStore(lab.store).job(inFlight.jobId)!;
  expect(
    coordinator.bindResolvedLock(
      lab.machineId,
      job.requestId,
      "raced",
      job.declarationGenerationId!,
      "numpy==1\n",
      () => {},
    ),
  ).toBe(1);
  expect(
    coordinator.settle(lab.machineId, job.requestId, {
      ok: true,
      status: {
        state: "ready", name: "raced", language: "python", manager: "uv",
        platform: "macos-aarch64", root: "/work/envs/raced", version: "3.12.7",
        packageCount: 1,
        lockRevision: 1,
        setupRequestId: job.requestId,
        lockfileFingerprint: environmentLockfileFingerprint("numpy==1\n"),
        packageFingerprint: environmentPackageFingerprint(["numpy"]),
        declarationGenerationId: environmentStore(lab.store).get("raced")!.declarationGenerationId,
        declarationCreatedTs: NOW,
      },
    }, () => {}),
  ).toBe(true);

  // Covered: the uncovered interest earns a second build, and that build
  // carries the package the add asked for. This is the assertion the
  // live-turn-only lookup could not make.
  const dispatched = lab.taken.filter((command) => command.type === "kernel-env-setup");
  expect(dispatched).toHaveLength(2);
  expect(dispatched[1]!.packages).toEqual(["numpy", "scanpy"]);
  expect(dispatched[1]!.runId).not.toBe(job.requestId);
  lab.detach();
});

it("does not tell an agent a build is running when none could be asked for", () => {
  // `building: true` is what the tool tells the model, and the model imports
  // on the strength of it. A declaration whose pinned revision this lab does
  // not hold the text of cannot be planned — no build can be dispatched for it
  // — so claiming one is running sends the agent to import something that is
  // not there and never will be. The declaration this call already appended
  // stands either way; only the claim about a build is withdrawn.
  const lab = labWithEnvironment("brokenpin", ["numpy"], ["numpy"]);
  lab.store.run(`DELETE FROM kernel_env_locks WHERE name = 'brokenpin'`);

  const result = post(
    lab.store,
    "/daemon/kernel-env/packages",
    { sessionId: "se_1", name: "brokenpin", packages: ["scanpy"] },
    "Bearer a-real-token",
    NOW,
    lab.runs,
  );

  expect(result!.status).toBe(200);
  expect(result!.json).toMatchObject({ added: ["scanpy"], building: false });
  // The append happened; the build did not.
  expect(environmentStore(lab.store).get("brokenpin")!.packages).toEqual(["numpy", "scanpy"]);
  expect(lab.taken.filter((command) => command.type === "kernel-env-setup")).toEqual([]);
  lab.detach();
});

it("survives a machine that is not on its own command stream, having already written the declaration", () => {
  // The declaration is the lab's and is already committed by the time the
  // build is dispatched. A machine whose command stream is down is a machine
  // that will build this the next time it is asked — it must not turn the
  // researcher's approved change into a 500 and leave the lab with a
  // declaration nobody was told about.
  const lab = labWithEnvironment("unreachable", ["numpy"]);
  lab.detach();

  const result = post(
    lab.store,
    "/daemon/kernel-env/packages",
    { sessionId: "se_1", name: "unreachable", packages: ["scanpy"] },
    "Bearer a-real-token",
    NOW,
    lab.runs,
  );

  expect(result!.status).toBe(200);
  expect(environmentStore(lab.store).get("unreachable")!.packages).toEqual(["numpy", "scanpy"]);
});

/**
 * The conversation grant, written beside the change it authorised.
 *
 * "For this conversation" on an environment card is a standing grant over a
 * NAME, and a daemon holding it only in memory loses it the moment its
 * process ends — so the researcher is asked again about something they
 * already allowed, in the same conversation, which teaches them their answer
 * meant less than it said. It is written HERE, in the same transaction as the
 * declaration or the append, so a change that did not happen can never leave
 * authority behind it.
 */
const grantsFor = (store: Store, sessionId: string): string[] =>
  environmentSetupStore(store).environmentGrantsForSession(sessionId);

it("remembers a conversation-scoped environment grant beside the declaration it authorised", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_1", machineId, "u_ben");

  const result = post(
    store,
    "/daemon/kernel-env/create",
    {
      sessionId: "se_1",
      name: "rstats",
      packages: [],
      language: "r",
      permissionScope: "conversation",
    },
    "Bearer a-real-token",
  );

  expect(result!.status).toBe(200);
  // Under the session's own researcher, the same way the declaration is: the
  // token names a machine, and only the session names a person.
  expect(grantsFor(store, "se_1")).toEqual(["rstats"]);
  expect(
    store.get(`SELECT granted_by FROM session_permission_grants WHERE session_id = ?`, ["se_1"])!
      .granted_by,
  ).toBe("u_ben");
});

it("remembers nothing for a create the researcher allowed once", () => {
  // `once` is the card's default, and it must leave nothing behind — a scope
  // that quietly stood for the rest of the conversation would make the two
  // answers the card offers the same answer.
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_1", machineId, "u_ben");

  const result = post(
    store,
    "/daemon/kernel-env/create",
    { sessionId: "se_1", name: "rstats", packages: [], language: "r", permissionScope: "once" },
    "Bearer a-real-token",
  );

  expect(result!.status).toBe(200);
  expect(grantsFor(store, "se_1")).toEqual([]);
});

it("takes a create from a daemon older than the scope field as allowed once", () => {
  // Absent is `once`, and absent is the only thing that is: a daemon that
  // predates this field still declares environments, and reading its silence
  // as a standing grant would mint authority nobody was asked for.
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_1", machineId, "u_ben");

  const result = post(
    store,
    "/daemon/kernel-env/create",
    { sessionId: "se_1", name: "rstats", packages: [], language: "r" },
    "Bearer a-real-token",
  );

  expect(result!.status).toBe(200);
  expect(grantsFor(store, "se_1")).toEqual([]);
});

it("refuses a Study-wide or global scope on this route rather than narrowing it", () => {
  // The two scopes an environment card offers are `once` and `conversation`,
  // and the daemon refuses the other two before they ever reach here. This
  // route is reachable from anything holding a machine token, so it refuses
  // them again — by name, never coerced: a caller told "for this Study" and
  // given one call would believe the wrong thing, and the declaration would
  // be written either way.
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_1", machineId, "u_ben");

  for (const [i, scope] of ["study", "global", "forever", 7, null].entries()) {
    const result = post(
      store,
      "/daemon/kernel-env/create",
      { sessionId: "se_1", name: `nope${i}`, packages: [], permissionScope: scope },
      "Bearer a-real-token",
    );
    expect(result!.status).toBe(400);
  }

  // Not one of them declared anything or left a grant behind.
  expect(environmentStore(store).list()).toEqual([]);
  expect(grantsFor(store, "se_1")).toEqual([]);
});

it("writes no grant for a create this lab refused", () => {
  // The atomicity rule, in the shape it actually arrives in: the researcher
  // answered "for this conversation" to a card reading *Create environment
  // python?*, and the name turns out to be taken. Minted anyway, this session
  // would hold uncarded authority to install software into an environment
  // somebody ELSE declared — off a card for something that does not exist.
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_1", machineId, "u_ben");
  environmentStore(store).declare({
    name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: NOW,
  });

  const result = post(
    store,
    "/daemon/kernel-env/create",
    {
      sessionId: "se_1",
      name: "crispr",
      packages: ["anndata"],
      permissionScope: "conversation",
    },
    "Bearer a-real-token",
  );

  expect(result!.status).toBe(409);
  expect(grantsFor(store, "se_1")).toEqual([]);
});

it("remembers a conversation-scoped grant beside the packages it authorised", () => {
  const lab = labWithEnvironment("granted", ["numpy"]);

  const result = post(
    lab.store,
    "/daemon/kernel-env/packages",
    {
      sessionId: "se_1",
      name: "granted",
      packages: ["scanpy"],
      permissionScope: "conversation",
    },
    "Bearer a-real-token",
    NOW,
    lab.runs,
  );

  expect(result!.status).toBe(200);
  expect(grantsFor(lab.store, "se_1")).toEqual(["granted"]);
  lab.detach();
});

it("remembers a conversation-scoped grant even when every package was already declared", () => {
  // The one place a grant is written with no accompanying mutation, made
  // deliberate rather than merely true: `added: []` because every package
  // named was already part of the declaration is still the state the
  // researcher's "for this conversation" answer asked to reach, and the
  // grant over the name is what makes the NEXT call for it ask nothing.
  const lab = labWithEnvironment("already-there", ["numpy", "scanpy"]);

  const result = post(
    lab.store,
    "/daemon/kernel-env/packages",
    {
      sessionId: "se_1",
      name: "already-there",
      packages: ["scanpy"],
      permissionScope: "conversation",
    },
    "Bearer a-real-token",
    NOW,
    lab.runs,
  );

  expect(result!.status).toBe(200);
  expect((result!.json as { added: string[] }).added).toEqual([]);
  expect(grantsFor(lab.store, "se_1")).toEqual(["already-there"]);
  lab.detach();
});

it("writes no grant for packages this lab would not add", () => {
  // 404 for a declaration deleted between the card being shown and the
  // answer arriving. Nothing was added; nothing may be remembered.
  const lab = labWithEnvironment("present", ["numpy"]);

  const result = post(
    lab.store,
    "/daemon/kernel-env/packages",
    {
      sessionId: "se_1",
      name: "gone",
      packages: ["scanpy"],
      permissionScope: "conversation",
    },
    "Bearer a-real-token",
    NOW,
    lab.runs,
  );

  expect(result!.status).toBe(404);
  expect(grantsFor(lab.store, "se_1")).toEqual([]);
  lab.detach();
});

it("refuses a Study-wide scope on a package change too, and adds nothing", () => {
  const lab = labWithEnvironment("scoped", ["numpy"]);

  const result = post(
    lab.store,
    "/daemon/kernel-env/packages",
    { sessionId: "se_1", name: "scoped", packages: ["scanpy"], permissionScope: "study" },
    "Bearer a-real-token",
    NOW,
    lab.runs,
  );

  expect(result!.status).toBe(400);
  expect(environmentStore(lab.store).get("scoped")!.packages).toEqual(["numpy"]);
  expect(grantsFor(lab.store, "se_1")).toEqual([]);
  lab.detach();
});
