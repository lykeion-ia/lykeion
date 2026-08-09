import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@lykeion/api";
import { allAgentHomes, confinementFor } from "./agent-home";
import type { KernelHost } from "./kernel-host";
import { forwardKernelCells, kernelConfinementFor, kernelSocketPath } from "./kernels";
import {
  canonicalPath,
  confine,
  covers,
  NO_AGENT_HOME,
  policyFor,
  renderSeatbeltProfile,
  type SandboxPolicy,
} from "./sandbox";
import { freshDir } from "./test-support/fresh-dir";

/** A machine with one Task directory, this machine's own data directory, and
 *  an environment a kernel would be run out of. */
function scene(): { workspace: string; dataDir: string; environment: string } {
  const workspace = freshDir();
  const dataDir = freshDir();
  const environment = freshDir();
  writeFileSync(join(environment, "pyvenv.cfg"), "version = 3.13\n");
  return { workspace, dataDir, environment };
}

/** Whether this policy's denies reach `path`, resolved the way the kernel
 *  will resolve it. An installation named through `/tmp` is denied at
 *  `/private/tmp`, and those are one place rather than two. */
function deniesReach(policy: SandboxPolicy, path: string): boolean {
  return covers(
    policy.denied.map((denied) => ({ path: denied, mode: "read" as const })),
    path,
    "read",
  );
}

it("gives a kernel a boundary that reads its environment and never writes it", () => {
  const { workspace, dataDir, environment } = scene();
  const { policy } = kernelConfinementFor({
    platform: "darwin",
    workspace,
    dataDir,
    grants: [],
    reads: [environment],
  });

  const where = canonicalPath(environment);
  expect(policy.readable).toEqual([where]);
  expect(policy.workspace).toBe(canonicalPath(workspace));
  expect(policy.grants).toEqual([]);

  const profile = renderSeatbeltProfile(policy);
  expect(profile).toContain(`(allow file-read* (subpath "${where}"))`);
  expect(profile).not.toContain(`file-write* (subpath "${where}")`);
});

it("carries the standing grants the agent beside it runs under", () => {
  const { workspace, dataDir, environment } = scene();
  const data = freshDir();
  const { policy } = kernelConfinementFor({
    platform: "darwin",
    workspace,
    dataDir,
    grants: [{ path: data, mode: "read" }],
    reads: [environment],
  });

  // A folder the researcher granted so the agent could read it is a folder
  // they granted, not a program they granted it to. A cell that could not
  // open the data the conversation beside it is about would be a notebook
  // that cannot see what the Task is for.
  expect(policy.grants).toEqual([{ path: canonicalPath(data), mode: "read" }]);
  const profile = renderSeatbeltProfile(policy);
  expect(profile).toContain(`(allow file-read* (subpath "${canonicalPath(data)}"))`);
  expect(profile).not.toContain(`file-write* (subpath "${canonicalPath(data)}")`);
});

it("owns no agent's installation and is denied every one of them", () => {
  const { workspace, dataDir, environment } = scene();
  const { policy } = kernelConfinementFor({
    platform: "darwin",
    workspace,
    dataDir,
    grants: [],
    reads: [environment],
  });

  expect(policy.home).toEqual(NO_AGENT_HOME);

  const installations = allAgentHomes(workspace);
  expect(installations.length).toBeGreaterThan(0);
  for (const installation of installations) expect(deniesReach(policy, installation)).toBe(true);
});

it("hands back a prefix a command can be concatenated onto", () => {
  const { workspace, dataDir, environment } = scene();
  const { prefix } = kernelConfinementFor({
    platform: "darwin",
    workspace,
    dataDir,
    grants: [],
    reads: [environment],
  });

  expect(prefix[0]).toBe("/usr/bin/sandbox-exec");
  expect(prefix[1]).toBe("-p");
  expect(prefix[2]).toContain("(deny default)");
  // The separator the program goes after, kept: a prefix missing it would
  // have the interpreter read as another of the boundary's own arguments.
  expect(prefix.at(-1)).toBe("--");
  // What this end passed through to find where the prefix stops is gone from
  // what the host will run.
  expect(prefix.some((argument) => argument.includes("\0"))).toBe(false);
});

it("refuses to describe a boundary on a platform that has none", () => {
  const { workspace, dataDir, environment } = scene();
  expect(() =>
    kernelConfinementFor({
    platform: "sunos",
    workspace,
    dataDir,
    grants: [],
    reads: [environment],
  }),
  ).toThrow(/sunos/);
  // Said before a path is resolved: a machine that can confine nothing at all
  // is not a machine with one directory it could not find.
  expect(() =>
    kernelConfinementFor({
      platform: "sunos",
      workspace: join(workspace, "nowhere"),
      dataDir,
      grants: [],
      reads: [environment],
    }),
  ).toThrow(/sunos/);
});

