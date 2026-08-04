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
import type { Store } from "../store/store";

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

function post(store: Store, path: string, body: unknown, authorization?: string, now: number = NOW) {
  return handleDaemonRoute({
    store,
    changes: recorderFor(store),
    method: "POST",
    path,
    body,
    authorization,
    now,
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

function runtimeRow(store: Store, runtimeId: string) {
  return store.get(`SELECT * FROM runtimes WHERE id = ?`, [runtimeId])!;
}

function cliRows(store: Store, runtimeId: string) {
  return store.all(
    `SELECT cli_id, name, command, version, available FROM runtime_clis WHERE runtime_id = ? ORDER BY seq ASC`,
    [runtimeId],
  );
}

/** A member and a paired machine, inserted directly so a test can hand
 *  `resolveMachine` a token whose plaintext it controls. */
function insertPairedMachine(store: Store, token: string): { runtimeId: string; ownerId: string } {
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
  const runtimeId = `rt_${nextSeq(store)}`;
  store.run(
    `INSERT INTO runtimes (id, owner_id, name, platform, daemon_version, capabilities, created_ts, last_seen_ts, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [runtimeId, ownerId, "a-machine", "macos-aarch64", "0.1.0", "[]", NOW, NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO machine_tokens (token_hash, runtime_id, owner_id, created_ts, seq) VALUES (?, ?, ?, ?, ?)`,
    [hashSecret(token), runtimeId, ownerId, NOW, nextSeq(store)],
  );
  return { runtimeId, ownerId };
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

it("resolveMachine names the runtime and owner behind a token that was actually issued", () => {
  const store = freshStore();
  const { runtimeId, ownerId } = insertPairedMachine(store, "a-real-token");
  expect(resolveMachine(store, "Bearer a-real-token")).toEqual({ runtimeId, ownerId });
});

it("resolveMachine refuses a token whose runtime has been removed, even if the token itself was not revoked", () => {
  // Belt and suspenders: `removeRuntime` revokes the token too, but this is
  // what still refuses the caller if that second write were ever missed.
  const store = freshStore();
  const { runtimeId } = insertPairedMachine(store, "a-real-token");
  store.run(`UPDATE runtimes SET removed_ts = ? WHERE id = ?`, [NOW, runtimeId]);
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

it("heartbeat refuses a revoked token", () => {
  const store = freshStore();
  const { runtimeId } = insertPairedMachine(store, "a-real-token");
  store.run(`UPDATE machine_tokens SET revoked_ts = ? WHERE runtime_id = ?`, [NOW, runtimeId]);
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
  const { runtimeId } = insertPairedMachine(store, "a-real-token");
  const before = runtimeRow(store, runtimeId);
  const later = NOW + 30;

  const result = post(store, "/daemon/heartbeat", {}, "Bearer a-real-token", later);

  expect(result!.status).toBe(200);
  const after = runtimeRow(store, runtimeId);
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
  const { runtimeId } = insertPairedMachine(store, "a-real-token");
  const before = runtimeRow(store, runtimeId);
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
  expect(runtimeRow(store, runtimeId)).toEqual(before);
  expect(changeLogCount(store)).toBe(0);
});

it("a report with a duplicate cli id in one body keeps the first occurrence, rather than failing", () => {
  const store = freshStore();
  const { runtimeId } = insertPairedMachine(store, "a-real-token");
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

  const rows = cliRows(store, runtimeId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ cli_id: "claude", version: "1.0.0" });
});

it("report replaces the machine's CLI rows wholesale", () => {
  const store = freshStore();
  const { runtimeId } = insertPairedMachine(store, "a-real-token");
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
  expect(cliRows(store, runtimeId).map((r) => r.cli_id)).toEqual(["claude", "codex"]);

  const secondBody = {
    ...firstBody,
    clis: [{ id: "gemini", name: "Gemini", command: "gemini", version: "2.0.0", available: true }],
  };
  expect(post(store, "/daemon/report", secondBody, "Bearer a-real-token")!.status).toBe(200);
  const rows = cliRows(store, runtimeId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.cli_id).toBe("gemini");
});

it("report moves last_seen_ts, the same as a heartbeat does", () => {
  const store = freshStore();
  const { runtimeId } = insertPairedMachine(store, "a-real-token");
  const later = NOW + 120;

  const result = post(
    store,
    "/daemon/report",
    { platform: "macos-aarch64", daemonVersion: "0.1.0", capabilities: [], clis: [] },
    "Bearer a-real-token",
    later,
  );

  expect(result!.status).toBe(200);
  expect(runtimeRow(store, runtimeId).last_seen_ts).toBe(later);
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
