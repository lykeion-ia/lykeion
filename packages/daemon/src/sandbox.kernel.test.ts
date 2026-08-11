import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalPath,
  confine,
  NO_AGENT_HOME,
  policyFor,
  type SandboxPolicy,
} from "./sandbox";
import { createServer } from "node:net";
import { confinementFor } from "./agent-home";
import { snapshotPathFor, takeSnapshot } from "./snapshot";
import { ensureTaskDir } from "./workspace";

/**
 * The kernel's own answer, not the profile's reading. A profile that reads
 * correctly and denies nothing is the failure this boundary exists to
 * prevent, so every claim here is made by asking the operating system to
 * refuse something and watching it refuse.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-seatbelt-"));
  dirs.push(dir);
  return canonicalPath(dir);
}

/** Runs one shell word-for-word inside the boundary and answers with what
 *  the kernel let it do. `/bin/sh -c` is the subject here, not a way of
 *  building a command line: nothing outside this file reaches a shell.
 *
 *  The script is one argument the boundary cannot resolve to a file, which is
 *  what keeps the probe honest: a path named directly in an argument array is
 *  readable because the program being spawned is readable, so a run reading a
 *  file it was handed as an argument says nothing about what the policy
 *  allowed.
 *
 *  Everything but the workspace stands empty unless a test names it, so each
 *  one declares the part of the boundary it is about and nothing else. */
function inside(
  policy: { workspace: string } & Partial<Omit<SandboxPolicy, "workspace">>,
  script: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const confined = confine(
    "darwin",
    { grants: [], denied: [], readable: [], home: NO_AGENT_HOME, ...policy },
    { command: "/bin/sh", args: ["-c", script] },
  );
  return new Promise((resolve) => {
    const child = spawn(confined.command, confined.args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const onDarwin = process.platform === "darwin" ? describe : describe.skip;

onDarwin("the boundary the kernel actually enforces", () => {
  it("lets an ordinary read and write inside the workspace through", async () => {
    const root = fresh();
    const workspace = join(root, "task");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "in.txt"), "twelve rows\n");

    const ran = await inside(
      { workspace, grants: [], denied: [] },
      `cat ${workspace}/in.txt && echo written > ${workspace}/out.txt && cat ${workspace}/out.txt`,
    );
    expect(ran.stdout).toContain("twelve rows");
    expect(ran.stdout).toContain("written");
    expect(ran.code).toBe(0);
  });

  it("denies a write outside the workspace", async () => {
    const root = fresh();
    const workspace = join(root, "task");
    mkdirSync(workspace);
    const outside = join(root, "elsewhere.txt");

    const ran = await inside({ workspace, grants: [], denied: [] }, `echo no > ${outside}`);
    expect(ran.code).not.toBe(0);
  });

  it("denies a write from a subprocess two levels down, since the boundary covers the tree", async () => {
    const root = fresh();
    const workspace = join(root, "task");
    mkdirSync(workspace);
    const outside = join(root, "nested.txt");

    const ran = await inside(
      { workspace, grants: [], denied: [] },
      `/bin/sh -c '/bin/sh -c "echo no > ${outside}"'`,
    );
    expect(ran.code).not.toBe(0);
  });

  it("denies a write through a symlink that leaves the workspace", async () => {
    const root = fresh();
    const workspace = join(root, "task");
    mkdirSync(workspace);
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, "escape"));

    const ran = await inside(
      { workspace, grants: [], denied: [] },
      `echo no > ${workspace}/escape/taken.txt`,
    );
    expect(ran.code).not.toBe(0);
  });

  it("keeps a secret denied beneath a folder the researcher granted", async () => {
    const root = fresh();
    const workspace = join(root, "task");
    mkdirSync(workspace);
    const granted = join(root, "work");
    mkdirSync(granted);
    writeFileSync(join(granted, "counts.csv"), "a,b\n");
    const secrets = join(granted, ".ssh");
    mkdirSync(secrets);
    writeFileSync(join(secrets, "id_ed25519"), "PRIVATE KEY\n");

    const policy: SandboxPolicy = {
      workspace,
      grants: [{ path: granted, mode: "write" }],
      denied: [secrets],
      readable: [],
      home: NO_AGENT_HOME,
    };

    const ordinary = await inside(policy, `cat ${granted}/counts.csv`);
    expect(ordinary.stdout).toContain("a,b");
    expect(ordinary.code).toBe(0);

    const secret = await inside(policy, `cat ${secrets}/id_ed25519`);
    expect(secret.stdout).not.toContain("PRIVATE KEY");
    expect(secret.code).not.toBe(0);
  });

  it("lets a write into a granted folder through", async () => {
    const root = fresh();
    const workspace = join(root, "task");
    mkdirSync(workspace);
    const granted = join(root, "work");
    mkdirSync(granted);

    const ran = await inside(
      { workspace, grants: [{ path: granted, mode: "write" }], denied: [] },
      `echo results > ${granted}/out.csv && cat ${granted}/out.csv`,
    );
    expect(ran.stdout).toContain("results");
    expect(ran.code).toBe(0);
  });

  it("denies a write into a folder granted for reading only", async () => {
    const root = fresh();
    const workspace = join(root, "task");
    mkdirSync(workspace);
    const granted = join(root, "reference");
    mkdirSync(granted);
    writeFileSync(join(granted, "paper.md"), "bridge rna\n");

    const policy: SandboxPolicy = {
      workspace,
      grants: [{ path: granted, mode: "read" }],
      denied: [],
      readable: [],
      home: NO_AGENT_HOME,
    };
    const read = await inside(policy, `cat ${granted}/paper.md`);
    expect(read.stdout).toContain("bridge rna");

    const write = await inside(policy, `echo no > ${granted}/added.md`);
    expect(write.code).not.toBe(0);
  });
});

