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
 *
 * `DENIED` and `NONE` open the very first chunk rather than trailing near
 * `endTurn`: both credential-denial and empty-floor behaviours stop waiting
 * the moment any assistant text arrives, so a token placed later would never
 * have landed by the time each behaviour reads what was said. They are also
 * the stub's own true answers, not stand-ins for one: it is confined with no
 * home and no skill system at all — see `agent: "stub"` below.
 */
const SCRIPT = [
  { emit: "agent_message_chunk", text: "DENIED. NONE. Looking at the directory now." },
  { emit: "tool_call", toolCallId: "list-1", title: "List files", rawInput: {} },
  { emit: "tool_call_update", toolCallId: "list-1", status: "completed", content: "a.txt\nb.txt" },
  {
    emit: "plan",
    entries: [
      { content: "Inspect the directory", status: "completed" },
      { content: "Report back", status: "pending" },
    ],
  },
  // A real call through a server the client named on `session/new`. In the
  // six behaviours whose sessions never name one, `toolServerNamed` fails
  // fast and this lands as a `failed` tool_call_update — which is itself the
  // honest shape of that situation, and nothing those behaviours wait on.
  { callTool: "conformance_probe", server: "probe", toolCallId: "probe-1", arguments: {} },
  { ask: "permission", toolCallId: "write-1", title: "Write /tmp/lykeion-conformance-stub/probe.txt" },
  { wait: "cancel", timeoutMs: 500 },
  { emit: "agent_message_chunk", text: "Done." },
  { endTurn: "end_turn" },
];

acpConformance("stub", () => ({
  command: process.execPath,
  args: ["--experimental-strip-types", STUB],
  env: { ...process.env, LYKEION_STUB_SCRIPT: JSON.stringify(SCRIPT) },
  // The stub authenticates against nothing and keeps no state of its own, so
  // it is confined with no home at all — which is also what keeps this suite
  // from quietly running with a real agent's credentials in reach.
  agent: "stub",
}));

// Real adapters need credentials and a network, so they cannot gate a commit
// — a suite that tries to spawn one of these on a machine that has not
// installed and signed into it by hand would fail there for a reason that
// has nothing to do with what changed.
//
// Two separately published binaries speak ACP for Claude Code:
// `claude-code-acp`, whose maintainer marks it deprecated, and its successor
// `claude-agent-acp`. This suite once held both, rather than guessing which
// one a given machine had installed. It now holds only the one the catalogue
// declares: `claude-code-acp` translates only `TodoWrite` into an ACP plan
// and the current CLI no longer ships that tool, so it fails "proposes a
// plan" on every run for a reason no change here can fix — see the comment
// on `adapters` in `agent-registry.ts` for the whole finding, and for what
// re-admitting it would take. Certifying an adapter this daemon will never
// spawn buys nothing and costs a permanently red suite, which is the one
// thing that stops a real failure here from being read as news.
const certify = process.env.LYKEION_CERTIFY_ADAPTERS === "1";
(certify ? describe : describe.skip)("certified adapters", () => {
  // Retried, unlike the stub: these behaviours ride a real model's choices,
  // and one unlucky turn — prose where a plan was asked for, a refusal where
  // an escalation was — must not certify an adapter broken. The stub's
  // script is deterministic, so its failures stay loud on the first try.
  const retried = { retry: 2 };
  acpConformance("claude-agent-acp", () => ({ command: "claude-agent-acp", args: [], agent: "claude" }), retried);
  acpConformance("codex-acp", () => ({ command: "codex-acp", args: [], agent: "codex" }), retried);
});
