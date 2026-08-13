import { afterEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { namingDir, summarizeTask } from "./naming";

const STUB = join(import.meta.dirname, "test-support", "stub-acp-agent.ts");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDirs(): { cwd: string; dataDir: string } {
  const workDir = mkdtempSync(join(tmpdir(), "lykeion-naming-"));
  dirs.push(workDir);
  const dataDir = mkdtempSync(join(tmpdir(), "lykeion-naming-state-"));
  dirs.push(dataDir);
  return { cwd: namingDir(workDir), dataDir };
}

/** Summarizes through a stub agent playing `script`. Everything a real
 *  naming passes is passed here too, so what these tests exercise is the
 *  same session a machine really opens — only the far end is scripted. */
function summarize(
  script: unknown[],
  options: { prompt?: string; deadlineMs?: number; adapter?: { command: string; args: string[] } } = {},
): Promise<string | null> {
  const { cwd, dataDir } = freshDirs();
  return summarizeTask({
    adapter: options.adapter ?? { command: process.execPath, args: ["--experimental-strip-types", STUB] },
    agent: "stub",
    prompt:
      options.prompt ??
      "Use the live Python kernel. Run one cell that sets values = list(range(30)) and prints each.",
    cwd,
    dataDir,
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    env: { ...process.env },
    extraEnv: { LYKEION_STUB_SCRIPT: JSON.stringify(script) },
  });
}

it("answers with what the agent said, joined and trimmed", async () => {
  await expect(
    summarize([
      { emit: "agent_message_chunk", text: "Python kernel " },
      { emit: "agent_message_chunk", text: "range check\n" },
    ]),
  ).resolves.toBe("Python kernel range check");
});

it("hands the agent the researcher's message and nothing else", async () => {
  // The stub echoes back what it was prompted with, which is the only way to
  // see from outside what a summarizer is actually shown.
  const prompt = "Rewrite the loader so it streams instead of reading the whole file into memory.";
  const answer = await summarize([{ emit: "echo_prompt" }], { prompt });
  expect(answer).toContain(prompt);
  expect(answer).toContain("at most six words");
});

it("says no to a permission request rather than leaving the turn waiting on a person", async () => {
  // There is nobody to ask. A card left unanswered would hold this session
  // open to its deadline and produce nothing; refused, the agent carries on
  // and still names the Task.
  const answer = await summarize([
    { ask: "permission", toolCallId: "call_1", title: "Read /Users/ana/thesis/data.csv" },
    { emit: "agent_message_chunk", text: "Streaming loader rewrite" },
  ]);
  expect(answer).toBe("Streaming loader rewrite");
});

it("answers null when the agent says nothing at all", async () => {
  await expect(summarize([])).resolves.toBeNull();
});

it("answers null, and leaves nothing running, when the adapter never speaks ACP", async () => {
  // A program that starts and sits there is the hardest hang: the handshake
  // has nothing to time it out on its own. The deadline has to cover
  // launching the adapter, not just answering.
  const started = Date.now();
  await expect(
    summarize([], {
      deadlineMs: 300,
      adapter: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60_000)"] },
    }),
  ).resolves.toBeNull();
  expect(Date.now() - started).toBeLessThan(10_000);
});

it("answers null for an adapter that is not a program at all", async () => {
  await expect(
    summarize([], { adapter: { command: "lykeion-no-such-agent-binary", args: [] } }),
  ).resolves.toBeNull();
});

it("stands in a directory of its own, holding nothing of the researcher's", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "lykeion-naming-where-"));
  dirs.push(workDir);
  const dir = namingDir(workDir);
  expect(existsSync(dir)).toBe(true);
  expect(dir.startsWith(workDir)).toBe(true);
  expect(dir).not.toContain("studies");
});
