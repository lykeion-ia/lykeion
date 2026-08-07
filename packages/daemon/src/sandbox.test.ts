import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boundaryOf,
  canonicalPath,
  confine,
  covers,
  deniedPaths,
  NO_AGENT_HOME,
  renderSeatbeltProfile,
  sandboxBackendFor,
  type SandboxPolicy,
} from "./sandbox";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-sandbox-"));
  dirs.push(dir);
  return canonicalPath(dir);
}

const policy = (over: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  workspace: "/work/task",
  grants: [],
  denied: [],
  home: NO_AGENT_HOME,
  ...over,
});

it("opens with a default that denies, so nothing is allowed by omission", () => {
  const profile = renderSeatbeltProfile(policy());
  expect(profile.startsWith("(version 1)\n(deny default)")).toBe(true);
});

it("grants the baseline without which no child starts at all", () => {
  const profile = renderSeatbeltProfile(policy());
  for (const rule of [
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow file-read-metadata)",
    "(allow mach-lookup)",
  ])
    expect(profile).toContain(rule);
});

it("gives the workspace read and write, and names that one directory only", () => {
  const profile = renderSeatbeltProfile(policy({ workspace: "/work/tasks/t_1" }));
  expect(profile).toContain('(allow file-read* file-write* (subpath "/work/tasks/t_1"))');
  expect(profile).not.toContain('(subpath "/work/tasks")');
});

it("gives a read grant read and a write grant both", () => {
  const profile = renderSeatbeltProfile(
    policy({
      grants: [
        { path: "/data/reference", mode: "read" },
        { path: "/data/scratch", mode: "write" },
      ],
    }),
  );
  expect(profile).toContain('(allow file-read* (subpath "/data/reference"))');
  expect(profile).toContain('(allow file-read* file-write* (subpath "/data/scratch"))');
});

it("puts a deny after an allow on its own ancestor, so the deny is what matches", () => {
  const profile = renderSeatbeltProfile(
    policy({
      grants: [{ path: "/data/work", mode: "write" }],
      denied: ["/data/work/.ssh"],
    }),
  );
  const allow = profile.indexOf('(subpath "/data/work")');
  const deny = profile.indexOf('(subpath "/data/work/.ssh")');
  expect(allow).toBeGreaterThan(-1);
  expect(deny).toBeGreaterThan(allow);
  expect(profile).toContain('(deny file-read* file-write* (subpath "/data/work/.ssh"))');
});

it("orders allows shallow to deep", () => {
  const profile = renderSeatbeltProfile(
    policy({
      workspace: "/work/t",
      grants: [
        { path: "/data/a/b/c", mode: "read" },
        { path: "/data/a", mode: "read" },
      ],
    }),
  );
  expect(profile.indexOf('"/data/a"')).toBeLessThan(profile.indexOf('"/data/a/b/c"'));
});

it("escapes a quote in a path rather than ending the rule early", () => {
  const profile = renderSeatbeltProfile(policy({ workspace: '/work/a"b' }));
  expect(profile).toContain('(subpath "/work/a\\"b")');
});

it("resolves a path through its symlinks, so a rule is written where the kernel looks", () => {
  const root = fresh();
  const real = join(root, "real");
  mkdirSync(real);
  const link = join(root, "link");
  symlinkSync(real, link);
  expect(canonicalPath(link)).toBe(real);
});

it("refuses a path that will not resolve, naming it", () => {
  const root = fresh();
  expect(() => canonicalPath(join(root, "nowhere"))).toThrow(/nowhere/);
});

it("reads a path written against the home directory", () => {
  const home = canonicalPath(process.env.HOME ?? "/");
  expect(canonicalPath("~")).toBe(home);
});

it("covers a path that lies beneath a grant, once both are resolved", () => {
  const root = fresh();
  const granted = join(root, "granted");
  mkdirSync(granted);
  const inside = join(granted, "notes.md");
  writeFileSync(inside, "");
  const link = join(root, "link");
  symlinkSync(granted, link);

  const grants = [{ path: granted, mode: "write" as const }];
  expect(covers(grants, inside, "write")).toBe(true);
  expect(covers(grants, join(link, "notes.md"), "write")).toBe(true);
  expect(covers(grants, granted, "read")).toBe(true);
  expect(covers(grants, root, "read")).toBe(false);
});

it("does not let a read grant cover a write", () => {
  const root = fresh();
  const granted = join(root, "granted");
  mkdirSync(granted);
  expect(covers([{ path: granted, mode: "read" }], granted, "write")).toBe(false);
  expect(covers([{ path: granted, mode: "read" }], granted, "read")).toBe(true);
});

it("covers a file the call is on its way to creating", () => {
  const root = fresh();
  const granted = join(root, "granted");
  mkdirSync(granted);
  expect(covers([{ path: granted, mode: "write" }], join(granted, "not-yet.csv"), "write")).toBe(
    true,
  );
  // And a name that climbs back out is still out, however it was written.
  expect(covers([{ path: granted, mode: "write" }], join(granted, "..", "out.csv"), "write")).toBe(
    false,
  );
});

it("has a backend for this platform and none for one it cannot confine", () => {
  expect(sandboxBackendFor("darwin")).toBeDefined();
  expect(sandboxBackendFor("linux")).toBeUndefined();
  expect(sandboxBackendFor("win32")).toBeUndefined();
});

it("spawns the adapter through the sandbox with an argument array, never a shell", () => {
  const backend = sandboxBackendFor("darwin")!;
  const confined = backend.confine(policy(), { command: "/bin/echo", args: ["hi there"] });
  expect(confined.command).toBe("/usr/bin/sandbox-exec");
  expect(confined.args.slice(-3)).toEqual(["--", "/bin/echo", "hi there"]);
  expect(confined.args).toContain("-p");
  expect(confined.args.some((arg) => arg.includes("(deny default)"))).toBe(true);
});

