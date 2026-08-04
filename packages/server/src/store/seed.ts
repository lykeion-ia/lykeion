import { catalogueWorkflows, methodSkills } from "@lykeion/api";
import type { Store } from "./store";
import { nextSeq } from "./migrations";

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
    for (const workflow of catalogueWorkflows()) {
      store.run(
        `INSERT INTO workflows (id, payload, seq)
         VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        [workflow.id, JSON.stringify(workflow), nextSeq(store)],
      );
    }
  });
}
