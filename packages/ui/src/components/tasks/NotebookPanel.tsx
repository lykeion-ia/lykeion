import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KernelEnvStatus,
  Language,
  NotebookCell,
  RunningKernel,
} from "@lykeion/api";
import { useApi } from "../../api/ApiContext";
import { CloseIcon, NotebookIcon } from "../icons";
import { NotebookAxis } from "./NotebookAxis";
import { NotebookConsoleDock } from "./NotebookConsoleDock";
import { NotebookLedger } from "./NotebookLedger";
import {
  buildNotebookContexts,
  contextLabel,
  kernelFor,
  languagesOf,
} from "./notebook-model";
import "./notebook.css";

/** How often the strip re-reads kernels + the notebook document while open. */
const POLL_MS = 1500;

/**
 * The right-rail Notebook tab: every cell this Task's sessions have run, as
 * one execution ledger in the order it happened, grouped into sub-tabs by the
 * context (kernel identity `name`) that ran it.
 *
 * The two axes are not the same kind of thing and are not rendered as though
 * they were. A context is a separate notebook — its own namespace, its own
 * cells — so choosing one changes what is on screen. A language is a second
 * kernel *inside* the selected context, so choosing one changes which kernel
 * the strip describes and the REPL runs in, and leaves the ledger alone: the
 * order the work happened in is the one thing a record of it has to keep, and
 * splitting the list by language would be the surface deciding a researcher
 * no longer wants to know what ran between two of their own cells.
 */
interface NotebookPanelProps {
  taskId: string;
  sessionLabel: string;
  onClose?: () => void;
  embedded?: boolean;
}

/** A Task identity owns every piece of notebook authority. The keyed inner
 *  component makes a prop change a synchronous state boundary: no cell,
 *  kernel, draft, warning, or selected context from the previous Task can be
 *  rendered while the next Task's reads are still in flight. */
export function NotebookPanel(props: NotebookPanelProps) {
  return <NotebookPanelForTask key={props.taskId} {...props} />;
}

