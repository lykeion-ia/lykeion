import { methodSkills } from "@lykeion/api";
import type { Store } from "./store";
import { nextSeq } from "./migrations";
import { environmentStore } from "./environments";

/**
 * Put the starting content in place, once.
 *
 * `ON CONFLICT DO NOTHING` rather than `createSkill`: that method resets
 * `enabled` on conflict, so running this on every boot would turn a Skill
 * back on after a researcher had turned it off, and would replace a body
 * they had edited. Leaving an existing row alone is what makes this safe to
 * run unconditionally.
 */
export function seedLabContent(store: Store): void {
  store.tx(() => {
    for (const skill of methodSkills()) {
      store.run(
        `INSERT INTO skills (name, description, body, enabled, seq)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(name) DO NOTHING`,
        [skill.name, skill.description, skill.body, nextSeq(store)],
      );
    }
    // The starters, declared on a fresh lab so a researcher has something to
    // set up rather than an empty list and no way to make one. NOT built:
    // nothing downloads a gigabyte until somebody asks, which is the whole
    // of D3. Their packages are the ones `tools-and-environments.md:13-16`
    // names for each language.
    //
    // No `createdBy` (R14): `environmentStore.declare` has no `ON CONFLICT`
    // of its own, unlike the two loops above, so this checks for the row
    // first rather than relying on one — a second boot must not throw on
    // the PRIMARY KEY the first boot already wrote. Absent `createdBy`
    // means Lykeion declared this, not a person: a fresh lab has no user at
    // all yet to attribute it to, and `kernel_envs.created_by` is nullable
    // for exactly this (R14) — attributing it to whoever happens to become
    // the owner would be a false statement about them on a screen every
    // researcher reads.
    if (!store.get(`SELECT 1 FROM kernel_envs WHERE name = 'python'`)) {
      environmentStore(store).declare({
        name: "python",
        language: "python",
        manager: "uv",
        packages: ["numpy", "pandas", "scipy", "matplotlib", "seaborn", "pillow"],
        createdTs: Math.floor(Date.now() / 1000),
      });
    }
    // `r` beside `python`, same shape and same reasoning above — `conda`,
    // not `uv`, because an R environment pins R itself rather than a
    // library resolved by some other interpreter (the derivation
    // `declareEnvironment`'s `MANAGER_FOR` makes for every caller; written
    // by hand here because a seed inserts directly and is never routed
    // through that gate).
    if (!store.get(`SELECT 1 FROM kernel_envs WHERE name = 'r'`)) {
      environmentStore(store).declare({
        name: "r",
        language: "r",
        manager: "conda",
        packages: ["tidyverse", "ggplot2", "jsonlite"],
        createdTs: Math.floor(Date.now() / 1000),
      });
    }
  });
}
