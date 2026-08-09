import { useState, type FormEvent } from "react";
import { DISCIPLINE_LABELS, type Workflow } from "@lykeion/api";
import { useApi } from "../api/ApiContext";
import { usePromise } from "../hooks/usePromise";
import { PhaseSpine } from "../components/workflows/PhaseSpine";
import { ScreenHeader } from "../components/ui/ScreenHeader";
import { DISCIPLINE_COLOR } from "../lib/workflow-meta";

/** Workflow detail (#/workflows/:id) — the procedure, its method, its blanks. */
export function WorkflowDetailScreen({ workflowId }: { workflowId: string }) {
  const api = useApi();
  const q = usePromise(() => api.listWorkflows(), [api]);
  const workflow = (q.data ?? []).find((w) => w.id === workflowId);

  if (q.error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-ui text-danger">
        {q.error}
      </div>
    );
  }
  if (!q.loading && !workflow) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-ui text-fg-subtle">
        Workflow not found
      </div>
    );
  }
  if (!workflow) return <div className="flex min-h-0 flex-1" aria-busy="true" />;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader title={workflow.name} />
      <div className="flex-1 overflow-auto px-5 pb-8">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6">
          <div className="flex flex-col gap-2">
            <span className="flex items-center gap-2 text-sub text-fg-muted">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: DISCIPLINE_COLOR[workflow.discipline] }}
              />
              {DISCIPLINE_LABELS[workflow.discipline]}
            </span>
            <p className="text-ui leading-relaxed text-fg-subtle">
              {workflow.description}
            </p>
          </div>

          <PhaseSpine workflow={workflow} />

          <RunForm key={workflow.id} workflow={workflow} />
        </div>
      </div>
    </div>
  );
}

/** One input per placeholder, and the prompt they expand into. */
function RunForm({ workflow }: { workflow: Workflow }) {
  const api = useApi();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      workflow.placeholders.map((p) => [p.key, p.default ?? ""]),
    ),
  );
  const [prompt, setPrompt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const build = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // Only non-empty values are sent, so a blank required field counts as
    // missing and resolution falls through: value, then default, then error.
    const sent: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value.trim() !== "") sent[key] = value;
    }
    try {
      setPrompt(await api.runWorkflow(workflow.id, sent));
    } catch (err) {
      setPrompt(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={build}>
      <h2 className="text-ui font-medium text-fg">Inputs</h2>

      {workflow.placeholders.map((ph) => {
        const id = `ph-${workflow.id}-${ph.key}`;
        return (
          <label className="flex flex-col gap-1" key={ph.key} htmlFor={id}>
            <span className="text-sub font-medium text-fg-muted">
              {ph.label}
              {ph.required && (
                <span className="text-danger" aria-hidden="true">
                  {" *"}
                </span>
              )}
            </span>
            <input
              id={id}
              value={values[ph.key] ?? ""}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [ph.key]: e.target.value }))
              }
              placeholder={
                ph.default
                  ? `Default: ${ph.default}`
                  : ph.required
                    ? "Required"
                    : "Optional"
              }
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-md border border-line bg-surface-2 px-2.5 py-2 text-ui text-fg outline-none placeholder:text-fg-subtle focus:border-line-strong"
            />
          </label>
        );
      })}

      <div className="flex justify-start">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-fg px-3.5 py-1.5 text-ui font-medium text-canvas transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Build prompt
        </button>
      </div>

      {error && (
        <p className="text-sub text-danger" role="alert">
          {error}
        </p>
      )}

      {prompt !== null && (
        <div className="flex flex-col gap-1.5">
          <div className="text-micro font-semibold uppercase tracking-[0.5px] text-fg-tertiary">
            Prompt
          </div>
          <pre
            className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-line bg-surface-2 p-3 text-sub leading-relaxed text-fg"
            data-testid="expanded-prompt"
          >
            {prompt}
          </pre>
        </div>
      )}
    </form>
  );
}

export default WorkflowDetailScreen;
