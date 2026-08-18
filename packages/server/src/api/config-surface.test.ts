import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORE_PHASES, isLykeionError } from "@lykeion/api";
import { openStore } from "../store/sqlite";
import { migrate, nextSeq } from "../store/migrations";
import { readConfig } from "../config";
import { createChannel } from "../channel";
import { createRunRelay } from "../run-relay";
import { createRevertRegistry } from "../run-revert";
import { createKernelListRegistry } from "../kernel-list-registry";
import { createTitleRegistry } from "../title-registry";
import { createPendingCells } from "../kernel-cells";
import { createEnvSetupRegistry } from "../env-setup-registry";
import { changeRecorder } from "./changes";
import { configSurfaceApi } from "./config-surface";
import type { Deps } from "./index";
import type { Store } from "../store/store";

// What the shared suite leaves uncovered for this family: it never calls
// `listAgents`, `upsertAgent`, `listWorkflows` or `listConnectorTools` at
// all, and where it does call a list method it checks membership rather
// than order or what a second write under one name does. These tests close
// those gaps directly against `configSurfaceApi`, the same way
// `tasks.test.ts` and `account.test.ts` close theirs for their own families.
//
// Ordering that both implementations of the contract have to agree on lives
// in the shared suite instead — a rule asserted only here would let the two
// drift apart while this file stayed green.

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-config-surface-"));
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

function depsFor(store: Store, now: () => number = () => NOW): Deps {
  const actor = { userId: "u_owner", role: "owner" } as const;
  const channel = createChannel(store, 1000);
  return {
    store,
    actor,
    now,
    config: readConfig({}),
    // A real channel rather than a stub: it is the cheapest place to leave
    // the recorder's publish path actually exercised.
    channel,
    runs: createRunRelay(),
    reverts: createRevertRegistry(),
    kernelLists: createKernelListRegistry(), titles: createTitleRegistry(), pendingCells: createPendingCells(), envSetups: createEnvSetupRegistry(),
    changes: changeRecorder({ store, actorId: actor.userId, now, channel }),
  };
}

it("lists Skills by name rather than by byte order", async () => {
  const store = freshStore();
  addOwner(store, "u_owner");
  const config = configSurfaceApi(depsFor(store));

  // Byte order would put every capital ahead of every lowercase letter,
  // reading as "Zebra, apple" to anyone who does not know that is what
  // happened.
  await config.createSkill({ name: "Zebra", description: "d", body: "b" });
  await config.createSkill({ name: "apple", description: "d", body: "b" });
  expect((await config.listSkills()).map((s) => s.name)).toEqual(["apple", "Zebra"]);

  // Two names differing only in case have a determinate order too, and it
  // does not depend on which was written first — a comparison that returned
  // equal for the pair would leave the answer to storage order.
  const store2 = freshStore();
  addOwner(store2, "u_owner");
  const config2 = configSurfaceApi(depsFor(store2));
  await config2.createSkill({ name: "Beta", description: "d", body: "b" });
  await config2.createSkill({ name: "beta", description: "d", body: "b" });
  expect((await config2.listSkills()).map((s) => s.name)).toEqual(["beta", "Beta"]);
});

it("names the record it cannot read rather than failing anonymously", async () => {
  // A truncated write, a hand-edited row. Parsing it inside the list method
  // with nothing catching it takes every other agent down with it, and the
  // caller is told only that the server failed to handle the call — with
  // nothing saying which record to go and look at.
  const store = freshStore();
  addOwner(store, "u_owner");
  const config = configSurfaceApi(depsFor(store));
  await config.upsertAgent({
    name: "readable",
    description: "d",
    systemPrompt: "p",
    tools: [],
    connectors: [],
  });
  store.run(`INSERT INTO agents (name, payload, seq) VALUES (?, ?, ?)`, [
    "truncated",
    '{"name":"trunca',
    nextSeq(store),
  ]);

  const err = await config.listAgents().then(() => undefined, (e: unknown) => e);
  expect(isLykeionError(err) && err.code).toBe("invalid");
  expect(String(err)).toContain("truncated");
});

it("setSkillEnabled names the skill it could not find, rather than silently doing nothing", async () => {
  const store = freshStore();
  addOwner(store, "u_owner");
  const config = configSurfaceApi(depsFor(store));

  const err = await config
    .setSkillEnabled("no-such-skill", true)
    .then(() => undefined, (e: unknown) => e);
  expect(isLykeionError(err) && err.code).toBe("not-found");
  expect((err as Error).message).toMatch(/no such skill: no-such-skill/);
});

it("upsertAgent replaces an existing name in place rather than duplicating it", async () => {
  const store = freshStore();
  addOwner(store, "u_owner");
  const config = configSurfaceApi(depsFor(store));

  await config.upsertAgent({
    name: "statistician",
    description: "First draft.",
    systemPrompt: "Be careful.",
    tools: [],
    connectors: [],
  });
  await config.upsertAgent({
    name: "lit-scout",
    description: "Between the two writes, so its position proves the first stayed put.",
    systemPrompt: "Cite everything.",
    tools: [],
    connectors: [],
  });
  await config.upsertAgent({
    name: "statistician",
    description: "Revised.",
    systemPrompt: "Be careful and say so.",
    tools: ["Read"],
    connectors: [],
  });

  const agents = await config.listAgents();
  expect(agents).toHaveLength(2);
  const statistician = agents.find((a) => a.name === "statistician")!;
  expect(statistician.description).toBe("Revised.");
  expect(statistician.tools).toEqual(["Read"]);
});

