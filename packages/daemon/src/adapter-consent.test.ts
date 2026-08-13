import { afterEach, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptAdapter, acceptedAdapters, consentKey, consentPath, revokeAdapter } from "./adapter-consent";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-consent-"));
  dirs.push(dir);
  return dir;
}

it("remembers an adapter the researcher accepted", () => {
  const dir = stateDir();
  acceptAdapter(dir, "antigravity", "agy-acp");
  expect(acceptedAdapters(dir).has(consentKey("antigravity", "agy-acp"))).toBe(true);
});

it("scopes an acceptance to one agent", () => {
  // Accepting a program to run as one agent is not accepting it to run as
  // another: what the prompt discloses is which credential it can read, and
  // that is a different credential for each agent.
  const dir = stateDir();
  acceptAdapter(dir, "antigravity", "agy-acp");
  expect(acceptedAdapters(dir).has(consentKey("kiro", "agy-acp"))).toBe(false);
});

it("forgets one the researcher revoked, leaving the others", () => {
  const dir = stateDir();
  acceptAdapter(dir, "antigravity", "agy-acp");
  acceptAdapter(dir, "kiro", "kiro-acp");
  revokeAdapter(dir, "antigravity", "agy-acp");
  const accepted = acceptedAdapters(dir);
  expect(accepted.has(consentKey("antigravity", "agy-acp"))).toBe(false);
  expect(accepted.has(consentKey("kiro", "kiro-acp"))).toBe(true);
});

it("reads a machine that has accepted nothing as having accepted nothing", () => {
  // Not an error. Every daemon starts here, and a missing file that threw
  // would take the whole probe cycle down on a fresh install.
  expect(acceptedAdapters(stateDir()).size).toBe(0);
});

it("treats a consent file that will not parse as an empty one", () => {
  // The opposite of `readState`'s rule, deliberately. A pairing token that
  // will not parse must stop the daemon rather than be silently replaced;
  // garbage here means at worst that a researcher is asked again, and
  // throwing would strand a machine on a file nobody can fix from the UI.
  const dir = stateDir();
  writeFileSync(join(dir, "adapter-consent.json"), "{not json");
  expect(acceptedAdapters(dir).size).toBe(0);
});

it("writes the consent file readable by this account alone", () => {
  const dir = stateDir();
  acceptAdapter(dir, "antigravity", "agy-acp");
  expect(statSync(consentPath(dir)).mode & 0o777).toBe(0o600);
});

it("puts the mode back when the file it overwrites was left wide open", () => {
  // `writeFileSync`'s own `mode` is honoured only while a file is being
  // created, so a write onto an existing file inherits whatever that file
  // already had. This is exactly what dropping the `chmodSync` would look
  // like, and why removing it as redundant would be wrong.
  const dir = stateDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(consentPath(dir), "[]", { mode: 0o644 });
  chmodSync(consentPath(dir), 0o644);
  acceptAdapter(dir, "antigravity", "agy-acp");
  expect(statSync(consentPath(dir)).mode & 0o777).toBe(0o600);
});

it("holds the mode through a revoke as well as an accept", () => {
  // Both writers go through the same `write()`, so both carry the same
  // guarantee — asserted rather than assumed, because a later refactor could
  // easily give one of them its own path.
  const dir = stateDir();
  acceptAdapter(dir, "antigravity", "agy-acp");
  chmodSync(consentPath(dir), 0o644);
  revokeAdapter(dir, "antigravity", "agy-acp");
  expect(statSync(consentPath(dir)).mode & 0o777).toBe(0o600);
});
