import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./sqlite";
import { migrate, nextSeq } from "./migrations";
import { environmentStore } from "./environments";
import type { Store } from "./store";

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-store-environments-"));
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

/** `kernel_envs.created_by` is a real foreign key onto `users` (`sqlite.ts`
 *  turns `PRAGMA foreign_keys` on), so every test needs a user row to
 *  declare against before it can call `declare`. */
function addUser(store: Store, id: string): void {
  store.run(
    `INSERT INTO users (id, email, display_name, password, created_ts, seq) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, `${id}@lab.example`, id, "x", NOW, nextSeq(store)],
  );
}

describe("the lab's environment declarations", () => {
  it("keeps what was asked for, not what was resolved", () => {
    const store = freshStore();
    addUser(store, "u_ana");
    const envs = environmentStore(store);
    envs.declare({
      name: "crispr", language: "python", manager: "uv",
      packages: ["scanpy", "anndata"], createdBy: "u_ana", createdTs: 100,
    });
    const [only] = envs.list();
    expect(only.packages).toEqual(["scanpy", "anndata"]);
    // A fresh declaration has resolved nothing yet, so it pins nothing.
    expect(only.lockRevision).toBe(0);
  });

  it("raises the revision only when a lockfile is written", () => {
    const store = freshStore();
    addUser(store, "u_ana");
    const envs = environmentStore(store);
    envs.declare({
      name: "crispr", language: "python", manager: "uv",
      packages: ["scanpy"], createdBy: "u_ana", createdTs: 100,
    });
    expect(envs.writeLock("crispr", "lock-v1", 200)).toBe(1);
    expect(envs.writeLock("crispr", "lock-v2", 300)).toBe(2);
    expect(envs.get("crispr")?.lockRevision).toBe(2);
    // Every revision is kept: a machine built from revision 1 must be able
    // to say what it holds, not merely that it is behind.
    expect(envs.readLock("crispr", 1)).toBe("lock-v1");
    expect(envs.readLock("crispr", 2)).toBe("lock-v2");
  });

  it("removing a declaration is a hard delete: gone from the list and unanswerable by name", () => {
    const store = freshStore();
    addUser(store, "u_ana");
    const envs = environmentStore(store);
    envs.declare({
      name: "crispr", language: "python", manager: "uv",
      packages: ["scanpy"], createdBy: "u_ana", createdTs: 100,
    });
    envs.remove("crispr");
    expect(envs.list()).toEqual([]);
    // No tombstone: `get` answers the same way it would for a name never
    // declared. Nothing in this phase reads "used to exist" as a fact
    // distinct from "never existed" — see `environments.ts`'s doc comment
    // on `remove`.
    expect(envs.get("crispr")).toBeUndefined();
  });

  it("clears locks too, so a recreated name starts fresh rather than inheriting a stale pin", () => {
    const store = freshStore();
    addUser(store, "u_ana");
    const envs = environmentStore(store);
    envs.declare({
      name: "crispr", language: "python", manager: "uv",
      packages: ["scanpy"], createdBy: "u_ana", createdTs: 100,
    });
    envs.writeLock("crispr", "lock-v1", 200);
    envs.remove("crispr");

    // Re-declaring the same name must not collide with the PRIMARY KEY the
    // deleted row left behind...
    envs.declare({
      name: "crispr", language: "python", manager: "uv",
      packages: ["anndata"], createdBy: "u_ana", createdTs: 300,
    });
    expect(envs.get("crispr")?.lockRevision).toBe(0);

    // ...and pinning it again must not collide with — or read back — the
    // lock its predecessor left under the same revision number. A machine
    // that built from the OLD "revision 1" must not be told its build is
    // current just because a new environment reused that number.
    expect(envs.writeLock("crispr", "lock-v2", 400)).toBe(1);
    expect(envs.readLock("crispr", 1)).toBe("lock-v2");
  });

  it("mints a new opaque generation even when delete and redeclare share one timestamp", () => {
    const store = freshStore();
    addUser(store, "u_ana");
    const envs = environmentStore(store);
    const first = envs.declare({
      name: "crispr", language: "python", manager: "uv",
      packages: ["scanpy"], createdBy: "u_ana", createdTs: 100,
    }) as ReturnType<typeof envs.declare> & { declarationGenerationId?: string };
    envs.remove("crispr");
    const second = envs.declare({
      name: "crispr", language: "python", manager: "uv",
      packages: ["anndata"], createdBy: "u_ana", createdTs: 100,
    }) as ReturnType<typeof envs.declare> & { declarationGenerationId?: string };

    expect(first.declarationGenerationId).toMatch(/^envgen_/);
    expect(second.declarationGenerationId).toMatch(/^envgen_/);
    expect(second.declarationGenerationId).not.toBe(first.declarationGenerationId);
  });

  it("keeps a pin nobody named a request for apart from one resolved from nothing", () => {
    // Absent is not zero, on the field the whole resolve-or-replay branch
    // turns on. A pin this lab cannot name the request for — a row written
    // before migration 28 — must read as `undefined` so `buildEnvironmentOn`
    // WIDENS to a resolve; a pin genuinely resolved from an empty list is an
    // answer, and must read as `[]` so an environment holding only its
    // interpreter replays rather than re-pinning the lab on every setup.
    // Collapsed either way, one of those two is silently wrong.
    const store = freshStore();
    addUser(store, "u_ana");
    const envs = environmentStore(store);
    envs.declare({
      name: "bare", language: "python", manager: "uv",
      packages: [], createdBy: "u_ana", createdTs: 100,
    });

    // Written with no request at all: SQL NULL, read back as absent.
    envs.writeLock("bare", "lock-v1", 200);
    expect(
      store.get(`SELECT requested_packages AS p FROM kernel_env_locks WHERE revision = 1`)!.p,
    ).toBeNull();
    expect(envs.readLockRequest("bare", 1)).toBeUndefined();

    // Written FROM an empty list: an answer, stored as one and read as one.
    envs.writeLock("bare", "lock-v2", 300, []);
    expect(
      store.get(`SELECT requested_packages AS p FROM kernel_env_locks WHERE revision = 2`)!.p,
    ).toBe("[]");
    expect(envs.readLockRequest("bare", 2)).toEqual([]);

    // And a revision that is not there at all is absent rather than empty —
    // the caller tells that from a missing row through `readLock`, which is
    // the harder failure and refused separately.
    expect(envs.readLockRequest("bare", 9)).toBeUndefined();
  });

  it("appends to a declaration it holds and refuses one it does not, by name", () => {
    // `addPackages` is exported from the store and reachable by any caller,
    // not only the route that 404s first. A precondition carried by call-site
    // discipline is one the next caller does not know about; a name this lab
    // does not declare is refused here, by name, rather than raising whatever
    // a non-null assertion happens to raise.
    const store = freshStore();
    addUser(store, "u_ana");
    const envs = environmentStore(store);
    envs.declare({
      name: "crispr", language: "python", manager: "uv",
      packages: ["numpy"], createdBy: "u_ana", createdTs: 100,
    });

    expect(envs.addPackages("crispr", ["scanpy", "numpy"])).toEqual({
      packages: ["numpy", "scanpy"],
      added: ["scanpy"],
    });
    expect(() => envs.addPackages("nope", ["scanpy"])).toThrow(/nope/);
  });
});
