// @vitest-environment node
//
// The node environment, alone in this package: importing the Vite config
// pulls in esbuild, which asserts on a `TextEncoder` that returns a real
// `Uint8Array` and refuses to load under jsdom's. Nothing here touches a
// DOM, so there is nothing to give up by asking for the environment the
// config itself is loaded in.
import { expect, it } from "vitest";
import config from "../vite.config";

/**
 * The dev server's proxy table, held against the URLs the client actually
 * opens.
 *
 * `dev:lab` is the only arrangement where these are two servers: the page
 * comes from Vite and the lab answers beside it, so every path the client
 * calls has to be forwarded by name. Production has no proxy at all — the lab
 * server serves the page itself — which is exactly why a missing entry here
 * survives every other check. Nothing in the built app is wrong, no test that
 * drives the API over a real or in-memory transport is affected, and the gap
 * shows up only as a feature that does not work while somebody develops it.
 *
 * It has already cost one: `/runs/:id/events` was absent while `/rpc` and
 * `/events` were present, so a run started, persisted and reloaded correctly
 * while its turn rendered nothing at all. Vite answered the stream with the
 * SPA's own `index.html`, `EventSource` refused a body that was not
 * `text/event-stream`, and the handle detached without ever seeing a frame.
 */

/** Every path prefix `createFetchTransport` builds a URL under. Written out
 *  rather than derived, so that adding a route to the client and forgetting
 *  the proxy fails here instead of in somebody's browser. */
const CLIENT_PATHS = [
  { prefix: "/rpc", why: "every RPC method call" },
  { prefix: "/auth", why: "sign-in and sign-out" },
  { prefix: "/events", why: "the workspace change channel" },
  { prefix: "/runs", why: "one run's own event stream — the live turn" },
];

function proxyKeys(): string[] {
  const server = (config as { server?: { proxy?: Record<string, unknown> } }).server;
  return Object.keys(server?.proxy ?? {});
}

it.each(CLIENT_PATHS)(
  "forwards $prefix to the lab server, for $why",
  ({ prefix }) => {
    expect(proxyKeys()).toContain(prefix);
  },
);

it("sends nothing to the lab that the client does not ask it for", () => {
  // The other direction: a stale entry forwards a path the page now serves
  // itself, which fails as mysteriously as a missing one and reads as a
  // routing bug rather than as a leftover.
  const known = new Set(CLIENT_PATHS.map((p) => p.prefix));
  expect(proxyKeys().filter((key) => !known.has(key))).toEqual([]);
});
