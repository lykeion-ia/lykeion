import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  KernelEnvStatus,
  KernelMessage,
  Language,
  NotebookCell,
  RunningKernel,
} from "@lykeion/api";
import { useApi } from "../../api/ApiContext";
import { CodeBlock } from "./CodeBlock";
import { CloseIcon, NotebookIcon } from "../icons";

/** How often the strip re-reads kernels + the notebook document while open. */
const POLL_MS = 1500;

/**
 * One name shared by every kernel and cell that ran under it — the grouping
 * axis a researcher actually thinks in: `"main"` for a session's own work, or
 * a delegated subagent's own name.
 */
interface Context {
  name: string;
  kernels: RunningKernel[];
  cells: NotebookCell[];
}

function buildContexts(kernels: RunningKernel[], cells: NotebookCell[]): Context[] {
  const names = new Set<string>();
  for (const k of kernels) names.add(k.name);
  for (const c of cells) names.add(c.name);
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      kernels: kernels.filter((k) => k.name === name),
      cells: cells.filter((c) => c.name === name),
    }));
}

/** The kernel a context's tab and strip speak for. A context ordinarily holds
 *  one; when it holds more (one per language a session writes), the
 *  languages sort first and `id` breaks any tie, so the pick is stable
 *  across polls regardless of the order `listRunningKernels` answers in. */
function primaryKernel(ctx: Context): RunningKernel | undefined {
  return [...ctx.kernels].sort(
    (a, b) => a.language.localeCompare(b.language) || a.id.localeCompare(b.id),
  )[0];
}

/** The one session every kernel in this context belongs to, or `undefined`
 *  when they don't agree — `taskNotebook` and `listRunningKernels` group by
 *  `name` alone, so a context can span more than one session, and naming
 *  just one of them as "the" session would be a claim the data doesn't back. */
function sharedSessionId(kernels: RunningKernel[]): string | undefined {
  const ids = new Set(kernels.map((k) => k.sessionId));
  return ids.size === 1 ? kernels[0].sessionId : undefined;
}

function languageLabel(language: Language): string {
  return language === "r" ? "R" : "Python";
}

/**
 * The right-rail Notebook tab: every cell this Task's sessions have run,
 * grouped into sub-tabs by the context (kernel identity `name`) that ran it,
 * with a strip naming the selected context's kernel, a footer counting
 * what's on screen, and a REPL that runs a cell on that same kernel — the
 * *same* namespace the agent's own tool calls run in.
 *
 * The managed environment is a separate surface, offered above the cells
 * while the core reports it unprovisioned and never in front of them: a cell
 * is a record of work that already ran, on a kernel the machine started out
 * of whatever interpreter it has, and none of it waits on an environment
 * this lab has yet to provision.
 */
