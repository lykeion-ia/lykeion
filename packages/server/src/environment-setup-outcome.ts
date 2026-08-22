import { createHash } from "node:crypto";
import {
  canonicalEnvironmentSetupOutcome,
  canonicalJson,
  type CanonicalEnvironmentSetupOutcome,
  type KernelEnvStatus,
} from "@lykeion/api";
import { environmentPackageFingerprint } from "@lykeion/api/environment-setup-evidence";
import { environmentStore } from "./store/environments";
import type { StoredEnvironmentSetupJob } from "./store/environment-setups";
import type { Store } from "./store/store";

/** What a machine's `kernel-env-setup` finally came to: the finished status
 *  it materialized, or the reason it could not. */
export type EnvSetupResult =
  | { ok: true; status: KernelEnvStatus }
  | { ok: false; name: string; error: string };

export function completedPackagesForEnvironmentSetupFingerprint(
  store: Store,
  job: StoredEnvironmentSetupJob,
): string[] {
  return (
    job.resolvedFrom ??
    environmentStore(store).readLockRequest(job.environmentName, job.lockRevision) ??
    []
  );
}

/** One canonical projection and digest for the exact daemon/server ack. */
export function fingerprintEnvironmentSetupOutcome(
  input: unknown,
  completedPackages?: string[],
): {
  outcome: CanonicalEnvironmentSetupOutcome;
  fingerprint: string;
} {
  const outcome = canonicalEnvironmentSetupOutcome(input);
  if (
    completedPackages !== undefined &&
    completedPackages.some((entry) => typeof entry !== "string")
  )
    throw new Error("completed environment packages must be strings");
  const canonical = canonicalJson({
    outcome,
    ...(completedPackages === undefined
      ? {}
      : { completedPackageFingerprint: environmentPackageFingerprint(completedPackages) }),
  });
  const fingerprint = createHash("sha256")
    .update(canonical)
    .digest("hex");
  return { outcome, fingerprint };
}
