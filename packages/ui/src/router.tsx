/**
 * Hand-rolled hash router — no react-router. Routes are a closed union;
 * `parseHash`/`routeHash` are pure (and unit-tested), the provider keeps
 * React state as the source of truth and mirrors it into `location.hash`
 * so deep links and back/forward work in a real browser.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { adoptRoute, navigate as navigateActive, useTabs } from "./lib/tabs";

export type Route =
  | { name: "researches" }
  | { name: "research"; researchId: string }
  | { name: "task"; researchId: string; taskId: string }
  | { name: "tasks" }
  /**
   * One unfiled Task — the same Task surface a filed one opens, addressed by
   * id alone. An unfiled Task has no Research, so there is no honest `:researchId`
   * to put under `#/researches/…`; the conversation itself is read by task id and
   * opens either way.
   */
  | { name: "unfiled-task"; taskId: string }
  | { name: "inbox" }
  | { name: "my-work" }
  | { name: "agents" }
  | { name: "agent"; agentId: string }
  | { name: "machines" }
  /**
   * Settings, optionally deep-linked to one of its nav tabs
   * (`#/settings/skills`). `tab` is absent for the default General tab, so
   * every reachable route round-trips through `routeHash`/`parseHash`.
   */
  | { name: "settings"; tab?: string }
  | { name: "my-tasks" }
  | { name: "groups" }
  | { name: "colleagues" }
  /**
   * A redeemable invite, addressed by its code. Reachable with nobody signed
   * in — `AuthGate` reads this route directly, ahead of the workbench,
   * because the person opening it does not have an account yet.
   */
  | { name: "join"; code: string }
  /**
   * A machine's pairing request, addressed the way the daemon printed it:
   * one query string on the hash rather than path segments, since the
   * daemon is composing a URL out of plain fields, not routing. Every field
   * is optional here because the hash comes from outside the app — a link
   * that has been hand-edited or truncated must still parse to *something*,
   * and the screen that reads `params` is the one place that decides
   * whether what arrived is enough to act on.
   */
  | { name: "pair"; params: PairParams }
  /**
   * The first run, addressed by which step it is on. Reachable with nobody
   * signed in, and read ahead of `AuthGate` for a stronger reason than
   * `join`'s: a machine whose lab does not exist yet has nobody to sign in
   * AS, so the gate has nothing it could resolve. The step is in the address
   * so that the trip out to a remote lab and back lands on the step that was
   * waiting rather than at the beginning.
   */
  | { name: "setup"; step: number };

/** The fields a pairing link carries, read off `#/pair?…`. Every one of
 *  them is optional at parse time — see the `pair` arm of `Route`. */
export interface PairParams {
  name?: string;
  platform?: string;
  version?: string;
  challenge?: string;
  state?: string;
  redirect?: string;
  /**
   * Which wizard step this approval is happening inside, when it is happening
   * inside one at all.
   *
   * A daemon composing the redirect for its own first run says so; a pairing
   * link somebody opens cold carries nothing. That is the whole difference
   * between a researcher who is mid-flow and a colleague approving a machine
   * from their own browser, and it is the only thing that can tell the two
   * apart — the approval screen is served by the lab, on a different origin,
   * and cannot ask the daemon anything.
   *
   * A string like every other value read off a hash, and validated where it is
   * used rather than here: this parser's job is to report what arrived.
   */
  step?: string;
}

const PAIR_PARAM_KEYS = [
  "name",
  "platform",
  "version",
  "challenge",
  "state",
  "redirect",
  "step",
] as const;

function parsePairParams(query: string): PairParams {
  const search = new URLSearchParams(query);
  const params: PairParams = {};
  for (const key of PAIR_PARAM_KEYS) {
    const value = search.get(key);
    if (value !== null) params[key] = value;
  }
  return params;
}

function pairQueryString(params: PairParams): string {
  const search = new URLSearchParams();
  for (const key of PAIR_PARAM_KEYS) {
    const value = params[key];
    if (value !== undefined) search.set(key, value);
  }
  return search.toString();
}