it("addConnector replaces an existing name in place rather than duplicating it", async () => {
  const store = freshStore();
  addOwner(store, "u_owner");
  const config = configSurfaceApi(depsFor(store));

  const server = { command: "uvx", args: ["mcp-scratch"], env: {} };
  await config.addConnector({
    name: "scratch",
    description: "First.",
    server,
    enabled: true,
    skipApprovals: false,
  });
  await config.addConnector({
    name: "scratch",
    description: "Second.",
    server,
    enabled: false,
    skipApprovals: true,
  });

  const connectors = await config.listConnectors();
  expect(connectors).toHaveLength(1);
  expect(connectors[0].description).toBe("Second.");
  expect(connectors[0].enabled).toBe(false);
  expect(connectors[0].skipApprovals).toBe(true);
});

it("lists Workflows by id, the way a reader reads them", async () => {
  const store = freshStore();
  addOwner(store, "u_owner");
  const config = configSurfaceApi(depsFor(store));

  const bare = (id: string) => ({
    id,
    name: id,
    description: "d",
    discipline: "general" as const,
    icon: "i",
    prompt: "p",
    placeholders: [],
    phases: [],
    suggestedSkills: [],
    requiresFiles: false,
  });
  await config.upsertWorkflow(bare("Zeta"));
  await config.upsertWorkflow(bare("alpha"));
  expect((await config.listWorkflows()).map((w) => w.id)).toEqual(["alpha", "Zeta"]);
});

// A payload is JSON off disk, so these three go in as raw rows rather than
// through `upsertWorkflow` — the contract's own type would refuse to express
// what the read path has to survive.
function insertPayload(store: Store, id: string, payload: unknown): void {
  store.run(`INSERT INTO workflows (id, payload, seq) VALUES (?, ?, ?)`, [
    id,
    JSON.stringify(payload),
    nextSeq(store),
  ]);
}

const withoutSpine = {
  name: "Older record",
  description: "d",
  icon: "i",
  prompt: "p",
  placeholders: [],
  suggestedSkills: [],
  requiresFiles: false,
};

it("reads a workflow stored with a grouping key as a real discipline on the full spine", async () => {
  const store = freshStore();
  addOwner(store, "u_owner");
  const config = configSurfaceApi(depsFor(store));

  insertPayload(store, "w1", { ...withoutSpine, id: "w1", category: "genomics" });

  const [workflow] = await config.listWorkflows();
  expect(workflow.discipline).toBe("biology");
  expect(workflow.phases).toEqual(CORE_PHASES);
  expect("category" in workflow).toBe(false);
});

it("reads an unrecognised discipline as general rather than leaving it unlabelled", async () => {
  const store = freshStore();
  addOwner(store, "u_owner");
  const config = configSurfaceApi(depsFor(store));

  insertPayload(store, "w1", { ...withoutSpine, id: "w1", discipline: "astrology" });

  const [workflow] = await config.listWorkflows();
  expect(workflow.discipline).toBe("general");
});

it("drops a phase the spine does not name, keeping the order of the rest", async () => {
  const store = freshStore();
  addOwner(store, "u_owner");
  const config = configSurfaceApi(depsFor(store));

  insertPayload(store, "w1", {
    ...withoutSpine,
    id: "w1",
    discipline: "physics",
    phases: ["report", "telepathy", "frame"],
  });

  const [workflow] = await config.listWorkflows();
  expect(workflow.phases).toEqual(["report", "frame"]);
});

it("keeps a Research Group's absent lead reading back as an absent key, not null", async () => {
  const store = freshStore();
  addOwner(store, "u_owner");
  const config = configSurfaceApi(depsFor(store));

  const bare = await config.createResearchGroup({ name: "No lead yet" });
  expect("leadAgent" in bare).toBe(false);
  expect(bare.memberAgents).toEqual([]);

  const led = await config.createResearchGroup({ name: "Led", leadAgent: "atlas" });
  expect(led.leadAgent).toBe("atlas");
});

it("lists Research Groups newest first, insertion order breaking a same-second tie", async () => {
  // Both groups land in the one second the clock is pinned to — the ordinary
  // shape of a scripted import, and the one case a real clock rarely
  // reproduces on its own.
  const store = freshStore();
  addOwner(store, "u_owner");
  const config = configSurfaceApi(depsFor(store, () => NOW));

  const first = await config.createResearchGroup({ name: "First" });
  const second = await config.createResearchGroup({ name: "Second" });
  expect((await config.listResearchGroups()).map((g) => g.id)).toEqual([second.id, first.id]);
});