export function NotebookPanel({
  taskId,
  onClose,
}: {
  taskId: string;
  onClose?: () => void;
}) {
  const api = useApi();
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [kernels, setKernels] = useState<RunningKernel[]>([]);
  const [envStatus, setEnvStatus] = useState<KernelEnvStatus | null>(null);
  const [envs, setEnvs] = useState<KernelEnvStatus[]>([]);
  const [activeEnv, setActiveEnv] = useState<string | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [repl, setRepl] = useState("");
  const [replBusy, setReplBusy] = useState(false);
  const [replError, setReplError] = useState<string | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupLog, setSetupLog] = useState<string[]>([]);

  const refreshCells = useCallback(async () => {
    try {
      setCells(await api.taskNotebook(taskId));
    } catch {
      /* transient — the next poll retries */
    }
  }, [api, taskId]);

  const refreshKernels = useCallback(async () => {
    try {
      const all = await api.listRunningKernels();
      setKernels(all.filter((k) => k.taskId === taskId));
    } catch {
      /* transient — the next poll retries */
    }
  }, [api, taskId]);

  const refreshEnvStatus = useCallback(async () => {
    try {
      setEnvStatus(await api.kernelEnvStatus());
    } catch {
      /* transient — the next poll retries */
    }
  }, [api]);

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

  // Poll the document, the running kernels, the env status and the env list
  // while the panel is mounted, so the agent's cells appear as they run.
  useEffect(() => {
    let alive = true;
    void refreshCells();
    void refreshKernels();
    void refreshEnvStatus();
    void refreshEnvs();
    const t = setInterval(() => {
      if (!alive) return;
      void refreshCells();
      void refreshKernels();
      void refreshEnvStatus();
      void refreshEnvs();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [refreshCells, refreshKernels, refreshEnvStatus, refreshEnvs]);

  const contexts = useMemo(() => buildContexts(kernels, cells), [kernels, cells]);

  useEffect(() => {
    setActiveName((cur) =>
      cur && contexts.some((c) => c.name === cur) ? cur : (contexts[0]?.name ?? null),
    );
  }, [contexts]);

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
      await refreshEnvs();
      await refreshEnvStatus();
    } catch (e) {
      setSetupError(e instanceof Error ? e.message : String(e));
    } finally {
      setSetupBusy(false);
    }
  }, [api, activeEnv, refreshEnvs, refreshEnvStatus]);

  // Whether the managed environment has still to be provisioned. It decides
  // whether the Setup surface is offered and nothing else: the cells, their
  // tabs, the kernel strip and the REPL all describe kernels a machine is
  // already holding, and gating them on this would hide every one of them
  // behind a button that provisions an environment none of them is in.
  const needsSetup = envStatus !== null && envStatus.state !== "ready";

  const selectedContext = contexts.find((c) => c.name === activeName) ?? null;
  const selectedKernel = selectedContext ? primaryKernel(selectedContext) : undefined;
  const cellsToShow = selectedContext?.cells ?? [];

  const runCell = useCallback(async () => {
    const code = repl.trim();
    if (!code || replBusy || !selectedKernel) return;
    setReplBusy(true);
    setReplError(null);
    try {
      // Returns only the id the cell will be recorded under — the executed
      // cell itself arrives on the next `taskNotebook` poll, the same way an
      // agent's does.
      await api.kernelExecute(selectedKernel.id, code);
      setRepl("");
    } catch (e) {
      setReplError(e instanceof Error ? e.message : String(e));
    } finally {
      setReplBusy(false);
    }
  }, [api, repl, replBusy, selectedKernel]);

  const restart = useCallback(async () => {
    if (!selectedKernel) return;
    try {
      await api.kernelRestart(selectedKernel.id);
      await refreshKernels();
    } catch (e) {
      setReplError(e instanceof Error ? e.message : String(e));
    }
  }, [api, selectedKernel, refreshKernels]);

  const onReplKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void runCell();
    }
  };

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

      {needsSetup && (
        <SetupState
          busy={setupBusy}
          error={setupError}
          log={setupLog}
          onSetup={runSetup}
        />
      )}

      <div className="nbp-ctxtabs" role="tablist" aria-label="Kernel context">
        {contexts.map((ctx) => (
          <ContextTab
            key={ctx.name}
            ctx={ctx}
            active={ctx.name === activeName}
            onSelect={() => setActiveName(ctx.name)}
          />
        ))}
      </div>

      <div className="nbp-cells" data-testid="notebook-cells">
        {cellsToShow.length === 0 ? (
          <p className="nbp-empty">
            No cells yet. Ask the agent to run code, or wait for this context's
            kernel to start one — each context keeps its own namespace.
          </p>
        ) : (
          cellsToShow.map((cell) => <CellView key={cell.id} cell={cell} />)
        )}
      </div>

      {selectedKernel && (
        <KernelStrip
          kernel={selectedKernel}
          session={sharedSessionId(selectedContext?.kernels ?? [])}
          onRestart={() => void restart()}
        />
      )}

      {selectedContext && (
        <div className="nbp-footer" data-testid="notebook-footer">
          {selectedContext.name} ·{" "}
          {selectedContext.cells.length === 1
            ? "1 cell"
            : `${selectedContext.cells.length} cells`}
        </div>
      )}

      <div className="nbp-repl">
        <p className="nbp-greeting">
          Connected to the agent's live kernel — variables and state are shared.
        </p>
        {replError && <p className="nbp-repl-error">{replError}</p>}
        <div className="nbp-prompt">
          <span className="nbp-caret" aria-hidden="true">
            &gt;&gt;&gt;
          </span>
          <textarea
            className="nbp-input"
            rows={2}
            aria-label={
              selectedKernel
                ? `Run ${languageLabel(selectedKernel.language)} on this kernel`
                : "Run code on this kernel"
            }
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
            disabled={replBusy || repl.trim().length === 0 || !selectedKernel}
          >
            {replBusy ? "Running…" : "Run"}
          </button>
        </div>
      </div>
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

