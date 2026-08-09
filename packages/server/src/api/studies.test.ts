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
import { createPendingCells } from "../kernel-cells";
import { changeRecorder } from "./changes";
import { studiesApi } from "./studies";
import type { Deps } from "./index";
import type { Store } from "../store/store";

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-studies-"));
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
  return {
    store,
    actor,
    now: () => NOW,
    config: readConfig({}),
    // A real channel rather than a stub: it is the cheapest place to leave
    // the recorder's publish path actually exercised.
    channel,
    runs: createRunRelay(),
    reverts: createRevertRegistry(),
    kernelLists: createKernelListRegistry(), pendingCells: createPendingCells(),
    changes: changeRecorder({ store, actorId: actor.userId, now: () => NOW, channel }),
  };
}

it("description and agentContext read back absent, not null, on a Study that never had one", async () => {
  // The shared conformance suite never creates a Study without these two
  // fields, so nothing that runs against a live server currently proves
  // `toStudy` keeps the same absent-key discipline the account family holds
  // for `removedTs`. This checks it directly.
  const store = freshStore();
  addOwner(store, "u_owner");
  const studies = studiesApi(depsFor(store));

  const bare = await studies.createStudy({ title: "Bare", key: "BAR" });
  expect("description" in bare).toBe(false);
  expect("agentContext" in bare).toBe(false);

  const detailed = await studies.createStudy({
    title: "Detailed",
    key: "DET",
    description: "A description.",
    agentContext: "Context.",
  });
  expect(detailed.description).toBe("A description.");
  expect(detailed.agentContext).toBe("Context.");
});
