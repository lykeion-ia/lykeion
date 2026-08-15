// @vitest-environment node
//
// The node environment, alone in this package: importing the Vite config
// pulls in esbuild, which asserts on a `TextEncoder` that returns a real
// `Uint8Array` and refuses to load under jsdom's. Nothing here touches a
// DOM, so there is nothing to give up by asking for the environment the
// config itself is loaded in.
import { expect, it } from "vitest";
import { FORWARDED_PREFIXES } from "@lykeion/api/routes";
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
 *
 * Which paths those are is not decided here: `FORWARDED_PREFIXES` is the one
 * register, and the daemon's front door reads the same one. This file is where
 * the dev server is held to it, in both directions.
 *
 * Note that the register carries routes no browser ever opens. A daemon is
 * told a lab address and calls it directly, and in `dev:lab` the address a
 * developer has to hand is the dev server's — so "the client does not ask for
 * it" is not grounds to take one out. `/daemon` came to be missing for exactly
 * that reason, and pairing failed with `the lab answered pairing with status
 * 404` — the SPA fallback answering the token exchange with `index.html` — on
 * a pairing the lab had in fact approved.
 */

function proxyTable(): Record<string, unknown> {
  const server = (config as { server?: { proxy?: Record<string, unknown> } }).server;
  return server?.proxy ?? {};
}

function proxyKeys(): string[] {
  return Object.keys(proxyTable());
}

it("forwards every path something behind this server actually opens", () => {
  const keys = proxyKeys();
  for (const { prefix, why } of FORWARDED_PREFIXES)
    expect(keys, `${prefix} — ${why}`).toContain(prefix);
});

it("sends nothing to the lab that nothing on this machine asks it for", () => {
  // The other direction: a stale entry forwards a path the page now serves
  // itself, which fails as mysteriously as a missing one and reads as a
  // routing bug rather than as a leftover. Both directions are checked here
  // against the same register, which is the whole reason there is only one.
  const known = new Set(FORWARDED_PREFIXES.map((p) => p.prefix));
  expect(proxyKeys().filter((key) => !known.has(key))).toEqual([]);
});

/**
 * What `Host` each prefix arrives at the lab with, as it was before the proxy
 * table was derived from one list.
 *
 * Vite reads a plain-string entry as `{ target, changeOrigin: true }`, so the
 * three prefixes once written as bare strings rewrite `Host` to the lab's and
 * the two written out in full do not. Pinned here rather than left to the
 * config because the lab reads no `Host` today: flipping one of these breaks
 * nothing that any test or any developer would notice, right up until
 * something does read it, and by then nobody chose the value it has.
 */
const CHANGES_HOST_TO_THE_LAB: Record<string, boolean> = {
  "/rpc": true,
  "/auth": true,
  "/daemon": true,
  "/events": false,
  "/runs": false,
};

it("reaches the lab with the Host header each prefix already used", () => {
  const table = proxyTable();
  for (const [prefix, changeOrigin] of Object.entries(CHANGES_HOST_TO_THE_LAB))
    expect(table[prefix], prefix).toMatchObject({ changeOrigin });
});