onDarwin("the snapshot is out of the agent's reach", () => {
  it("denies a write into the place a Task's snapshot is kept", async () => {
    const work = fresh();
    const task = ensureTaskDir(work, "s_1", "t_1");
    writeFileSync(join(task, "counts.csv"), "a,b\n");
    await takeSnapshot(work, "s_1", "t_1");
    const snapshot = snapshotPathFor(work, "s_1", "t_1");

    const policy: SandboxPolicy = {
      workspace: canonicalPath(task),
      grants: [],
      denied: [],
      readable: [],
      home: NO_AGENT_HOME,
    };
    const overwrite = await inside(policy, `echo tampered > ${snapshot}/counts.csv`);
    expect(overwrite.code).not.toBe(0);
    const remove = await inside(policy, `rm -rf ${snapshot}`);
    expect(remove.code).not.toBe(0);
    expect(readFileSync(join(snapshot, "counts.csv"), "utf8")).toBe("a,b\n");
  });
});

onDarwin("the policy a real run is given, asked of the kernel", () => {
  /** Built by `policyFor`, exactly as a run builds it — not hand-written by
   *  the test, which is what let a missing deny pass unnoticed. */
  function realRun(): { policy: SandboxPolicy; task: string; other: string; granted: string; dataDir: string } {
    const root = fresh();
    const dataDir = join(root, "daemon-state");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "state.json"), '{"token":"MACHINE-TOKEN"}');
    const workDir = join(root, "work");
    const task = ensureTaskDir(workDir, "s_1", "t_1");
    const other = ensureTaskDir(workDir, "s_1", "t_2");
    writeFileSync(join(other, "private.csv"), "ANOTHER TASK'S DATA\n");
    const granted = join(root, "granted");
    mkdirSync(join(granted, ".ssh"), { recursive: true });
    writeFileSync(join(granted, "reference.csv"), "gene,count\n");
    writeFileSync(join(granted, ".ssh", "id_ed25519"), "GRANTED-FOLDER-KEY\n");
    return {
      policy: policyFor({ workspace: task, grants: [{ path: granted, mode: "write" }], dataDir }),
      task,
      other,
      granted,
      dataDir,
    };
  }

  it("keeps a key inside a granted folder denied, without the run naming it", async () => {
    const { policy, granted } = realRun();
    const ordinary = await inside(policy, `cat ${granted}/reference.csv`);
    expect(ordinary.stdout).toContain("gene,count");

    const key = await inside(policy, `cat ${granted}/.ssh/id_ed25519`);
    expect(key.stdout).not.toContain("GRANTED-FOLDER-KEY");
    expect(key.code).not.toBe(0);
  });

  it("keeps one Task out of another's directory", async () => {
    const { policy, other } = realRun();
    const read = await inside(policy, `cat ${other}/private.csv`);
    expect(read.stdout).not.toContain("ANOTHER TASK'S DATA");
    expect(read.code).not.toBe(0);
  });

  it("keeps this machine's own token off limits", async () => {
    const { policy, dataDir } = realRun();
    const read = await inside(policy, `cat ${dataDir}/state.json`);
    expect(read.stdout).not.toContain("MACHINE-TOKEN");
    expect(read.code).not.toBe(0);
  });

  it("does not make the rest of the disk readable on the way to the adapter", async () => {
    const { policy } = realRun();
    const elsewhere = fresh();
    writeFileSync(join(elsewhere, "somebody-elses.csv"), "NOT THIS RUN'S\n");
    const read = await inside(policy, `cat ${elsewhere}/somebody-elses.csv`);
    expect(read.stdout).not.toContain("NOT THIS RUN'S");
    expect(read.code).not.toBe(0);
  });
});

