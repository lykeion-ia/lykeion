import { expect, it } from "vitest";
import { fingerprintEnvironmentSetupOutcome } from "./environment-setup-outcome";

const success = {
  requestId: "envsetup_fingerprint",
  name: "analysis",
  declarationGenerationId: "envgen_fingerprint",
  result: {
    ok: true,
    status: {
      state: "ready",
      name: "analysis",
      language: "python",
      manager: "uv",
      platform: "macos-aarch64",
      root: "/work/envs/analysis",
      version: "3.12.7",
      packageCount: 2,
      lockRevision: 4,
      setupRequestId: "envsetup_fingerprint",
      lockfileFingerprint: "a".repeat(64),
      packageFingerprint: "b".repeat(64),
      declarationGenerationId: "envgen_fingerprint",
      declarationCreatedTs: 1_800_000_000,
    },
  },
} as const;

it("fingerprints the full canonical outcome and a deterministically ordered completed-package set", () => {
  const first = fingerprintEnvironmentSetupOutcome(success, ["scanpy", "numpy"]);
  const reordered = fingerprintEnvironmentSetupOutcome(success, ["numpy", "scanpy"]);
  expect(first).toEqual(reordered);

  expect(fingerprintEnvironmentSetupOutcome(success, ["scanpy"]).fingerprint)
    .not.toBe(first.fingerprint);
  expect(fingerprintEnvironmentSetupOutcome({
    ...success,
    result: {
      ...success.result,
      status: { ...success.result.status, lockRevision: 5 },
    },
  }, ["scanpy", "numpy"]).fingerprint).not.toBe(first.fingerprint);
  expect(fingerprintEnvironmentSetupOutcome({
    ...success,
    result: { ok: false, name: "analysis", error: "failed" },
  }).fingerprint).not.toBe(first.fingerprint);
});

it("rejects a successful outcome whose marker evidence is not bound to the exact request", () => {
  for (const status of [
    { ...success.result.status, setupRequestId: "envsetup_older" },
    { ...success.result.status, lockfileFingerprint: undefined },
    { ...success.result.status, packageFingerprint: "not-a-sha256" },
  ]) {
    expect(() =>
      fingerprintEnvironmentSetupOutcome({
        ...success,
        result: { ok: true, status },
      }),
    ).toThrow();
  }
});
