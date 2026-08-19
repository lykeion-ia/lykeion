import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  KernelEnvDeclaration,
  Language,
  MachineCompute,
  NotebookCell,
  RunningKernel,
  Machine,
} from "@lykeion/api";
import { useApi } from "../../api/ApiContext";
import { CloseIcon, NotebookIcon } from "../icons";
import { NotebookAxis } from "./NotebookAxis";
import { NotebookStatusBar } from "./NotebookStatusBar";
import { NotebookLedger } from "./NotebookLedger";
import {
  buildNotebookContexts,
  contextLabel,
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
  const [envs, setEnvs] = useState<KernelEnvDeclaration[]>([]);
  const [activeEnv, setActiveEnv] = useState<string | null>(null);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [activeLang, setActiveLang] = useState<Language | null>(null);
  /** Why the last Interrupt or Restart did not happen. Kept visible rather
   *  than swallowed: those are the two controls on this surface that act, and
   *  one that silently fails reads as one that did nothing. */
  const [kernelError, setKernelError] = useState<string | null>(null);
  /** Which environments are building right now, by name. Panel-wide would
   *  say "Setting up…" on every row while one of them builds, which is a
   *  sentence about the wrong environment: each row provisions its own, and
   *  a row nobody has pressed is not busy. */
  const [building, setBuilding] = useState<string[]>([]);
  /** Kept beside the environment each belongs to, for the same reason: two
   *  builds in flight would otherwise interleave into one log and one error
   *  line with nothing saying which is which. */
  const [setupErrors, setSetupErrors] = useState<Record<string, string>>({});
  const [setupLogs, setSetupLogs] = useState<Record<string, string[]>>({});

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

  // Poll the document, the running kernels, the machines and the env list
  // while the panel is mounted, so the agent's cells appear as they run.
  useEffect(() => {
    let alive = true;
    void refreshCells();
    void refreshKernels();
    void refreshMachines();
    void refreshEnvs();
    const t = setInterval(() => {
      if (!alive) return;
      void refreshCells();
      void refreshKernels();
      void refreshMachines();
      void refreshEnvs();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [refreshCells, refreshKernels, refreshMachines, refreshEnvs]);

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

  /** The environments a cell of the language now being viewed could actually
   *  run in. `kernelEnvList` is lab-wide and carries both languages, and an
   *  R environment is not a thing a Python cell can be run in — offering it
   *  is offering a choice whose only outcome is a refusal by name. */
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

  /** What this machine has NOT built, by name — read off the same snapshot
   *  `setupOffer` reads, so the picker and the Setup button below it cannot
   *  disagree about which environments are missing. Empty until a machine is
   *  settled on and has reported: a machine that has said nothing is not a
   *  machine holding nothing, and guessing here would put build targets in
   *  front of a researcher for environments nobody knows are absent. */
  const unbuiltHere = useMemo(() => {
    const held = machines?.find((m) => m.machineId === chosenMachineId)?.environments;
    if (held === undefined) return new Set<string>();
    return new Set(
      held.filter((e) => e.state === "absent" || e.state === "broken").map((e) => e.name),
    );
  }, [machines, chosenMachineId]);

  const envsHere = useMemo(
    () =>
      shownLang === null
        ? envs
        : envs.filter(
            (e) =>
              e.language === shownLang ||
              // Plus anything this machine has not built, whatever language
              // it is in. Selecting one is the ONLY route to building it:
              // `neededEnvs` is this notebook's cells plus the selection, an
              // environment that was never built can be in no cell, and this
              // panel holds the product's only `kernelEnvSetup` call. Scoped
              // to the viewed language alone, a Task with one Python cell
              // could not build the lab's `r` starter at all.
              //
              // Safe to offer to a cell, because there is no cell to offer it
              // to: nothing runs in an environment that does not exist here,
              // so naming one can only ever produce the refusal it already
              // produces — while leaving it out produces an environment
              // nobody can build. It leaves this list the moment it is built.
              unbuiltHere.has(e.name),
          ),
    [envs, shownLang, unbuiltHere],
  );

  // Keeps the selection inside `envsHere`. Reconciled here rather than in
  // `refreshEnvs` so switching the language lens re-picks a valid
  // environment rather than leaving the previous language's selection
  // standing. The `cur && envsHere.some(...)` guard makes this a no-op
  // whenever the current pick is already valid for the language being
  // viewed, so it does not fight the picker's own `onClick`.
  useEffect(() => {
    setActiveEnv((cur) =>
      cur && envsHere.some((e) => e.name === cur) ? cur : (envsHere[0]?.name ?? null),
    );
  }, [envsHere]);

  /** Which environments this Task needs: every one its own cells have named,
   *  and whichever one the researcher currently has selected. Derived from
   *  the cells this panel already holds — `NotebookCell.environment` names
   *  it — so the names worth offering to build are the names this notebook
   *  has actually used. */
  const neededEnvs = useMemo(() => {
    const names = new Set(cells.map((c) => c.environment).filter((name) => name !== ""));
    if (activeEnv !== null) names.add(activeEnv);
    return [...names];
  }, [cells, activeEnv]);

  /**
   * What the Setup surface has to say, or nothing at all.
   *
   * `MachineCompute.environments` being absent is the case this turns on: it
   * means the machine has NOT reported, which is not the same fact as a
   * machine holding none. A machine that has not said must not be shown as
   * one holding nothing, and must not have Setup offered for environments
   * nobody knows it lacks.
   */
  const setupOffer = useMemo<SetupOffer | null>(() => {
    if (neededEnvs.length === 0) return null;
    // Nothing read yet is not an answer — this says nothing until the first
    // snapshot lands.
    if (machines === null) return null;
    if (chosenMachineId === null) {
      if (machines.length === 0) return { kind: "nowhere" };
      return {
        kind: "choose",
        // Which silence they are being asked about: no kernel anywhere is a
        // different fact from kernels on two machines at once, and a
        // researcher reading "nothing is holding a kernel" while two of
        // theirs are would rightly stop believing this surface.
        why: runningMachines.length > 1 ? "several-machines" : "no-kernel",
        machines: machines.map((m) => ({
          machineId: m.machineId,
          label: pairedMachines.find((r) => r.id === m.machineId)?.name ?? m.machineId,
        })),
      };
    }
    const held = machines.find((m) => m.machineId === chosenMachineId)?.environments;
    if (held === undefined) return { kind: "unreported" };
    const stateOf = (name: string) => held.find((e) => e.name === name)?.state;
    // Partitioned rather than filtered on "not ready". The two are one
    // button and two different sentences: `absent` has never been built
    // here, `broken` is a provision that started and was interrupted — and
    // telling a researcher their half-built environment was never built is
    // telling them something false about their own machine.
    const absent = neededEnvs.filter((name) => stateOf(name) === "absent");
    const broken = neededEnvs.filter((name) => stateOf(name) === "broken");
    return absent.length === 0 && broken.length === 0
      ? null
      : { kind: "build", absent, broken };
  }, [neededEnvs, chosenMachineId, machines, machines, runningMachines]);

  const runSetup = useCallback(
    async (name: string) => {
      // Never inferred here: the surface offers this button only where a
      // machine has already been settled on, and a Setup with no machine to
      // name would be `kernelEnvSetup` picking one.
      if (chosenMachineId === null) return;
      // Its own row is already disabled while it builds; this is the guard
      // against a second click arriving before React has drawn that.
      if (building.includes(name)) return;
      setBuilding((names) => [...names, name]);
      setSetupErrors(({ [name]: _cleared, ...rest }) => rest);
      setSetupLogs((logs) => ({ ...logs, [name]: [] }));
      try {
        await api.kernelEnvSetup(chosenMachineId, name, (line: string) =>
          setSetupLogs((logs) => ({
            ...logs,
            [name]: [...(logs[name] ?? []).slice(-200), line],
          })),
        );
        await refreshEnvs();
        await refreshMachines();
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setSetupErrors((errors) => ({ ...errors, [name]: message }));
      } finally {
        setBuilding((names) => names.filter((n) => n !== name));
      }
    },
    [api, chosenMachineId, building, refreshEnvs, refreshMachines],
  );

  // Whether an environment this Task needs has still to be provisioned. It
  // decides whether the Setup surface is offered and nothing else: the
  // cells, their tabs, the kernel strip and the REPL all describe kernels a
  // machine is already holding, and gating them on this would hide every one
  // of them behind a button that provisions an environment none of them is
  // in.
  const needsSetup = setupOffer !== null;

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
        contextLabel={selectedContext ? contextLabel(selectedContext.name) : null}
        writable={selectedKernel !== undefined}
        {...(activeLang !== null
          ? {
              emptyNote: `No ${languageLabel(activeLang)} cells in this context. Choose All to see the rest.`,
            }
          : {})}
      />

      {/* Outside the Setup surface, deliberately. This row is the only
          control that can add a name to the set this Task needs, and inside
          a surface that renders only where an offer already exists it could
          never produce one: an environment a colleague declared and no cell
          here has used yet would have no way to be selected, and therefore
          no way to be built — on the only screen in this product where
          building happens.

          Bounded, because this panel is dense and keyboard-first: one
          declared environment for the language being viewed is already the
          selected one, so a permanent row for it would be a control with
          nothing to choose between. */}
      {envsHere.length > 1 && (
        <div className="nbp-envrow">
          <div className="nbp-envpick" role="tablist" aria-label="Kernel environment">
            {envsHere.map((env) => (
              <button
                key={env.name}
                type="button"
                role="tab"
                aria-selected={env.name === activeEnv}
                className={`nbp-envchip${env.name === activeEnv ? " is-active" : ""}`}
                onClick={() => setActiveEnv(env.name)}
              >
                {env.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {needsSetup && setupOffer !== null && (
        <SetupState
          offer={setupOffer}
          building={building}
          errors={setupErrors}
          logs={setupLogs}
          onPickMachine={setPickedMachine}
          onSetup={runSetup}
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

/**
 * What the Setup surface has to say about the environments this Task needs.
 *
 * Four different things, and none of them is a rewording of another. Only
 * `build` names something a researcher can act on; the other three each say
 * why nothing here can offer that yet, which is the honest alternative to a
 * button that cannot work.
 */
type SetupOffer =
  /** Declared in this lab, and this machine cannot start a kernel in them.
   *  Two lists rather than one: `absent` has never been built here, and
   *  `broken` is a provision that began and was interrupted. One button
   *  fixes either — `kernelEnvSetup` — and the two are owed different
   *  sentences, because "never built" is false about a half-built copy. */
  | { kind: "build"; absent: string[]; broken: string[] }
  /** The machine has not said what it holds — NOT that it holds none. */
  | { kind: "unreported" }
  /** Nothing here can name one machine: either no kernel is running to name
   *  one, or this Task's kernels name more than one. */
  | {
      kind: "choose";
      why: "no-kernel" | "several-machines";
      machines: Array<{ machineId: string; label: string }>;
    }
  /** No machine is paired with this lab at all. */
  | { kind: "nowhere" };

/** The managed-env surface: which environments this Task needs that the
 *  machine it runs on does not hold, and the one control that builds each. */
function SetupState({
  offer,
  building,
  errors,
  logs,
  onPickMachine,
  onSetup,
}: {
  offer: SetupOffer;
  building: string[];
  errors: Record<string, string>;
  logs: Record<string, string[]>;
  onPickMachine: (machineId: string) => void;
  onSetup: (name: string) => void;
}) {
  return (
    <div className="nbp-setup" data-testid="notebook-setup">
      {offer.kind === "build" && (
        <>
          {offer.absent.map((name) => (
            <SetupRow
              key={name}
              name={name}
              action={`Set up ${name}`}
              acting="Setting up…"
              building={building.includes(name)}
              error={errors[name] ?? null}
              log={logs[name] ?? []}
              onSetup={onSetup}
            >
              <strong>{name}</strong> is declared in this lab and has never been
              built on this machine. Building it installs an isolated
              interpreter and the packages this lab pinned — a few hundred MB
              on first run, and nothing already on this machine is touched.
            </SetupRow>
          ))}
          {/* A different fact and a different sentence. This environment WAS
              built here and the build was interrupted, so the remedy is to
              provision it again rather than for the first time — and the
              sentence above, which the state filter used to swallow this case
              into, would be telling a researcher something false about their
              own machine. */}
          {offer.broken.map((name) => (
            <SetupRow
              key={name}
              name={name}
              action={`Rebuild ${name}`}
              acting="Rebuilding…"
              building={building.includes(name)}
              error={errors[name] ?? null}
              log={logs[name] ?? []}
              onSetup={onSetup}
            >
              <strong>{name}</strong> was built on this machine and the build was
              interrupted, so nothing can start a kernel in it. Rebuilding
              replaces the half-built copy from the same lockfile this lab has
              pinned — nothing else on this machine is touched.
            </SetupRow>
          ))}
        </>
      )}
      {/* Said rather than guessed at. A machine that has not reported is not
          a machine holding nothing, so nothing here offers to download a
          gigabyte onto it on the strength of silence. */}
      {offer.kind === "unreported" && (
        <div className="nbp-setup-row">
          <span className="nbp-setup-lead">
            This Task's machine has not said which environments it holds, so
            nothing here knows whether any of them still need building. It
            says the next time its daemon reports.
          </span>
        </div>
      )}
      {/* The researcher picks. Inferring it would be this product silently
          choosing which of their several paired computers downloads a
          gigabyte. */}
      {offer.kind === "choose" && (
        <>
          <div className="nbp-setup-row">
            {offer.why === "no-kernel" ? (
              <span className="nbp-setup-lead">
                Nothing is holding a kernel for this Task, so there is no
                machine to read this Task's environments from. Choose which of
                your machines should build them.
              </span>
            ) : (
              <span className="nbp-setup-lead">
                This Task's kernels are running on more than one of your
                machines, so nothing here can say which of them these
                environments belong on. Choose which should build them.
              </span>
            )}
          </div>
          <div className="nbp-envpick" role="group" aria-label="Which machine">
            {offer.machines.map((machine) => (
              <button
                key={machine.machineId}
                type="button"
                className="nbp-envchip"
                onClick={() => onPickMachine(machine.machineId)}
              >
                {machine.label}
              </button>
            ))}
          </div>
        </>
      )}
      {offer.kind === "nowhere" && (
        <div className="nbp-setup-row">
          <span className="nbp-setup-lead">
            No machine is paired with this lab, so there is nowhere to build an
            environment. Pair one from the Machines screen first.
          </span>
        </div>
      )}
    </div>
  );
}

/** One environment, the sentence that says why it needs building, and the
 *  control that builds it — with its own progress and its own error.
 *
 *  Everything here is scoped to this one environment on purpose. A build is
 *  per-environment, so a panel-wide "Setting up…" would put that sentence on
 *  rows nobody pressed, and a panel-wide log would interleave two builds into
 *  one stream with nothing saying which line came from which. */
function SetupRow({
  name,
  action,
  acting,
  building,
  error,
  log,
  onSetup,
  children,
}: {
  name: string;
  action: string;
  acting: string;
  building: boolean;
  error: string | null;
  log: string[];
  onSetup: (name: string) => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className="nbp-setup-row">
        <span className="nbp-setup-lead">{children}</span>
        <button
          type="button"
          className="nbp-setup-btn"
          onClick={() => onSetup(name)}
          disabled={building}
        >
          {building ? acting : action}
        </button>
      </div>
      {error !== null && <p className="nbp-repl-error">{error}</p>}
      {log.length > 0 && <pre className="nbp-setup-log">{log.join("\n")}</pre>}
    </>
  );
}