/**
 * What the boundary has to leave intact for the agent to be an agent at all:
 * the connection its model is on the other end of, the directory it keeps its
 * own state in, and the store it authenticates from. A boundary that denies
 * these is airtight against the agent as well as for it, and no turn finishes.
 */
onDarwin("the profile a real agent is confined by is one this machine accepts", () => {
  // A rule the sandbox cannot parse is not a rule it ignores — it refuses the
  // whole profile, and the child never starts. From outside that looks exactly
  // like an agent nobody has installed, which is how a malformed pattern
  // reached a running product: every assertion about the profile's TEXT
  // passed, because the text was fine and only the kernel disagreed.
  //
  // Built from the real declaration each agent actually runs with, never a
  // hand-written one, for the same reason the policy below is.
  for (const agent of ["claude", "codex", "stub"]) {
    it(`starts a child under the policy "${agent}" is given`, async () => {
      const root = fresh();
      const workspace = join(root, "task");
      mkdirSync(workspace);
      const dataDir = join(root, "daemon-state");
      mkdirSync(dataDir);

      const policy = policyFor({
        workspace,
        grants: [],
        dataDir,
        ...confinementFor(agent, workspace),
      });
      const ran = await inside(policy, "echo the profile parsed");
      expect(ran.stderr).not.toMatch(/sandbox-exec/);
      expect(ran.stdout).toContain("the profile parsed");
      expect(ran.code).toBe(0);
    });
  }
});

