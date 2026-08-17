import { useCallback, useEffect, useMemo, useState } from "react";
import { Agentation } from "agentation";
import type { LykeionApi, Transport } from "@lykeion/api";
import { ApiProvider } from "./api/ApiContext";
import { hasWorkspaceServer, selectApi } from "./api/select";
import { useChangeChannel } from "./hooks/useChangeChannel";
import { hasDestination, landingHash } from "./lib/landing";
import { restoreTabsOnce } from "./lib/tabs-storage";
import { AuthGate } from "./shell/AuthGate";
import { parseHash, RouterProvider, useRoute } from "./router";
import { drawsSetupStep, SetupFlow } from "./screens/setup/SetupFlow";
import { ThemeProvider } from "./theme/ThemeContext";
import { Shell } from "./shell/Shell";
import { PairScreen } from "./screens/PairScreen";
import "./styles/app.css";

/** Wires the change channel from inside `<ApiProvider>`, where
 *  `useInvalidateData` resolves. `App` itself sits above that provider, so
 *  the hook cannot be called there directly. Renders nothing. */
function ChangeChannel({ transport }: { transport: Transport | undefined }) {
  useChangeChannel(transport);
  return null;
}

/**
 * The setup step off the current hash, or `null` off any other route and off
 * a step this build does not draw yet.
 *
 * Read from the hash rather than from the router for the same reason
 * `AuthGate` reads it that way: setup renders ABOVE the gate, which is above
 * `RouterProvider`, so there is no router context to ask. `parseHash` is
 * still the one function that decides what a hash means.
 */
function setupStepFromHash(): number | null {
  const route = parseHash(window.location.hash);
  return route.name === "setup" && drawsSetupStep(route.step) ? route.step : null;
}

/**
 * The step the daemon served this page FOR, read off the mark it put on the
 * document.
 *
 * A daemon hands this application out at two moments that carry a step with
 * them and no hash to say so: the link it prints, which opens the first run,
 * and the callback a lab redirects to after approving this machine, which
 * lands on the step that was waiting. Both are a plain page load at `/` or
 * `/paired` — the step cannot be in the address, because the address is what
 * the daemon was reached at.
 *
 * So it rides on the document instead, and `adoptServedStep` below promotes it
 * into the address exactly once. Everything after that is ordinary hash
 * routing, which is what makes leaving the flow — clearing the hash — mean
 * something.
 */
function servedSetupStep(): number | null {
  const marked = Number(document.documentElement.dataset.setupStep);
  return Number.isInteger(marked) && drawsSetupStep(marked) ? marked : null;
}

/**
 * Which step this page opens on, taking the mark into the address if that is
 * where it came from.
 *
 * The hash wins when it names a step: a researcher who navigated inside the
 * flow, or came back to a link they kept, has said something more specific
 * than the page they were served.
 *
 * `replaceState` rather than assigning the hash, because this runs while the
 * first state is being computed — the value is returned directly, and firing a
 * `hashchange` to tell the listener what it is about to be told anyway would
 * only race it. The mark is deliberately NOT cleared afterwards: React
 * double-invokes a state initializer under StrictMode, and a mark consumed on
 * the first invocation would leave the second answering `null` and the whole
 * flow skipped.
 */
function adoptServedStep(): number | null {
  const fromHash = setupStepFromHash();
  if (fromHash !== null) return fromHash;
  // Any address at all wins, not just one naming a step. A daemon that has
  // paired serves its page marked step 3, and that same origin is where a
  // researcher lands when the lab redirects them to `#/pair?…` to approve
  // another machine — so a mark that only deferred to setup hashes would
  // throw away the pairing request and show the agents step instead.
  if (hasDestination(window.location.hash)) return null;
  const served = servedSetupStep();
  if (served !== null) window.history.replaceState(null, "", `#/setup/${served}`);
  return served;
}

/**
 * What fills the app below the auth gate: the workbench, or — for a
 * pairing link — the approval screen in place of it. `pair` is reached the
 * same way `join` is, by a link nobody navigates to from inside the app,
 * but `join` is a doorway for someone with no account yet and belongs
 * above the gate; a pairing link assumes a signed-in browser, so the
 * distinction is made here, once identity is already settled, rather than
 * inside `Shell`'s own route switch.
 */
function Workbench() {
  const route = useRoute();
  if (route.name === "pair") return <PairScreen params={route.params} />;
  return <Shell />;
}

/**
 * The Lykeion shell: a dark, dense, keyboard-first workbench.
 *
 * The data layer is injected, so tests can supply their own; left unset it is
 * built by `selectApi`. Against a workspace server, `AuthGate` sits in front
 * of it — the shell has nothing to show until the server has named whoever
 * opened it.
 */