/** Spawns one argument array and answers with what the kernel let it do. */
function ran(argv: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const [command, ...args] = argv;
  return new Promise((resolve) => {
    const child = spawn(command!, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** Runs one shell word-for-word behind the prefix a kernel would be started
 *  behind, and answers with what the kernel let it do. `/bin/sh -c` is the
 *  subject here rather than a way of building a command line: the script is
 *  one argument, so nothing it names is readable for having been named. */
function behind(
  prefix: string[],
  script: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return ran([...prefix, "/bin/sh", "-c", script]);
}

const onDarwin = process.platform === "darwin" ? describe : describe.skip;

/**
 * The kernel's own answer rather than the profile's reading. A prefix that
 * reads correctly and confines nothing is the failure this exists to prevent,
 * so what is claimed here is claimed by asking the operating system to refuse
 * something and watching it refuse.
 */
onDarwin("the boundary a kernel is started inside", () => {
  it("reads the environment it was given and cannot write it", async () => {
    const { workspace, dataDir, environment } = scene();
    const { prefix } = kernelConfinementFor({
      platform: "darwin",
      workspace,
      dataDir,
      grants: [],
      reads: [environment],
    });

    const read = await behind(prefix, `cat ${environment}/pyvenv.cfg`);
    expect(read.stdout).toContain("version = 3.13");
    expect(read.code).toBe(0);

    // A cell that could write here would leave code the next launch runs.
    const wrote = await behind(prefix, `touch ${environment}/sitecustomize.py`);
    expect(wrote.code).not.toBe(0);
    expect(existsSync(join(environment, "sitecustomize.py"))).toBe(false);
  });

  it("writes the Task it belongs to and nothing this machine keeps for itself", async () => {
    const { workspace, dataDir, environment } = scene();
    writeFileSync(join(dataDir, "token"), "THIS MACHINES OWN TOKEN\n");
    const { prefix } = kernelConfinementFor({
      platform: "darwin",
      workspace,
      dataDir,
      grants: [],
      reads: [environment],
    });

    const wrote = await behind(prefix, `echo eleven rows > ${workspace}/out.csv`);
    expect(wrote.code).toBe(0);
    expect(readFileSync(join(workspace, "out.csv"), "utf8")).toContain("eleven rows");

    const stolen = await behind(prefix, `cat ${dataDir}/token`);
    expect(stolen.stdout).not.toContain("THIS MACHINES OWN TOKEN");
    expect(stolen.code).not.toBe(0);
  });

  it("reads a folder the researcher granted, and writes it only where they said so", async () => {
    const { workspace, dataDir, environment } = scene();
    const experiments = freshDir();
    writeFileSync(join(experiments, "kinome.csv"), "eleven rows\n");
    const { prefix } = kernelConfinementFor({
      platform: "darwin",
      workspace,
      dataDir,
      grants: [{ path: experiments, mode: "read" }],
      reads: [environment],
    });

    const read = await behind(prefix, `cat ${experiments}/kinome.csv`);
    expect(read.stdout).toContain("eleven rows");
    expect(read.code).toBe(0);

    const wrote = await behind(prefix, `echo no > ${experiments}/written.csv`);
    expect(wrote.code).not.toBe(0);
    expect(existsSync(join(experiments, "written.csv"))).toBe(false);
  });

  it("reads nothing a researcher keeps in their own home, where an agent still reads its configuration", async () => {
    const { workspace, dataDir, environment } = scene();
    // A real hidden entry in the real home directory, of the shape nothing
    // below the allows denies by name: an agent's own configuration lives
    // among these, and so do the tokens a researcher publishes packages with.
    const configuration = join(homedir(), `.lykeion-kernel-probe-${randomUUID()}`);
    writeFileSync(configuration, "//registry.npmjs.org/:_authToken=A RESEARCHERS OWN TOKEN\n");
    try {
      const { prefix } = kernelConfinementFor({
        platform: "darwin",
        workspace,
        dataDir,
        grants: [],
        reads: [environment],
      });
      const cell = await behind(prefix, `cat ${configuration}`);
      expect(cell.stdout).not.toContain("A RESEARCHERS OWN TOKEN");
      expect(cell.code).not.toBe(0);

      // The same file, under a boundary drawn for something that does own an
      // installation. A rule an agent stopped getting would be a program that
      // starts and reports itself signed out, so the direction that has to
      // keep working is asked of the kernel too.
      const agent = policyFor({
        workspace,
        grants: [],
        dataDir,
        ...confinementFor("claude", workspace),
      });
      const confined = confine("darwin", agent, {
        command: "/bin/sh",
        args: ["-c", `cat ${configuration}`],
      });
      const turn = await ran([confined.command, ...confined.args]);
      expect(turn.stdout).toContain("A RESEARCHERS OWN TOKEN");
      expect(turn.code).toBe(0);
    } finally {
      rmSync(configuration, { force: true });
    }
  });
});

/** A `KernelHost` that spawns nothing: this suite tests the routing
 *  `forwardKernelCells` builds on top of the host interface, not the wire
 *  protocol underneath it — `kernel-host.test.ts` already covers that
 *  against a real child process. */
function fakeHost(): { host: KernelHost; announce: (method: string, params: unknown) => void } {
  const listeners = new Map<string, Array<(params: unknown) => void>>();
  const host: KernelHost = {
    call: () => Promise.resolve({}),
    on(method, handler) {
      listeners.set(method, [...(listeners.get(method) ?? []), handler]);
    },
    stop: () => Promise.resolve(),
    get running() {
      return true;
    },
    stderrTail: () => "",
  };
  return {
    host,
    announce(method, params) {
      for (const handler of listeners.get(method) ?? []) handler(params);
    },
  };
}

/** A cell announcement's worth of fields, with a session supplied by the
 *  caller — every other field is a fixed, uninteresting stand-in, since
 *  what these tests are about is which run a notification reaches, not what
 *  it says once it does. */
function cellAnnouncement(sessionId: string): Record<string, unknown> {
  return {
    sessionId,
    taskId: "tk_1",
    kernelId: "k_1",
    name: "main",
    language: "python",
    environment: "python",
    executionCount: 1,
    source: "1 + 1",
    origin: { surface: "agent", by: "a_claude" },
    ok: true,
    wallMs: 5,
    ts: 42,
    outputs: [],
  };
}

it("routes a cell notification to the run of the session it names", () => {
  const { host, announce } = fakeHost();
  const events: Array<{ runId: string; event: RunEvent }> = [];
  forwardKernelCells(
    host,
    (sessionId) => (sessionId === "sess_1" ? "run_1" : undefined),
    (runId, event) => events.push({ runId, event }),
    () => undefined,
  );

  announce("cell", cellAnnouncement("sess_1"));

  expect(events).toHaveLength(1);
  expect(events[0]!.runId).toBe("run_1");
  const forwarded = events[0]!.event as Extract<RunEvent, { event: "cell" }>;
  expect(forwarded.event).toBe("cell");
  expect(forwarded.cell.source).toBe("1 + 1");
  expect(typeof forwarded.cell.id).toBe("string");
  // The session and Task the notification named do not travel any further:
  // `NotebookCell` carries neither, and a stored cell already stands inside
  // one Task's notebook.
  expect("sessionId" in forwarded.cell).toBe(false);
  expect("taskId" in forwarded.cell).toBe(false);
});

it("drops a cell notification for a session with no run currently taking its turn", () => {
  const { host, announce } = fakeHost();
  const events: unknown[] = [];
  forwardKernelCells(
    host,
    () => undefined,
    (runId, event) => events.push({ runId, event }),
    () => undefined,
  );

  announce("cell", cellAnnouncement("sess_1"));

  expect(events).toEqual([]);
});

it("routes a cell to whichever run is current when a session's kernel outlives more than one turn", () => {
  const { host, announce } = fakeHost();
  const events: Array<{ runId: string; event: RunEvent }> = [];
  let current = "run_1";
  forwardKernelCells(
    host,
    (sessionId) => (sessionId === "sess_1" ? current : undefined),
    (runId, event) => events.push({ runId, event }),
    () => undefined,
  );

  announce("cell", cellAnnouncement("sess_1"));
  current = "run_2";
  announce("cell", cellAnnouncement("sess_1"));

  expect(events.map((e) => e.runId)).toEqual(["run_1", "run_2"]);
});

it("keeps two sessions' cells apart", () => {
  const { host, announce } = fakeHost();
  const events: Array<{ runId: string; event: RunEvent }> = [];
  const runFor: Record<string, string> = { sess_1: "run_1", sess_2: "run_2" };
  forwardKernelCells(
    host,
    (sessionId) => runFor[sessionId],
    (runId, event) => events.push({ runId, event }),
    () => undefined,
  );

  announce("cell", cellAnnouncement("sess_1"));
  announce("cell", cellAnnouncement("sess_2"));

  expect(events.map((e) => e.runId)).toEqual(["run_1", "run_2"]);
});

it("drops a cell the researcher's own REPL ran, which reaches the lab its own way", () => {
  // A REPL cell is answered to the call that asked for it and posted under
  // the id the lab minted before that call was ever sent. Forwarded here as
  // well it would be recorded a second time, under a second id — which is
  // what a REPL cell run while an agent holds the same session's turn would
  // be, since then there IS a run for this to deliver to.
  const { host, announce } = fakeHost();
  const events: Array<{ runId: string; event: RunEvent }> = [];
  forwardKernelCells(
    host,
    () => "run_1",
    (runId, event) => events.push({ runId, event }),
    () => undefined,
  );

  announce("cell", {
    ...cellAnnouncement("sess_1"),
    origin: { surface: "repl", by: "mem_1" },
  });
  expect(events).toEqual([]);

  // The agent's own cell, on the same session and the same run, still travels.
  announce("cell", cellAnnouncement("sess_1"));
  expect(events).toHaveLength(1);
});

it("asks the session which kernel call a cell with no toolUseId arrived as", () => {
  const { host, announce } = fakeHost();
  const events: Array<{ runId: string; event: RunEvent }> = [];
  const asked: Array<[string, string]> = [];
  forwardKernelCells(
    host,
    () => "run_1",
    (runId, event) => events.push({ runId, event }),
    (sessionId, source) => {
      asked.push([sessionId, source]);
      return "toolu_9";
    },
  );

  announce("cell", cellAnnouncement("sess_1"));

  expect(asked).toEqual([["sess_1", "1 + 1"]]);
  const forwarded = events[0]!.event as Extract<RunEvent, { event: "cell" }>;
  expect(forwarded.cell.toolUseId).toBe("toolu_9");
});

it("keeps the toolUseId a cell announced itself, without asking the session", () => {
  // A provider that forwarded its own id down the MCP channel named its own
  // call, and is the authority on it.
  const { host, announce } = fakeHost();
  const events: Array<{ runId: string; event: RunEvent }> = [];
  forwardKernelCells(
    host,
    () => "run_1",
    (runId, event) => events.push({ runId, event }),
    () => {
      throw new Error("an announced id is not a question");
    },
  );

  announce("cell", { ...cellAnnouncement("sess_1"), toolUseId: "toolu_own" });

  const forwarded = events[0]!.event as Extract<RunEvent, { event: "cell" }>;
  expect(forwarded.cell.toolUseId).toBe("toolu_own");
});

it("forwards a cell nothing could join with no toolUseId at all", () => {
  const { host, announce } = fakeHost();
  const events: Array<{ runId: string; event: RunEvent }> = [];
  forwardKernelCells(
    host,
    () => "run_1",
    (runId, event) => events.push({ runId, event }),
    () => undefined,
  );

  announce("cell", cellAnnouncement("sess_1"));

  const forwarded = events[0]!.event as Extract<RunEvent, { event: "cell" }>;
  expect("toolUseId" in forwarded.cell).toBe(false);
});

/** The working directory a machine has on an ordinary install: the default
 *  `dataDir` on macOS with `-work` after it, a Study inside it, and a Task
 *  inside that. Nothing here is unusual — it is what `config.ts` resolves
 *  when a researcher sets nothing at all. */
function defaultInstallWorkspace(): string {
  return join(
    homedir(),
    "Library",
    "Application Support",
    "Lykeion",
    "daemon-work",
    "studies",
    "s_1",
    "tasks",
    "t_1",
  );
}

it("names a socket a default install can actually bind", () => {
  // The number the operating system holds a socket's name in, and the one
  // the host refuses at. A name that reaches it is a machine that holds no
  // kernels for this Task, on the install nobody configured anything on.
  expect(Buffer.byteLength(kernelSocketPath(defaultInstallWorkspace()), "utf8")).toBeLessThan(104);
});

it("gives one Task one socket and two Tasks two", () => {
  const one = join(homedir(), "work", "studies", "s_1", "tasks", "t_1");
  const two = join(homedir(), "work", "studies", "s_1", "tasks", "t_2");
  expect(kernelSocketPath(one)).toBe(kernelSocketPath(one));
  expect(kernelSocketPath(one)).not.toBe(kernelSocketPath(two));
});

it("refuses a name it cannot bind, saying which name and how long it is", () => {
  const was = process.env.TMPDIR;
  // A temporary directory long enough that even a name of this shape does
  // not fit. Said in words here rather than left to the operating system,
  // whose own failure names neither the path nor how much room there was.
  process.env.TMPDIR = `/tmp/${"x".repeat(90)}`;
  try {
    expect(() => kernelSocketPath(defaultInstallWorkspace())).toThrow(/is 1\d\d bytes/);
    expect(() => kernelSocketPath(defaultInstallWorkspace())).toThrow(/xxxxxxxx/);
  } finally {
    if (was === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = was;
  }
});
