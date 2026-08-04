import type { LykeionApi } from "@lykeion/api";
import type { Deps } from "./index";

export type SettingsApi = Pick<LykeionApi, "getSettings" | "setTheme">;

/**
 * The lab's settings as this member sees them. `theme` is personal and
 * stored per person; the organization's name and id are the lab's and
 * shared. The remaining fields are constants because nothing in the
 * contract writes to them — a model or an effort level chosen here would be
 * a preference this server has no way to honour.
 */
export function settingsApi({ store, actor, config }: Deps): SettingsApi {
  return {
    async getSettings() {
      const personal = store.get(`SELECT theme FROM user_settings WHERE user_id = ?`, [actor.userId]);
      const lab = store.get(`SELECT org_name, org_id FROM lab_settings WHERE id = 1`);
      return {
        defaultModel: "",
        reasoningEffort: "",
        subagentModel: "",
        reviewerModel: "",
        useIntent: "",
        dataLocation: config.dataDir,
        orgName: (lab?.org_name as string | undefined) ?? "",
        orgId: (lab?.org_id as string | undefined) ?? "",
        theme: (personal?.theme as string | undefined) ?? "midnight",
      };
    },

    async setTheme(theme) {
      // Stored verbatim: the picker offers a closed set of ids, but nothing
      // here is the place that enforces it, and rejecting an id the picker
      // hasn't caught up to yet would be a stricter contract than the one
      // this method promises.
      // Upsert rather than update: a member whose settings row is missing
      // for any reason would otherwise have their choice discarded with
      // nothing said.
      store.run(
        `INSERT INTO user_settings (user_id, theme) VALUES (?, ?)
           ON CONFLICT (user_id) DO UPDATE SET theme = excluded.theme`,
        [actor.userId, theme],
      );
    },
  };
}
