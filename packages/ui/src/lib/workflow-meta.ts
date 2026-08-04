import {
  DISCIPLINE_LABELS,
  METHOD_PHASE_LABELS,
  METHOD_PHASE_SKILL,
  METHOD_PHASES,
  type Discipline,
  type MethodPhase,
  type Workflow,
} from "@lykeion/api";

export interface PhaseMeta {
  label: string;
  /** The Skill this phase runs on, by name. */
  skill: string;
  badgeClass: string;
}

/**
 * How each phase renders. Four hues across ten phases, assigned by what the
 * phase is for rather than to keep neighbours apart: framing and design are
 * decisions, pre-registration and reproducible setup are commitments, the
 * middle is work, and the last three are checks.
 */
export const PHASE_META: Record<MethodPhase, PhaseMeta> = {
  frame: {
    label: METHOD_PHASE_LABELS.frame,
    skill: METHOD_PHASE_SKILL.frame,
    badgeClass: "border-accent/40 text-accent",
  },
  "survey-prior-work": {
    label: METHOD_PHASE_LABELS["survey-prior-work"],
    skill: METHOD_PHASE_SKILL["survey-prior-work"],
    badgeClass: "border-accent/40 text-accent",
  },
  "design-analysis": {
    label: METHOD_PHASE_LABELS["design-analysis"],
    skill: METHOD_PHASE_SKILL["design-analysis"],
    badgeClass: "border-accent/40 text-accent",
  },
  "pre-register": {
    label: METHOD_PHASE_LABELS["pre-register"],
    skill: METHOD_PHASE_SKILL["pre-register"],
    badgeClass: "border-iris/40 text-iris",
  },
  "reproducible-setup": {
    label: METHOD_PHASE_LABELS["reproducible-setup"],
    skill: METHOD_PHASE_SKILL["reproducible-setup"],
    badgeClass: "border-iris/40 text-iris",
  },
  execute: {
    label: METHOD_PHASE_LABELS.execute,
    skill: METHOD_PHASE_SKILL.execute,
    badgeClass: "border-success/40 text-success",
  },
  "investigate-anomalies": {
    label: METHOD_PHASE_LABELS["investigate-anomalies"],
    skill: METHOD_PHASE_SKILL["investigate-anomalies"],
    badgeClass: "border-success/40 text-success",
  },
  verify: {
    label: METHOD_PHASE_LABELS.verify,
    skill: METHOD_PHASE_SKILL.verify,
    badgeClass: "border-warn/40 text-warn",
  },
  "red-team": {
    label: METHOD_PHASE_LABELS["red-team"],
    skill: METHOD_PHASE_SKILL["red-team"],
    badgeClass: "border-warn/40 text-warn",
  },
  report: {
    label: METHOD_PHASE_LABELS.report,
    skill: METHOD_PHASE_SKILL.report,
    badgeClass: "border-warn/40 text-warn",
  },
};

/**
 * A colour per discipline, as a hex rather than a token class.
 *
 * Eight disciplines against the six hue tokens the theme carries would force
 * two of them to share, and two fields in the same colour read as related.
 * The value is a dot beside a neutral chip, so it never sits behind text and
 * never has to meet a contrast floor; the filter's own option dots take the
 * same hex from here, so the list and the filter cannot disagree.
 */
export const DISCIPLINE_COLOR: Record<Discipline, string> = {
  general: "#8a8f98",
  biology: "#3ea76a",
  chemistry: "#d9a441",
  physics: "#5b8def",
  neuroscience: "#a678e0",
  medicine: "#e5705b",
  "earth-science": "#3fa6a0",
  computation: "#c26fb0",
};

/** The phases the spine names that this procedure does not use, in spine
 *  order — what the detail screen says it skips. */
export function skippedPhases(workflow: Workflow): MethodPhase[] {
  const used = new Set(workflow.phases);
  return METHOD_PHASES.filter((phase) => !used.has(phase));
}

/** A discipline's label, for a value that reached the client from storage. */
export function disciplineLabel(discipline: Discipline): string {
  return DISCIPLINE_LABELS[discipline];
}
