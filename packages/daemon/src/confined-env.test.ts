import { expect, it } from "vitest";
import { CONFINED_ENV_ALLOWLIST, confinedEnv } from "./confined-env";
import { CATALOGUE } from "./agent-registry";

const source = {
  PATH: "/usr/bin",
  HOME: "/Users/ana",
  LANG: "en_GB.UTF-8",
  HTTPS_PROXY: "http://proxy.example.edu:3128",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-secret",
  ANTHROPIC_API_KEY: "sk-ant-api-secret",
  AWS_SECRET_ACCESS_KEY: "not-an-agent-variable-but-still-not-ours",
  GITHUB_TOKEN: "ghp_secret",
};

it("passes through what a program needs to run at all", () => {
  const env = confinedEnv("claude", {}, source);
  expect(env.PATH).toBe("/usr/bin");
  expect(env.HOME).toBe("/Users/ana");
  expect(env.LANG).toBe("en_GB.UTF-8");
});

it("passes the proxy through, because a managed network has no other way", () => {
  expect(confinedEnv("claude", {}, source).HTTPS_PROXY).toBe("http://proxy.example.edu:3128");
});

it("drops every credential, named or not", () => {
  const env = confinedEnv("claude", {}, source);
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  // Never named anywhere in this codebase, and dropped anyway. That is the
  // whole difference between an allowlist and a denylist.
  expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  expect(env.GITHUB_TOKEN).toBeUndefined();
});

it("carries the row's own home variable", () => {
  const env = confinedEnv("claude", {}, source);
  expect(env.CLAUDE_CONFIG_DIR).toBeDefined();
});

it("carries what the call site set on purpose", () => {
  expect(confinedEnv("claude", { TMPDIR: "/work/task/tmp" }, source).TMPDIR).toBe("/work/task/tmp");
});

it("hands the agent our home even when the source names the researcher's", () => {
  // The isolation property itself, at the unit. A researcher who exports
  // `CLAUDE_CONFIG_DIR` in their shell profile and then starts the daemon
  // from that shell is the ordinary way this arrives, and the two session
  // tests that cover it have to spawn a real adapter to do so. This is the
  // same claim for the price of a function call, so a reordering inside
  // `confinedEnv` fails here first and in seconds.
  const poisoned = { ...source, CLAUDE_CONFIG_DIR: "/Users/ana/.claude" };
  expect(confinedEnv("claude", {}, poisoned).CLAUDE_CONFIG_DIR).not.toBe("/Users/ana/.claude");
  expect(confinedEnv("claude", {}, poisoned).CLAUDE_CONFIG_DIR).toContain(".lykeion");
});

it("lets the call site outrank the home it was given, which is why no call site may name one", () => {
  // Stated as a test because it is a hazard rather than a feature. `extra` is
  // applied last so a scratch `TMPDIR` wins, and that same precedence would
  // let a caller passing `CLAUDE_CONFIG_DIR` point a confined run at the
  // researcher's own installation — the exact thing this module exists to
  // prevent. Nothing reaches it today: the only callers passing anything are
  // `session.ts` with a fixed `TMPDIR`, and test files.
  //
  // Pinned rather than fixed, because `TMPDIR` genuinely must win and making
  // the home variable unconditionally last would be a wider change than this
  // task's. If a later task gives `extra` a caller that names a home
  // variable, this test is where that decision has to be made deliberately.
  expect(
    confinedEnv("claude", { CLAUDE_CONFIG_DIR: "/Users/ana/.claude" }, source).CLAUDE_CONFIG_DIR,
  ).toBe("/Users/ana/.claude");
});

it("gives an agent it does not recognise no home variable and no credentials", () => {
  const env = confinedEnv(undefined, {}, source);
  expect(env.PATH).toBe("/usr/bin");
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
});

it("never lets a declared ambient credential onto the allowlist", () => {
  // The declaration and the allowlist are two lists that must not intersect.
  // A row added later naming a variable this list happens to carry would be
  // a hole nobody looked for.
  for (const entry of CATALOGUE)
    for (const name of entry.isolation?.ambientAuthEnv ?? [])
      expect(CONFINED_ENV_ALLOWLIST).not.toContain(name);
});
