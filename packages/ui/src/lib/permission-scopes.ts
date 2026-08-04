import type { PermissionScope } from "@lykeion/api";

/**
 * The four scopes a permission grant can carry, in the order the split
 * button's dropdown offers them: Once → this conversation → this Study →
 * Global, from narrowest to broadest. `label` is the menu row's own wording;
 * `description` is the line under it, asserted verbatim by
 * `PermissionCard.test.tsx` — keep the four strings exact if this list is
 * ever touched again.
 */
export const PERMISSION_SCOPES: {
  scope: PermissionScope;
  label: string;
  description: string;
}[] = [
  { scope: "once", label: "Once", description: "This call only" },
  {
    scope: "conversation",
    label: "This conversation",
    description: "Until this chat ends",
  },
  {
    scope: "study",
    label: "This Study",
    description: "Remembered for this Study",
  },
  {
    scope: "global",
    label: "Global",
    description: "Remembered across all projects",
  },
];

/**
 * The scope a fresh permission card starts on — `conversation`, not `once`.
 * Listing `conversation` first in `PERMISSION_SCOPES` above is cosmetic, not
 * sufficient on its own:
 * `PermissionCard`'s `Allow` button renders its label FROM this value (e.g.
 * "Allow for this conversation"), so the default has to be an explicit,
 * named scope a researcher can read off the button before ever opening the
 * menu — not an accident of array order.
 */
export const DEFAULT_SCOPE: PermissionScope = "conversation";
