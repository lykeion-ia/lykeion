import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node in the lower half of the supported range exposes `node:sqlite`
    // only behind this flag. It is set here rather than as a shell prefix on
    // the test script, because `VAR=value command` is POSIX syntax and the
    // package manager runs scripts through cmd.exe on Windows, where the
    // prefix form is a syntax error rather than an environment variable.
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--experimental-sqlite"] } },
  },
});
