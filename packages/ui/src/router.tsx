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

export type Route =
  | { name: "studies" }
  | { name: "study"; studyId: string }
  | { name: "task"; studyId: string; taskId: string }
  | { name: "tasks" }
  /**
   * One unfiled Task — the same Task surface a filed one opens, addressed by
   * id alone. An unfiled Task has no Study, so there is no honest `:studyId`
   * to put under `#/studies/…`; the conversation itself is read by task id and
   * opens either way.
   */
  | { name: "unfiled-task"; taskId: string }
  | { name: "inbox" }
  | { name: "my-work" }
  | { name: "agents" }
  | { name: "agent"; agentId: string }
  | { name: "workflows" }
  | { name: "workflow"; workflowId: string }
  | { name: "machines" }
  /**
   * Settings, optionally deep-linked to one of its nav tabs
   * (`#/settings/skills`). `tab` is absent for the default General tab, so
   * every reachable route round-trips through `routeHash`/`parseHash`.
   */
  | { name: "settings"; tab?: string }
  | { name: "my-tasks" }
  | { name: "research-groups" }
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

/** Parse a location hash into a Route. Unknown hashes fall back to Studies. */
export function parseHash(hash: string): Route {
  // Every other route lives entirely in path segments; `pair` is the one
  // whose parameters are a query string, so the split into path vs. query
  // happens before the path is cut into segments at all.
  const [path, query] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const [head, a, b, c] = parts;
  switch (head) {
    case undefined:
      return { name: "studies" };
    case "studies":
      if (a !== undefined && b === "tasks" && c !== undefined)
        return { name: "task", studyId: a, taskId: c };
      if (a !== undefined) return { name: "study", studyId: a };
      return { name: "studies" };
    // `#/tasks/<id>` is an unfiled Task. A filed one keeps its Study-scoped
    // address under `#/studies/<study>/tasks/<id>`, parsed above.
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
    case "workflows":
      if (a !== undefined)
        return { name: "workflow", workflowId: decodeURIComponent(a) };
      return { name: "workflows" };
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
    // hash lands on it rather than falling back to Studies.
    case "usage":
      return { name: "settings", tab: "profile" };
    case "settings":
      if (a === undefined) return { name: "settings" };
      // Preferences was renamed Appearance. The tab key is the URL, so the old
      // one is carried here rather than kept as a second key in the nav — an
      // unmapped key renders the "nothing configured" placeholder, which is a
      // worse answer to a bookmark than the tab it used to name.
      return { name: "settings", tab: a === "preferences" ? "appearance" : a };
    case "my-tasks":
      return { name: "my-tasks" };
    case "research-groups":
      return { name: "research-groups" };
    case "join":
      return a !== undefined ? { name: "join", code: a } : { name: "studies" };
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
      return { name: "studies" };
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
    case "studies":
      return "#/studies";
    case "study":
      return `#/studies/${route.studyId}`;
    case "task":
      return `#/studies/${route.studyId}/tasks/${route.taskId}`;
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
    case "workflows":
      return "#/workflows";
    case "workflow":
      return `#/workflows/${encodeURIComponent(route.workflowId)}`;
    case "machines":
      return "#/machines";
    case "settings":
      return route.tab ? `#/settings/${route.tab}` : "#/settings";
    case "my-tasks":
      return "#/my-tasks";
    case "research-groups":
      return "#/research-groups";
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

export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(window.location.hash),
  );
  const firstSync = useRef(true);
  /** The fragment this router is answerable for, or null when the one in the
   *  address bar belongs to somebody else. */
  const ownHash = useRef<string | null>(null);

  // External hash edits (URL bar, anchors) and back/forward.
  useEffect(() => {
    const sync = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("hashchange", sync);
      window.removeEventListener("popstate", sync);
      // The app owns the fragment only while mounted — leave none behind.
      //
      // Only its own, though. Unmounting is how the workbench gives way when
      // the session behind it turns out to be gone, and what replaces it may
      // be reading a fragment this router never owned: an invite link most
      // of all, which is a working credential and the only copy of it the
      // person has. Wiping that on the way out throws it away.
      if (ownHash.current === null || window.location.hash !== ownHash.current) return;
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    };
  }, []);

  // Mirror state into the URL: replace on first sync, push afterwards.
  useEffect(() => {
    const hash = routeHash(route);
    // `join` and `pair` are both links somebody was handed rather than
    // somewhere this router ever sent them by its own navigation: `join`'s
    // code redeems an invite, `pair`'s parameters are the one copy of a
    // machine's pairing request. Owning either fragment would mean wiping
    // it out from under a screen that unmounted for an unrelated reason —
    // a session found to be gone mid-visit — leaving nothing to come back
    // to once that reason resolves.
    ownHash.current = route.name === "join" || route.name === "pair" ? null : hash;
    if (window.location.hash !== hash) {
      if (firstSync.current) window.history.replaceState(null, "", hash);
      else window.history.pushState(null, "", hash);
    }
    firstSync.current = false;
  }, [route]);

  const navigate = useCallback((next: Route) => setRoute(next), []);
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
