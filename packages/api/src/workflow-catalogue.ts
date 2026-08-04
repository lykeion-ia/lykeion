/**
 * The Workflow catalogue a lab opens with.
 *
 * Read by both implementations' seeds, so a browser surface and a self-hosted
 * lab show one catalogue rather than two lists that drift. Each entry names
 * the phases of the method spine it runs; the ones it leaves out are the ones
 * it has nothing to do in.
 */

import type { Workflow } from "./customization";
import { METHOD_PHASES } from "./types";

export function catalogueWorkflows(): Workflow[] {
  return [
    {
      id: "diffexpr",
      name: "Differential expression",
      description: "Run a standard differential-expression analysis.",
      discipline: "biology",
      icon: "dna",
      prompt:
        "Load {counts_file} and run differential expression between {group_a} and {group_b}. Report the top {top_n} genes.",
      placeholders: [
        { key: "counts_file", label: "Counts matrix", required: true },
        { key: "group_a", label: "Group A", required: true },
        { key: "group_b", label: "Group B", required: true },
        { key: "top_n", label: "Top N", required: false, default: "20" },
      ],
      phases: METHOD_PHASES,
      suggestedSkills: ["rnaseq"],
      requiresFiles: true,
    },
    {
      id: "lit-summary",
      name: "Literature summary",
      description: "Summarize the recent literature on a topic with citations.",
      discipline: "general",
      icon: "book",
      prompt:
        "Summarize the literature on {topic} from the last {years} years, citing each source.",
      placeholders: [
        { key: "topic", label: "Topic", required: true },
        { key: "years", label: "Years back", required: false, default: "5" },
      ],
      // Nothing is predicted and no compute is pinned, so two phases of the
      // spine have nothing to act on here.
      phases: ["frame", "survey-prior-work", "report"],
      suggestedSkills: ["literature-review"],
      requiresFiles: false,
    },
    {
      id: "variant-calling",
      name: "Variant calling",
      description: "Call and filter variants against a reference genome.",
      discipline: "biology",
      icon: "dna",
      prompt:
        "Call variants in {sample_bam} against {reference}, filter at depth {min_depth}, and report the annotated set.",
      placeholders: [
        { key: "sample_bam", label: "Aligned reads", required: true },
        { key: "reference", label: "Reference genome", required: true },
        { key: "min_depth", label: "Minimum depth", required: false, default: "10" },
      ],
      phases: [
        "frame",
        "design-analysis",
        "reproducible-setup",
        "execute",
        "investigate-anomalies",
        "verify",
        "report",
      ],
      suggestedSkills: [],
      requiresFiles: true,
    },
    {
      id: "docking",
      name: "Molecular docking",
      description: "Dock a ligand set against a target and rank poses.",
      discipline: "chemistry",
      icon: "flask",
      prompt:
        "Dock the ligands in {ligand_set} against {target_structure} and rank the top {pose_count} poses by binding energy.",
      placeholders: [
        { key: "ligand_set", label: "Ligand set", required: true },
        { key: "target_structure", label: "Target structure", required: true },
        { key: "pose_count", label: "Poses to report", required: false, default: "10" },
      ],
      phases: [
        "frame",
        "survey-prior-work",
        "design-analysis",
        "reproducible-setup",
        "execute",
        "verify",
        "report",
      ],
      suggestedSkills: [],
      requiresFiles: true,
    },
    {
      id: "reaction-yield",
      name: "Reaction yield screen",
      description: "Compare yields across reaction conditions.",
      discipline: "chemistry",
      icon: "flask",
      prompt:
        "Compare the yield of {reaction} across {conditions}, and report which condition wins and by how much.",
      placeholders: [
        { key: "reaction", label: "Reaction", required: true },
        { key: "conditions", label: "Conditions", required: true },
      ],
      phases: METHOD_PHASES,
      suggestedSkills: ["stats-hygiene"],
      requiresFiles: true,
    },
    {
      id: "spectra-fit",
      name: "Spectral line fit",
      description: "Fit line profiles and report parameters with uncertainty.",
      discipline: "physics",
      icon: "chart",
      prompt:
        "Fit {line_model} to the spectrum in {spectrum_file} over {fit_range}, and report parameters with uncertainties.",
      placeholders: [
        { key: "spectrum_file", label: "Spectrum", required: true },
        { key: "line_model", label: "Line model", required: false, default: "Voigt" },
        { key: "fit_range", label: "Fit range", required: true },
      ],
      phases: [
        "frame",
        "design-analysis",
        "reproducible-setup",
        "execute",
        "investigate-anomalies",
        "verify",
        "report",
      ],
      suggestedSkills: ["stats-hygiene"],
      requiresFiles: true,
    },
    {
      id: "mc-simulation",
      name: "Monte Carlo simulation",
      description: "Run a seeded simulation and summarize the distribution.",
      discipline: "physics",
      icon: "chart",
      prompt:
        "Run {iterations} iterations of {model} at seed {seed}, and summarize the resulting distribution.",
      placeholders: [
        { key: "model", label: "Model", required: true },
        { key: "iterations", label: "Iterations", required: false, default: "10000" },
        { key: "seed", label: "Seed", required: false, default: "1" },
      ],
      phases: [
        "frame",
        "design-analysis",
        "pre-register",
        "reproducible-setup",
        "execute",
        "verify",
        "report",
      ],
      suggestedSkills: [],
      requiresFiles: false,
    },
    {
      id: "spike-sorting",
      name: "Spike sorting",
      description: "Sort extracellular recordings into single units.",
      discipline: "neuroscience",
      icon: "brain",
      prompt:
        "Sort the recording in {recording} into units, applying a {threshold} threshold, and report cluster quality.",
      placeholders: [
        { key: "recording", label: "Recording", required: true },
        { key: "threshold", label: "Detection threshold", required: false, default: "4.5 SD" },
      ],
      phases: [
        "frame",
        "design-analysis",
        "reproducible-setup",
        "execute",
        "investigate-anomalies",
        "verify",
        "report",
      ],
      suggestedSkills: [],
      requiresFiles: true,
    },
    {
      id: "fmri-contrast",
      name: "fMRI contrast",
      description: "Estimate a contrast across subjects with correction.",
      discipline: "neuroscience",
      icon: "brain",
      prompt:
        "Estimate the {contrast} contrast across the subjects in {dataset}, correcting at {correction}, and report surviving clusters.",
      placeholders: [
        { key: "dataset", label: "Dataset", required: true },
        { key: "contrast", label: "Contrast", required: true },
        { key: "correction", label: "Correction", required: false, default: "FDR q<0.05" },
      ],
      phases: METHOD_PHASES,
      suggestedSkills: ["stats-hygiene"],
      requiresFiles: true,
    },
    {
      id: "survival-analysis",
      name: "Survival analysis",
      description: "Compare time-to-event between arms.",
      discipline: "medicine",
      icon: "chart",
      prompt:
        "Compare time to {endpoint} between {arm_a} and {arm_b} in {cohort}, and report the hazard ratio with its interval.",
      placeholders: [
        { key: "cohort", label: "Cohort", required: true },
        { key: "endpoint", label: "Endpoint", required: true },
        { key: "arm_a", label: "Arm A", required: true },
        { key: "arm_b", label: "Arm B", required: true },
      ],
      phases: METHOD_PHASES,
      suggestedSkills: ["stats-hygiene"],
      requiresFiles: true,
    },
    {
      id: "trial-power",
      name: "Trial power analysis",
      description: "Size a trial for a target effect before it runs.",
      discipline: "medicine",
      icon: "chart",
      prompt:
        "Size a trial to detect an effect of {effect_size} at power {power} and alpha {alpha}, and state the assumptions the number rests on.",
      placeholders: [
        { key: "effect_size", label: "Effect size", required: true },
        { key: "power", label: "Power", required: false, default: "0.8" },
        { key: "alpha", label: "Alpha", required: false, default: "0.05" },
      ],
      // Sizing happens before anything is measured, so there is no outcome to
      // investigate and nothing to red-team yet.
      phases: ["frame", "survey-prior-work", "design-analysis", "verify", "report"],
      suggestedSkills: ["stats-hygiene"],
      requiresFiles: false,
    },
    {
      id: "series-trend",
      name: "Time-series trend",
      description: "Test a long series for trend against autocorrelation.",
      discipline: "earth-science",
      icon: "chart",
      prompt:
        "Test {series} over {window} for a monotonic trend, accounting for autocorrelation, and report the slope with its interval.",
      placeholders: [
        { key: "series", label: "Series", required: true },
        { key: "window", label: "Window", required: true },
      ],
      phases: [
        "frame",
        "survey-prior-work",
        "design-analysis",
        "pre-register",
        "execute",
        "verify",
        "red-team",
        "report",
      ],
      suggestedSkills: ["stats-hygiene"],
      requiresFiles: true,
    },
    {
      id: "benchmark-compare",
      name: "Benchmark comparison",
      description: "Compare implementations on a fixed workload.",
      discipline: "computation",
      icon: "chip",
      prompt:
        "Compare {baseline} against {candidate} on {workload} over {repeats} repeats, and report the difference with its interval.",
      placeholders: [
        { key: "baseline", label: "Baseline", required: true },
        { key: "candidate", label: "Candidate", required: true },
        { key: "workload", label: "Workload", required: true },
        { key: "repeats", label: "Repeats", required: false, default: "30" },
      ],
      phases: [
        "frame",
        "design-analysis",
        "pre-register",
        "reproducible-setup",
        "execute",
        "investigate-anomalies",
        "verify",
        "report",
      ],
      suggestedSkills: [],
      requiresFiles: true,
    },
  ];
}
