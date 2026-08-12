import { expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installAgentHomes, sweepReplantedSkills } from "./agent-install";

function scratchRoot(): (agent: string) => string {
  const base = mkdtempSync(join(tmpdir(), "lykeion-install-"));
  return (agent: string) => join(base, agent);
}

it("creates a home for every declared agent and none for the rest", () => {
  const root = scratchRoot();
  const results = installAgentHomes(root);
  expect(results.map((r) => r.agent)).toEqual(["claude", "codex"]);
  for (const result of results) expect(existsSync(result.home)).toBe(true);
});

it("writes codex the whole of its configuration", () => {
  const root = scratchRoot();
  installAgentHomes(root);
  const config = readFileSync(join(root("codex"), "config.toml"), "utf8");
  expect(config).toContain("mcp_servers = {}");
  expect(config).toContain("plugins = false");
  expect(config).toContain("apps = false");
  expect(config).toContain("skill_search = false");
});

it("leaves an agent that seeds nothing without a config file to edit", () => {
  const root = scratchRoot();
  installAgentHomes(root);
  expect(existsSync(join(root("claude"), "config.toml"))).toBe(false);
});

it("overwrites an edit rather than trusting what it finds", () => {
  // A file written once can be edited to reintroduce a server, and the
  // isolation would look intact while no longer being it.
  const root = scratchRoot();
  installAgentHomes(root);
  const config = join(root("codex"), "config.toml");
  writeFileSync(config, '[mcp_servers.smuggled]\ncommand = "nc"\n');
  installAgentHomes(root);
  const rewritten = readFileSync(config, "utf8");
  expect(rewritten).not.toContain("smuggled");
  expect(rewritten).toContain("mcp_servers = {}");
});

it("reports an agent whose home cannot be written rather than throwing", () => {
  // Isolation that cannot be established is an agent that is not offered,
  // never an agent offered anyway.
  const results = installAgentHomes((agent) => join("/dev/null/not-a-directory", agent));
  expect(results.every((r) => r.ready)).toBe(false);
  expect(results[0]?.reason).toBeTruthy();
});

it("clears a replanted bundle that left no marker behind", () => {
  // Observed of Codex: its binary writes `skills/.system` back into
  // CODEX_HOME the first time it runs there, entirely apart from anything
  // this row seeded, and a conformance run found it surviving every
  // `[features]` toggle turned off. Written where such a bundle would sit
  // under any declared agent's home rather than naming codex, so the
  // assertion below holds for claude's home too — nothing there to clear is
  // nothing cleared.
  const root = scratchRoot();
  const codexSkills = join(root("codex"), "skills", ".system");
  mkdirSync(codexSkills, { recursive: true });
  writeFileSync(join(codexSkills, "skill-creator.md"), "planted before this ran");
  installAgentHomes(root);
  expect(existsSync(join(codexSkills, "skill-creator.md"))).toBe(false);
  // The seeded config itself is untouched by the same pass that cleared it.
  expect(readFileSync(join(root("codex"), "config.toml"), "utf8")).toContain("mcp_servers = {}");
});

it("keeps the marker a CLI's own binary already wrote, clearing only what came in beside it", () => {
  // Deleting the whole directory works on disk but cannot win on its own: a
  // CLI that replants at the start of every process it spawns undoes a sweep
  // that only runs once per daemon start before the very next session opens.
  // Keeping whatever the CLI itself already wrote as its own "already
  // planted" marker — a fact this machine only has to recognise the name of,
  // never the format of — is what lets that CLI's own check answer yes on
  // every session in between, not only the one right after a daemon start.
  const root = scratchRoot();
  const codexSkills = join(root("codex"), "skills", ".system");
  mkdirSync(codexSkills, { recursive: true });
  writeFileSync(join(codexSkills, "skill-creator.md"), "planted before this ran");
  writeFileSync(join(codexSkills, ".codex-system-skills.marker"), "whatever the CLI itself wrote");
  installAgentHomes(root);
  expect(existsSync(join(codexSkills, "skill-creator.md"))).toBe(false);
  expect(readFileSync(join(codexSkills, ".codex-system-skills.marker"), "utf8")).toBe(
    "whatever the CLI itself wrote",
  );
});

it("clears a bundle planted after the daemon already swept, without waiting for the next start", () => {
  // The case a daemon-start sweep cannot reach at all, and the one that
  // matters most: a home with no marker yet — this machine's very first time
  // running this CLI. The sweep at startup finds nothing; the first process
  // to run in that home plants the bundle (a probe cycle's own `login
  // status`, minutes before anybody opens a session) and writes its marker;
  // and nothing clears it until the daemon is restarted, so every session in
  // that run meets six skills. Asked again per session, it is cleared before
  // the session that would have met it.
  const root = scratchRoot();
  installAgentHomes(root);
  const codexSkills = join(root("codex"), "skills", ".system");
  mkdirSync(codexSkills, { recursive: true });
  writeFileSync(join(codexSkills, "skill-creator.md"), "planted since the daemon started");
  writeFileSync(join(codexSkills, ".codex-system-skills.marker"), "written by the CLI itself");
  sweepReplantedSkills("codex", root);
  expect(existsSync(join(codexSkills, "skill-creator.md"))).toBe(false);
  expect(readFileSync(join(codexSkills, ".codex-system-skills.marker"), "utf8")).toBe(
    "written by the CLI itself",
  );
});

it("asks nothing of a home with no such directory, which is the ordinary case", () => {
  // Run per session as well as per daemon start, so what it costs on a home
  // nothing was ever planted in is the whole of what it costs almost always:
  // one `existsSync` and a return. An id nobody declared reaches nothing
  // either, the same answer every other lookup on this machine gives it.
  const root = scratchRoot();
  expect(() => sweepReplantedSkills("claude", root)).not.toThrow();
  expect(() => sweepReplantedSkills("nobody-has-declared-this", root)).not.toThrow();
});
