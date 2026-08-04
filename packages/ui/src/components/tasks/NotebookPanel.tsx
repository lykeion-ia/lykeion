import { useCallback, useEffect, useState } from "react";
import type {
  KernelEnvStatus,
  KernelMessage,
  Language,
  NotebookCell,
  NotebookStatus,
} from "@lykeion/api";
import { useApi } from "../../api/ApiContext";
import { CodeBlock } from "./CodeBlock";
import { CloseIcon, NotebookIcon } from "../icons";

/** How often the strip re-reads kernel status + the document while open. */
const POLL_MS = 1500;

/**
 * The right-rail Notebook tab: a live REPL onto the Study's shared Python
 * kernel — the *same* namespace the agent's `run_python` calls run in — plus the
 * accumulated cell log (agent + researcher, interleaved) and a live-kernel strip.
 *
 * The kernel is Study-scoped, so every Task in a Study opens onto one kernel;
 * that is why the strip says "shared with the agent" rather than naming a
 * session. Until the managed env is provisioned the panel shows a Setup state
 * (nothing faked — the honest first-install surface).
 */
export function NotebookPanel({
  studyId,
  onClose,
}: {
  studyId: string;
  onClose?: () => void;
}) {
  const api = useApi();
  const [status, setStatus] = useState<NotebookStatus | null>(null);
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [envs, setEnvs] = useState<KernelEnvStatus[]>([]);
  const [activeEnv, setActiveEnv] = useState<string | null>(null);
  const [repl, setRepl] = useState("");
  const [replBusy, setReplBusy] = useState(false);
  const [replError, setReplError] = useState<string | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupLog, setSetupLog] = useState<string[]>([]);

  // The active env sub-tab selects the execution language. Fresh install (no
  // envs yet, activeEnv null) falls through to "python" so onboarding still
  // works — no-mock-data means only a real "r" env (from kernelEnvList) ever
  // produces an "r" tab, never an invented one.
  const language: Language = activeEnv === "r" ? "r" : "python";

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.kernelStatus(studyId, language));
    } catch {
      /* transient — the next poll retries */
    }
  }, [api, studyId, language]);

  const refreshDoc = useCallback(async () => {
    try {
      setCells(await api.kernelDocument(studyId));
    } catch {
      /* transient */
    }
  }, [api, studyId]);

  const refreshEnvs = useCallback(async () => {
    try {
      const list = await api.kernelEnvList();
      setEnvs(list);
      // Default to the first env; keep the current selection if it's still
      // in the list, so a live poll doesn't yank the researcher's tab.
      setActiveEnv((cur) =>
        cur && list.some((e) => e.name === cur) ? cur : (list[0]?.name ?? null),
      );
    } catch {
      /* transient — the next poll retries */
    }
  }, [api]);

  // Poll status + reload the document while the panel is mounted, so the
  // agent's cells appear as they run and the strip tracks busy/idle live.
  useEffect(() => {
    let alive = true;
    void refreshStatus();
    void refreshDoc();
    void refreshEnvs();
    const t = setInterval(() => {
      if (!alive) return;
      void refreshStatus();
      void refreshDoc();
      void refreshEnvs();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [refreshStatus, refreshDoc, refreshEnvs]);

  const runCell = useCallback(async () => {
    const code = repl.trim();
    if (!code || replBusy) return;
    setReplBusy(true);
    setReplError(null);
    try {
      await api.kernelExecute(studyId, code, language);
      setRepl("");
      await refreshDoc();
      await refreshStatus();
    } catch (e) {
      setReplError(e instanceof Error ? e.message : String(e));
    } finally {
      setReplBusy(false);
    }
  }, [api, studyId, repl, replBusy, refreshDoc, refreshStatus, language]);

  const runSetup = useCallback(async () => {
    setSetupBusy(true);
    setSetupError(null);
    setSetupLog([]);
    try {
      // Provision the ACTIVE tab's env — `activeEnv` is null only before the
      // first `kernelEnvList` read resolves, in which case the command's
      // own default ("python") applies.
      await api.kernelEnvSetup(activeEnv ?? undefined, (line) =>
        setSetupLog((l) => [...l.slice(-200), line]),
      );
      await refreshStatus();
    } catch (e) {
      setSetupError(e instanceof Error ? e.message : String(e));
    } finally {
      setSetupBusy(false);
    }
  }, [api, activeEnv, refreshStatus]);

  const restart = useCallback(async () => {
    try {
      setStatus(await api.kernelRestart(studyId, language));
      await refreshDoc();
    } catch (e) {
      setReplError(e instanceof Error ? e.message : String(e));
    }
  }, [api, studyId, refreshDoc, language]);

  const onReplKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void runCell();
    }
  };

  const needsSetup = status !== null && !status.envReady;

  return (
    <section className="notebook-panel" data-testid="notebook-panel">
      <header className="art-header">
        <span className="art-title">
          <NotebookIcon />
          Notebook
        </span>
        {onClose && (
          <button
            type="button"
            className="art-icon-btn"
            title="Close notebook"
            aria-label="Close notebook"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        )}
      </header>

      {/* Environment sub-tab strip — one tab per real env the core reports. */}
      <div
        className="nbp-envtabs"
        role="tablist"
        aria-label="Kernel environment"
      >
        {envs.map((env) => (
          <button
            key={env.name}
            type="button"
            className={`nbp-envtab${env.name === activeEnv ? " is-active" : ""}`}
            role="tab"
            aria-selected={env.name === activeEnv}
            onClick={() => setActiveEnv(env.name)}
          >
            {env.name}
          </button>
        ))}
      </div>

      {needsSetup ? (
        <SetupState
          busy={setupBusy}
          error={setupError}
          log={setupLog}
          onSetup={runSetup}
        />
      ) : (
        <>
          <div className="nbp-cells" data-testid="notebook-cells">
            {cells.length === 0 ? (
              <p className="nbp-empty">
                No cells yet. Run one below, or ask the agent to run Python —
                both land in this one shared namespace.
              </p>
            ) : (
              cells.map((cell, i) => <CellView key={i} cell={cell} />)
            )}
          </div>

          <KernelStrip status={status} onRestart={restart} />

          <div className="nbp-repl">
            <p className="nbp-greeting">
              Connected to the agent's live kernel — variables and state are
              shared.
            </p>
            {replError && <p className="nbp-repl-error">{replError}</p>}
            <div className="nbp-prompt">
              <span className="nbp-caret" aria-hidden="true">
                &gt;&gt;&gt;
              </span>
              <textarea
                className="nbp-input"
                rows={2}
                aria-label={`Run ${language === "r" ? "R" : "Python"} on the shared kernel`}
                placeholder="df.shape"
                value={repl}
                disabled={replBusy}
                onChange={(e) => setRepl(e.target.value)}
                onKeyDown={onReplKey}
              />
              <button
                type="button"
                className="nbp-run"
                onClick={() => void runCell()}
                disabled={replBusy || repl.trim().length === 0}
              >
                {replBusy ? "Running…" : "Run"}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/** The managed-env Setup state — the honest surface before provisioning. */
function SetupState({
  busy,
  error,
  log,
  onSetup,
}: {
  busy: boolean;
  error: string | null;
  log: string[];
  onSetup: () => void;
}) {
  return (
    <div className="nbp-setup" data-testid="notebook-setup">
      <p className="nbp-setup-lead">
        The managed Python environment isn't set up yet. Provisioning installs
        an isolated interpreter and a scientific base (numpy, pandas,
        matplotlib) — a few hundred MB on first run. Nothing on your machine is
        touched.
      </p>
      <button
        type="button"
        className="nbp-setup-btn"
        onClick={onSetup}
        disabled={busy}
      >
        {busy ? "Setting up…" : "Set up environment"}
      </button>
      {error && <p className="nbp-repl-error">{error}</p>}
      {log.length > 0 && <pre className="nbp-setup-log">{log.join("\n")}</pre>}
    </div>
  );
}

/** The live-kernel strip: an activity meter · shared-kernel label · counter ·
 *  Restart. The meter sweeps while the kernel is `busy` and rests otherwise —
 *  the live-activity indicator. */
function KernelStrip({
  status,
  onRestart,
}: {
  status: NotebookStatus | null;
  onRestart: () => void;
}) {
  const state = status?.launched ? status.state : "idle";
  const count = status?.executionCount ?? 0;
  return (
    <div className="nbp-strip" data-testid="notebook-strip">
      <span
        className={`nbp-meter nbp-meter--${state}`}
        data-testid="notebook-meter"
        aria-hidden="true"
      >
        <span className="nbp-meter-fill" />
      </span>
      <span className="nbp-strip-label">
        Python kernel · shared with the agent
      </span>
      <span className="nbp-strip-state">{state}</span>
      <span className="nbp-strip-count">In [{count}]</span>
      <button
        type="button"
        className="nbp-restart"
        onClick={onRestart}
        title="Restart the kernel (clears every variable)"
      >
        Restart
      </button>
    </div>
  );
}

/** One cell: an `In [n]` gutter + highlighted source, then a collapsible output. */
function CellView({ cell }: { cell: NotebookCell }) {
  const label = cell.executionCount > 0 ? cell.executionCount : " ";
  return (
    <div
      className={`nbp-cell nbp-cell--${cell.surface}${cell.ok ? "" : " nbp-cell--err"}`}
    >
      <div className="nbp-cell-head">
        <span className="nbp-gutter" aria-hidden="true">
          In [{label}]
        </span>
        <span className="nbp-cell-by">
          {cell.surface === "agent" ? "agent" : "you"}
        </span>
      </div>
      {/* The cell's OWN language — the document is mixed (a Study can run a
          Python and an R kernel side by side), so hardcoding one highlighter
          rendered R cells with Python's tokenizer. */}
      <CodeBlock code={cell.source} lang={cell.language} />
      {cell.outputs.length > 0 && (
        <details className="nbp-output-wrap" open>
          <summary className="nbp-output-summary">output</summary>
          <div className="nbp-outputs">
            {cell.outputs.map((out, i) => (
              <OutputView key={i} out={out} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** Render one kernel message the way a notebook does: text mono, errors red, a
 *  figure inline, a spilled payload as a path note. */
function OutputView({ out }: { out: KernelMessage }) {
  if (out.kind === "stream") {
    return <pre className="nbp-out nbp-stream">{out.text}</pre>;
  }
  if (out.kind === "error") {
    const tb = out.traceback.join("\n");
    return (
      <pre className="nbp-out nbp-error">
        {tb || `${out.ename}: ${out.evalue}`}
      </pre>
    );
  }
  // execute_result / display_data: image first, then text/plain, then spills.
  const data = out.data as Record<string, unknown>;
  const png = data["image/png"];
  if (typeof png === "string") {
    const b64 = png.replace(/\s+/g, "");
    return (
      <div className="nbp-out nbp-image">
        <img src={`data:image/png;base64,${b64}`} alt="cell output" />
      </div>
    );
  }
  const text = data["text/plain"];
  if (typeof text === "string") {
    return <pre className="nbp-out nbp-result">{text}</pre>;
  }
  const refs = out.data_ref as Record<string, unknown>;
  const refKeys = Object.keys(refs ?? {});
  if (refKeys.length > 0) {
    return (
      <pre className="nbp-out nbp-result">
        {refKeys
          .map((mime) => {
            const meta = refs[mime] as { path?: string } | undefined;
            return `[${mime} → ${meta?.path ?? ".lykeion/outputs"}]`;
          })
          .join("\n")}
      </pre>
    );
  }
  return null;
}