onDarwin("what a run needs in order to be a run", () => {
  it("lets a run open a connection, since its model is not on this machine", async () => {
    const root = fresh();
    const workspace = join(root, "task");
    mkdirSync(workspace);

    // A listener on this machine, so the claim under test is that the kernel
    // permitted the connection and nothing at all about the internet.
    const server = createServer((socket) => socket.end());
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    try {
      const ran = await inside({ workspace, grants: [], denied: [] }, `nc -z 127.0.0.1 ${port}`);
      expect(ran.code).toBe(0);
    } finally {
      server.close();
    }
  });

  it("lets an agent write the directory it was declared to own", async () => {
    const root = fresh();
    const workspace = join(root, "task");
    mkdirSync(workspace);
    const state = join(root, ".agent");
    mkdirSync(state);

    const ran = await inside(
      {
        workspace,
        grants: [],
        denied: [],
        home: { state: [state], credentials: [], sealed: [], private: [], patterns: [] },
      },
      `echo session > ${state}/history.jsonl && cat ${state}/history.jsonl`,
    );
    expect(ran.stdout).toContain("session");
    expect(ran.code).toBe(0);
  });

  it("keeps an agent from writing an entry sealed inside its own home", async () => {
    const root = fresh();
    const workspace = join(root, "task");
    mkdirSync(workspace);
    const state = join(root, ".agent");
    mkdirSync(state);
    const sealed = join(state, "settings.json");
    writeFileSync(sealed, '{"hooks":{}}\n');

    const policy = {
      workspace,
      grants: [],
      denied: [],
      home: { state: [state], credentials: [], sealed: [sealed], private: [], patterns: [] },
    };
    const wrote = await inside(policy, `echo TAMPERED > ${sealed}`);
    expect(wrote.code).not.toBe(0);
    expect(readFileSync(sealed, "utf8")).not.toContain("TAMPERED");
    // Sealed against writing only — an agent still reads its own configuration.
    const read = await inside(policy, `cat ${sealed}`);
    expect(read.code).toBe(0);
  });

  it("keeps an agent out of a store it did not declare", async () => {
    const root = fresh();
    const workspace = join(root, "task");
    mkdirSync(workspace);
    const mine = join(root, "mine");
    const theirs = join(root, "theirs");
    mkdirSync(mine);
    mkdirSync(theirs);
    writeFileSync(join(theirs, "token"), "ANOTHER AGENTS TOKEN\n");

    const read = await inside(
      {
        workspace,
        grants: [],
        denied: [],
        home: { state: [], credentials: [mine], sealed: [], private: [], patterns: [] },
      },
      `cat ${theirs}/token`,
    );
    expect(read.stdout).not.toContain("ANOTHER AGENTS TOKEN");
    expect(read.code).not.toBe(0);
  });

  it("keeps this Task's own record while the ones beside it stay out of reach", async () => {
    // The agent's directory holds the researcher's account of every other
    // thing they have done with the same program. A run writes its own and
    // reads none of theirs — which is one wide deny and one narrow allow
    // after it, and only the kernel can say whether that ordering holds.
    const root = fresh();
    const workspace = join(root, "task");
    mkdirSync(workspace);
    const state = join(root, ".agent");
    const records = join(state, "projects");
    const mine = join(records, "-this-task");
    const theirs = join(records, "-another-task");
    mkdirSync(mine, { recursive: true });
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, "transcript.jsonl"), "SOMEBODY ELSES CONVERSATION\n");

    const policy = {
      workspace,
      grants: [],
      denied: [],
      home: { state: [state, mine], credentials: [], sealed: [], private: [records], patterns: [] },
    };

    const own = await inside(policy, `echo turn > ${mine}/transcript.jsonl && cat ${mine}/transcript.jsonl`);
    expect(own.stdout).toContain("turn");
    expect(own.code).toBe(0);

    const other = await inside(policy, `cat ${theirs}/transcript.jsonl`);
    expect(other.stdout).not.toContain("SOMEBODY ELSES CONVERSATION");
    expect(other.code).not.toBe(0);
  });

  it("gives an agent its own scratch beneath a root it cannot otherwise touch", async () => {
    // The shell tool creates a working directory of its own before it runs
    // anything, under a root shared with every other run on this machine.
    const root = fresh();
    const workspace = join(root, "task");
    mkdirSync(workspace);
    const shared = join(root, "shared-scratch");
    mkdirSync(shared);
    writeFileSync(join(shared, "another-runs.txt"), "NOT THIS RUNS SCRATCH\n");
    const mine = join(shared, "-this-task");

    const policy = {
      workspace,
      grants: [],
      denied: [],
      home: { state: [mine], credentials: [], sealed: [], private: [], patterns: [] },
    };

    // Created by the run itself, the way the tool does, into a directory that
    // does not exist yet.
    const made = await inside(policy, `mkdir -p ${mine} && echo ok > ${mine}/probe && cat ${mine}/probe`);
    expect(made.stdout).toContain("ok");
    expect(made.code).toBe(0);

    const sibling = await inside(policy, `cat ${shared}/another-runs.txt`);
    expect(sibling.stdout).not.toContain("NOT THIS RUNS SCRATCH");
    expect(sibling.code).not.toBe(0);
  });

  it("gives a credential store reading and no writing, whatever else the run may do", async () => {
    const root = fresh();
    const workspace = join(root, "task");
    mkdirSync(workspace);
    const store = join(root, "store");
    mkdirSync(store);
    writeFileSync(join(store, "token"), "THE AGENTS OWN TOKEN\n");

    const policy = {
      workspace,
      grants: [],
      denied: [],
      home: { state: [], credentials: [store], sealed: [], private: [], patterns: [] },
    };
    const read = await inside(policy, `cat ${store}/token`);
    expect(read.stdout).toContain("THE AGENTS OWN TOKEN");
    const wrote = await inside(policy, `echo REPLACED > ${store}/token`);
    expect(wrote.code).not.toBe(0);
    expect(readFileSync(join(store, "token"), "utf8")).not.toContain("REPLACED");
  });
});

