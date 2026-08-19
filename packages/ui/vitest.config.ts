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
     * Half the cores, not all of them. Vitest defaults to one worker per
     * core, which is right for a machine running one suite and wrong for
     * this one: several sessions share it, and each of them spawning a
     * full-width pool oversubscribes the box many times over. A run under
     * that load stops reporting on the code — timers slip past even the
     * raised ceiling below and manufacture failures that pass on a re-run.
     * Half leaves room for whatever else is working.
     */
    maxWorkers: "50%",
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
