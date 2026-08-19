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
import { createEnvSetupRegistry, type EnvSetupRegistry } from "../env-setup-registry";
import { createRunRelay, type RunCommand, type RunRelay } from "../run-relay";
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

function post(
  store: Store,
  path: string,
  body: unknown,
  authorization?: string,
  now: number = NOW,
  // A real registry rather than a stub, so a route that checks whether this
  // machine was actually asked is exercised against the same object the
  // server wires in. Fresh per call by default: a route under test that
  // never consults it should not be able to pass by inheriting somebody
  // else's outstanding ask.
  envSetups: EnvSetupRegistry = createEnvSetupRegistry(),
  // A real relay too, and fresh per call for the same reason. Nothing is
  // attached to it by default, so a route that dispatches a command to a
  // machine nothing is listening on gets exactly what a disconnected machine
  // gives — which is a state this route has to survive rather than throw
  // from, since it has already written the declaration.
  runs: RunRelay = createRunRelay(),
) {
  return handleDaemonRoute({
    store,
    changes: recorderFor(store),
    method: "POST",
    path,
    body,
    authorization,
    now,
    envSetups,
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

it("names which of the Studies and Tasks a machine asked about are gone", () => {
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

/** A registry already waiting on `requestId` from `machineId`, for the
 *  environment `name` that ask was minted for — the state the lock route
 *  requires. `await` is deliberately not awaited: the entry has to stay
 *  outstanding, which is exactly what a machine mid-build leaves.
 *
 *  `resolvedFrom` is what this lab asked that machine to resolve FROM, and it
 *  is present because the lock route is only ever reached legitimately on the
 *  resolving branch. Before it was here the helper produced the REPLAY shape
 *  for everybody — `oneSetup` sends no `resolvedFrom` on that branch — so
 *  every lock test on this branch was exercising the one shape the route now
 *  refuses, which is why the suite could not see the hole. The replay shape
 *  is `materializing` below, named rather than spelled as an absent argument:
 *  a default parameter is applied to an explicit `undefined` too, so
 *  "pass nothing here" could not have expressed it. */
function awaiting(
  machineId: string,
  requestId: string,
  name: string,
  resolvedFrom: string[] = ["scanpy"],
): EnvSetupRegistry {
  const envSetups = createEnvSetupRegistry();
  void envSetups.await(machineId, requestId, name, { resolvedFrom });
  return envSetups;
}

/** The same, for a machine asked to MATERIALIZE a pin this lab already holds:
 *  outstanding, addressed to this machine, naming this environment, and
 *  carrying no request to resolve anything — which is what `oneSetup` leaves
 *  on the replaying branch. */
function materializing(machineId: string, requestId: string, name: string): EnvSetupRegistry {
  const envSetups = createEnvSetupRegistry();
  void envSetups.await(machineId, requestId, name);
  return envSetups;
}

it("writes a lockfile and answers with the revision it became", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  environmentStore(store).declare({
    name: "crispr", language: "python", manager: "uv", packages: ["scanpy"], createdTs: NOW,
  });
  const result = post(
    store,
    "/daemon/kernel-env/lock",
    { requestId: "envsetup_1", name: "crispr", lockfile: "scanpy==1.9.0\n" },
    "Bearer a-real-token",
    NOW,
    awaiting(machineId, "envsetup_1", "crispr", ["scanpy"]),
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

  const result = post(
    store,
    "/daemon/kernel-env/lock",
    { requestId: "envsetup_9", name: "crispr", lockfile: "scanpy==9.9.9\n" },
    "Bearer a-real-token",
    NOW,
    // Outstanding, addressed to this machine, naming this environment — and
    // asked to replay, not to resolve.
    materializing(machineId, "envsetup_9", "crispr"),
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
  const result = post(
    store,
    "/daemon/kernel-env/lock",
    { requestId: "envsetup_1", name: "crispr", lockfile: "scanpy==9.9.9\n" },
    "Bearer a-real-token",
    NOW,
    // Nothing outstanding: this machine was never asked.
    createEnvSetupRegistry(),
  );
  expect(result!.status).toBe(403);
  // And nothing was written — the refusal is not merely a status code.
  expect(environmentStore(store).get("crispr")!.lockRevision).toBe(0);
  expect(environmentStore(store).readLock("crispr", 1)).toBeUndefined();
});

it("refuses to write a lockfile for a name this lab no longer declares, rather than throwing on the raw foreign key", () => {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  const result = post(
    store,
    "/daemon/kernel-env/lock",
    { requestId: "envsetup_1", name: "gone", lockfile: "x==1\n" },
    "Bearer a-real-token",
    NOW,
    // Asked for `gone` and answering about `gone`: the declaration was
    // deleted underneath a resolve that was already in flight, which is the
    // race this 404 exists for — not a machine reaching for a name it was
    // never sent.
    awaiting(machineId, "envsetup_1", "gone"),
  );
  expect(result!.status).toBe(404);
  expect((result!.json as { error: string }).error).toMatch(/gone/);
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

  const result = post(
    store,
    "/daemon/kernel-env/lock",
    { requestId: "envsetup_1", name: "atlas", lockfile: "anndata==9.9.9\n" },
    "Bearer a-real-token",
    NOW,
    // Asked for `crispr`, and only `crispr`.
    awaiting(machineId, "envsetup_1", "crispr"),
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
  for (const omitted of ["requestId", "name", "lockfile"] as const) {
    const body: Record<string, string> = { ...complete };
    delete body[omitted];
    const result = post(
      store,
      "/daemon/kernel-env/lock",
      body,
      "Bearer a-real-token",
      NOW,
      awaiting(machineId, "envsetup_1", "crispr"),
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
 *  yet — and which `planFor` therefore reads as still owing a build. */
function labWithEnvironment(
  name: string,
  packages: string[],
  pinned?: string[],
): {
  store: Store;
  machineId: string;
  taken: RunCommand[];
  runs: RunRelay;
  detach: () => void;
} {
  const store = freshStore();
  const { machineId } = insertPairedMachine(store, "a-real-token");
  insertSession(store, "se_1", machineId, "u_ben");
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
  return { store, machineId, taken, runs, detach };
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
    createEnvSetupRegistry(),
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
    createEnvSetupRegistry(),
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
    createEnvSetupRegistry(),
    lab.runs,
  );

  expect(result!.status).toBe(200);
  // Nothing was added, because nothing was new — the answer stays honest
  // about the declaration.
  expect((result!.json as { added: string[] }).added).toEqual([]);
  // And nothing was written: no duplicate in the declaration, no change-log
  // row for an append that did not happen.
  expect(environmentStore(lab.store).get("retried")!.packages).toEqual(["numpy", "scanpy"]);
  expect(changeLogCount(lab.store)).toBe(before);
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
    createEnvSetupRegistry(),
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
    createEnvSetupRegistry(),
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
        createEnvSetupRegistry(),
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
  const envSetups = createEnvSetupRegistry();
  const add = (packages: string[]) =>
    post(
      lab.store,
      "/daemon/kernel-env/packages",
      { sessionId: "se_1", name: "coalesced", packages },
      "Bearer a-real-token",
      NOW,
      envSetups,
      lab.runs,
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
    { requestId: first.runId, name: "coalesced", lockfile: "numpy==1\nscanpy==1\n" },
    "Bearer a-real-token",
    NOW,
    envSetups,
    lab.runs,
  );
  envSetups.settle(lab.machineId, first.runId, {
    ok: true,
    status: {
      state: "ready", name: "coalesced", language: "python", manager: "uv",
      platform: "macos-aarch64", root: "/work/envs/coalesced", version: "3.12.7",
      packageCount: 2, lockRevision: 1,
    },
  });

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
  expect(second.reason).toBe("anndata was added to coalesced");
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
    createEnvSetupRegistry(),
    lab.runs,
  );

  expect(result!.status).toBe(200);
  expect(environmentStore(lab.store).get("unreachable")!.packages).toEqual(["numpy", "scanpy"]);
});