/** Parse a location hash into a Route. Unknown hashes fall back to Researches. */
export function parseHash(hash: string): Route {
  // Every other route lives entirely in path segments; `pair` is the one
  // whose parameters are a query string, so the split into path vs. query
  // happens before the path is cut into segments at all.
  const [path, query] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const [head, a, b, c] = parts;
  switch (head) {
    case undefined:
      return { name: "researches" };
    case "researches":
      if (a !== undefined && b === "tasks" && c !== undefined)
        return { name: "task", researchId: a, taskId: c };
      if (a !== undefined) return { name: "research", researchId: a };
      return { name: "researches" };
    // What these were addressed as while a Research was called a Study.
    // Parse-only: the mirror rewrites them to `#/researches/…`, so a bookmark
    // still lands and the address bar stops saying the old word when it does.
    case "studies":
      if (a !== undefined && b === "tasks" && c !== undefined)
        return { name: "task", researchId: a, taskId: c };
      if (a !== undefined) return { name: "research", researchId: a };
      return { name: "researches" };
    // `#/tasks/<id>` is an unfiled Task. A filed one keeps its Research-scoped
    // address under `#/researches/<research>/tasks/<id>`, parsed above.
    case "tasks":
      return a !== undefined
        ? { name: "unfiled-task", taskId: a }
        : { name: "tasks" };
    case "inbox":
      return { name: "inbox" };
    case "my-work":
      return { name: "my-work" };
    case "agents":
      if (a !== undefined)
        return { name: "agent", agentId: decodeURIComponent(a) };
      return { name: "agents" };
    case "machines":
      return { name: "machines" };
    // What this screen was addressed as for as long as it was called Runtimes.
    // Parse-only, like the three below: the mirror rewrites it to `#/machines`,
    // so a bookmark still lands and the address bar stops saying the old word
    // the moment it does.
    case "runtimes":
      return { name: "machines" };
    // Skills, Connectors and Usage live in Settings now. These three stay as
    // parse-only aliases so old links and bookmarks keep working; the
    // provider's state→URL mirror rewrites them to `#/settings/<tab>`.
    case "skills":
      return { name: "settings", tab: "skills" };
    case "connectors":
      return { name: "settings", tab: "connectors" };
    // Usage is the Profile tab now — the surface is the same one, so the old
    // hash lands on it rather than falling back to Researches.
    case "usage":
      return { name: "settings", tab: "profile" };
    case "settings":
      if (a === undefined) return { name: "settings" };
      // Members is not a Settings tab any more — it is the Colleagues surface.
      // Carried here rather than left to render the "nothing configured"
      // placeholder, which is a worse answer to a bookmark than the surface
      // that took the tab's job.
      if (a === "members") return { name: "colleagues" };
      // Preferences was renamed Appearance. The tab key is the URL, so the old
      // one is carried here rather than kept as a second key in the nav — an
      // unmapped key renders the "nothing configured" placeholder, which is a
      // worse answer to a bookmark than the tab it used to name.
      return { name: "settings", tab: a === "preferences" ? "appearance" : a };
    case "my-tasks":
      return { name: "my-tasks" };
    case "groups":
      return { name: "groups" };
    // What this screen was addressed as while it was called Research Groups.
    // Parse-only, like the aliases above: the mirror rewrites it to `#/groups`,
    // so a bookmark still lands and the address bar stops saying the old words
    // the moment it does.
    case "research-groups":
      return { name: "groups" };
    case "colleagues":
      return { name: "colleagues" };
    case "join":
      return a !== undefined ? { name: "join", code: a } : { name: "researches" };
    case "pair":
      return { name: "pair", params: parsePairParams(query ?? "") };
    case "setup": {
      // A step that is missing, not a number, or not a step this flow has
      // reads as the first one. The address comes from outside the app —
      // a redirect the daemon composed, or a link somebody kept — and
      // starting over is the one answer that is always safe to give.
      const step = Number(a);
      return { name: "setup", step: Number.isInteger(step) && step >= 1 ? step : 1 };
    }
    default:
      return { name: "researches" };
  }
}

/**
 * The canonical hash for a Route (usable as an anchor's `href`).
 *
 * Every arm is spelled out, including the ones whose hash is just their name.
 * A catch-all here answers a route carrying parameters with a hash that drops
 * them, and it typechecks while doing it: the screen would render from the
 * `Route` object while the address bar held something `parseHash` resolves
 * elsewhere, so a reload or a copied link lands somewhere else. Listing them
 * makes the compiler the thing that notices.
 */
