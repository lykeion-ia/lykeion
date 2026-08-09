import { useState } from "react";
import type { RunArtifact } from "@lykeion/api";
import { AssistantMessage } from "./AssistantMessage";
import { AssistantReply, replyText } from "./AssistantReply";

/** A collapsible "Subagent: <persona>" sub-thread nested under a parent turn. */
export function SubagentThread({
  persona,
  task,
  messages,
  outputs,
  running,
}: {
  persona: string;
  task: string;
  messages: string[];
  outputs?: RunArtifact[];
  running?: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="subagent-thread" data-testid="subagent-thread">
      <button
        type="button"
        className="subagent-head"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="subagent-badge">Subagent</span>
        <span className="subagent-name">{persona}</span>
        {running && <span className="run-dot" aria-hidden="true" />}
      </button>
      {open && (
        <div className="subagent-body">
          <div className="msg msg--user">{task}</div>
          {/* A subagent's messages are the paragraphs of its one answer, and
              take one Copy between them — the same rule the parent turn's
              reply follows. */}
          <AssistantReply text={replyText(messages)}>
            {messages.map((t, i) => (
              <AssistantMessage text={t} key={i} />
            ))}
          </AssistantReply>
          {outputs && outputs.length > 0 && (
            <div className="subagent-outputs">
              {outputs.map((o) => (
                <span className="output-chip" key={o.path}>
                  {o.path}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SubagentThread;
