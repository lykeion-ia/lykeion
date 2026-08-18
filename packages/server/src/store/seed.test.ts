import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methodSkills } from "@lykeion/api";
import { openStore } from "./sqlite";
import { migrate } from "./migrations";
import { seedLabContent } from "./seed";
import { environmentStore } from "./environments";
import type { Store } from "./store";

// The seeder runs on every boot, so what it must not do is more interesting
// than what it does: a lab that has been used for a month starts this code
// path with rows already in place, and a researcher's choices live in them.

const dirs: string[] = [];
const opened: Store[] = [];

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-seed-"));
  dirs.push(dir);
  const store = openStore(join(dir, "workspace.db"));
  opened.push(store);
  migrate(store);
  return store;
}

afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // The directory is a temporary one; a failure to remove it is not the
      // test's subject.
    }
  }
});

const countOf = (store: Store, table: string): number =>
  store.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n as number;

it("puts the method skills and the workflow catalogue in an empty database", () => {
  const store = freshStore();
  expect(countOf(store, "skills")).toBe(0);
  expect(countOf(store, "workflows")).toBe(0);

  seedLabContent(store);

  expect(countOf(store, "skills")).toBe(methodSkills().length);
  expect(countOf(store, "workflows")).toBeGreaterThan(0);
});

it("seeds the same content twice without duplicating it", () => {
  const store = freshStore();
  seedLabContent(store);
  const skills = countOf(store, "skills");
  const workflows = countOf(store, "workflows");

  seedLabContent(store);

  expect(countOf(store, "skills")).toBe(skills);
  expect(countOf(store, "workflows")).toBe(workflows);
});

it("leaves a skill disabled between boots disabled", () => {
  const store = freshStore();
  seedLabContent(store);
  const [first] = methodSkills();
  store.run(`UPDATE skills SET enabled = 0 WHERE name = ?`, [first.name]);

  seedLabContent(store);

  const row = store.get(`SELECT enabled FROM skills WHERE name = ?`, [
    first.name,
  ]);
  expect(row!.enabled).toBe(0);
});

it("leaves an edited record as the researcher left it", () => {
  const store = freshStore();
  seedLabContent(store);
  const [first] = methodSkills();
  store.run(`UPDATE skills SET body = ? WHERE name = ?`, [
    "Rewritten.",
    first.name,
  ]);
  const workflow = store.get(`SELECT id FROM workflows LIMIT 1`)!.id as string;
  store.run(`UPDATE workflows SET payload = ? WHERE id = ?`, [
    JSON.stringify({ id: workflow, name: "Renamed" }),
    workflow,
  ]);

  seedLabContent(store);

  expect(
    store.get(`SELECT body FROM skills WHERE name = ?`, [first.name])!.body,
  ).toBe("Rewritten.");
  expect(
    store.get(`SELECT payload FROM workflows WHERE id = ?`, [workflow])!
      .payload,
  ).toContain("Renamed");
});

// R14: the starter environment has no author. On a fresh lab there is no
// user at all yet, and `kernel_envs.created_by` used to be `NOT NULL
// REFERENCES users(id)` under `PRAGMA foreign_keys = ON` — declaring the
// starter there raised a foreign-key violation on first boot, before any
// owner had signed up to receive the seed's request.

it("seeds the python starter on a fresh lab with nobody signed up yet, attributed to nobody", () => {
  const store = freshStore();

  // Before R14 this threw a foreign-key violation: `created_by` demanded a
  // row in `users` this fresh store has none of.
  seedLabContent(store);

  const python = environmentStore(store).get("python");
  expect(python).toBeDefined();
  // Absent, not a placeholder id: this is Lykeion's own declaration, not a
  // person's, and inventing an owner would be a false statement about
  // somebody the moment a user does exist.
  expect(python!.createdBy).toBeUndefined();
  expect(python!.language).toBe("python");
  expect(python!.manager).toBe("uv");
  expect(python!.lockRevision).toBe(0);
  expect(python!.packages).toEqual([
    "numpy", "pandas", "scipy", "matplotlib", "seaborn", "pillow",
  ]);
});

it("does not duplicate the starter across boots", () => {
  const store = freshStore();
  seedLabContent(store);
  expect(countOf(store, "kernel_envs")).toBe(1);

  // A second boot must not throw on the PRIMARY KEY the first boot wrote —
  // `environmentStore.declare` has no `ON CONFLICT` of its own, unlike the
  // skills/workflows loops above.
  seedLabContent(store);
  expect(countOf(store, "kernel_envs")).toBe(1);
});
