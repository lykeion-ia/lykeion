import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath, confine, policyFor, type SandboxPolicy } from "./sandbox";
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
 *  building a command line: nothing outside this file reaches a shell. */
function inside(
  policy: SandboxPolicy,
  script: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const confined = confine("darwin", policy, { command: "/bin/sh", args: ["-c", script] });
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
