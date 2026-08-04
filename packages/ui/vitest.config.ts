import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: true,
    /**
     * The run-simulation suites drive a turn through plan, approval,
     * permission and completion, each step waiting on a timer. On an idle
     * machine that lands around a second; on a loaded one it can pass five,
     * and the default budget then reports a timeout that says nothing about
     * the code under test. A passing test still finishes when it finishes,
     * so the higher ceiling costs a green run nothing — it only stops a busy
     * machine from manufacturing failures that have to be re-run to read.
     */
    testTimeout: 20000,
  },
});