export function routeHash(route: Route): string {
  switch (route.name) {
    case "researches":
      return "#/researches";
    case "research":
      return `#/researches/${route.researchId}`;
    case "task":
      return `#/researches/${route.researchId}/tasks/${route.taskId}`;
    case "tasks":
      return "#/tasks";
    case "unfiled-task":
      return `#/tasks/${route.taskId}`;
    case "inbox":
      return "#/inbox";
    case "my-work":
      return "#/my-work";
    case "agents":
      return "#/agents";
    case "agent":
      return `#/agents/${encodeURIComponent(route.agentId)}`;
    case "machines":
      return "#/machines";
    case "settings":
      return route.tab ? `#/settings/${route.tab}` : "#/settings";
    case "my-tasks":
      return "#/my-tasks";
    case "groups":
      return "#/groups";
    case "colleagues":
      return "#/colleagues";
    case "join":
      return `#/join/${route.code}`;
    case "pair": {
      const query = pairQueryString(route.params);
      return query ? `#/pair?${query}` : "#/pair";
    }
    case "setup":
      return `#/setup/${route.step}`;
  }
}

interface RouterValue {
  route: Route;
  navigate: (route: Route) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

/**
 * Routes that are not the workbench's to hold.
 *
 * `join` carries an invite code and `pair` a machine's challenge — working
 * credentials whose only copy is the fragment somebody was handed. `setup`
 * addresses a first run that has no lab yet. None of them is a place the
 * Shell can draw, so none may become a tab, and none of their fragments is
 * this router's to own or to wipe.
 */
export function handedLink(route: Route): boolean {
  return (
    route.name === "join" || route.name === "pair" || route.name === "setup"
  );
}

export function RouterProvider({ children }: { children: ReactNode }) {
  /**
   * Take the incoming address into the strip — during the first render of each
   * mount, before the store is read below.
   *
   * Three constraints meet here, and only this position satisfies all of them.
   *
   * Not an effect: the mirror effect further down runs in the same commit and
   * would `replaceState` the already-active tab's route over the incoming
   * address before the adopt landed, so a reload at that instant would lose the
   * link. Adopting during render means the snapshot `useTabs` reads immediately
   * below is already the adopted one, and the first paint is the right screen.
   *
   * Not one level up in `App`, though that render also precedes this one. On a
   * lab build this provider sits inside `AuthGate`'s children, unmounted while
   * the gate resolves or shows sign-in; when the gate opens it re-renders the
   * same `children` element, so `App`'s body does not run again and a link
   * pasted at the sign-in screen would be adopted by nobody. This provider
   * renders on every mount, which is exactly the moment that needs covering.
   *
   * And once per mount, not once per render: after the first commit the address
   * bar LAGS the store, because the mirror effect below writes it afterwards.
   * Re-reading it mid-life would adopt the route the reader just left and yank
   * them back to it. While this provider is mounted an external address change
   * arrives as `hashchange` instead, which `sync` handles.
   *
   * A handed link — `join`, `pair`, `setup` — is never adopted: none is a tab
   * this Shell can draw, each is read straight off the hash by whoever answers
   * it, and adopting one would hand `persistTabs` a working credential nothing
   * ever clears. An empty hash adopts nothing, which means "stay on whatever
   * tab was already active".
   */
  const adopted = useRef(false);
  if (!adopted.current) {
    adopted.current = true;
    const incoming = window.location.hash;
    if (incoming !== "") {
      const initial = parseHash(incoming);
      if (!handedLink(initial)) adoptRoute(initial);
    }
  }

  const tabs = useTabs();
  const activeTab =
    tabs.tabs.find((t) => t.id === tabs.activeId) ?? tabs.tabs[0];
  const tabRoute = activeTab.stack[activeTab.index].route;

  /**
   * `pair` is served by `Workbench` — inside this provider, outside the Shell —
   * so it is the one route that is not a tab. It arrives from a link the daemon
   * composed and is never navigated to from within the app.
   */
  const [standalone, setStandalone] = useState<Route | null>(() => {
    const initial = parseHash(window.location.hash);
    return initial.name === "pair" ? initial : null;
  });
  const route = standalone ?? tabRoute;

  /** The fragment this router is answerable for, or null when the one in the
   *  address bar belongs to somebody else. */
  const ownHash = useRef<string | null>(null);

  // External hash edits (URL bar, anchors) and the browser's own history.
  useEffect(() => {
    const sync = () => {
      const next = parseHash(window.location.hash);
      if (next.name === "pair") {
        setStandalone(next);
        return;
      }
      // `join` and `setup` reaching here the same way `pair` does — a
      // colleague's invite link, or a first-run redirect, pasted into an
      // already-open workbench — are handled the way a cold load handles
      // them: not at all. Neither is a tab `Shell` can draw, so pushing one
      // into the strip via `navigateActive` would hand `persistTabs` a
      // working credential nothing ever clears, and leave `ScreenSwitch`
      // with nothing to draw for it. Ignored outright, rather than routed
      // through `setStandalone(next)` the way `pair` is: `Workbench` only
      // reads `standalone` for `pair`, so parking either there would just
      // move the same blank-main-area failure one step over.
      //
      // Returning early also leaves `standalone` alone, so a reader already on
      // `#/pair?…` who is then handed a `#/join/…` address keeps the pairing
      // screen they were using while the address bar shows the invite. That is
      // not right either, but it is better than the alternatives available
      // here: clearing `standalone` would blank the main area, and drawing the
      // invite needs a screen the workbench does not have. Left as is,
      // deliberately, rather than papered over.
      if (handedLink(next)) return;
      setStandalone(null);
      navigateActive(next);
    };
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    // Once, now that the listeners are attached: adoption read the address
    // during render, and an address that changed between then and this commit's
    // effect phase — the post-sign-in landing redirect is the real candidate —
    // fired its `hashchange` into a window where nothing was listening yet, and
    // would then be overwritten by the mirror effect below. Re-reading here
    // costs nothing when the address has not moved: `navigateActive` no-ops on
    // the route the active tab is already showing.
    //
    // Only for an address that says something, though. An empty fragment is
    // "wherever you were", but `parseHash("")` answers with the Researches
    // fallback, so syncing on one would navigate the active tab there. That is
    // not hypothetical: the cleanup below wipes the fragment on unmount, and
    // StrictMode's mount/unmount/mount leaves the second mount reading exactly
    // that empty value — which sent two hand-off tests back to Researches
    // mid-flow.
    if (window.location.hash !== "") sync();
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
      // The app owns the fragment only while mounted — leave none behind, and
      // only its own. See the note on `ownHash` below for which fragments
      // that excludes and why.
      if (ownHash.current === null || window.location.hash !== ownHash.current)
        return;
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    };
  }, []);

