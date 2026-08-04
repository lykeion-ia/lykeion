/**
 * The Reviewer contract. Field names and string encodings are the wire format
 * exactly: camelCase fields, kebab-case enums.
 *
 * The Reviewer is an advisory pass: it reads the record (plan, log, runs,
 * artifacts, references, claims) and flags six failure classes, each citing
 * the exact claim and the contradicting evidence. It never auto-fixes. The one
 * enforced rule is the light Done-gate: a Task cannot reach Done while a
 * high-severity finding is unresolved.
 */

/** The six failure classes the Reviewer catches. */
export type FindingClass =
  | "uncomputed-result"
  | "value-contradicts-source"
  | "citation-unsupported"
  | "doi-mismatch"
  | "plan-step-incomplete"
  | "conclusion-unsupported";

/** Finding severity. The Done-gate blocks on `high`. */
export type Severity = "high" | "medium" | "low";

/** One Reviewer finding. Cites the claim + the evidence;
 * never carries a fix. */
export interface Finding {
  /** Deterministic id (stable for the same record → resolvable). */
  id: string;
  class: FindingClass;
  severity: Severity;
  /** The claim id this finding is about. */
  claimId: string;
  /** The claim, quoted. */
  claim: string;
  /** What in the record contradicts it. */
  evidence: string;
  /** Where the claim appears (artifact path, message index, …). */
  location?: string;
  /** Set once the researcher resolves it (the Done-gate reads this). */
  resolved: boolean;
}

/** Human labels for each failure class — plain-language, for the Review tab. */
export const FINDING_CLASS_LABELS: Record<FindingClass, string> = {
  "uncomputed-result": "Result reported as computed but nothing ran",
  "value-contradicts-source": "Reported value contradicts its source file",
  "citation-unsupported": "Citation doesn't support the claim",
  "doi-mismatch": "DOI resolves to a different article",
  "plan-step-incomplete": "Approved plan step left incomplete",
  "conclusion-unsupported": "Conclusion the method doesn't support",
};

/** Human labels for the severities. */
export const SEVERITY_LABELS: Record<Severity, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Severity ordering for display — worst first. */
export const SEVERITY_ORDER: Record<Severity, number> = {
  high: 0,
  medium: 1,
  low: 2,
};
