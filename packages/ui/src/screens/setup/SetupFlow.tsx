import { useEffect, useState } from "react";
import { AgentsStep } from "./AgentsStep";
import { JoinLabScreen } from "./JoinLabScreen";
import { WhereScreen, type Topology } from "./WhereScreen";

/**
 * The first run, as one component that owns which step is showing and what
 * each answer costs.
 *
 * It lives above the auth gate because a machine whose lab does not exist yet
 * has nobody to sign in AS — the gate would be resolving an identity against
 * a lab that has not been created. The step rides in the address so the trip
 * out to a remote lab and back lands on the step that was waiting.
 *
 * A step this build does not draw yet answers `null` rather than a blank
 * frame, and the caller falls through to the ordinary application. That keeps
 * every commit in this series shippable: the steps arrive one at a time, and
 * until one exists the researcher sees what they see today rather than a
 * screen that is not finished.
 */
/**
 * Whether this build has a screen for that step.
 *
 * Exported because the caller has to know BEFORE rendering: a step with no
 * screen must fall through to the ordinary application, and a component that
 * answered `null` from inside would leave the caller showing a blank page
 * with no way to tell that apart from a screen that rendered nothing.
 */
export function drawsSetupStep(step: number): boolean {
  return step === 1 || step === 2 || step === 3;
}

/**
 * How often an open first run tells the daemon it is still open.
 *
 * Well inside the three minutes a request waits, so a missed ping or a busy
 * moment costs nothing — and far enough apart that a page left open overnight
 * is a few hundred requests to loopback rather than a load.
 */
const STILL_HERE_MS = 45_000;

export function SetupFlow({ step }: { step: number }): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The request behind this page is replaced when nobody answers for three
  // minutes, and reading the first question is indistinguishable from having
  // walked away — so it expired underneath researchers who were still there,
  // taking the admission cookie with it and leaving every control dead.
  //
  // A page that is open is the evidence the clock was always looking for, and
  // it was the one kind nothing reported. It stops the moment the tab does,
  // so the request goes back to expiring when nobody is actually looking.
  useEffect(() => {
    const stillHere = () => {
      void fetch("/setup/still-here", { method: "POST", credentials: "same-origin" }).catch(
        () => {
          // A daemon that cannot be reached is not something this can fix, and
          // whatever the researcher does next will say so in its own words.
        },
      );
    };
    const timer = setInterval(stillHere, STILL_HERE_MS);
    return () => clearInterval(timer);
  }, []);

  if (!drawsSetupStep(step)) return null;
  // Step 2 on the branch that leaves this machine. The other branch's step 2
  // is behind the auth gate — see `chose` below — so reaching this address at
  // all means the lab is somewhere else.
  if (step === 2) return <JoinLabScreen />;
  // Step 3 is the same on both branches, and it is where a machine lands
  // coming back from a lab that just approved it — `/paired` serves this
  // application already on this step. Leaving clears the hash and hands the
  // page to the gate, which is now answerable: this machine has a token.
  if (step === 3)
    return (
      <AgentsStep
        onDone={() => {
          window.location.hash = "";
        }}
      />
    );

  const chose = (topology: Topology) => {
    if (busy) return;
    setBusy(true);
    // Told to the daemon before the screen moves on, because recording `here`
    // is what starts the lab — the next step has nothing to talk to until
    // this has landed. A refusal leaves the researcher on the question with
    // the choice they made still selected, which is the only state from which
    // trying again means anything.
    void fetch("/setup/topology", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topology }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`the daemon refused that choice with ${res.status}`);
        setError(null);
        // Both answers reach step 2; they differ in who draws it, and in how
        // much has to happen for the page to be able to draw it.
        //
        // A lab HERE has just STARTED, and this page was served before it
        // existed — so it is running against no lab at all, and the marker
        // that tells it otherwise is injected into the document when the
        // daemon serves it. A new document is the only thing that can carry
        // one, which is why this reloads rather than changing the hash: the
        // data layer is chosen once, from the page, and a hash change would
        // leave the browser talking to its own in-memory demo with a real lab
        // running behind it. The daemon serves `/` with no step now that the
        // topology is settled, so the gate answers and the create-the-lab
        // screen wears the step-2 chrome itself.
        //
        // A lab ELSEWHERE started nothing and has nothing behind the gate to
        // resolve, so step 2 stays here and asks which lab.
        if (topology === "here") window.location.assign("/");
        else window.location.hash = "#/setup/2";
      })
      .catch((reason: unknown) => {
        // Said, not swallowed. This used to be deliberately silent because
        // step 2 did not exist yet and there was nowhere to carry a failure
        // to; both halves of that stopped being true, and what was left was a
        // Continue button that did nothing at all.
        //
        // The common cause is the one the researcher can least guess at. This
        // page is admitted by a nonce with three minutes on it, and the
        // request behind it is replaced when nobody answers in that time —
        // which is exactly what reading the question, thinking about it, and
        // going to make coffee looks like from the daemon. The cookie this
        // tab holds stops being recognised at that moment, and every button on
        // the page goes quiet. So the refusal names the way back rather than
        // reporting a status.
        setError(
          reason instanceof Error && reason.message.includes("403")
            ? "This page has been open too long and the daemon has replaced its request. Run `lykeion open` on this machine for a fresh link."
            : "This machine's daemon would not take that answer. It may have stopped — check the terminal it is running in.",
        );
      })
      .finally(() => setBusy(false));
  };

  return <WhereScreen onChose={chose} error={error} />;
}

export default SetupFlow;
