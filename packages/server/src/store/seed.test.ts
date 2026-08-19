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

it("seeds no workflows, because the table is gone", () => {
  const store = freshStore();
  seedLabContent(store);
  const table = store.get(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflows'`,
  );
  expect(table).toBeUndefined();
});

it("seeds the same content twice without duplicating it", () => {
  const store = freshStore();
  seedLabContent(store);
  const skills = countOf(store, "skills");

  seedLabContent(store);

  expect(countOf(store, "skills")).toBe(skills);
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

  seedLabContent(store);

  expect(
    store.get(`SELECT body FROM skills WHERE name = ?`, [first.name])!.body,
  ).toBe("Rewritten.");
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

it("seeds an r starter beside python on a fresh lab", () => {
  const store = freshStore();

  seedLabContent(store);

  const r = environmentStore(store).get("r");
  expect(r).toBeDefined();
  // Absent for the same reason `python`'s is: Lykeion declared this, not a
  // person (R14).
  expect(r!.createdBy).toBeUndefined();
  expect(r!.language).toBe("r");
  // `conda`, not `uv` — an R environment pins R itself rather than a
  // library resolved by some other interpreter.
  expect(r!.manager).toBe("conda");
  expect(r!.lockRevision).toBe(0);
  expect(r!.packages).toEqual(["tidyverse", "ggplot2", "jsonlite"]);
});

it("does not duplicate the starters across boots", () => {
  const store = freshStore();
  seedLabContent(store);
  expect(countOf(store, "kernel_envs")).toBe(2);

  // A second boot must not throw on the PRIMARY KEY the first boot wrote —
  // `environmentStore.declare` has no `ON CONFLICT` of its own, unlike the
  // skills loop above.
  seedLabContent(store);
  expect(countOf(store, "kernel_envs")).toBe(2);
});