it("refuses to confine a run on a platform it has no backend for, naming the platform", () => {
  expect(() => confine("linux", policy(), { command: "/bin/echo", args: [] })).toThrow(/linux/);
});

it("never grants a program location broad enough to swallow the boundary", () => {
  const backend = sandboxBackendFor("darwin")!;
  // `/bin` is a real PATH entry on every machine, and the directory above it
  // is the whole disk.
  const confined = backend.confine(policy(), { command: "/bin/sh", args: ["-c", "true"] });
  const profile = confined.args[1];
  expect(profile).not.toContain('(subpath "/")');
  expect(profile).not.toContain(`(subpath "${canonicalPath(process.env.HOME ?? "/")}")`);
  // What a program genuinely needs is still there.
  expect(profile).toContain('(subpath "/bin/sh")');
});

it("lets a run open a connection, since the model it is reaching for is not on this machine", () => {
  expect(renderSeatbeltProfile(policy())).toContain("(allow network-outbound)");
});

it("gives an agent read and write over the directory it was declared to own", () => {
  const profile = renderSeatbeltProfile(
    policy({ home: { state: ["/home/.agent"], credentials: [], sealed: [], private: [], patterns: [] } }),
  );
  expect(profile).toContain('(allow file-read* file-write* (subpath "/home/.agent"))');
});

it("gives an agent read alone over the store it authenticates from", () => {
  const profile = renderSeatbeltProfile(
    policy({ home: { state: [], credentials: ["/home/Library/Keychains"], sealed: [], private: [], patterns: [] } }),
  );
  expect(profile).toContain('(allow file-read* (subpath "/home/Library/Keychains"))');
  expect(profile).not.toContain('file-write* (subpath "/home/Library/Keychains")');
});

it("seals an entry inside an agent's own home after the allow that would cover it", () => {
  const profile = renderSeatbeltProfile(
    policy({
      home: {
        state: ["/home/.agent"],
        credentials: [],
        sealed: ["/home/.agent/settings.json"],
        private: [],
        patterns: [],
      },
    }),
  );
  const allow = profile.indexOf('(subpath "/home/.agent")');
  const deny = profile.indexOf('(subpath "/home/.agent/settings.json")');
  expect(allow).toBeGreaterThan(-1);
  expect(deny).toBeGreaterThan(allow);
  expect(profile).toContain('(deny file-write* (subpath "/home/.agent/settings.json"))');
});

it("denies a private entry both ways, unlike a sealed one", () => {
  const profile = renderSeatbeltProfile(
    policy({
      home: {
        state: ["/home/.agent"],
        credentials: [],
        sealed: [],
        private: ["/home/.agent/projects"],
        patterns: [],
      },
    }),
  );
  expect(profile).toContain('(deny file-read* file-write* (subpath "/home/.agent/projects"))');
});

it("reopens this Task's own record last, so the narrow allow is what matches", () => {
  // The directory holding every Task's record is denied; the one entry in it
  // that belongs to this run is allowed again afterwards. Last match wins, so
  // the order is the whole rule.
  const profile = renderSeatbeltProfile(
    policy({
      home: {
        state: ["/home/.agent", "/home/.agent/projects/-work-t-1"],
        credentials: [],
        sealed: [],
        private: ["/home/.agent/projects"],
        patterns: [],
      },
    }),
  );
  const deny = profile.indexOf('(deny file-read* file-write* (subpath "/home/.agent/projects"))');
  // The last one, not the first: this path is also rendered among the agent's
  // own allows further up, and what decides is whichever rule the kernel reads
  // last.
  const reopened = profile.lastIndexOf(
    '(allow file-read* file-write* (subpath "/home/.agent/projects/-work-t-1"))',
  );
  expect(deny).toBeGreaterThan(-1);
  expect(reopened).toBeGreaterThan(deny);
});

it("reopens nothing that was never denied, so an ordinary home renders no trailing allows", () => {
  const profile = renderSeatbeltProfile(
    policy({ home: { state: ["/home/.agent"], credentials: [], sealed: [], private: [], patterns: [] } }),
  );
  expect(profile).not.toContain("what the agent keeps inside what it is denied");
});

it("leaves an agent that declared no home reaching nothing of its own", () => {
  const profile = renderSeatbeltProfile(policy());
  expect(profile).not.toContain("Keychains");
});

it("does not deny the machine's credential service unconditionally, since a deny would outlive the allow", () => {
  // Nothing in the baseline allows the enclosing directory, so this store is
  // already out of reach by default. Naming it among the denies as well would
  // survive the allow an agent's own home renders, and take the agent's
  // credential with it.
  expect(deniedPaths("/tmp/data").some((path) => path.includes("Keychains"))).toBe(false);
});

it("still denies the flat-file credential stores, where a deny is the only gate there is", () => {
  const denied = deniedPaths(join(fresh(), "data"));
  expect(denied.some((path) => path.endsWith(".ssh"))).toBe(true);
  expect(denied.some((path) => path.endsWith("data"))).toBe(true);
});

it("tells two agents' boundaries apart, so one is never reused for the other", () => {
  const one = boundaryOf(policy({ home: { state: ["/home/.a"], credentials: [], sealed: [], private: [], patterns: [] } }));
  const other = boundaryOf(policy({ home: { state: ["/home/.b"], credentials: [], sealed: [], private: [], patterns: [] } }));
  expect(one).not.toBe(other);
});
