import {
  createFetchTransport,
  createHttpApi,
  createInMemoryApi,
  defaultSeed,
  emptySeed,
  type LykeionApi,
  type Transport,
} from "@lykeion/api";

/**
 * Whether a real lab is behind this page. Two sources, both declared rather
 * than discovered: the server stamps the document it serves, and the dev
 * server is started with the flag when it is proxying to one. Probing for a
 * server would make the answer depend on a network round trip that can fail
 * for reasons unrelated to whether one exists.
 */
export function hasWorkspaceServer(): boolean {
  if (import.meta.env.VITE_LYKEION_WORKSPACE === "1") return true;
  return (
    typeof document !== "undefined" &&
    document.querySelector('meta[name="lykeion-workspace"]') !== null
  );
}

/**
 * Build the data layer for this session.
 *
 * Against a workspace server every screen reads and writes the lab's real
 * records, and `transport` is the same connection the change channel
 * subscribes on. With no server the app runs entirely in the browser on
 * seeded data that lives for the session — which is why that mode says so
 * on screen rather than looking like the real thing, and `transport` is
 * `undefined`: there is no server for anything to reach.
 */
export function selectApi(onUnauthenticated?: () => void): {
  api: LykeionApi;
  transport: Transport | undefined;
} {
  if (hasWorkspaceServer()) {
    const transport = createFetchTransport({ onUnauthenticated });
    return { api: createHttpApi(transport), transport };
  }
  const empty =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("seed") === "empty";
  // A real clock: what a researcher creates or edits must stamp as the
  // moment it happened, not as the seed data's fixture date and not as
  // whenever the tab was opened.
  const api = createInMemoryApi(empty ? emptySeed() : defaultSeed(), {
    now: () => Date.now() / 1000,
  });
  return { api, transport: undefined };
}
