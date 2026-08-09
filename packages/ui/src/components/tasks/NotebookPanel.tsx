import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KernelEnvStatus,
  KernelMessage,
  Language,
  NotebookCell,
  RunningKernel,
} from "@lykeion/api";
import { useApi } from "../../api/ApiContext";
import { useDirectory } from "../../hooks/useDirectory";
import { useOutsideClick } from "../../hooks/useOutsideClick";
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

/**
 * What a context is called on its own tab.
 *
 * The identity's `name` and nothing derived from it. A session id is the only
 * other thing a kernel carries that could stand here, and it is a word this
 * lab minted for its own bookkeeping — putting it in front of a researcher
 * names nothing they have ever seen. `"main"` is the one value with a reading
 * better than itself: it is the session's own context, as opposed to a
 * delegated subagent's, and that is what it is called.
 */
function contextLabel(name: string): string {
  return name === "main" ? "Main agent" : name;
}

/** Every language this context has a kernel for or a cell from.
 *
 *  The union rather than the live kernels alone: a kernel that expired took
 *  its process, not its record, and a chip row built from processes would
 *  drop the language whose cells are still on screen underneath it. */
function languagesOf(ctx: Context): Language[] {
  const seen = new Set<Language>();
  for (const k of ctx.kernels) seen.add(k.language);
  for (const c of ctx.cells) seen.add(c.language);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** The kernel a context's strip and REPL speak for, given the selected
 *  language. Undefined when this context has run that language before and
 *  holds no process for it now, which the surface states rather than
 *  quietly substituting another kernel's. */
function kernelFor(ctx: Context, language: Language | null): RunningKernel | undefined {
  const ordered = [...ctx.kernels].sort(
    (a, b) => a.language.localeCompare(b.language) || a.id.localeCompare(b.id),
  );
  if (language === null) return ordered[0];
  return ordered.find((k) => k.language === language);
}

function languageLabel(language: Language): string {
  return language === "r" ? "R" : "Python";
}

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
  const [activeLang, setActiveLang] = useState<Language | null>(null);
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

  const contexts = useMemo(() => buildContexts(kernels, cells), [kernels, cells]);

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

  const interrupt = useCallback(async () => {
    if (!selectedKernel) return;
    try {
      await api.kernelInterrupt(selectedKernel.id);
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

      {/* Context first, language second, on one line: the tabs choose which
          notebook is on screen and the chips choose which of that notebook's
          kernels the strip and REPL below speak for. */}
      {(contexts.length > 0 || languages.length > 1) && (
        <div className="nbp-axis">
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
          {languages.length > 1 && (
            <div
              className="nbp-langs"
              role="radiogroup"
              aria-label="Kernel language"
              data-testid="notebook-langs"
            >
              {languages.map((lang) => (
                <button
                  key={lang}
                  type="button"
                  role="radio"
                  aria-checked={lang === shownLang}
                  className={`nbp-lang${lang === shownLang ? " is-active" : ""}`}
                  onClick={() => setActiveLang(lang)}
                >
                  {languageLabel(lang)}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

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

      {selectedKernel ? (
        <KernelStrip
          kernel={selectedKernel}
          onRestart={() => void restart()}
          onInterrupt={() => void interrupt()}
        />
      ) : (
        shownLang !== null && (
          <div className="nbp-strip nbp-strip--idle" data-testid="notebook-strip">
            <span className="nbp-strip-lang">{languageLabel(shownLang)} kernel</span>
            <span className="nbp-strip-state">not running</span>
          </div>
        )
      )}

      {selectedContext && (
        <div className="nbp-footer" data-testid="notebook-footer">
          <span>
            {contextLabel(selectedContext.name)}
            {selectedKernel && " — writable"}
          </span>
          <span className="nbp-footer-count">
            {selectedContext.cells.length === 1
              ? "1 cell"
              : `${selectedContext.cells.length} cells`}
          </span>
        </div>
      )}

      <div className="nbp-repl">
        {/* Conditional, because with no kernel in scope this is the one
            outright false sentence the surface could carry: there is nothing
            connected, and nothing shares a namespace with anything. */}
        <p className="nbp-greeting">
          {selectedKernel ? (
            <>
              Connected to the agent&rsquo;s live kernel — variables and state
              are shared.
            </>
          ) : shownLang !== null ? (
            <>
              This context ran {languageLabel(shownLang)} here. Nothing is
              holding that namespace now, so there is nothing to run against.
            </>
          ) : (
            <>Nothing has run code on this Task yet.</>
          )}
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
            placeholder={selectedKernel ? "df.shape" : "No kernel to run against"}
            value={repl}
            disabled={replBusy || !selectedKernel}
            onChange={(e) => setRepl(e.target.value)}
            onKeyDown={onReplKey}
          />
          {/* While a cell is in flight the same slot carries the way to end
              it. A researcher who has just started something that will not
              come back needs the control then, not in a menu they have to
              find with the surface busy. */}
          {replBusy || selectedKernel?.state === "running" ? (
            <button
              type="button"
              className="nbp-run nbp-run--stop"
              onClick={() => void interrupt()}
              disabled={!selectedKernel}
            >
              Interrupt
            </button>
          ) : (
            <button
              type="button"
              className="nbp-run"
              onClick={() => void runCell()}
              disabled={repl.trim().length === 0 || !selectedKernel}
            >
              Run
            </button>
          )}
        </div>
      </div>
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

/** One context sub-tab: a state dot for its kernel and the context's name. */
function ContextTab({
  ctx,
  active,
  onSelect,
}: {
  ctx: Context;
  active: boolean;
  onSelect: () => void;
}) {
  const kernel = kernelFor(ctx, null);
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
      <span className="nbp-ctxtab-label">{contextLabel(ctx.name)}</span>
    </button>
  );
}

/**
 * The live-kernel strip: which kernel the REPL below runs in — its language,
 * the environment it is in, whether the agent is in the same namespace, where
 * it stands, and its lifecycle controls behind one menu.
 */
function KernelStrip({
  kernel,
  onRestart,
  onInterrupt,
}: {
  kernel: RunningKernel;
  onRestart: () => void;
  onInterrupt: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useOutsideClick(menuRef, () => setMenuOpen(false), menuOpen);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <div className="nbp-strip" data-testid="notebook-strip">
      <span className="nbp-strip-lang">{languageLabel(kernel.language)} kernel</span>
      <span className="nbp-strip-env">{kernel.environment}</span>
      <span className="nbp-strip-shared">shared with the agent</span>
      <span className={`nbp-strip-state nbp-strip-state--${kernel.state}`}>
        {kernel.state}
      </span>
      <div className="nbp-strip-menu" ref={menuRef}>
        <button
          type="button"
          ref={triggerRef}
          className="nbp-strip-more"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Kernel actions"
          onClick={() => setMenuOpen((o) => !o)}
        >
          ⋯
        </button>
        {menuOpen && (
          <div className="nbp-strip-menulist" role="menu" aria-label="Kernel actions">
            {/* Only while something is running: interrupting an idle kernel
                reaches a cell that has already ended, and offering it then
                promises an effect it cannot have. */}
            {kernel.state === "running" && (
              <button
                type="button"
                role="menuitem"
                className="nbp-strip-menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onInterrupt();
                }}
              >
                Interrupt
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              className="nbp-strip-menuitem"
              onClick={() => {
                setMenuOpen(false);
                onRestart();
              }}
            >
              Restart
              <span className="nbp-strip-menunote">clears every variable</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Who ran a cell, as far as this lab can say.
 *
 *  A researcher's own cell carries their member id, which the directory turns
 *  into the name their colleagues know them by. An agent's carries the agent's
 *  own id, which is already the word a researcher reads everywhere else. A
 *  member the directory has not heard of is named as unknown rather than as
 *  their id: an identifier in this position reads as a name, and it is not. */
function CellBy({ cell }: { cell: NotebookCell }) {
  const directory = useDirectory();
  const { surface, by } = cell.origin;
  if (surface === "agent") return <>agent · {by}</>;
  if (!directory.loaded) return <>repl</>;
  const user = directory.user(by);
  return <>repl · {user ? user.displayName : "unknown member"}</>;
}

/** One cell: the execution counter, its language and who ran it, over the
 *  code it ran, with its output folded away until asked for. */
function CellView({ cell }: { cell: NotebookCell }) {
  const label = cell.executionCount > 0 ? cell.executionCount : " ";
  return (
    <div className={`nbp-cell${cell.ok ? "" : " nbp-cell--err"}`}>
      {/* The cell's OWN language — a context can itself run Python and R side
          by side, so each cell highlights under its own grammar and says
          which one in its own header rather than inheriting the strip's. */}
      <CodeBlock
        code={cell.source}
        lang={cell.language}
        lineNumbers
        meta={
          <span className="nbp-cell-meta">
            <span className="nbp-gutter">In [{label}]</span>
            <span className="nbp-cell-lang">{cell.language}</span>
            <span className="nbp-cell-by">
              <CellBy cell={cell} />
            </span>
          </span>
        }
      />
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
