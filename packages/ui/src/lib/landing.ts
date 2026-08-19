import type { LykeionApi } from "@lykeion/api";

/**
 * Where a member lands the moment they sign in.
 *
 * A member with no machine of their own cannot run anything, and Researches does
 * not say so — it shows the work and lets them find out at the first send. So
 * they land on Machines instead, which is where the one thing they still have
 * to do is explained. Once a machine is paired the rule stops applying and
 * sign-in goes where it always did.
 *
 * Scoped to the member, not the lab: machines are owned, so a colleague's
 * paired laptop is not a reason to stop telling this person how to add theirs.
 *
 * `null` means "leave the address bar alone", and it is also the answer when
 * asking fails. Onboarding is worth a redirect; it is not worth swallowing
 * somebody's destination because a request did not come back.
 */
export async function landingHash(api: LykeionApi): Promise<string | null> {
  try {
    const [me, machines] = await Promise.all([api.currentUser(), api.listMachines()]);
    return machines.some((r) => r.ownerId === me.id) ? null : "#/machines";
  } catch {
    return null;
  }
}

/**
 * Whether the address bar is asking for somewhere in particular.
 *
 * Signing in is not always the start of a visit — it is also what happens
 * when somebody opens a link to a Task and turns out not to be signed in.
 * Sending them to Machines instead of the thing they clicked would be the
 * onboarding rule eating a destination they had already chosen, so the
 * redirect only applies when nothing else has been asked for.
 */
export function hasDestination(hash: string): boolean {
  const trimmed = hash.replace(/^#\/?/, "");
  return trimmed !== "";
}
