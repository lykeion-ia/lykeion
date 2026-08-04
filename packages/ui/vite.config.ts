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
      // The change channel streams, so it must not be buffered into one
      // response before the browser sees any of it.
      "/events": { target: "http://127.0.0.1:1421", ws: false, changeOrigin: false },
    },
  },
});
