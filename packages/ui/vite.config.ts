import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { FORWARDED_PREFIXES } from "@lykeion/api/routes";

/** The lab that `dev:lab` expects to find running beside this server. */
const LAB = "http://127.0.0.1:1421";

/**
 * The two prefixes that reach the lab carrying the browser's own `Host` header
 * rather than the lab's.
 *
 * Not a choice made here — a difference inherited, and kept deliberately. Vite
 * reads a plain-string proxy entry as `{ target, changeOrigin: true }`, so
 * before this table was derived from one list, the three prefixes written as
 * bare strings rewrote `Host` to `127.0.0.1:1421` and these two, written out in
 * full with `changeOrigin: false`, passed `localhost:1420` through untouched.
 *
 * Nothing in the lab server reads `Host` today, so flattening the difference
 * would break nothing — which is exactly why it must not be flattened by
 * accident. Unifying the *list* of forwarded prefixes is not a licence to
 * change what forwarding one does, and the daemon's front door starts proxying
 * to this same lab next, so whatever it inherits should be what was already
 * true rather than something a refactor decided on nobody's behalf.
 */
const KEEPS_THE_BROWSERS_HOST = new Set(["/events", "/runs"]);

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react()],

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Read off the register rather than listed here, because the daemon's
    // front door forwards the same paths and two hand-kept lists drift. Which
    // prefixes these are, and what each one is for, is written where the
    // register is; a prefix added there reaches this table for free.
    //
    // One shape for all of them, but not one set of options: `changeOrigin`
    // reproduces per prefix what each already ran with, for the reason given
    // above. `ws: false` is the only genuine restatement — an unset `ws` is
    // falsy either way — and it is written out because none of these are
    // websockets and two of them stream, which is the pair of facts somebody
    // reaching for `ws: true` here would need.
    proxy: Object.fromEntries(
      FORWARDED_PREFIXES.map(({ prefix }) => [
        prefix,
        {
          target: LAB,
          ws: false,
          changeOrigin: !KEEPS_THE_BROWSERS_HOST.has(prefix),
        },
      ]),
    ),
  },
});
