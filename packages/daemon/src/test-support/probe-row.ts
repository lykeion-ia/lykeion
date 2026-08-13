import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectAcp } from "../acp";
import { confinedRunCommand } from "../agent-auth";
import { resolveOnPath } from "../command-path";
import { confinedEnv } from "../confined-env";

/**
 * One instrument for researching a catalogue row, rather than eleven
 * improvisations.
 *
 * The ten rows still to be declared each need the same facts answered, and
 * those facts are about somebody else's program — they cannot be invented
 * here, only gathered. What can be made consistent is HOW they are gathered:
 * asked the same way, confined the same way, and recorded in the same shape
 * whether a row is researched today or in six months.
 *
 * Everything here runs inside the same boundary a real run gets. That is not
 * ceremony: an unresearched CLI is one nobody yet knows the storage habits of,
 * and the whole reason this project exists is that running one unconfined
 * against the researcher's own home is how their credentials get read.
 */
export interface RowFindings {
  command: string;
  onPath: boolean;
  /** The realpath the command resolves to, which is what a boundary is
   *  rendered against — a version-manager shim and its target are different
   *  programs, and the second is the one that runs. */
  resolved?: string;
  version?: string;
  /**
   * Which candidate variable actually moved this CLI's configuration home.
   *
   * Decided the way rung 5 decides it: point the variable at a directory
   * created empty a moment ago and ask who is signed in. A CLI that honours
   * the variable cannot be signed in there. One that still reports an account
   * is reading from somewhere else, and there is only one somewhere else it
   * could be.
   */
  homeEnv?: string;
  /** What each candidate produced from that empty home, so a researcher can
   *  read the answer rather than trust this function's reading of it. */
  answers: Array<{ candidate: string; stdout: string; stderr: string; failed?: string }>;
  /** Whether the CLI completes an ACP `initialize` handshake under the flag
   *  it was asked about. */
  speaksAcp: boolean;
  acpDetail?: string;
}

/** How long a single question gets before it counts as unanswered. */
const ASK_TIMEOUT_MS = 10_000;
const ACP_TIMEOUT_MS = 10_000;

/**
 * Anything long enough and unstructured enough to be a secret, replaced by its
 * length and shape.
 *
 * A status command answers with an account, and sometimes with rather more
 * than that. These findings are read by a person and pasted into a commit
 * message, so a token that survived this far would be one this research had
 * published. Redacted on the way out rather than trusted not to appear.
 */
function withoutSecrets(text: string): string {
  return text.replace(/[A-Za-z0-9_\-.]{20,}/g, (match) => `<redacted:${match.length} chars>`);
}

/**
 * Ask one CLI everything a catalogue row needs to know.
 *
 * `statusArgs` is required, and the plan's own signature omitted it. It cannot
 * be defaulted: the whole point of asking is to find out how this CLI answers,
 * and a harness that guessed `["auth", "status"]` would record a usage error
 * as evidence about the CLI's storage. Question 3 — how is it asked who it is
 * signed in as — is answered by a human reading `--help` before this runs, and
 * this is what checks that answer against the program.
 */
export async function probeRow(
  command: string,
  homeEnvCandidates: readonly string[],
  statusArgs: readonly string[],
  acpArgs: readonly string[] = ["--acp"],
): Promise<RowFindings> {
  const path = process.env.PATH ?? "";
  const resolved = await resolveOnPath(command, path);
  if (resolved === undefined)
    return { command, onPath: false, answers: [], speaksAcp: false };

  const dataDir = mkdtempSync(join(tmpdir(), "lykeion-probe-row-state-"));
  const run = confinedRunCommand({ dataDir, path, timeoutMs: ASK_TIMEOUT_MS });
  const findings: RowFindings = {
    command,
    onPath: true,
    resolved,
    answers: [],
    speaksAcp: false,
  };

  try {
    try {
      const version = await run(command, ["--version"], {});
      findings.version = withoutSecrets(`${version.stdout}${version.stderr}`.trim());
    } catch (err) {
      findings.version = `did not answer: ${err instanceof Error ? err.message : String(err)}`;
    }

    for (const candidate of homeEnvCandidates) {
      // Created empty a moment ago, so "signed in" here can only mean the
      // variable was ignored. Removed afterwards whatever happened.
      const scratch = mkdtempSync(join(tmpdir(), "lykeion-probe-row-home-"));
      try {
        const answer = await run(command, statusArgs, { [candidate]: scratch });
        findings.answers.push({
          candidate,
          stdout: withoutSecrets(answer.stdout.trim()),
          stderr: withoutSecrets(answer.stderr.trim()),
        });
      } catch (err) {
        findings.answers.push({
          candidate,
          stdout: "",
          stderr: "",
          failed: err instanceof Error ? err.message : String(err),
        });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }

    // Deliberately not decided here. Which answer means "signed out" is the
    // row's own `read` closure, and writing a second reader in the harness
    // would give a row two definitions that could disagree — the exact fault
    // rung 5 exists to catch. `homeEnv` is left for whoever reads `answers`.

    findings.speaksAcp = await asksAndAnswers(resolved, acpArgs, findings);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }

  return findings;
}

/**
 * Whether this command completes an ACP `initialize` under `acpArgs`.
 *
 * Asked with a real request rather than by waiting for a greeting. An ACP
 * server speaks when spoken to — a harness that spawned it and watched for
 * output would time out against a correctly-behaved adapter and record it as
 * not speaking the protocol.
 */
async function asksAndAnswers(
  resolved: string,
  acpArgs: readonly string[],
  findings: RowFindings,
): Promise<boolean> {
  const cwd = mkdtempSync(join(tmpdir(), "lykeion-probe-row-acp-"));
  let connection: Awaited<ReturnType<typeof connectAcp>> | undefined;
  try {
    connection = await connectAcp(resolved, [...acpArgs], {
      cwd,
      env: confinedEnv(undefined),
    });
    const answered = await Promise.race([
      connection.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("no answer within 10s")), ACP_TIMEOUT_MS),
      ),
    ]);
    findings.acpDetail = withoutSecrets(JSON.stringify(answered)).slice(0, 400);
    return true;
  } catch (err) {
    findings.acpDetail = withoutSecrets(
      `${err instanceof Error ? err.message : String(err)} ${connection?.stderrTail() ?? ""}`.trim(),
    ).slice(0, 400);
    return false;
  } finally {
    await connection?.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}