  /**
   * Mirror the active tab into the URL — always `replaceState`.
   *
   * History belongs to the tabs now. A `pushState` here would build a second,
   * flat history alongside the per-tab stacks, and the browser's back button
   * would walk it through places the strip has no record of.
   */
  useEffect(() => {
    const hash = routeHash(route);
    // A `join` code and a `pair` challenge are working credentials whose only
    // copy is the fragment somebody was handed; a `setup` fragment was
    // composed outside this app, by a daemon or a redirect it sent someone on.
    // None of the three is this router's to own — claiming it as the fragment
    // to restore, or wiping it on the way out (see the cleanup above), would
    // treat somebody else's link as if it were a place the workbench put them.
    ownHash.current = handedLink(route) ? null : hash;
    if (window.location.hash !== hash)
      window.history.replaceState(null, "", hash);
  }, [route]);

  const navigate = useCallback((next: Route) => {
    // Only `pair` is `Workbench`'s to serve as the standalone route — the
    // same one `Workbench` reads off `route.name === "pair"`. `join` and
    // `setup` render nothing there, so parking either in `standalone` would
    // leave the main area blank while the mirror effect wrote a working
    // credential's hash out to the address bar. Nothing calls `navigate`
    // with either today; a silent no-op is the right outcome anyway, since
    // the Shell cannot draw them. See `handedLink`.
    if (next.name === "pair") {
      setStandalone(next);
      return;
    }
    if (handedLink(next)) return;
    setStandalone(null);
    navigateActive(next);
  }, []);
  const value = useMemo(() => ({ route, navigate }), [route, navigate]);

  return (
    <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
  );
}

export function useRouter(): RouterValue {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter() must be used inside <RouterProvider>");
  return ctx;
}

export function useRoute(): Route {
  return useRouter().route;
}
