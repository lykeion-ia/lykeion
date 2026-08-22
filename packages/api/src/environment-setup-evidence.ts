import { createHash } from "node:crypto";

import { canonicalJson } from "./provenance";

const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** One canonical identity for the exact requested package set. */
export function environmentPackageFingerprint(packages: readonly string[]): string {
  if (packages.some((entry) => typeof entry !== "string"))
    throw new Error("environment packages must be strings");
  return sha256(canonicalJson([...packages].sort()));
}

/** Identity of the authoritative lock bytes, without parsing or normalising them. */
export function environmentLockfileFingerprint(lockfile: string): string {
  if (typeof lockfile !== "string") throw new Error("environment lockfile must be a string");
  return sha256(lockfile);
}

export function isEnvironmentEvidenceFingerprint(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}
