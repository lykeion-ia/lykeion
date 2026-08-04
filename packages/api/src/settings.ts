/**
 * Workspace-level settings surfaced by the Settings screen. Neutral defaults —
 * no illustrative account details. The controls are decorative with ONE
 * exception: `theme` is really written by `setTheme` and read back by
 * `getSettings`, so the picker round-trips. Nothing here survives a reload.
 */
export interface WorkspaceSettings {
  defaultModel: string;
  reasoningEffort: string;
  subagentModel: string;
  reviewerModel: string;
  useIntent: string;
  dataLocation: string;
  orgName: string;
  orgId: string;
  /**
   * Active color theme id — one of the ids the theme picker offers. Unlike
   * the other fields, this one is user-writable: `setTheme` stores it and
   * `getSettings` reads it back for the rest of the session. "midnight" is
   * the boot default.
   */
  theme: string;
}
