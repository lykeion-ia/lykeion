import { cliBrand, cliInk, cliName } from "../../lib/cli-brand";

/**
 * Who the Task is talking to, named at the head of its own surface — the
 * coding agent's brand mark and the brand's own name for itself.
 *
 * A Task is one continuous conversation with one agent, so this is a fact
 * about the whole page rather than about any one turn in it, which is why it
 * rides in the breadcrumb strip. The Study list already leads every row with
 * the same mark (`TaskGlyph`, StudyScreen.tsx); without this, opening a Task
 * lost a fact the list had shown.
 *
 * The mark is drawn bare and in its brand's ink, not on the filled tile the
 * composer's CLI dock wears. The strip is chrome standing on the page's own
 * background, and a filled brand chip beside the trail would read as the
 * loudest thing in a row whose job is to be quiet. Brands whose mark is black
 * or white have no ink of their own to be in and keep the strip's — see
 * `cliInk`.
 *
 * Renders nothing without an agent. A Task nobody has run is on no agent, and
 * an empty strip is the honest drawing of that.
 */
export function AgentLabel({
  agent,
  name,
}: {
  /** An `AgentCli.id`, read off the Task's newest turn. */
  agent?: string;
  /** What detection calls this CLI. Absent falls back to `cliName` — the
   *  agent a turn ran on need not be installed on the machine now reading
   *  the Task, so there is not always a detected name to ask for. */
  name?: string;
}) {
  if (agent === undefined) return null;
  const label = name ?? cliName(agent);
  const brand = cliBrand(agent, label);
  const Mark = brand.icon;
  const ink = cliInk(agent);
  return (
    <span className="task-agent-label">
      {/* Decorative: the name it stands for is written right beside it. */}
      <span
        className="task-agent-mark"
        aria-hidden="true"
        {...(ink ? { style: { color: ink } } : {})}
      >
        {Mark ? <Mark className="task-agent-glyph" /> : brand.mono}
      </span>
      {label}
    </span>
  );
}

export default AgentLabel;
