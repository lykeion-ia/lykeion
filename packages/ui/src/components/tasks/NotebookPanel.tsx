import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  KernelEnvDeclaration,
  Language,
  MachineCompute,
  NotebookCell,
  ResearchEnvironmentDefault,
  RunningKernel,
  Machine,
  TaskEnvironmentSetup,
} from "@lykeion/api";
import { useApi, useDataVersion, useInvalidateData } from "../../api/ApiContext";
import { CloseIcon, NotebookIcon } from "../icons";
import { EnvironmentBar } from "./EnvironmentBar";
import { NotebookAxis } from "./NotebookAxis";
import { NotebookStatusBar } from "./NotebookStatusBar";
import { NotebookLedger } from "./NotebookLedger";
import {
  buildNotebookContexts,
  kernelFor,
  languageLabel,
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
 * cells — so choosing one changes which notebook you are in. A language is a
 * second kernel *inside* the selected context, so choosing one is a lens on the
 * notebook you are already in: it narrows the ledger to that language's cells
 * and points the status line at that kernel.
 *
 * Which is why the lens defaults to `All` rather than to a language. The order
 * the work happened in is the one thing a record of it has to keep, so the
 * interleaved list is what the panel opens on; narrowing to one language is
 * something the researcher asks for, and one click returns the rest.
 */
interface NotebookPanelProps {
  taskId: string;
  sessionLabel: string;
  /** What this Task's Research has confirmed it defaults to, per language.
   *  Passed in rather than read here: the screen above already holds the
   *  Research, and a second read for one soft preference would be a second
   *  answer to go stale. Absent on a Task whose Research has not been read —
   *  which is not the same as a Research with no default, so nothing here
   *  treats it as one. */
  environmentDefaults?: ResearchEnvironmentDefault[];
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
  environmentDefaults,
  onClose,
  embedded,
}: NotebookPanelProps) {
  const api = useApi();
  // The app-wide read signal, both ways round: every read below re-runs when
  // it moves, and the three commands this panel sends move it once each has
  // returned. Nothing here derives a setup state to fill the gap in between.
  const version = useDataVersion();
  const invalidate = useInvalidateData();
  const requestGeneration = useRef(0);
  const [cells, setCells] = useState<NotebookCell[]>([]);
  const [cellsLoaded, setCellsLoaded] = useState(false);
  const [cellsWarning, setCellsWarning] = useState<string | null>(null);
  const [kernels, setKernels] = useState<RunningKernel[]>([]);
  const [kernelsWarning, setKernelsWarning] = useState<string | null>(null);
  /** What each paired machine last reported, `null` until the first read
   *  lands. `null` is not `[]`: a lab nobody has asked yet and a lab with no
   *  paired machine are different facts, and only the second is worth saying
   *  out loud. */
  const [machines, setMachines] = useState<MachineCompute[] | null>(null);
  /** Names for the machines above, so a researcher choosing between two of
   *  them is choosing between "laptop" and "workstation" rather than between
   *  two opaque ids. Missing names fall back to the id rather than to
   *  nothing — an unnamed machine is still a machine that can be picked. */
  const [pairedMachines, setPairedMachines] = useState<Machine[]>([]);
  /** Which machine the researcher chose, on a Task with no kernel running
   *  and more than one machine to choose between. Nothing infers this: a
   *  guess here is the product silently deciding which of a member's several
   *  paired computers downloads a gigabyte. */
  const [pickedMachine, setPickedMachine] = useState<string | null>(null);
  /** The lab's declarations, `null` until the first read lands. `null` is not
   *  `[]` for the same reason it is not on `machines`: a lab nobody has asked
   *  yet and a lab that has declared nothing are different facts, and the bar
   *  below states the second one out loud. */
  const [envs, setEnvs] = useState<KernelEnvDeclaration[] | null>(null);
  /** Which environment the researcher chose, keyed by the language lens they
   *  chose it under. Per language because the lens IS which language they are
   *  working in: a choice made while reading the R cells is not an answer
   *  about what the Python ones should run in. */
  const [chosenEnv, setChosenEnv] = useState<Record<string, string>>({});
  /** Every durable setup this Task has, exactly as the server projects them.
   *  This is the whole of what this panel knows about provisioning — there is
   *  no second copy here to disagree with it, and no local flag that a press
   *  flips ahead of the server. */
  const [setups, setSetups] = useState<TaskEnvironmentSetup[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [activeLang, setActiveLang] = useState<Language | null>(null);
  /** Why the last Interrupt or Restart did not happen. Kept visible rather
   *  than swallowed: those are the two controls on this surface that act, and
   *  one that silently fails reads as one that did nothing. */
  const [kernelError, setKernelError] = useState<string | null>(null);

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

  const refreshMachines = useCallback(async () => {
    // Settled apart rather than together. These two reads are not worth the
    // same: `computeSnapshot` is what the whole build surface is made of,
    // while `listMachines` supplies only the machines' display names and the
    // id fallback below already covers its absence. Sharing one rejection
    // would let a failed name lookup throw away a snapshot that arrived, and
    // the panel would go silent about builds because a label was missing.
    //
    // Neither failure clears what was last read: a failed poll is not this
    // lab losing its machines, and the next tick retries.
    const [compute, paired] = await Promise.allSettled([
      api.computeSnapshot(),
      api.listMachines(),
    ]);
    if (compute.status === "fulfilled") setMachines(compute.value);
    if (paired.status === "fulfilled") setPairedMachines(paired.value);
  }, [api]);

  const refreshEnvs = useCallback(async () => {
    try {
      setEnvs(await api.kernelEnvList());
    } catch {
      /* transient — the next poll retries */
    }
  }, [api]);

  /** What the server says is being built for this Task, and the only place
   *  this panel learns it. Never cleared on a failed read: a poll that did
   *  not answer is not a Task with no builds, and blanking the bar on one
   *  would be this surface guessing about the very thing it does not own. */
  const refreshSetups = useCallback(async () => {
    const generation = requestGeneration.current;
    try {
      const next = await api.taskEnvironmentSetups(taskId);
      if (generation !== requestGeneration.current) return;
      setSetups(next);
    } catch {
      /* transient — the next poll retries */
    }
  }, [api, taskId]);

  // Poll the document, the running kernels, the machines, the env list and
  // this Task's setups while the panel is mounted, so the agent's cells
  // appear as they run and a build moves without anybody pressing anything.
  //
  // `version` is in the dependency list, so every write anywhere in the app —
  // including this panel's own Set up, once its command has returned, and
  // including a change the server pushed down the change stream — re-reads
  // all five at once rather than waiting out the poll.
  useEffect(() => {
    let alive = true;
    const readAll = () => {
      void refreshCells();
      void refreshKernels();
      void refreshMachines();
      void refreshEnvs();
      void refreshSetups();
    };
    readAll();
    const t = setInterval(() => {
      if (alive) readAll();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [refreshCells, refreshKernels, refreshMachines, refreshEnvs, refreshSetups, version]);

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
  // The ledger through the language lens. `activeLang` is null for `All`, which
  // is the resting state — NOT `shownLang`, which always names a language once
  // a kernel exists and would open the panel on half its own record.
  const cellsToShow = useMemo(() => {
    const all = selectedContext?.cells ?? [];
    return activeLang === null
      ? all
      : all.filter((cell) => cell.language === activeLang);
  }, [selectedContext, activeLang]);

  /** The distinct machines this Task's own kernels are running on. One of
   *  them is an answer; two of them are a question. Taking the first of two
   *  would be the same silent pick this surface exists to refuse, wearing a
   *  running kernel as its excuse. */
  const runningMachines = useMemo(
    () => [...new Set(kernels.map((k) => k.machineId).filter((id) => id !== ""))],
    [kernels],
  );

  // Which machine an environment would be built on.
  //
  // A kernel already running for this Task names its own runtime, and that
  // IS the machine this Task executes on — taken outright, with no choice
  // offered, but only where this Task's running kernels agree on one. With
  // none running the snapshot decides: exactly one machine is not an
  // inference, several is a question for the researcher, and none is a fact
  // to state rather than a button to offer. A phase-4 ruling stands behind
  // every case that ends in a question — inferring the machine would be this
  // product silently choosing which of a member's several paired computers
  // downloads a gigabyte.
  const chosenMachineId = useMemo(() => {
    if (runningMachines.length === 1) return runningMachines[0] ?? null;
    if (runningMachines.length === 0 && machines?.length === 1)
      return machines[0]?.machineId ?? null;
    return machines?.find((m) => m.machineId === pickedMachine)?.machineId ?? null;
  }, [runningMachines, machines, pickedMachine]);

  /** The machines a build could be sent to, by the name their owner gave
   *  them. A researcher choosing between two is choosing between "laptop"
   *  and "workstation", not between two opaque ids — and a machine whose
   *  name this poll could not read is still offered, under the id, rather
   *  than dropped for want of a label. */
  const machineOptions = useMemo(
    () =>
      (machines ?? []).map((m) => ({
        machineId: m.machineId,
        label: pairedMachines.find((r) => r.id === m.machineId)?.name ?? m.machineId,
      })),
    [machines, pairedMachines],
  );

  /**
   * Which language's choice of environment this is.
   *
   * Keyed on `shownLang` — the notebook's EFFECTIVE language, the one the
   * status bar is describing — rather than on the raw lens. `All` is a lens
   * on the ledger, not a third language to have an opinion about: reading a
   * Python notebook unnarrowed and then narrowing it to Python is the same
   * notebook, and a choice made in one of those must not be forgotten in the
   * other. `"all"` is reached only where `shownLang` is null, which is a Task
   * that has run no code in any language at all.
   */
  const langKey = shownLang ?? "all";

  /** What this Research has confirmed for the language being viewed, if
   *  anything. Soft: it seeds the selection and is overridden the moment the
   *  researcher picks something else. */
  const researchDefault = useMemo(() => {
    if (shownLang === null) return undefined;
    return environmentDefaults?.find((d) => d.language === shownLang)?.environmentName;
  }, [environmentDefaults, shownLang]);

  /**
   * Which environment the bar is about.
   *
   * Four rules in order, and the first is the researcher's own: a choice they
   * made stands until the environment leaves this lab's declarations, which
   * is the only thing that can make it stop naming anything. Then what this
   * Research confirmed, then the language's starter — the one Lykeion itself
   * declared, which carries no `createdBy` — and only then the first
   * declaration, preferring one of the language being viewed, because an R
   * notebook opening onto a Python environment because Python happened to be
   * declared first is the panel answering a question nobody asked.
   */
  const selectedEnv = useMemo(() => {
    const declared = envs ?? [];
    if (declared.length === 0) return null;
    const declaredHas = (name: string | undefined): name is string =>
      name !== undefined && declared.some((e) => e.name === name);
    const chosen = chosenEnv[langKey];
    if (declaredHas(chosen)) return chosen;
    if (declaredHas(researchDefault)) return researchDefault;
    if (shownLang !== null) {
      const starter = declared.find(
        (e) => e.language === shownLang && e.createdBy === undefined,
      );
      if (starter) return starter.name;
      const firstOfLanguage = declared.find((e) => e.language === shownLang);
      if (firstOfLanguage) return firstOfLanguage.name;
    }
    return declared[0]?.name ?? null;
  }, [envs, chosenEnv, langKey, researchDefault, shownLang]);

  /**
   * What the chosen machine reports about the chosen environment.
   *
   * `undefined` is this surface not knowing, in either of the two ways it can
   * fail to: that machine has said nothing at all
   * (`MachineCompute.environments` absent), or it reported a list this
   * environment is not in — which a declaration made since its last report
   * looks exactly like. Neither is the same fact as a machine reporting it
   * holds none, which is `state: "absent"`, and the bar is required to tell
   * that apart from both. The two silences are treated alike on purpose: a
   * build offered on the strength of either would be asking for a gigabyte on
   * the strength of not having been told, and the next report settles it.
   */
  const envStatus = useMemo(() => {
    if (selectedEnv === null || chosenMachineId === null) return undefined;
    return machines
      ?.find((m) => m.machineId === chosenMachineId)
      ?.environments?.find((e) => e.name === selectedEnv);
  }, [machines, chosenMachineId, selectedEnv]);

  /** The durable setup for exactly this environment on exactly this machine,
   *  latest report first. A Task can have several — one per environment it
   *  has ever asked for — and a bar showing another one's progress would be
   *  describing a build the researcher is not looking at. */
  const selectedSetup = useMemo(() => {
    if (selectedEnv === null || chosenMachineId === null) return undefined;
    return setups
      .filter(
        (s) =>
          s.job.environmentName === selectedEnv && s.job.machineId === chosenMachineId,
      )
      .sort((a, b) => b.job.updatedTs - a.job.updatedTs)[0];
  }, [setups, selectedEnv, chosenMachineId]);

  /**
   * Ask the server to provision it. A direct press IS the authorization for
   * this disclosed operation, so no agent permission card stands between the
   * researcher and their own button.
   *
   * The read signal moves only once the command has answered, and nothing
   * here writes a state in the meantime: the job that comes back down is the
   * first and only word on whether this is building.
   */
  const requestSetup = useCallback(async () => {
    if (chosenMachineId === null || selectedEnv === null) return;
    await api.requestKernelEnvironmentSetup({
      taskId,
      machineId: chosenMachineId,
      environmentName: selectedEnv,
    });
    invalidate();
  }, [api, taskId, chosenMachineId, selectedEnv, invalidate]);

  const retrySetup = useCallback(
    async (waiterId: string) => {
      await api.retryKernelEnvironmentSetup(waiterId);
      invalidate();
    },
    [api, invalidate],
  );

  const answerSuggestion = useCallback(
    async (suggestionId: string, useByDefault: boolean) => {
      await api.answerEnvironmentDefaultSuggestion(suggestionId, useByDefault);
      invalidate();
    },
    [api, invalidate],
  );

  const restart = useCallback(async () => {
    if (!selectedKernel) return;
    setKernelError(null);
    try {
      await api.kernelRestart(selectedKernel.id);
      await refreshKernels();
    } catch (e) {
      setKernelError(e instanceof Error ? e.message : String(e));
    }
  }, [api, selectedKernel, refreshKernels]);

  const interrupt = useCallback(async () => {
    if (!selectedKernel) return;
    setKernelError(null);
    try {
      await api.kernelInterrupt(selectedKernel.id);
      await refreshKernels();
    } catch (e) {
      setKernelError(e instanceof Error ? e.message : String(e));
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
        // The raw pick, not `shownLang`: the chips mark what the researcher
        // chose, and `All` is a choice `shownLang` cannot express.
        activeLanguage={activeLang}
        onLanguageChange={setActiveLang}
        sessionLabel={sessionLabel}
      />

      <NotebookLedger
        cells={cellsToShow}
        loading={!cellsLoaded}
        warning={cellsWarning}
        // Nothing on this surface runs a cell any more, so there is never one
        // freshly executed to open. The ledger keeps the capability — a cell
        // that failed still opens itself — and this is simply no longer a
        // caller of it.
        autoOpenCellId={null}
        {...(activeLang !== null
          ? {
              emptyNote: `No ${languageLabel(activeLang)} cells in this context. Choose All to see the rest.`,
            }
          : {})}
      />

      {/* The one environment control, and the one place a build is asked
          for. Drawn once both the lab's declarations and the machines'
          snapshot have landed: before that there is no true sentence for it
          to say, and "no machine is paired with this lab" is a false one to
          flash at somebody whose laptop is about to appear in it. */}
      {envs !== null && machines !== null && (
        <EnvironmentBar
          taskId={taskId}
          language={shownLang}
          environments={envs}
          selectedEnvironment={selectedEnv}
          {...(researchDefault === undefined ? {} : { defaultEnvironment: researchDefault })}
          machineOptions={machineOptions}
          selectedMachineId={chosenMachineId}
          {...(envStatus === undefined ? {} : { status: envStatus })}
          {...(selectedSetup === undefined ? {} : { setup: selectedSetup })}
          onSelectEnvironment={(name) =>
            setChosenEnv((chosen) => ({ ...chosen, [langKey]: name }))
          }
          onSelectMachine={setPickedMachine}
          onSetup={requestSetup}
          onRetry={retrySetup}
          onAnswerSuggestion={answerSuggestion}
        />
      )}

      {kernelsWarning && (
        <p className="nbp-warning" role="status">
          {kernelsWarning}
        </p>
      )}

      {kernelError && (
        <p className="nbp-warning" role="alert">
          {kernelError}
        </p>
      )}

      <NotebookStatusBar
        kernel={selectedKernel}
        language={shownLang}
        cellCount={cellsToShow.length}
        onInterrupt={() => void interrupt()}
        onRestart={() => void restart()}
      />
    </section>
  );
}
