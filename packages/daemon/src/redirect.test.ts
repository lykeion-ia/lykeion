import { afterEach, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { forgetRedirectProofs, provesRedirect } from "./redirect";
import { entryFor } from "./agent-registry";

afterEach(() => forgetRedirectProofs());

it("proves the redirect when a scratch home reads as signed out", async () => {
  // The whole experiment. A CLI pointed at an empty home cannot be signed in
  // there unless it is ignoring where it was pointed, so "not signed in" is
  // the positive result rather than a disappointment.
  const asked: Array<Record<string, string>> = [];
  const run = async (_c: string, _a: readonly string[], env: Record<string, string>) => {
    asked.push(env);
    return { stdout: '{"loggedIn":false}', stderr: "" };
  };
  const proof = await provesRedirect(entryFor("claude")!, "claude@1", run);
  expect(proof.proven).toBe(true);

  // Pointed at a home that is neither the researcher's nor ours. Ours may
  // legitimately be signed in, and asking against it would prove nothing.
  const home = asked[0]!.CLAUDE_CONFIG_DIR!;
  expect(home).not.toContain(join(homedir(), ".claude"));
  expect(home).not.toContain(".lykeion");
});

it("refuses the declaration when a scratch home still reads as signed in", async () => {
  // The failure this rung exists for. A signed-in answer from a home created
  // empty a moment ago means the variable was ignored and the CLI answered
  // from the researcher's own installation — which is exactly the isolation
  // failure a declaration written from documentation can introduce, and it
  // would otherwise be completely silent.
  const run = async () => ({ stdout: '{"loggedIn":true,"email":"r@lab.org"}', stderr: "" });
  const proof = await provesRedirect(entryFor("claude")!, "claude@1", run);
  expect(proof.proven).toBe(false);
  expect(proof.reason).toContain("CLAUDE_CONFIG_DIR");
});

it("asks each CLI against its own declared variable, not one name for all of them", async () => {
  // codex redirects with CODEX_HOME, claude with CLAUDE_CONFIG_DIR. Asking
  // the wrong one would set a variable the CLI ignores and read its real home
  // as the scratch one — the proof would pass while proving nothing.
  const asked: Array<Record<string, string>> = [];
  const run = async (_c: string, _a: readonly string[], env: Record<string, string>) => {
    asked.push(env);
    return { stdout: "", stderr: "Not logged in" };
  };
  await provesRedirect(entryFor("codex")!, "codex@1", run);
  expect(Object.keys(asked[0]!)).toEqual(["CODEX_HOME"]);
});

it("asks once per CLI build and not once per probe cycle", async () => {
  let calls = 0;
  const run = async () => {
    calls += 1;
    return { stdout: '{"loggedIn":false}', stderr: "" };
  };
  await provesRedirect(entryFor("claude")!, "claude@1", run);
  await provesRedirect(entryFor("claude")!, "claude@1", run);
  expect(calls).toBe(1);
  // A different build is a different question: an upgrade can move where a
  // CLI keeps things, and a proof cached across one would be a stale claim
  // about a program that no longer exists.
  await provesRedirect(entryFor("claude")!, "claude@2", run);
  expect(calls).toBe(2);
});

it("caches a refusal too, so a wrong declaration is not re-asked every cycle", async () => {
  let calls = 0;
  const run = async () => {
    calls += 1;
    return { stdout: '{"loggedIn":true}', stderr: "" };
  };
  expect((await provesRedirect(entryFor("claude")!, "claude@1", run)).proven).toBe(false);
  expect((await provesRedirect(entryFor("claude")!, "claude@1", run)).proven).toBe(false);
  expect(calls).toBe(1);
});

it("treats a CLI that could not answer as unproven rather than disproven", async () => {
  // A status command that throws has said nothing either way. Reporting it as
  // a failed redirect would take a working install off the page over one bad
  // moment; reporting it as proven would be inventing an answer.
  const run = async () => {
    throw new Error("spawn ENOENT");
  };
  const proof = await provesRedirect(entryFor("claude")!, "claude@1", run);
  expect(proof.proven).toBe(false);
  expect(proof.reason).toMatch(/did not answer/);
});

it("refuses to certify an isolation on output nobody could read", async () => {
  // The hole this closes. A row's status arguments are guessed from vendor
  // documentation the same way its `homeEnv` is. Get them wrong and the CLI
  // prints a usage error, the reader finds no "logged in", and a rung whose
  // entire job is catching a wrong declaration would rubber-stamp one —
  // having observed nothing whatsoever about where the CLI keeps its sign-in.
  const run = async () => ({ stdout: "error: unknown flag --json\nUsage: claude auth ...", stderr: "" });
  const proof = await provesRedirect(entryFor("claude")!, "claude@1", run);
  expect(proof.proven).toBe(false);
  expect(proof.reason).toMatch(/could not read/);
});

it("still proves the redirect on an answer the row genuinely understands", async () => {
  // The complement: a recognised "not signed in" is what proof looks like,
  // so the check above cannot have been bought by rejecting everything.
  const run = async () => ({ stdout: '{"loggedIn":false,"authMethod":"none"}', stderr: "" });
  expect((await provesRedirect(entryFor("claude")!, "claude@1", run)).proven).toBe(true);
});

it("reads codex's own refusal as an answer, not as noise", async () => {
  // codex says "Not logged in" on stderr and has no --json at all. That is a
  // recognised answer and must prove the redirect, or this rung would refuse
  // every CLI that does not speak JSON.
  const run = async () => ({ stdout: "", stderr: "Not logged in" });
  expect((await provesRedirect(entryFor("codex")!, "codex@1", run)).proven).toBe(true);
});

it("does not remember silence, so one bad moment cannot stand an install down", async () => {
  // The catch path is the one case that must NOT be cached. A real answer
  // cannot change without the program changing; a CLI that failed to answer
  // has said nothing, and remembering nothing as "unproven" would hold a
  // working install off the page until the daemon restarted.
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error("spawn ENOENT");
    return { stdout: '{"loggedIn":false}', stderr: "" };
  };
  expect((await provesRedirect(entryFor("claude")!, "claude@1", flaky)).proven).toBe(false);
  expect((await provesRedirect(entryFor("claude")!, "claude@1", flaky)).proven).toBe(true);
  expect(calls).toBe(2);
});

it("refuses an entry that declares no isolation at all, and says which entry", async () => {
  // The reason matters here, not only the verdict: without it this passes
  // just as happily with the guard deleted, because an undeclared entry would
  // fall through to the same catch-all `proven: false` for a different
  // reason entirely.
  const proof = await provesRedirect(entryFor("gemini")!, "gemini@1", async () => ({ stdout: "", stderr: "" }));
  expect(proof.proven).toBe(false);
  expect(proof.reason).toContain("Gemini");
  expect(proof.reason).toMatch(/declares no isolation/);
});

it("leaves no scratch home behind, on the failing paths as much as the passing one", async () => {
  // One per cycle per CLI, forever, is what a leak here would cost.
  const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("lykeion-redirect-")));
  await provesRedirect(entryFor("claude")!, "claude@ok", async () => ({ stdout: '{"loggedIn":false}', stderr: "" }));
  await provesRedirect(entryFor("claude")!, "claude@throws", async () => {
    throw new Error("spawn ENOENT");
  });
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith("lykeion-redirect-"));
  expect(after.filter((n) => !before.has(n))).toEqual([]);
});