export default function App({ api }: { api?: LykeionApi }) {
  const [identityGeneration, setIdentityGeneration] = useState(0);
  // One trigger for both directions an identity can change: somebody signed
  // in, or the server now says nobody is (an explicit sign-out, or a
  // session that lapsed mid-visit). Either way the API layer and every
  // screen under it need to read again rather than keep answering as
  // whoever they last resolved to be.
  const identityChanged = useCallback(() => setIdentityGeneration((n) => n + 1), []);
  // An injected `api` (tests) has no transport of its own — nothing for the
  // change channel to subscribe to.
  const resolved = useMemo(
    () => (api ? { api, transport: undefined } : selectApi(identityChanged)),
    [api, identityChanged],
  );
  const currentUser = useCallback(() => resolved.api.currentUser(), [resolved]);

  // Setup moves between its own steps by changing the hash, and nothing else
  // in this component would notice — the same reason `AuthGate` listens for a
  // join code appearing.
  const [setupStep, setSetupStep] = useState<number | null>(adoptServedStep);
  useEffect(() => {
    const sync = () => setSetupStep(setupStepFromHash());
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  // Signing in is the one moment the landing rule applies. Held here rather
  // than in the gate because it is the only place that has both the API to
  // ask with and a single callback fired exactly once per sign-in — and
  // because a rule expressed as routing instead would be unable to tell
  // `#/studies` typed by the router's default apart from `#/studies` clicked
  // in the rail, and would bounce anyone who went there on purpose.
  const signedIn = useCallback(() => {
    identityChanged();
    if (hasDestination(window.location.hash)) return;
    void landingHash(resolved.api).then((hash) => {
      // Checked again on the way back: the answer took a round trip, and a
      // member who navigated while it was in flight has since chosen.
      if (hash !== null && !hasDestination(window.location.hash))
        window.location.hash = hash;
    });
  }, [identityChanged, resolved]);

  // Read the stored strip here, in the render body, and exactly once per page.
  //
  // Not an effect: effects run child-first, so an effect here would land AFTER
  // `RouterProvider`'s own first render — which would already have painted, and
  // mirrored into the address bar, whatever tab the restore had not yet put
  // there. Running it during this render is before `RouterProvider` renders at
  // all and before anything has subscribed to the store, so mutating the store
  // from here is safe.
  //
  // Adopting the incoming hash is the other half of that ordering, and it
  // deliberately does NOT live here — it lives in `RouterProvider`'s render
  // body, which runs immediately after this one and, unlike this one, runs on
  // every mount of the workbench. See the note there.
  restoreTabsOnce();

  const shell = (
    <ApiProvider api={resolved.api} key={identityGeneration}>
      <ChangeChannel transport={resolved.transport} />
      <ThemeProvider>
        <RouterProvider>
          <Workbench />
        </RouterProvider>
      </ThemeProvider>
      {/* The annotation toolbar, in every build a browser is served — a lab
          running from the workspace server is reviewed the same way the dev
          server is. Still absent under vitest, whose jsdom lacks the browser
          globals and timers it needs. */}
      {import.meta.env.MODE !== "test" && <Agentation />}
    </ApiProvider>
  );

  // First of all, and above BOTH the gate and the demo check.
  //
  // Above the gate because a machine whose lab does not exist yet has nobody
  // to sign in AS — the gate would be resolving an identity against a lab
  // nobody has created, and setup is what creates it.
  //
  // Above the demo check because a first run looks exactly like demo mode from
  // here and is the opposite of it: a daemon serving this page before a lab
  // exists forwards nothing, so the page finds no workspace marker and would
  // fall through to the in-browser demo — on the one machine where a real lab
  // is one answer away. Setup talks to the daemon's own routes, never to a
  // lab, so it needs no data layer at all to run.
  if (setupStep !== null) return <SetupFlow step={setupStep} />;
  // Demo mode has nobody to sign in, so it is not gated: the gate exists to
  // resolve a lab member, and there is no lab.
  if (api || !hasWorkspaceServer()) return shell;
  return (
    <AuthGate
      currentUser={currentUser}
      onSignedIn={signedIn}
      onSignedOut={identityChanged}
      // The same counter that remounts the data layer also tells the gate to
      // ask again. Nothing else can: `currentUser` closes over an API object
      // built once for the app's whole life, so a session that lapses after
      // the first resolve leaves that function looking unchanged.
      revision={identityGeneration}
    >
      {shell}
    </AuthGate>
  );
}
