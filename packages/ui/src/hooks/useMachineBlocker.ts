import type { ReactNode } from "react";
import type { Machine } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { hasWorkspaceServer } from "../api/select";
import { usePromise } from "./usePromise";

const NO_MACHINE =
  "No machine of yours is connected to this lab. Install the local machine " +
  "daemon on a machine you want to run on, and it will appear here.";

/** What the composer says when the lab would not say who is asking. Not
 *  {@link NO_MACHINE}, which would be a claim about the lab's machines that
 *  nothing here is in a position to make: the roster may be full of the
 *  caller's own. All that is known is that none of it can be attributed. */
const NO_IDENTITY =
  "This lab could not confirm who is signed in, so there is no way to tell " +
  "which machines are yours. Reload the page, or sign in again.";

/** What the composer says when the caller has a machine, but none of them
 *  can run a session yet — every machine a daemon reports today lands here,
 *  since nothing it can do is a capability yet. Names the one machine there
 *  is; with several, none of them is singled out. */
function cannotRunYet(mine: Machine[]): string {
  if (mine.length === 1) {
    return `${mine[0].name} is connected, but it cannot run sessions yet.`;
  }
  return "None of your machines can run sessions yet.";
}

/** What `useMachineBlocker` resolves to: the notice `Composer`'s `blocker`
 *  prop should read (or `undefined` to leave it free), and the machine names
 *  a caller who names machines on screen — `CliDock`'s tiles — needs and
 *  would otherwise have to read `listMachines()` a second time to get. */
export interface MachineBlocker {
  blocker: ReactNode | undefined;
  /** Machine id → the machine's paired name, for the caller's own machines
   *  and no others. Nothing downstream can name a colleague's machine even
   *  from the full list, because `listAgentClis()` never answers with a
   *  colleague's CLI and there would be nothing to attach the name to — but
   *  that makes this map's contents depend on a rule enforced in another
   *  package to stay private. Narrowing here costs one filter and makes it
   *  depend on nothing: what a member has on their machines, including what
   *  they called them, is theirs. Empty until the caller is known, since
   *  until then there is no way to say which machines are the caller's. */
  machineNames: Record<string, string>;
}

/**
 * What `Composer`'s `blocker` prop should read on a screen that hosts it —
 * the one place the copy and the condition exist, so `StudyScreen` and
 * `TaskScreen` cannot drift apart on either — bundled with the machine names
 * both screens also need for `CliDock`, so `listMachines()` is read once
 * here rather than once more per screen. `ApiContext.tsx`'s `DirectoryContext`
 * is this repo's own precedent for not re-reading the same list per
 * consumer; this stays a plain return value rather than a second context
 * because the one read already lives in the one hook both screens call.
 *
 * The question is whether THE CALLER has something to run on, not whether
 * the lab does — a colleague's paired machine is real, but a send from
 * someone else's composer has no way to reach it, since a machine only ever
 * runs for the member who paired it. So this reads `listMachines()` against
 * `currentUser()` and narrows to the caller's own before deciding anything.
 *
 * `listMachines()` answers empty both against a real workspace server with
 * no daemon registered AND in the browser-only demo, where nothing is
 * meant to register one — the browser tab is the machine there, and a send
 * is simulated rather than dispatched anywhere. So an empty list only means
 * "nothing to run on" when `hasWorkspaceServer()` says a real lab is behind
 * the page; without that, `undefined` leaves the composer free to send.
 */
export function useMachineBlocker(): MachineBlocker {
  const api = useApi();
  const machines = usePromise(() => api.listMachines(), [api]);
  const me = usePromise(() => api.currentUser(), [api]);
  const machineNames = Object.fromEntries(
    (machines.data ?? [])
      .filter((r) => me.data !== null && r.ownerId === me.data.id)
      .map((r) => [r.id, r.name]),
  );

  if (!hasWorkspaceServer()) return { blocker: undefined, machineNames };
  // A `currentUser()` that REJECTED is not one still in flight, and the two
  // call for opposite answers. `usePromise` sets `data: null` for both, so
  // the rejection is read off `error` — asked first, because a failed
  // identity settles the question however far the roster has got.
  //
  // Blocking is the honest answer to it: every machine on the roster belongs
  // to somebody, and without knowing who is asking there is no telling
  // whether any of them is theirs. Leaving the composer free would let a
  // send go to a machine that will not run it and lose what was typed.
  if (me.error !== null) return { blocker: NO_IDENTITY, machineNames };
  // Not yet answered is not the same as answered empty. Against a real lab
  // both reads cross the network, so treating the gap as "no machine" would
  // put the notice up on every page load and swallow anything typed before
  // the answers arrived — the send would return with the text still in the
  // box and nothing said about why.
  if (machines.loading || machines.data === null || me.data === null) {
    return { blocker: undefined, machineNames };
  }
  const meId = me.data.id;
  const mine = machines.data.filter((r) => r.ownerId === meId);
  if (mine.length === 0) return { blocker: NO_MACHINE, machineNames };
  const runnable = mine.find((r) => r.capabilities.includes("sessions"));
  if (!runnable) return { blocker: cannotRunYet(mine), machineNames };
  return { blocker: undefined, machineNames };
}
