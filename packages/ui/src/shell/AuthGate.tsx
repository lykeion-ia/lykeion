import { useEffect, useState, type ReactNode } from "react";
import { isLykeionError, type User } from "@lykeion/api";
import { postAuth } from "../lib/auth-request";
import { clearStoredTabs } from "../lib/tabs-storage";
import { SessionProvider } from "../api/SessionContext";
import { SignInScreen } from "../screens/SignInScreen";
import { SetupScreen } from "../screens/SetupScreen";
import { JoinScreen } from "../screens/JoinScreen";
import { parseHash } from "../router";

type Gate = "resolving" | "in" | "sign-in" | "setup";

/** The invite code off the current hash, or `null` off any other route.
 *  `AuthGate` sits above `RouterProvider` (`App.tsx` renders it outside the
 *  provider's subtree), so it cannot call `useRouter()` — it reads the hash
 *  itself and parses it with the same `parseHash` the router uses, so one
 *  function decides what a hash means. */
/** Take the code out of the URL once it has nothing left to do — it has
 *  been redeemed, or the person reading it is already a member. A spent
 *  code left in the address bar is offered up again on every reload, and it
 *  outlives the page in history and autocomplete. */
function clearJoinHash(): void {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

function joinCodeFromHash(): string | null {
  const route = parseHash(window.location.hash);
  return route.name === "join" ? route.code : null;
}

/**
 * Stands between the workbench and whoever opened it. Renders its children
 * only once the server has named the caller; until then it shows the way in.
 * A lab with no owner yet gets the setup screen instead, which is the only
 * time that route answers. An invite link gets the join screen instead of
 * either — the person opening it does not have an account yet, so asking the
 * server whether this lab needs setting up would only send them to sign in
 * for one that does not exist.
 */
export function AuthGate({
  currentUser,
  onSignedIn,
  onSignedOut,
  revision = 0,
  children,
}: {
  currentUser: () => Promise<User>;
  onSignedIn: () => void;
  onSignedOut?: () => void;
  /**
   * Advanced by the caller whenever the ambient identity might have changed
   * for a reason the gate was not told about directly — a session that
   * lapsed on some unrelated call, halfway through a visit. Each new value
   * sends the question back to the server.
   */
  revision?: number;
  children: ReactNode;
}) {
  const [gate, setGate] = useState<Gate>("resolving");
  const [attempt, setAttempt] = useState(0);
  const [joinCode, setJoinCode] = useState<string | null>(joinCodeFromHash);
  /** The code whose holder has been asked about since it arrived. */
  const [verifiedFor, setVerifiedFor] = useState<string | null>(null);

  // Somebody who lands on the sign-in screen and then pastes a join link into
  // the address bar changes only the hash — nothing else in this component
  // navigates, so nothing else would notice.
  useEffect(() => {
    const sync = () => setJoinCode(joinCodeFromHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  // A member who is already in has nothing to redeem, so the code goes —
  // from the address bar and from here. Dropping only the first would leave
  // this holding a code the URL no longer shows, and signing out would land
  // them on an account-creation form for it.
  //
  // Only ever on a verdict reached with this code in hand. `in` is the answer
  // to a question asked earlier, and a page that has been open a while may
  // have lost the session behind it — offboarded, expired — without anything
  // yet asking again. A code discarded against that stale reading is a
  // working invite thrown away, and the address bar no longer holds it for a
  // second try. The identity check below re-runs whenever the code changes,
  // so the verdict this waits for is always one that postdates it.
  useEffect(() => {
    if (joinCode !== null && gate === "in" && verifiedFor === joinCode) {
      clearJoinHash();
      setJoinCode(null);
    }
  }, [joinCode, gate, verifiedFor]);

  useEffect(() => {
    let cancelled = false;
    currentUser().then(
      () => {
        if (cancelled) return;
        setGate("in");
        setVerifiedFor(joinCode);
      },
      async (err: unknown) => {
        if (cancelled) return;
        if (!isLykeionError(err) || err.code !== "unauthenticated") {
          // Not a refusal but some other failure — a crash, a network
          // error. There is no separate screen to route a failure like that
          // to, and asking whoever is there to prove who they are again is
          // still the safest recovery, so this falls through to the same
          // probe an explicit refusal takes below. Logged here because that
          // shared path would otherwise swallow the more specific reason.
          console.error("[AuthGate] could not resolve the signed-in member:", err);
        }
        // A probe that cannot be made at all is not an answer that this lab
        // needs setting up. Sign-in is the recovery from either outcome, and
        // it is the one that cannot show the workbench to someone the server
        // has not named — so an unreachable server resolves that way too,
        // rather than leaving the gate undecided and the page blank.
        const probe = await fetch("/auth/setup").catch(() => undefined);
        if (cancelled) return;
        setGate(probe?.ok ? "setup" : "sign-in");
        setVerifiedFor(joinCode);
      },
    );
    return () => {
      cancelled = true;
    };
    // `joinCode` belongs here: a code arriving is exactly the moment the
    // question of who is holding it has to be put again, and running this
    // check is how the answer comes back stamped with the code it was asked
    // about. Nothing else re-asks — a live session is not re-examined on its
    // own, so without this the gate would answer a new link out of a verdict
    // reached before it existed.
  }, [currentUser, attempt, revision, joinCode]);

  /**
   * Put the question back to the server, showing nothing while it answers.
   * Returning to `resolving` is what unmounts the form that was just
   * submitted. Left mounted, it keeps its own state across a re-check that
   * lands back on the same screen — so a submission the server accepted,
   * followed by a re-check that fails for an unrelated reason, would leave a
   * disabled button reading "Signing in…" and no way forward but a reload.
   */
  const recheck = () => {
    setGate("resolving");
    setAttempt((n) => n + 1);
  };

  const signedIn = () => {
    onSignedIn();
    recheck();
  };

  const signOut = () => {
    // Cleared before the request rather than after it: leaving on screen
    // means the previous member's workbench stays up across three round
    // trips, and the middle one remounts the data layer under it, so they
    // watch their own work fail to reload on the way out.
    setGate("resolving");
    // The strip goes with them. A tab's label is a Task's title, and it is
    // written to this machine's storage — so leaving it would hand the next
    // person to sign in here a list of the last one's work, and a reload would
    // bring it back even after the session was gone.
    clearStoredTabs();
    postAuth("/auth/signout")
      .finally(() => {
        onSignedOut?.();
        recheck();
      })
      // A sign-out that never reached the server is still answered by the
      // re-check above, which asks the server who is signed in and shows
      // whatever it says. Swallowed here so a failed request does not also
      // surface as an unhandled rejection on a page that has recovered.
      .catch(() => {});
  };

  // Only for somebody who is not already in. A member who opens a link a
  // colleague forwarded is being offered an account they have — and the
  // screen has no way back to their own lab, so showing it would strand
  // them in a form whose only outcome is a second identity.
  if (joinCode !== null && gate !== "in")
    return (
      <JoinScreen
        code={joinCode}
        onSignedIn={() => {
          clearJoinHash();
          setJoinCode(null);
          signedIn();
        }}
        onSignIn={() => {
          clearJoinHash();
          setJoinCode(null);
        }}
      />
    );
  if (gate === "resolving") return null;
  if (gate === "setup") return <SetupScreen onSignedIn={signedIn} />;
  if (gate === "sign-in") return <SignInScreen onSignedIn={signedIn} />;
  return <SessionProvider signOut={signOut}>{children}</SessionProvider>;
}