/**
 * A boundary drawn for something that is not an agent. It owns no installation
 * and authenticates from nothing, and what it needs instead is an environment
 * it can be run out of and cannot alter.
 */
onDarwin("a boundary around something that declared no home", () => {
  it("lets a run read the environment it was given and refuses to write it", async () => {
    const env = fresh();
    writeFileSync(join(env, "sitecustomize.py"), "print('ok')\n");
    const workspace = fresh();

    const read = await inside({ workspace, readable: [env] }, `cat ${env}/sitecustomize.py`);
    expect(read.stdout).toContain("print('ok')");
    expect(read.code).toBe(0);

    // A cell that could write here would leave code the next launch executes.
    const wrote = await inside({ workspace, readable: [env] }, `touch ${env}/evil.py`);
    expect(wrote.code).not.toBe(0);
    expect(existsSync(join(env, "evil.py"))).toBe(false);
  });

  it("keeps a credential store denied inside an environment it may otherwise read", async () => {
    // What decides is the last rule the kernel reads, so a readable environment
    // rendered after the denies would hand over every key beneath it.
    const env = fresh();
    writeFileSync(join(env, "pyvenv.cfg"), "version = 3.13\n");
    mkdirSync(join(env, ".netrc"), { recursive: true });
    writeFileSync(join(env, ".netrc", "creds"), "AN ENVIRONMENTS STOWAWAY KEY\n");
    const workspace = fresh();

    const policy = { workspace, readable: [env] };
    const ordinary = await inside(policy, `cat ${env}/pyvenv.cfg`);
    expect(ordinary.stdout).toContain("version = 3.13");
    expect(ordinary.code).toBe(0);

    const key = await inside(policy, `cat ${env}/.netrc/creds`);
    expect(key.stdout).not.toContain("AN ENVIRONMENTS STOWAWAY KEY");
    expect(key.code).not.toBe(0);
  });

  it("keeps one language's library tree out of another language's boundary", async () => {
    // Why runs.ts renders one boundary per language rather than one union of
    // them, asked of the operating system rather than of the profile text.
    //
    // It is asked here because it cannot be asked from runs.ts's own suite,
    // and the difference is not academic: a path absent from a profile is not
    // thereby denied. `SYSTEM_READ` grants /opt, so on the common homebrew
    // install a Python cell reads /opt/homebrew/lib/R/4.6/site-library and
    // the whole of R's Cellar tree today, boundary or no boundary — measured
    // on this machine, `ls` and a `cat` of stats/DESCRIPTION, both code 0. A
    // test written against the profile's words would have gone green on that
    // and called it confinement.
    //
    // The entry the split genuinely separates is the one R puts under the
    // researcher's own home: R_LIBS_USER, where install.packages() writes,
    // and therefore where a researcher's own packages and whatever sits
    // beside them actually live. Stood in for below by a directory outside
    // every grant, which is what a home path is to a kernel: the policy
    // declares no home at all.
    const home = fresh();
    const library = join(home, "R", "arm64", "4.6", "library", "somepkg");
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, "DESCRIPTION"), "Package: somepkg\n");
    const workspace = fresh();
    const pythonEnv = fresh();

    // R's own boundary, written from R's own reads, opens it.
    const rs = await inside(
      { workspace, readable: [join(home, "R")] },
      `cat ${library}/DESCRIPTION`,
    );
    expect(rs.stdout).toContain("Package: somepkg");
    expect(rs.code).toBe(0);

    // Python's, written from Python's, does not — and would if the two were
    // rendered from one union of their reads.
    const pythons = await inside(
      { workspace, readable: [pythonEnv] },
      `cat ${library}/DESCRIPTION`,
    );
    expect(pythons.stdout).not.toContain("Package: somepkg");
    expect(pythons.code).not.toBe(0);
  });
});