/** One context sub-tab: a state dot for its kernel, its session + name, and
 *  a language chip row when it holds more than one kernel. */
function ContextTab({
  ctx,
  active,
  onSelect,
}: {
  ctx: Context;
  active: boolean;
  onSelect: () => void;
}) {
  const kernel = primaryKernel(ctx);
  const session = sharedSessionId(ctx.kernels);
  const label = session ? `${session} · ${ctx.name}` : ctx.name;
  const languages = [...new Set(ctx.kernels.map((k) => k.language))].sort((a, b) =>
    a.localeCompare(b),
  );
  return (
    <button
      type="button"
      className={`nbp-ctxtab${active ? " is-active" : ""}`}
      role="tab"
      aria-selected={active}
      onClick={onSelect}
    >
      {kernel && (
        <span
          className={`nbp-ctxtab-dot nbp-ctxtab-dot--${kernel.state}`}
          aria-hidden="true"
        />
      )}
      <span className="nbp-ctxtab-label">{label}</span>
      {ctx.kernels.length > 1 && (
        <span className="nbp-ctxtab-langs">
          {languages.map((l) => (
            <span key={l} className="nbp-ctxtab-lang">
              {l}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

/** The live-kernel strip: which kernel the selected context's cells belong
 *  to — its language, its session (when every kernel in the context shares
 *  one), where it stands, and Restart. */
function KernelStrip({
  kernel,
  session,
  onRestart,
}: {
  kernel: RunningKernel;
  session?: string;
  onRestart: () => void;
}) {
  return (
    <div className="nbp-strip" data-testid="notebook-strip">
      <span className="nbp-strip-lang">{languageLabel(kernel.language)} kernel</span>
      {session && <span className="nbp-strip-session">{session}</span>}
      <span className="nbp-strip-state">{kernel.state}</span>
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
      className={`nbp-cell nbp-cell--${cell.origin.surface}${cell.ok ? "" : " nbp-cell--err"}`}
    >
      <div className="nbp-cell-head">
        <span className="nbp-gutter" aria-hidden="true">
          In [{label}]
        </span>
        <span className="nbp-cell-by">
          {cell.origin.surface === "agent" ? "agent" : "you"}
        </span>
      </div>
      {/* The cell's OWN language — a context can itself run Python and R
          side by side, so each cell highlights under its own grammar. */}
      <CodeBlock code={cell.source} lang={cell.language} />
      {cell.outputs.length > 0 && (
        <details className="nbp-output-wrap">
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

/** One `Record` of a kernel message's payload, or nothing when the message
 *  carries none. Every one of these crossed a machine this browser did not
 *  write and a store that keeps them as opaque JSON, so a message naming a
 *  kind this build does not know reaches here with no payload at all —
 *  indexing that would throw during render and take the whole Task screen
 *  down for everyone looking at it, over one cell's output. */
function payload(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** Render one kernel message the way a notebook does: text mono, errors red, a
 *  figure inline, a spilled payload as a path note. */
function OutputView({ out }: { out: KernelMessage }) {
  if (out.kind === "stream") {
    return <pre className="nbp-out nbp-stream">{out.text}</pre>;
  }
  if (out.kind === "error") {
    const tb = Array.isArray(out.traceback) ? out.traceback.join("\n") : "";
    return (
      <pre className="nbp-out nbp-error">
        {tb || `${out.ename}: ${out.evalue}`}
      </pre>
    );
  }
  // execute_result / display_data: image first, then text/plain, then spills.
  const data = payload(out.data);
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
  const refs = payload(out.data_ref);
  const refKeys = Object.keys(refs);
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
