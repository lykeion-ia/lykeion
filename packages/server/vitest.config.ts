import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Half the cores, not all of them. Vitest defaults to one worker per
     * core, which is right for a machine running one suite and wrong for
     * this one: several sessions share it, and each of them spawning a
     * full-width pool oversubscribes the box many times over. A run under
     * that load stops reporting on the code — it manufactures timeouts that
     * pass on a re-run. Half leaves room for whatever else is working.
     */
    maxWorkers: "50%",
    // Node in the lower half of the supported range exposes `node:sqlite`
    // only behind this flag. It is set here rather than as a shell prefix on
    // the test script, because `VAR=value command` is POSIX syntax and the
    // package manager runs scripts through cmd.exe on Windows, where the
    // prefix form is a syntax error rather than an environment variable.
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--experimental-sqlite"] } },
  },
});
