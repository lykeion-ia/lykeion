/**
 * The Skills backing the method spine.
 *
 * Ten are the targets of `METHOD_PHASE_SKILL`, one per phase. Five are
 * cross-cutting: they apply at any phase and belong to none, so the spine
 * shows ten rows rather than an eleventh that has no place in the order.
 *
 * One factory, so the browser core and a self-hosted lab seed identical
 * content rather than two texts that drift.
 */

import type { Skill } from "./customization";

/** The Skills that back no single phase. */
export const SUPPORTING_METHOD_SKILLS = [
  "research-method",
  "parallel-investigations",
  "delegated-analysis",
  "receiving-critical-review",
  "writing-research-skills",
] as const;

/** Every method Skill: the ten phase Skills, then the five supporting ones. */
export function methodSkills(): Skill[] {
  return [
    {
      name: "framing-questions",
      description:
        "Turn an interest into a question that could come out the other way.",
      body: `# Framing questions

An interest is not a question. "Something is going on with these cells" cannot
be answered, only agreed with. Turn it into a claim that a result could
contradict.

## Record
- The question, as one sentence ending in a question mark.
- The population, the comparison, and the outcome, each named.
- What answer you expect, and roughly how strongly.
- What you would see if the expectation is wrong.

## Do not
- Do not ask whether there is "an effect" without saying on what, in whom,
  measured how.
- Do not carry an unfalsifiable framing forward because the data is already
  collected.
- Do not widen the question when a narrow one looks likely to come out flat.

## Done when
Someone who disagrees with you can say which result would settle it.
`,
    },
    {
      name: "surveying-prior-work",
      description:
        "Ground the method in what is already known, including what has failed.",
      body: `# Surveying prior work

Read before you design. The point is not citations — it is finding the
confounds someone else already hit, and the measurement that already has a
standard.

## Record
- The two or three results the question sits against, and their effect sizes.
- Known confounds for this measurement, and how others handled them.
- The conventional analysis for this design, and where it is disputed.
- Anything that failed to replicate.

## Do not
- Do not read only the results that agree with the expectation.
- Do not treat a single paper's method as the field's convention.
- Do not skip this because the analysis "is standard" — that is the claim to
  check, not the reason to skip checking.

## Done when
The design's choices each trace to something read, or are marked as deliberate
departures.
`,
    },
    {
      name: "designing-analyses",
      description:
        "Name the variables, the model, and the decision rule before running anything.",
      body: `# Designing analyses

Break the work into steps small enough that each one can be wrong on its own.
The design is what makes a later result interpretable.

## Record
- Every variable: what it is, its type, how it is derived.
- The model, written out, including every term.
- Exclusions, and what triggers one.
- The primary outcome, singular, and the rule that decides it.
- Any secondary outcome, marked as secondary.

## Do not
- Do not leave "we will see which model fits" as the plan.
- Do not name three primary outcomes.
- Do not derive a variable during the analysis that was not specified here.

## Done when
Someone else could run the analysis from this and get your numbers.
`,
    },
    {
      name: "pre-registering-analyses",
      description:
        "Lock the prediction and the decision rule before any outcome is seen.",
      body: `# Pre-registering analyses

Write down what you expect and how you will judge it, before you look at the
outcome. Anything decided after the result is exploratory, and saying so costs
less than being found not to have said so.

## Record
- The hypothesis, as a claim that could turn out false.
- The primary test, its threshold, and the direction of the effect.
- Exclusions and stopping rules, decided now.
- The correction for multiple tests, if there is more than one.
- What result would change your mind.

## Do not
- Do not leave the primary outcome unnamed until the data arrives.
- Do not run five tests and call the one that fires the primary.
- Do not extend collection because the result is nearly there.

## Done when
The plan is frozen, and a reader who has never seen the data could apply it and
reach the same verdict you will.
`,
    },
    {
      name: "reproducible-setup",
      description:
        "Pin the environment, fix the seeds, and keep raw data read-only.",
      body: `# Reproducible setup

A result nobody can regenerate is a claim, not a finding. Set the workspace up
so re-running is the cheap path.

## Record
- The environment, pinned to exact versions.
- Every seed, set explicitly rather than defaulted.
- Where the raw data lives, and that nothing writes there.
- The command that reproduces the analysis end to end.

## Do not
- Do not edit raw data in place; derive a copy and transform that.
- Do not let a notebook's execution order become part of the method.
- Do not depend on a file path that exists only on one machine.

## Done when
A clean checkout, one command, and the same numbers.
`,
    },
    {
      name: "executing-analyses",
      description: "Run the plan as written, and mark every departure from it.",
      body: `# Executing analyses

Run what was designed. The value of the plan is entirely in not quietly
improving on it once results start appearing.

## Record
- Each step as it completes, and its output.
- Every departure from the plan, with the reason, at the moment it happens.
- Anything surprising, before investigating it.

## Do not
- Do not add an analysis because you are already in there.
- Do not silently change a threshold, an exclusion, or a model term.
- Do not stop early because the result already looks clear.

## Done when
Every planned step has run, and every departure is written down as a departure.
`,
    },
    {
      name: "investigating-anomalies",
      description:
        "Find the cause of a strange result before adjusting anything.",
      body: `# Investigating anomalies

A number that looks wrong is information. Find out what produced it before
deciding what to do about it.

## Record
- What was expected, what appeared, and the size of the gap.
- The candidate causes, including a real coding error.
- What each candidate predicts you would also see.
- Which check ruled each one in or out.

## Do not
- Do not drop the outlier first and ask why second.
- Do not stop at the first plausible explanation.
- Do not treat "the pipeline is fine" as a finding without a check that could
  have shown otherwise.

## Done when
The cause is identified, or the search is written down as inconclusive and the
result carries that.
`,
    },
    {
      name: "verifying-results",
      description: "Re-run and stress the result before claiming it.",
      body: `# Verifying results

Between having a number and claiming it, check that the number survives.

## Record
- A clean re-run from raw data, and whether it matched.
- The result under a reasonable alternative specification.
- The effect size with its interval, not only the test.
- Sensitivity to the exclusions that were applied.

## Do not
- Do not report a number you have produced exactly once.
- Do not report significance without magnitude.
- Do not pick the specification that gives the cleanest answer.

## Done when
The claim holds under re-running and under the alternatives you tried, or it is
stated with the conditions it needs.
`,
    },
    {
      name: "red-teaming-findings",
      description: "Attack the finding before anyone else gets to.",
      body: `# Red-teaming findings

Take the position that the result is wrong, and see how far you get.

## Record
- The strongest alternative explanation, stated fairly.
- Which analytic choices, if flipped, would change the conclusion.
- What a reviewer would ask for first.
- Anything in the analysis that was decided after seeing data.

## Do not
- Do not review your own work in the voice of someone who wants it to hold.
- Do not answer an objection by narrowing the claim without saying you did.
- Do not defer the hardest question to the discussion section.

## Done when
The strongest objection has been made in writing, and either answered or
carried into the report as a limitation.
`,
    },
    {
      name: "reporting-and-archiving",
      description:
        "Write what was found, with the conditions, and archive what reproduces it.",
      body: `# Reporting and archiving

Report the finding at the strength it actually has, and leave behind what
someone would need to check it.

## Record
- The claim, with its effect size and interval.
- Which analyses were confirmatory and which were exploratory.
- Every departure from the plan.
- The limitations, including the ones nobody raised.
- The archived environment, data references, and the command that reproduces
  the numbers.

## Do not
- Do not present an exploratory result in confirmatory language.
- Do not omit an analysis that was run and did not work.
- Do not archive a workspace you have not re-run from clean.

## Done when
A reader can tell what was predicted, what was found, and what would have
changed the answer.
`,
    },
    {
      name: "research-method",
      description:
        "How the phases fit together, and which one the work is in right now.",
      body: `# Research method

Work moves through phases: frame the question, survey prior work, design the
analysis, pre-register, set the workspace up, execute, investigate anomalies,
verify, red-team, report. Not every procedure uses all of them, but the order
does not change.

## Record
- Which phase the work is in, before doing anything in it.
- What the previous phase concluded, so the next one does not relitigate it.
- Which phases this procedure does not use, and why.

## Do not
- Do not begin analysing before the question is framed.
- Do not treat a phase as finished because time was spent in it.
- Do not skip a phase the procedure declares.

## Done when
Anyone joining can say where the work stands and what happens next.
`,
    },
    {
      name: "parallel-investigations",
      description:
        "Split independent questions across separate lines of work without letting them contaminate each other.",
      body: `# Parallel investigations

Several independent questions can be pursued at once. The risk is that they
stop being independent.

## Record
- Each line's question, written before any of them start.
- What each line may see of the others' results: usually nothing until all are
  done.
- Which lines share data, and therefore share a multiplicity problem.

## Do not
- Do not let a line's finding reshape another line's still-open analysis.
- Do not run the same question several ways and report the best line.
- Do not forget that parallel tests on shared data multiply, and need the same
  correction as sequential ones.

## Done when
Each line's conclusion would be the same had it run alone.
`,
    },
    {
      name: "delegated-analysis",
      description:
        "Hand a bounded analysis to a subagent with enough context to be checked.",
      body: `# Delegated analysis

A delegated step is only useful if its output can be verified without redoing
it.

## Record
- The exact question delegated, and the bounds on it.
- The inputs handed over, and their provenance.
- What the result must contain to be checkable.
- What came back, before interpreting it.

## Do not
- Do not delegate a question you have not framed.
- Do not accept a result whose derivation you cannot follow.
- Do not let a delegated step decide something the plan reserved.

## Done when
The returned result has been checked against its inputs, not just read.
`,
    },
    {
      name: "receiving-critical-review",
      description:
        "Take a criticism seriously enough to check whether it is right.",
      body: `# Receiving critical review

A criticism is a claim about the work. Verify it before agreeing or
disagreeing.

## Record
- The objection, restated in your own words.
- Whether it is correct, checked against the code or the data.
- What changes, if it is correct.
- Why it does not apply, if it does not.

## Do not
- Do not implement a suggestion you have not verified.
- Do not agree to move on.
- Do not dismiss an objection because of how it was phrased.

## Done when
Each point has been checked and either acted on or answered with a reason.
`,
    },
    {
      name: "writing-research-skills",
      description: "Write a new method Skill that will actually get followed.",
      body: `# Writing research skills

A Skill is instructions someone follows under pressure. Length is what stops
that happening.

## Record
- When it applies, in the first line.
- What to write down, as a list.
- What not to do, with the failure each avoids.
- The condition that means it is finished.

## Do not
- Do not explain the reasoning at length; state the rule.
- Do not write a Skill for a step that is already unavoidable.
- Do not leave "done" undefined.

## Done when
Someone can follow it without asking what it means.
`,
    },
  ];
}
