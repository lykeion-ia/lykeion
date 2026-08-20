import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Capturable, GitState } from "@lykeion/api";

const run = promisify(execFile);

/** A repository is a fact about the machine, and asking takes a process.
 *  Long enough that a cold index answers, short enough that a wedged one
 *  is affordable. The budget is per `git` invocation, not a single bound on
 *  the probe as a whole: the toplevel check spends it once, and — only if
 *  that succeeds — the three calls that follow spend it again together, in
 *  parallel. A repository wedged on every command costs at most the
 *  toplevel probe plus that one parallel batch: up to roughly twice this
 *  value, not one. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * What repository, if any, backs a workspace.
 *
 * A Task directory is created by `ensureTaskDir` under `workDir` and is
 * ordinarily not a repository at all, so `not_applicable` is the usual
 * answer rather than an error path. It is reported rather than inferred:
 * "no repository" and "we did not manage to ask" are different facts about
 * a cell, and collapsing them is what the reason exists to prevent.
 *
 * Spawned with an argument array. A workspace path is attacker-influenced
 * the moment a Task is named by anything but this machine, and `shell: true`
 * here would make that path a command.
 */
export async function probeCodeState(
  workspace: string,
  options: { timeoutMs?: number } = {},
): Promise<Capturable<GitState>> {
  const timeout = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await run("git", args, { cwd: workspace, timeout });
    return stdout.trim();
  };

  let top: string;
  try {
    top = await git(["rev-parse", "--show-toplevel"]);
  } catch (failure) {
    // A non-zero exit is `git` saying there is no repository here, which is
    // an answer. A timeout is `git` saying nothing, which is not — and
    // neither is a spawn that never happened: no `git` on this machine's
    // PATH, or a workspace directory that is not there to run one in. Both
    // arrive as ENOENT and are the same fact, that nothing looked.
    const silent = timedOut(failure) || spawnFailed(failure);
    return { status: "unavailable", reason: silent ? "not_captured" : "not_applicable" };
  }

  try {
    const [branch, commit, status] = await Promise.all([
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
      git(["rev-parse", "HEAD"]),
      // `--porcelain` is the stable form, and untracked files count: a file
      // the commit does not describe is exactly what `dirty` is asked about.
      git(["status", "--porcelain", "--untracked-files=normal"]),
    ]);
    return {
      status: "available",
      value: { repository: top, branch, commit, dirty: status.length > 0 },
    };
  } catch {
    // The repository is there; something about reading it is not. A
    // half-filled record would be worse than saying so.
    return { status: "unavailable", reason: "not_captured" };
  }
}

function timedOut(failure: unknown): boolean {
  return (
    failure !== null &&
    typeof failure === "object" &&
    ("killed" in failure ? failure.killed === true : false)
  );
}

/** Whether the process never started, as opposed to starting and refusing.
 *
 *  Read off `code`, which `child_process` sets to the errno name, rather
 *  than matched against the message: a sentence is a thing that gets
 *  reworded, and a probe keyed on one would go back to answering
 *  `not_applicable` the day it did. */
function spawnFailed(failure: unknown): boolean {
  return (
    failure !== null &&
    typeof failure === "object" &&
    "code" in failure &&
    failure.code === "ENOENT"
  );
}
