import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  EnvironmentSetupJob,
  EnvironmentSetupStage,
  KernelEnvDeclaration,
  KernelEnvStatus,
  Language,
  TaskEnvironmentSetup,
} from "@lykeion/api";
import {
  CheckIcon,
  ChipIcon,
  ClockIcon,
  SpinnerIcon,
  WarningTriangleIcon,
} from "../icons";
import { languageLabel } from "./notebook-model";

/**
 * The one line that says which environment this Task's code runs in, which
 * machine holds it, and what — if anything — is being built right now.
 *
 * Every fact on it is read, never derived. The environment list is the lab's
 * declarations, the machine is the one this Task settled on, and the setup
 * state is the durable job the server owns: this component holds no copy of
 * any of it and cannot disagree with the server about a build, because it
 * never forms an opinion about one. The three things it does own are which
 * popup is open, which option a keyboard is standing on, and whether the last
 * command it sent was refused — none of which outlive a render of the page.
 *
 * It is also deliberately the same line in every state. A researcher who
 * pressed **Set up** keeps their finger on the same button while the build
 * runs and after it finishes: nothing here moves focus, opens a modal, or
 * raises a toast when a build completes, because the person who started it is
 * usually reading something else by then and the agent is already continuing.
 */
export interface EnvironmentBarProps {
  taskId: string;
  language: Language | null;
  environments: KernelEnvDeclaration[];
  selectedEnvironment: string | null;
  defaultEnvironment?: string;
  machineOptions: Array<{ machineId: string; label: string }>;
  selectedMachineId: string | null;
  status?: KernelEnvStatus;
  setup?: TaskEnvironmentSetup;
  onSelectEnvironment(name: string): void;
  onSelectMachine(machineId: string): void;
  onSetup(): Promise<void>;
  onRetry(waiterId: string): Promise<void>;
  onAnswerSuggestion(id: string, useByDefault: boolean): Promise<void>;
}

/** Which of the seven sentences this bar is saying. Named rather than
 *  computed inline at three call sites, because the icon, the colour and the
 *  progress track all key off the same answer and a bar whose icon and words
 *  disagreed would be worse than one that said nothing. */
type BarStateKind =
  /** The lab has declared nothing to run code in. */
  | "no-environment"
  /** Nowhere to build: nothing paired, or several paired and none chosen. */
  | "no-machine"
  /** The machine has not said what it holds. Not the same as holding none,
   *  and nothing here offers a download on the strength of silence. */
  | "unreported"
  /** The machine reported, and it does not hold this one. */
  | "needed"
  /** A durable job is requested or building. */
  | "progress"
  | "ready"
  | "failed";

interface BarState {
  kind: BarStateKind;
  label: string;
}

/** What each build phase is called on screen. The phase is the only thing
 *  announced while a build runs — see the live region below, which carries
 *  this string and nothing that ticks. */
function stageLabel(stage: EnvironmentSetupStage, machine: string): string {
  switch (stage) {
    case "waiting-for-machine":
      return `Waiting for ${machine} to report`;
    case "resolving":
      return "Resolving packages";
    case "installing":
      return "Installing packages";
    case "finalizing":
      return "Finalizing the environment";
  }
}

/** How long the machine has been at it, as of its last report — the server's
 *  own two timestamps subtracted, never a clock running in this tab. A timer
 *  here would draw a rising number between reports that no machine had
 *  vouched for, and would re-render this bar once a second to do it. */