function NotebookPanelForTask({
  taskId,
  sessionLabel,
  onClose,
  embedded,
}: NotebookPanelProps) {
  const api = useApi();
  const requestGeneration = useRef(0);
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [cellsLoaded, setCellsLoaded] = useState(false);
  const [cellsWarning, setCellsWarning] = useState<string | null>(null);
  const [kernels, setKernels] = useState<RunningKernel[]>([]);
  const [kernelsWarning, setKernelsWarning] = useState<string | null>(null);
  const [envStatus, setEnvStatus] = useState<KernelEnvStatus | null>(null);
  const [envs, setEnvs] = useState<KernelEnvStatus[]>([]);
  const [activeEnv, setActiveEnv] = useState<string | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [activeLang, setActiveLang] = useState<Language | null>(null);
  const [repl, setRepl] = useState("");
  const [autoOpenCellId, setAutoOpenCellId] = useState<string | null>(null);
  const [replBusy, setReplBusy] = useState(false);
  const [replError, setReplError] = useState<string | null>(null);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupLog, setSetupLog] = useState<string[]>([]);

  // A keyed Task change unmounts this state owner. Invalidate every read it
  // started before any late completion can attempt to publish stale truth.
  useEffect(
    () => () => {
      requestGeneration.current += 1;
    },
    [],
  );

  const refreshCells = useCallback(async () => {
    const generation = requestGeneration.current;
    try {
      const nextCells = await api.taskNotebook(taskId);
      if (generation !== requestGeneration.current) return;
      setCells(nextCells);
      setCellsLoaded(true);
      setCellsWarning(null);
    } catch {
      if (generation !== requestGeneration.current) return;
      setCellsLoaded(true);
      setCellsWarning(
        "Could not refresh the notebook. Showing the last confirmed cells.",
      );
    }
  }, [api, taskId]);

  const refreshKernels = useCallback(async () => {
    const generation = requestGeneration.current;
    try {
      const all = await api.listRunningKernels();
      if (generation !== requestGeneration.current) return;
      setKernels(all.filter((k) => k.taskId === taskId));
      setKernelsWarning(null);
    } catch {
      if (generation !== requestGeneration.current) return;
      setKernels([]);
      setKernelsWarning("Kernel status is unavailable. Code execution is disabled.");
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
      // in the list, so a live poll doesn't yank the researcher's choice.
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

  const contexts = useMemo(() => buildNotebookContexts(kernels, cells), [kernels, cells]);

  useEffect(() => {
    setActiveName((cur) =>
      cur && contexts.some((c) => c.name === cur) ? cur : (contexts[0]?.name ?? null),
    );
  }, [contexts]);

  const selectedContext = contexts.find((c) => c.name === activeName) ?? null;
  const languages = useMemo(
    () => (selectedContext ? languagesOf(selectedContext) : []),
    [selectedContext],
  );

  // A selection that leaves the set falls back to the context's own first
  // kernel rather than to nothing, so a language whose kernel expired under a
  // poll hands the strip to the one still running instead of blanking it.
  useEffect(() => {
    setActiveLang((cur) => (cur !== null && languages.includes(cur) ? cur : null));
  }, [languages]);

  const selectedKernel = selectedContext ? kernelFor(selectedContext, activeLang) : undefined;
  // What the chip row shows as chosen. `activeLang` is null until a
  // researcher picks one, and the row still has to mark the language whose
  // kernel the strip below it is describing.
  const shownLang = activeLang ?? selectedKernel?.language ?? languages[0] ?? null;
  const cellsToShow = selectedContext?.cells ?? [];

  // Freshness is a one-shot instruction. The matching CellView has already
  // initialized open in this commit; consuming the id keeps a later unmount
  // and remount from overriding the researcher's manual disclosure choice.
  useEffect(() => {
    if (
      autoOpenCellId !== null &&
      cellsToShow.some((cell) => cell.id === autoOpenCellId)
    ) {
      setAutoOpenCellId(null);
    }
  }, [autoOpenCellId, cellsToShow]);

  const runSetup = useCallback(async () => {
    setSetupBusy(true);
    setSetupError(null);
    setSetupLog([]);
    try {
      // Provision the SELECTED env — `activeEnv` is null only before the
      // first `kernelEnvList` read resolves, in which case the command's
      // own default applies.
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

  const runCell = useCallback(async () => {
    const code = repl.trim();
    if (!code || replBusy || !selectedKernel) return;
    setReplBusy(true);
    setReplError(null);
    try {
      // Returns only the id the cell will be recorded under — the executed
      // cell itself arrives on the next `taskNotebook` poll, the same way an
      // agent's does.
      const result = await api.kernelExecute(selectedKernel.id, code);
      setAutoOpenCellId(result.cellId);
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

  const interrupt = useCallback(async () => {
    if (!selectedKernel) return;
    try {
      await api.kernelInterrupt(selectedKernel.id);
      await refreshKernels();
    } catch (e) {
      setReplError(e instanceof Error ? e.message : String(e));
    }
  }, [api, selectedKernel, refreshKernels]);

  return (
    <section className="notebook-panel" data-testid="notebook-panel">
      {embedded !== true && (
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
      )}

      <NotebookAxis
        contexts={contexts}
        activeContext={activeName}
        onContextChange={setActiveName}
        languages={languages}
        activeLanguage={shownLang}
        onLanguageChange={setActiveLang}
        sessionLabel={sessionLabel}
      />

      <NotebookLedger
        cells={cellsToShow}
        loading={!cellsLoaded}
        warning={cellsWarning}
        autoOpenCellId={autoOpenCellId}
        contextLabel={selectedContext ? contextLabel(selectedContext.name) : null}
        writable={selectedKernel !== undefined}
      />

      {needsSetup && (
        <SetupState
          busy={setupBusy}
          error={setupError}
          log={setupLog}
          envs={envs}
          activeEnv={activeEnv}
          onPickEnv={setActiveEnv}
          onSetup={runSetup}
        />
      )}

      {kernelsWarning && (
        <p className="nbp-warning" role="status">
          {kernelsWarning}
        </p>
      )}

      <NotebookConsoleDock
        kernel={selectedKernel}
        language={shownLang}
        contextName={selectedContext?.name ?? null}
        code={repl}
        busy={replBusy}
        error={replError}
        onCodeChange={setRepl}
        onRun={() => void runCell()}
        onInterrupt={() => void interrupt()}
        onRestart={() => void restart()}
      />
    </section>
  );
}

/** The managed-env surface before provisioning: which environment, and the
 *  one control that provisions it. */
function SetupState({
  busy,
  error,
  log,
  envs,
  activeEnv,
  onPickEnv,
  onSetup,
}: {
  busy: boolean;
  error: string | null;
  log: string[];
  envs: KernelEnvStatus[];
  activeEnv: string | null;
  onPickEnv: (name: string) => void;
  onSetup: () => void;
}) {
  return (
    <div className="nbp-setup" data-testid="notebook-setup">
      <div className="nbp-setup-row">
        <span className="nbp-setup-lead">
          No managed environment is provisioned. Provisioning installs an
          isolated interpreter and its scientific base — a few hundred MB on
          first run, and nothing already on this machine is touched.
        </span>
        <button
          type="button"
          className="nbp-setup-btn"
          onClick={onSetup}
          disabled={busy}
        >
          {busy ? "Setting up…" : "Set up environment"}
        </button>
      </div>
      {/* One control per environment the core actually reports. Never a
          hardcoded pair: an environment appears here when something says it
          exists, and on a machine that reports none there is nothing to
          choose between and the row does not render. */}
      {envs.length > 0 && (
        <div className="nbp-envpick" role="tablist" aria-label="Kernel environment">
          {envs.map((env) => (
            <button
              key={env.name}
              type="button"
              role="tab"
              aria-selected={env.name === activeEnv}
              className={`nbp-envchip${env.name === activeEnv ? " is-active" : ""}`}
              onClick={() => onPickEnv(env.name)}
            >
              {env.name}
            </button>
          ))}
        </div>
      )}
      {error && <p className="nbp-repl-error">{error}</p>}
      {log.length > 0 && <pre className="nbp-setup-log">{log.join("\n")}</pre>}
    </div>
  );
}
