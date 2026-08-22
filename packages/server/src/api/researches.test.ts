import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { environmentSetupStore } from "../store/environment-setups";
import { changeRecorder } from "./changes";
import { declareEnvironment, environmentsApi, type EnvironmentsApi } from "./environments";
import { researchesApi, type ResearchesApi } from "./researches";
import type { Deps } from "./index";
import type { Store } from "../store/store";

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-researches-"));
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

function depsFor(store: Store): Deps {
  const actor = { userId: "u_owner", role: "owner" } as const;
  const channel = createChannel(store, 1000);
  const runs = createRunRelay();
  // Attached, so a `kernelEnvReclaim` this file drives reaches a machine
  // rather than being refused as disconnected before it can free anything.
  runs.attach("rt_1", () => {});
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

it("description and agentContext read back absent, not null, on a Research that never had one", async () => {
  // The shared conformance suite never creates a Research without these two
  // fields, so nothing that runs against a live server currently proves
  // `toResearch` keeps the same absent-key discipline the account family holds
  // for `removedTs`. This checks it directly.
  const store = freshStore();
  addOwner(store, "u_owner");
  const researches = researchesApi(depsFor(store));

  const bare = await researches.createResearch({ title: "Bare", key: "BAR" });
  expect("description" in bare).toBe(false);
  expect("agentContext" in bare).toBe(false);
  expect(bare.environmentDefaults).toEqual([]);

  const detailed = await researches.createResearch({
    title: "Detailed",
    key: "DET",
    description: "A description.",
    agentContext: "Context.",
  });
  expect(detailed.description).toBe("A description.");
  expect(detailed.agentContext).toBe("Context.");
  expect((await researches.listResearches())[0]!.environmentDefaults).toEqual([]);
  expect((await researches.getResearch(detailed.id)).research.environmentDefaults).toEqual([]);
});

/** A machine of `ownerId`'s, heard from just now — enough of a `runtimes`
 *  row for `kernelEnvReclaim`'s own authorization to resolve. */
function addRuntime(store: Store, id: string, ownerId: string): void {
  store.run(
    `INSERT INTO runtimes (id, owner_id, name, platform, daemon_version, capabilities, created_ts, last_seen_ts, seq)
     VALUES (?, ?, ?, 'macos-aarch64', '0.1.0', '[]', ?, ?, ?)`,
    [id, ownerId, `${id}-machine`, NOW, NOW, nextSeq(store)],
  );
}

/**
 * A Research whose R environment has just finished building on this
 * researcher's own machine, with the soft default it offers still pending.
 *
 * Synchronous, and deliberately: every write here is one this lab makes
 * inside a transaction of its own, so a fixture that awaited them would be
 * describing an ordering the production path does not have.
 */
function readySetupWithSuggestion(): {
  api: ResearchesApi & EnvironmentsApi;
  suggestionId: string;
  researchId: string;
} {
  const store = freshStore();
  addOwner(store, "u_owner");
  addRuntime(store, "rt_1", "u_owner");
  const deps = depsFor(store);
  const api = { ...researchesApi(deps), ...environmentsApi(deps) };
  const researchId = `s_${nextSeq(store)}`;
  store.run(
    `INSERT INTO studies (id, key, title, agent_context, created_by, created_ts, updated_ts, seq)
     VALUES (?, 'META', 'Meta-analysis', ?, 'u_owner', ?, ?, ?)`,
    // A Research that already carries prose, so "the default never touches
    // agentContext" is checked against something rather than against two
    // absences that would agree however this behaved.
    [researchId, "Effect sizes are Hedges' g throughout.", NOW, NOW, nextSeq(store)],
  );
  store.run(
    `INSERT INTO tasks
       (id, number, study_id, stage, title, status, priority, created_by, created_ts, updated_ts, seq)
     VALUES ('t_1', 1, ?, 'background', 'Pool the trials', 'todo', 'no-priority', 'u_owner', ?, ?, ?)`,
    [researchId, NOW, NOW, nextSeq(store)],
  );
  const declared = declareEnvironment(
    store,
    deps.changes.record,
    { name: "meta-analysis-r", language: "r", packages: ["metafor"] },
    "u_owner",
    NOW,
  );
  const setups = environmentSetupStore(store);
  const job = setups.requestJob({
    studyId: researchId,
    taskId: "t_1",
    runtimeId: "rt_1",
    environmentName: declared.name,
    language: "r",
    manager: "conda",
    lockRevision: 0,
    declarationGenerationId: declared.declarationGenerationId!,
    declarationCreatedTs: NOW,
    requestId: "req_meta",
    requestedBy: "u_owner",
    requestedTs: NOW,
    requestedPackages: ["metafor"],
    resolvedFrom: ["metafor"],
  }).job;
  setups.markReady(job.requestId, NOW);
  const [suggestion] = setups.createSuggestionsForReadyJob(job.id, NOW);
  return { api, suggestionId: suggestion!.id, researchId };
}

it("accepts one suggestion as the R default without changing agentContext", async () => {
  const { api, suggestionId, researchId } = readySetupWithSuggestion();
  const before = await api.getResearch(researchId);
  await api.answerEnvironmentDefaultSuggestion(suggestionId, true);
  const after = await api.getResearch(researchId);
  expect(after.research.environmentDefaults).toEqual([
    expect.objectContaining({ language: "r", environmentName: "meta-analysis-r" }),
  ]);
  expect(after.research.agentContext).toBe(before.research.agentContext);
});

it("deleting an environment clears its defaults and suggestions; reclaim does not", async () => {
  const h = readySetupWithSuggestion();
  await h.api.answerEnvironmentDefaultSuggestion(h.suggestionId, true);
  await h.api.kernelEnvReclaim("rt_1", "meta-analysis-r");
  expect((await h.api.getResearch(h.researchId)).research.environmentDefaults).toHaveLength(1);
  await h.api.kernelEnvDelete("meta-analysis-r");
  expect((await h.api.getResearch(h.researchId)).research.environmentDefaults).toEqual([]);
});
