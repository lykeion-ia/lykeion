import { describe } from "vitest";
import { join } from "node:path";
import { acpConformance } from "./acp-conformance";

const STUB = join(import.meta.dirname, "test-support", "stub-acp-agent.ts");

/**
 * One script, played back the same way regardless of which of
 * `acpConformance`'s prompts arrives — the stub does not read prompt text, so
 * this has to carry everything every behaviour needs: prose, a tool call, a
 * plan, and a permission ask, in an order where each behaviour's own
 * `waitFor` finds what it is looking for before the rest of the script even
 * matters to it.
 *
 * The final `wait` step is what makes `session/cancel` mean something here.
 * Left alone, it lets the turn finish normally half a second later — long
 * enough for the permission-card behaviour to answer the ask above it and
 * still see the turn complete. Cut short by a stop, it ends the turn
 * `cancelled` instead: stopping a turn abandons whatever card is still open,
 * which is what unblocks the ask above this step, so cancellation has
 * already been noted by the time this step is reached either way.
 */
const SCRIPT = [
  { emit: "agent_message_chunk", text: "Looking at the directory now." },
  { emit: "tool_call", toolCallId: "list-1", title: "List files", rawInput: {} },
  { emit: "tool_call_update", toolCallId: "list-1", status: "completed", content: "a.txt\nb.txt" },
  {
    emit: "plan",
    entries: [
      { content: "Inspect the directory", status: "completed" },
      { content: "Report back", status: "pending" },
    ],
  },
  { ask: "permission", toolCallId: "write-1", title: "Write /tmp/lykeion-conformance-stub/probe.txt" },
  { wait: "cancel", timeoutMs: 500 },
  { emit: "agent_message_chunk", text: "Done." },
  { endTurn: "end_turn" },
];

acpConformance("stub", () => ({
  command: process.execPath,
  args: ["--experimental-strip-types", STUB],
  env: { ...process.env, LYKEION_STUB_SCRIPT: JSON.stringify(SCRIPT) },
}));

// Real adapters need credentials and a network, so they cannot gate a commit
// — a suite that tries to spawn one of these on a machine that has not
// installed and signed into it by hand would fail there for a reason that
// has nothing to do with what changed.
//
// Two separately published binaries speak ACP for Claude Code:
// `claude-code-acp`, whose maintainer marks it deprecated, and its successor
// `claude-agent-acp`. Both are held to this suite rather than guessing which
// one a given machine has installed. Which binary this daemon spawns for
// `claude` is a separate question, and not this suite's to answer.
const certify = process.env.LYKEION_CERTIFY_ADAPTERS === "1";
(certify ? describe : describe.skip)("certified adapters", () => {
  acpConformance("claude-code-acp", () => ({ command: "claude-code-acp", args: [] }));
  acpConformance("claude-agent-acp", () => ({ command: "claude-agent-acp", args: [] }));
  acpConformance("codex-acp", () => ({ command: "codex-acp", args: [] }));
});
