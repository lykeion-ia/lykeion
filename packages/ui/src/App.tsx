import { useCallback, useMemo, useState } from "react";
import { Agentation } from "agentation";
import type { LykeionApi, Transport } from "@lykeion/api";
import { ApiProvider } from "./api/ApiContext";
import { hasWorkspaceServer, selectApi } from "./api/select";
import { useChangeChannel } from "./hooks/useChangeChannel";
import { AuthGate } from "./shell/AuthGate";
import { RouterProvider, useRoute } from "./router";
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

  const shell = (
    <ApiProvider api={resolved.api} key={identityGeneration}>
      <ChangeChannel transport={resolved.transport} />
      <ThemeProvider>
        <RouterProvider>
          <Workbench />
        </RouterProvider>
      </ThemeProvider>
      {/* Dev-only annotation toolbar; stripped from prod builds and not
          mounted under vitest, whose jsdom lacks the browser globals and
          timers it needs. */}
      {import.meta.env.DEV && import.meta.env.MODE !== "test" && <Agentation />}
    </ApiProvider>
  );

  // Demo mode has nobody to sign in, so it is not gated: the gate exists to
  // resolve a lab member, and there is no lab.
  if (api || !hasWorkspaceServer()) return shell;
  return (
    <AuthGate
      currentUser={currentUser}
      onSignedIn={identityChanged}
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
