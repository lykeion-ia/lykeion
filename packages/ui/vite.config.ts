import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), react()],

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/rpc": "http://127.0.0.1:1421",
      "/auth": "http://127.0.0.1:1421",
      // The daemon's three routes: it trades a pairing code for a token,
      // heartbeats, and asks what it may run. A daemon pointed at the dev
      // server rather than at the workspace server reaches them through here,
      // and without this entry the SPA fallback answers the exchange with
      // `index.html` — which the daemon reports as a 404 from the lab, on a
      // pairing the lab in fact approved.
      "/daemon": "http://127.0.0.1:1421",
      // The change channel streams, so it must not be buffered into one
      // response before the browser sees any of it.
      "/events": { target: "http://127.0.0.1:1421", ws: false, changeOrigin: false },
      // A run's own stream, on the same terms and for the same reason. Absent
      // here, this path alone fell through to the SPA fallback and answered a
      // turn's event stream with `index.html`: `EventSource` refuses a body
      // that is not `text/event-stream`, so the handle closed without a
      // single frame and a running turn drew nothing. Everything else about
      // the run was fine — it started, it persisted, and a reload showed the
      // whole conversation — which is what made it read as a rendering bug
      // rather than as a route that was never forwarded.
      "/runs": { target: "http://127.0.0.1:1421", ws: false, changeOrigin: false },
    },
  },
});
