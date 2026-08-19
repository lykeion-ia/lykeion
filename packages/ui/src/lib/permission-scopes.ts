import type { AccessKind, PermissionScope } from "@lykeion/api";

/**
 * The four scopes a permission grant can carry, in the order the split
 * button's dropdown offers them: Once → this conversation → this Research →
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
    label: "This Research",
    description: "Remembered for this Research",
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

/**
 * What "this conversation" actually covers on an environment card, said on
 * the card rather than left to be discovered.
 *
 * The grant behind it is kept by the environment's NAME, not by the packages
 * on the card, and that is deliberate: keyed by the package list it would ask
 * again on every single call, because the realistic sequence is *add scanpy*,
 * then *add anndata*, and a scope that never covers anything is a control
 * that does nothing. So the scope genuinely does cover any later change to
 * that environment until the conversation ends — which makes it a standing
 * grant, bounded, with the researcher sitting right there. That is the
 * design. A standing grant they did not know they were giving is not, which
 * is why this row cannot carry the generic wording.
 */
const ENVIRONMENT_CONVERSATION_SCOPE =
  "Any packages for this environment, until this chat ends";

/**
 * Which scopes a card may be answered with. Every kind but `environment`
 * offers all four.
 *
 * An environment card offers `once` and `conversation` only. "Global —
 * remembered across all projects" on this card is a standing grant to
 * install arbitrary packages, permanently, on every machine in the lab,
 * without being asked again — which is a standing grant to run strangers'
 * build scripts on colleagues' computers. Both remaining scopes are bounded
 * and both have the researcher sitting right there.
 */
export function scopesFor(access: AccessKind) {
  return access.kind === "environment"
    ? PERMISSION_SCOPES.filter(
        (s) => s.scope === "once" || s.scope === "conversation",
      ).map((s) =>
        s.scope === "conversation"
          ? { ...s, description: ENVIRONMENT_CONVERSATION_SCOPE }
          : s,
      )
    : PERMISSION_SCOPES;
}

/** An environment card starts on `once`, not on `conversation`. */
export function defaultScopeFor(access: AccessKind): PermissionScope {
  return access.kind === "environment" ? "once" : DEFAULT_SCOPE;
}
