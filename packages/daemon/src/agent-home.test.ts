import { expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentHomeFor, foreignHomes, workspaceKey } from "./agent-home";

const home = homedir();
const WORKSPACE = "/work/studies/s_47/tasks/t_176";
const KEY = workspaceKey(WORKSPACE);
const claude = join(home, ".claude");

it("names a working directory the way the tools that key on it do", () => {
  expect(workspaceKey("/work/studies/s_47/tasks/t_176")).toBe(
    "-work-studies-s-47-tasks-t-176",
  );
  expect(workspaceKey("/a_b/c")).toBe("-a-b-c");
});

it("gives an agent the directory it keeps its own state in", () => {
  expect(agentHomeFor("claude", WORKSPACE).state).toContain(claude);
  expect(agentHomeFor("codex", WORKSPACE).state).toContain(join(home, ".codex"));
});

it("gives an agent the scratch directory its shell cannot run without", () => {
  // The shell tool creates a working directory of its own, under a root
  // shared by every run on this machine, named after the directory it was
  // started in. Without it every command fails before it runs.
  const state = agentHomeFor("claude", WORKSPACE).state;
  const scratch = state.find((path) => path.includes("/tmp/"));
  expect(scratch).toBe(`/tmp/claude-${process.getuid?.() ?? 0}/${KEY}`);
});

it("never grants the root that scratch directory sits in", () => {
  // One directory for every run on this machine, and for the researcher's own
  // sessions of the same program. This run gets its own and nobody else's.
  const state = agentHomeFor("claude", WORKSPACE).state;
  expect(state).not.toContain(`/tmp/claude-${process.getuid?.() ?? 0}`);
});

it("gives an agent this Task's record and denies it every other", () => {
  const declared = agentHomeFor("claude", WORKSPACE);
  expect(declared.state).toContain(join(claude, "projects", KEY));
  expect(declared.private).toContain(join(claude, "projects"));
});

it("keeps the researcher's other conversations out of a run entirely", () => {
  const declared = agentHomeFor("claude", WORKSPACE);
  expect(declared.private).toContain(join(claude, "history.jsonl"));
  expect(declared.private).toContain(join(claude, "todos"));
});

it("names the store an agent authenticates from, so a confined turn can be signed in", () => {
  expect(agentHomeFor("claude", WORKSPACE).credentials).toContain(
    join(home, "Library", "Keychains"),
  );
});

it("seals the entries an agent could otherwise leave code in", () => {
  const { sealed } = agentHomeFor("claude", WORKSPACE);
  for (const entry of ["settings.json", "settings.local.json", "hooks", "agents", "commands"])
    expect(sealed).toContain(join(claude, entry));
  expect(agentHomeFor("codex", WORKSPACE).sealed).toContain(join(home, ".codex", "config.toml"));
});

it("seals nothing outside the state it also grants, so a seal is never the only rule about a path", () => {
  for (const id of ["claude", "codex"]) {
    const { state, sealed } = agentHomeFor(id, WORKSPACE);
    for (const entry of sealed) expect(state.some((dir) => entry.startsWith(`${dir}/`))).toBe(true);
  }
});

it("gives an agent this machine knows nothing about no home at all", () => {
  expect(agentHomeFor("nothing-installed", WORKSPACE)).toEqual({
    state: [],
    credentials: [],
    sealed: [],
    private: [],
    patterns: [],
  });
});

it("names every other agent's installation, so one agent never reads another's credential", () => {
  expect(foreignHomes("claude", WORKSPACE)).toContain(join(home, ".codex"));
  expect(foreignHomes("codex", WORKSPACE)).toContain(claude);
  expect(foreignHomes("codex", WORKSPACE)).toContain(join(home, "Library", "Keychains"));
});

it("never denies an agent its own home while naming the others", () => {
  for (const id of ["claude", "codex"]) {
    const own = [...agentHomeFor(id, WORKSPACE).state, ...agentHomeFor(id, WORKSPACE).credentials];
    for (const foreign of foreignHomes(id, WORKSPACE)) expect(own).not.toContain(foreign);
  }
});

it("gives two Tasks on one machine different scratch and different records", () => {
  const one = agentHomeFor("claude", "/work/studies/s_1/tasks/t_1");
  const other = agentHomeFor("claude", "/work/studies/s_1/tasks/t_2");
  expect(one.state).not.toEqual(other.state);
});

it("lets an agent's shell tidy up after a command it already ran", () => {
  // The shell writes where it ended up into a scratch file with a fresh random
  // name and then removes it. No path to grant, only a shape — and without it
  // a command that worked is drawn as one that failed.
  const [pattern] = agentHomeFor("claude", WORKSPACE).patterns;
  expect(pattern).toBeDefined();
  expect(new RegExp(pattern!).test("/private/tmp/claude-9a9a-cwd")).toBe(true);
  // Only ever a file sitting directly in that directory.
  expect(new RegExp(pattern!).test("/private/tmp/claude-9a9a-cwd/escaped")).toBe(false);
  expect(new RegExp(pattern!).test("/private/tmp/claude-mcp-browser-bridge-cwd")).toBe(false);
  expect(new RegExp(pattern!).test("/private/tmp/claude-501")).toBe(false);
});
