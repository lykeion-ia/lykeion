import { useState } from "react";
import { cn } from "../../lib/utils";
import { LykeionMark } from "./LykeionMark";
import { Wizard } from "./Wizard";

/** Where the lab for this machine runs. `here` starts one beside the daemon;
 *  `elsewhere` joins one a group already has. */
export type Topology = "here" | "elsewhere";

const CHOICES: readonly { value: Topology; title: string; detail: string }[] = [
  {
    value: "here",
    title: "On this machine",
    detail: "Everything local. Nothing to type, nothing to approve.",
  },
  {
    value: "elsewhere",
    title: "Somewhere else",
    detail: "Join a lab your group already runs.",
  },
];

/**
 * Step 1 — the only question whose answer changes what the rest of setup is.
 *
 * It is the landing rather than the second screen: a doorway that said
 * "welcome" first would have spent a step on nothing, and this question has
 * to be asked before anything else can be. That is why the mark rides here —
 * with no doorway to carry it, this is the first and only place the product
 * says its own name.
 *
 * Nothing is chosen for the researcher. A default would decide the shape of
 * everything after on their behalf, so there is no way forward at all until
 * the question has an answer — `onContinue` is withheld from the frame rather
 * than a dead button being drawn, which is the same thing said honestly.
 */
export function WhereScreen({
  onChose,
  error,
}: {
  onChose: (topology: Topology) => void;
  /** What the daemon said when it would not take the answer. Shown on this
   *  screen because this screen is where the researcher still is: the flow
   *  does not move until the choice lands, so a refusal that went unsaid left
   *  a Continue button that simply did nothing. */
  error?: string | null;
}) {
  const [chosen, setChosen] = useState<Topology | undefined>(undefined);

  return (
    <Wizard
      step={1}
      total={3}
      onContinue={chosen === undefined ? undefined : () => onChose(chosen)}
    >
      <div className="mb-8">
        <LykeionMark />
      </div>

      <h1 className="text-[2rem] font-semibold leading-tight tracking-[-0.03em] text-fg">
        Where does the lab live?
      </h1>
      <p className="mt-3 max-w-[34rem] text-read leading-relaxed text-fg-muted">
        A lab holds the studies, the tasks and the people. This machine runs the agents.
      </p>

      <div className="mt-8 flex flex-col gap-3">
        {CHOICES.map((choice) => (
          <button
            key={choice.value}
            type="button"
            aria-pressed={chosen === choice.value}
            onClick={() => setChosen(choice.value)}
            className={cn(
              "rounded-xl border p-4 text-left transition-colors",
              chosen === choice.value
                ? "border-accent bg-surface-2"
                : "border-line bg-surface hover:bg-surface-2",
            )}
          >
            <span className="block text-ui font-medium text-fg">{choice.title}</span>
            <span className="mt-1 block text-sub leading-snug text-fg-subtle">
              {choice.detail}
            </span>
          </button>
        ))}
      </div>

      {error && (
        <p role="alert" className="mt-4 text-sub text-danger">
          {error}
        </p>
      )}
    </Wizard>
  );
}

export default WhereScreen;
