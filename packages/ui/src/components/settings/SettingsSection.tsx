import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import { screenTitleClass } from "../ui/ScreenHeader";

/**
 * The two settings headings, and the one thing they must not share: their size.
 *
 * They live in their own module so the panels rendered as a tab — Skills,
 * Connectors, Profile — can lead with the same heading as every other tab
 * without importing `SettingsView` (which renders them: that would be a cycle).
 *
 * `SettingsSectionHeader` titles a TAB and `SectionTitle` titles a section
 * inside one, so the pane is two levels deep and the type says which level a
 * reader is at. They were one size, taken from `ScreenHeader` so a tab titled
 * itself no smaller than any other section in the app — which made "Profile"
 * and the "Account" under it indistinguishable, and left a tab reading as a
 * list of equal headings with no top to it.
 *
 * A section keeps `ScreenHeader`'s size, so a settings section and a screen
 * section are still the same thing at the same size. The tab title steps up
 * from it. That step is the whole point: change one of these and the two must
 * still differ, or the hierarchy goes back to being flat.
 */
const sectionTitleClass = screenTitleClass;
const tabTitleClass = "text-display font-semibold tracking-[-0.2px] text-fg";

/**
 * The box a settings heading sits in: `ScreenHeader`'s own content box — its
 * 52px row less the row's `pt-3`/`pb-2` — centring its text the same way.
 *
 * This is what puts a heading on the surface title's line. The title row lives
 * in the nav's column and the body column starts level with it, so the body's
 * `pt-3` matches the row's and this box matches what that row centres inside
 * it. Take the box away and every heading rides ~5px high of the title across
 * the rule, because a bare `h3` starts at the padding edge where the title
 * starts centred.
 *
 * Both headings take the same box, which is what keeps a tab title and a
 * section title starting on the same line however they are mixed. It centres
 * them rather than sitting them on a shared baseline — at 20px the tab title's
 * own baseline is a hair below a 17px one — and 32px is chosen to hold the
 * taller of the two without growing: 20px at this line-height is 30px.
 */
const titleBoxClass = "flex min-h-[32px] items-center";

/**
 * The heading a settings section leads with.
 *
 * `id` is for a section whose content carries its own role — a list, a table
 * — and should be named BY this heading rather than by a second copy of the
 * same words: point the content's `aria-labelledby` here and the group is
 * announced once.
 *
 * The box around the heading is what keeps it on the same line as the one
 * `SettingsSectionHeader` produces; see the note there, which depends on the
 * two boxes staying identical.
 */
export function SectionTitle({
  id,
  children,
}: {
  id?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(titleBoxClass, "mb-3")}>
      <h3 id={id} className={sectionTitleClass}>
        {children}
      </h3>
    </div>
  );
}

/**
 * A tab's own title, optionally carrying a primary action on its right. Every
 * Settings tab leads with this, which is what makes the step up from
 * `SectionTitle` mean "you are at the top of a tab" rather than "this one
 * panel is shouting".
 *
 * The action is taken OUT OF FLOW on purpose, so this block is `SectionTitle`
 * with an action hung on it rather than a different shape that happens to look
 * alike: the `h3` is the row's only in-flow child, so it fills the row and sits
 * exactly where every other tab's title sits. In flow, the action would take a
 * share of the row's width from the title, and any action taller than the
 * shared 32px box would drive the row and push the title off the baseline the
 * screen title sets. Keep it out of flow.
 */
export function SettingsSectionHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className={cn("relative", titleBoxClass, "mb-3")}>
      <h3 className={tabTitleClass}>{title}</h3>
      {action && (
        <div className="absolute right-0 top-1/2 -translate-y-1/2">
          {action}
        </div>
      )}
    </div>
  );
}