function elapsedLabel(job: EnvironmentSetupJob): string | null {
  const start = job.startedTs ?? job.requestedTs;
  const seconds = Math.max(0, Math.round((job.updatedTs - start) / 1000));
  if (seconds === 0) return null;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** As much of a solver's complaint as belongs on one line. The server already
 *  bounds what it keeps; this bounds what is read at a glance, and the whole
 *  of it is one disclosure away in **Full details**. */
const EXCERPT_CHARS = 240;
function excerptOf(summary: string): string {
  const flat = summary.trim();
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function EnvironmentBar({
  taskId,
  language,
  environments,
  selectedEnvironment,
  defaultEnvironment,
  machineOptions,
  selectedMachineId,
  status,
  setup,
  onSelectEnvironment,
  onSelectMachine,
  onSetup,
  onRetry,
  onAnswerSuggestion,
}: EnvironmentBarProps) {
  /** Why the last command this bar sent did not happen. UI truth about a
   *  refused request, never setup truth: the job's own state stays the
   *  server's to report, and a refusal here changes nothing about it. */
  const [requestError, setRequestError] = useState<string | null>(null);
  /** Guards a second press landing before the first request has answered.
   *  A ref rather than state: it must not redraw the bar, because the bar is
   *  supposed to look identical until the server says something new. */
  const sending = useRef(false);

  const job = setup?.job;
  const waiter = setup?.waiter;
  const suggestion = setup?.suggestion;

  /** The machine this bar acts ON. A build that cannot name one is the silent
   *  pick this product refuses to make, so the action below exists only where
   *  this does. */
  const chosenMachine =
    machineOptions.find((m) => m.machineId === selectedMachineId) ?? null;
  /** What to call the machine in a sentence. The job carries the name the
   *  build was started against, which keeps a sentence about a build readable
   *  after that machine drops off the snapshot mid-build — a thing to say, not
   *  a thing to press. */
  const machineWord = chosenMachine?.label ?? job?.machineName ?? "the machine";

  const declaration = environments.find((e) => e.name === selectedEnvironment) ?? null;

  // Every declaration, always — the list is the lab's, not the lens's. An
  // environment of another language is exactly what a researcher reaches for
  // when they want it built, and this panel holds the only control that
  // builds one; scoping the list to the viewed language put that environment
  // out of reach on the only screen that could do anything about it. The lens
  // orders the list instead, so the ones a cell here could run come first.
  const options = useMemo(() => {
    if (language === null) return environments;
    return [...environments].sort(
      (a, b) => Number(a.language !== language) - Number(b.language !== language),
    );
  }, [environments, language]);

  const state = useMemo<BarState>(() => {
    if (selectedEnvironment === null)
      return { kind: "no-environment", label: "No environment declared" };
    // Nowhere to act. A job still describes itself here — a build that
    // started on a machine which has since dropped off the snapshot is a fact
    // worth stating — but there is nothing to press until one is chosen.
    if (selectedMachineId === null && job === undefined)
      return {
        kind: "no-machine",
        label:
          machineOptions.length === 0
            ? "No machine is paired with this lab"
            : "Choose which machine builds it",
      };
    if (job !== undefined) {
      switch (job.state) {
        case "failed":
          return { kind: "failed", label: "Setup failed" };
        case "building":
        case "requested":
          return { kind: "progress", label: stageLabel(job.stage, machineWord) };
        case "ready":
          return { kind: "ready", label: "Ready" };
      }
    }
    // Absent is not zero. A machine that has never said what it holds and one
    // that said "none" are different facts, and only the second is something
    // a Set up press can act on. `status` is also absent for an environment
    // declared since that machine's last report — a narrower silence, treated
    // the same way here on purpose, because both are this surface not knowing
    // rather than knowing there is nothing.
    if (status === undefined)
      return { kind: "unreported", label: `Waiting for ${machineWord} to report` };
    if (status.state === "ready") return { kind: "ready", label: "Ready" };
    return { kind: "needed", label: "Setup needed" };
  }, [selectedEnvironment, selectedMachineId, machineWord, machineOptions, job, status]);

  /** The agent's own turn is queued behind this build and will start itself.
   *  Said on the same line as **Ready**, because they are one event as far as
   *  the researcher is concerned. */
  const continuing =
    state.kind === "ready" && (waiter?.state === "queued" || waiter?.state === "resumed");

  const inProgress = state.kind === "progress";
  const elapsed = inProgress && job !== undefined ? elapsedLabel(job) : null;

  // `broken` is a build that started and was interrupted, and a copy that is
  // already there is rebuilt rather than set up for the first time — saying
  // "never built" about it is a false statement about the researcher's own
  // machine. A ready copy takes the same word for the same reason.
  const rebuild =
    status?.state === "broken" || status?.state === "ready" || job?.state === "ready";
  /**
   * Nothing to offer on an environment that was already healthy when this
   * panel opened and that this Task has asked nothing of. An offer to rebuild
   * what is already there asks a researcher to spend a gigabyte on nothing,
   * and on a bar whose whole brief is calm it would be the loudest thing on
   * a line where everything is well.
   *
   * A job is what makes the difference, and it is also why this is safe for
   * focus: the moment a build is requested there IS a job, so the button is
   * mounted before anyone can press it and stays mounted through `requested`,
   * `building`, `ready` and `failed` alike. It never disappears under the
   * finger that pressed it — it is simply never drawn for a build nobody on
   * this Task ever asked for.
   */
  const settled = status?.state === "ready" && job === undefined;
  const actionLabel =
    selectedEnvironment !== null && chosenMachine !== null && !settled
      ? `${rebuild ? "Rebuild" : "Set up"} ${selectedEnvironment} on ${chosenMachine.label}`
      : null;
  /** Present and refusing, rather than absent. The button a researcher pressed
   *  has to still be under their finger when the build finishes — a control
   *  that unmounts on readiness throws focus to the document, which is the one
   *  thing a calm completion must not do. `aria-disabled` is what says "not
   *  now" without taking the element out of the focus order to say it. */
  const actionBlocked =
    state.kind === "progress" || state.kind === "unreported" || state.kind === "no-machine";

  const failed = state.kind === "failed";
  const excerpt = failed && job?.errorSummary ? excerptOf(job.errorSummary) : null;
  const retryWaiterId = failed ? waiter?.id : undefined;

  const report = (run: () => Promise<void>) => {
    setRequestError(null);
    return run().catch((error: unknown) => setRequestError(messageOf(error)));
  };

  /** A build request, at most one in the air. The bar refuses a second press
   *  once the server has a job to show for the first, and this covers the
   *  moment before that job comes back down. */
  const build = (run: () => Promise<void>) => {
    if (sending.current) return;
    sending.current = true;
    void report(run).finally(() => {
      sending.current = false;
    });
  };

  /** Answering the default question, which holds nothing up — not the agent's
   *  continuation, and not a build request in flight. Deliberately outside
   *  the guard above: a preference about the next Task is not a second press
   *  of this one's button. */
  const answer = (run: () => Promise<void>) => {
    void report(run);
  };

  // News from the server supersedes the refusal of a command sent before it.
  // A "that machine is offline" left standing under a bar that has since
  // started building would be this surface reporting a fact that stopped
  // being one.
  //
  // Held in state rather than a ref: a ref written during render survives a
  // render React then discards, and the next one would see a signature that
  // already matched and leave the stale line standing — the one thing this
  // exists to prevent. This is React's own adjust-state-when-props-change
  // form, and a discarded render takes the whole of it with it.
  const jobSignature = job === undefined ? null : `${job.id}:${job.state}`;
  const [lastSignature, setLastSignature] = useState(jobSignature);
  if (lastSignature !== jobSignature) {
    setLastSignature(jobSignature);
    if (requestError !== null) setRequestError(null);
  }

  return (
    <div className="envbar" data-testid="environment-bar">
      <div className="envbar-row">
        <Picker
          id={`envbar-envs-${taskId}`}
          triggerLabel={`Kernel environment: ${
            selectedEnvironment ?? "none selected"
          }${
            selectedEnvironment !== null && selectedEnvironment === defaultEnvironment
              ? " (this Research's default)"
              : ""
          }`}
          triggerText={selectedEnvironment ?? "No environment"}
          listLabel="Kernel environment"
          options={options.map((env) => ({
            value: env.name,
            ...(env.name === defaultEnvironment ? { note: "default" } : {}),
          }))}
          selected={selectedEnvironment}
          onSelect={onSelectEnvironment}
        />

        {/* One machine is not a choice — it is already the answer, and a
            control with nothing to choose between spends a line of a dense
            panel saying so. Two is a question, and the phase-4 ruling stands
            behind asking it: inferring the machine would be this product
            silently choosing which of a member's paired computers downloads
            a gigabyte. */}
        {machineOptions.length > 1 || (machineOptions.length > 0 && chosenMachine === null) ? (
          <Picker
            id={`envbar-machines-${taskId}`}
            triggerLabel={`Machine: ${chosenMachine?.label ?? "none selected"}`}
            triggerText={chosenMachine?.label ?? "Choose a machine"}
            listLabel="Machine"
            options={machineOptions.map((m) => ({ value: m.machineId, label: m.label }))}
            selected={selectedMachineId}
            onSelect={onSelectMachine}
          />
        ) : null}

        {/* The one live region. It carries the phase and nothing that ticks,
            so a build announces itself when it moves from resolving to
            installing and stays quiet for the ninety seconds in between. */}
        <p className={`envbar-state envbar-state--${state.kind}`} role="status">
          <StateIcon kind={state.kind} />
          <span className="envbar-state-label">{state.label}</span>
          {continuing && <span className="envbar-continuing">Agent continuing…</span>}
        </p>

        {/* Outside the live region and out of the accessibility tree both: it
            is a number that changes on every report, and it is worth reading
            at a glance and worth announcing to nobody. */}
        {elapsed !== null && (
          <span className="envbar-elapsed" aria-hidden="true">
            {elapsed}
          </span>
        )}

        <div className="envbar-actions">
          {retryWaiterId !== undefined && (
            <button
              type="button"
              className="envbar-btn"
              onClick={() => build(() => onRetry(retryWaiterId))}
            >
              Retry
            </button>
          )}
          {actionLabel !== null && (
            <button
              type="button"
              className="envbar-btn envbar-btn--primary"
              aria-disabled={actionBlocked}
              onClick={() => {
                if (actionBlocked) return;
                build(onSetup);
              }}
            >
              {actionLabel}
            </button>
          )}
        </div>
      </div>

      {/* Indeterminate on purpose, and with no `aria-valuenow` to make it
          anything else. Nothing upstream measures a percentage of a package
          solve, so a bar that drew one would be inventing the only number on
          this surface a researcher would actually plan around. */}
      {inProgress && (
        <div
          className="envbar-progress"
          role="progressbar"
          aria-label="Environment setup progress"
        >
          <div className="envbar-progress__indicator" />
        </div>
      )}

      {(excerpt !== null || requestError !== null) && (
        <div className="envbar-alert" role="alert">
          {excerpt !== null && <p className="envbar-excerpt">{excerpt}</p>}
          {requestError !== null && (
            <p className="envbar-excerpt">{requestError}</p>
          )}
        </div>
      )}

      {/* Asked once, answered whenever. Neither button holds up the agent's
          continuation and neither changes what the line above says: this is a
          preference about the next R Task in this Research, not a step in
          this one. */}
      {suggestion?.state === "pending" && job?.state === "ready" && (
        <div className="envbar-suggestion">
          <p className="envbar-suggestion-question">
            Use {suggestion.environmentName} for future{" "}
            {languageLabel(suggestion.language)} work in this Research?
          </p>
          <div className="envbar-suggestion-actions">
            <button
              type="button"
              className="envbar-btn"
              onClick={() => answer(() => onAnswerSuggestion(suggestion.id, true))}
            >
              Use by default
            </button>
            <button
              type="button"
              className="envbar-btn envbar-btn--quiet"
              onClick={() => answer(() => onAnswerSuggestion(suggestion.id, false))}
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {/* Closed while a build behaves itself, open when one did not. A
          researcher watching packages install is watching, not reading; one
          reading a failure needs the solver's own words without hunting for
          the disclosure that holds them. */}
      {(declaration !== null || job !== undefined) && (
        <details className="envbar-details" open={failed}>
          <summary className="envbar-summary">Full details</summary>
          <div className="envbar-details-body">
            {declaration !== null && (
              <p className="envbar-packages">
                <span className="envbar-detail-head">Packages</span>{" "}
                {declaration.packages.length === 0
                  ? "None pinned yet."
                  : declaration.packages.join(", ")}
              </p>
            )}
            {job?.errorSummary !== undefined && (
              <pre className="envbar-log">{job.errorSummary}</pre>
            )}
            {job !== undefined && job.log.length > 0 && (
              <pre className="envbar-log">{job.log.join("\n")}</pre>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

/** Icon and text, always — never colour on its own. The colour below each of
 *  these is supplemental: the shape and the sentence beside it carry the same
 *  fact for a reader who cannot tell green from red, or is reading this on a
 *  projector that renders both as grey. */
function StateIcon({ kind }: { kind: BarStateKind }): ReactNode {
  switch (kind) {
    case "ready":
      return <CheckIcon className="envbar-icon" width={14} height={14} />;
    case "progress":
      return <SpinnerIcon className="envbar-icon envbar-icon--spin" width={14} height={14} />;
    case "failed":
    case "no-machine":
    case "no-environment":
      return <WarningTriangleIcon className="envbar-icon" width={14} height={14} />;
    case "unreported":
      return <ClockIcon className="envbar-icon" width={14} height={14} />;
    case "needed":
      return <ChipIcon className="envbar-icon" width={14} height={14} />;
  }
}

interface PickerOption {
  value: string;
  /** What to draw, when it is not the value itself. */
  label?: string;
  /** A quiet note beside the name — out of the accessibility tree, so an
   *  option is still addressable by the one thing it is called. */
  note?: string;
}

/**
 * A button that opens one list, and the keyboard that drives it.
 *
 * Both of this bar's choices are the same widget: a name, a list of names,
 * and one of them chosen. Written once here rather than twice, because a
 * second copy is a second place for `aria-expanded` to go stale.
 */
function Picker({
  id,
  triggerLabel,
  triggerText,
  listLabel,
  options,
  selected,
  onSelect,
}: {
  id: string;
  /** The trigger's accessible name — what it is, and what is chosen. */
  triggerLabel: string;
  /** What the trigger draws. Shorter than its name on purpose: the bar has
   *  one line and the name has room to be a sentence. */
  triggerText: string;
  listLabel: string;
  options: PickerOption[];
  selected: string | null;
  onSelect(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selectedIndex = Math.max(
    0,
    options.findIndex((o) => o.value === selected),
  );

  const optionId = (index: number) => `${id}-option-${index}`;

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus();
  }, [open]);

  // The list scrolls past 240px, and `aria-activedescendant` moves a cursor
  // that the browser does not scroll to on its own — so a sighted keyboard
  // reader arrowing down a long lab's declarations would walk it off the
  // bottom of the popup. `block: "nearest"` scrolls only when it has to.
  useEffect(() => {
    if (!open) return;
    const option = listRef.current?.children.item(active);
    // Optional call: this runs under jsdom too, which implements no scrolling
    // at all, and a test suite is not a reason to guard a browser behaviour
    // behind a feature check anywhere else.
    (option as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };

  /** Closing hands the focus back to the control that opened it. A popup that
   *  vanishes and leaves focus on the document body loses a keyboard reader
   *  their place on the whole screen, not just in this list. */
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  return (
    <div className="envbar-picker" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="envbar-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        // Named only while the list it names exists. `aria-controls` pointing
        // at an unmounted id is a dangling reference an axe audit fails, and
        // accessibility here is a requirement rather than a finish.
        {...(open ? { "aria-controls": id } : {})}
        aria-label={triggerLabel}
        onClick={() => (open ? close() : openAt(selectedIndex))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openAt(selectedIndex);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            openAt(options.length === 0 ? 0 : options.length - 1);
          }
        }}
      >
        <span className="envbar-trigger-text">{triggerText}</span>
        <span className="envbar-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <ul
          ref={listRef}
          id={id}
          className="envbar-list"
          role="listbox"
          aria-label={listLabel}
          tabIndex={-1}
          aria-activedescendant={options.length === 0 ? undefined : optionId(active)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, options.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Home") {
              e.preventDefault();
              setActive(0);
            } else if (e.key === "End") {
              e.preventDefault();
              setActive(Math.max(0, options.length - 1));
            } else if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              const option = options[active];
              if (option) onSelect(option.value);
              close();
            } else if (e.key === "Escape") {
              e.preventDefault();
              close();
            } else if (e.key === "Tab") {
              close(false);
            }
          }}
        >
          {options.map((option, index) => (
            <li
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={option.value === selected}
              className={`envbar-option${index === active ? " is-active" : ""}${
                option.value === selected ? " is-selected" : ""
              }`}
              onClick={() => {
                onSelect(option.value);
                close();
              }}
            >
              <span className="envbar-option-name">{option.label ?? option.value}</span>
              {option.note !== undefined && (
                <span className="envbar-option-note" aria-hidden="true">
                  {option.note}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default EnvironmentBar;
