import type { ReactNode } from "react";

/**
 * The type a section titles itself in — the one definition of it.
 *
 * Not private to this row, because two screens do not use this row: Skills and
 * Connectors lead with `SettingsSectionHeader` so their titles sit on the same
 * baseline as the other Settings tabs. Sized separately, those two would title
 * themselves smaller than every other section while looking, in the source,
 * like they had been dealt with. Both headings import this, so a section title
 * is one size across the app by construction rather than by everyone
 * remembering.
 */
export const screenTitleClass = "text-title font-semibold text-fg";

/**
 * The fixed title row every section screen uses — Studies, Groups, Experts,
 * Skills, Connectors, My Tasks, Machines, Usage, Settings.
 *
 * This is the single definition of the header's geometry (padding, height,
 * title size) and of where the primary action sits: hard right, on the title
 * line. Screens pass their CTA as `action`; nothing else may re-position it,
 * so every section lines up exactly.
 *
 * The row height is pinned to `min-h-[52px]` — the `h-8` (32px) CTA button
 * plus this row's `pt-3` + `pb-2` — so a section WITHOUT an action (Machines,
 * Settings) centres its title on exactly the same baseline as one WITH a
 * "New …" button. Otherwise the actionless row collapses to the title's own
 * line-height and the title rides ~7px higher than every CTA section.
 */
export function ScreenHeader({
  title,
  action,
  level = 1,
}: {
  title: string;
  /** The primary CTA (a `PrimaryButton` or an `ActionMenu` trigger). */
  action?: ReactNode;
  /**
   * Heading level. A screen is its page's own `h1` and needs nothing here; the
   * Settings *modal* passes 2, because it opens over a Task that already has
   * one and a dialog is not the page's top-level heading. The geometry is the
   * same either way — that is the whole point of taking a level rather than
   * letting the modal re-cut this row for itself.
   */
  level?: 1 | 2;
}) {
  const Heading = level === 1 ? "h1" : "h2";
  return (
    <div className="flex min-h-[52px] shrink-0 items-center gap-2 px-5 pb-2 pt-3">
      <Heading className={screenTitleClass}>{title}</Heading>
      <span className="flex-1" />
      {action}
    </div>
  );
}

export default ScreenHeader;
