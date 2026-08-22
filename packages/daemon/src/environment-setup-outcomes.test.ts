import { afterEach, expect, it } from "vitest";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  environmentSetupOutcomeSpool,
  type EnvironmentSetupJournal,
  type EnvironmentSetupOutcome,
} from "./environment-setup-outcomes";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temporaryDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykeion-environment-outcomes-"));
  dirs.push(dir);
  return dir;
}

it("persists a bounded private outcome atomically without setup inputs or credentials", () => {
  const dataDir = temporaryDataDir();
  const spool = environmentSetupOutcomeSpool(dataDir);
  const root = join(dataDir, "environment-setup-outcomes");
  const secretPassword = "spool-password-must-not-survive";
  const secretToken = "spool-token-must-not-survive";
  const secretPackage = "private-package-must-not-survive";
  const outcome = {
    requestId: "envsetup_private_spool",
    name: "analysis",
    declarationGenerationId: "envgen_private_spool",
    result: {
      ok: false,
      name: "analysis",
      error:
        `resolve failed at https://alice:${secretPassword}@packages.example.invalid/simple ` +
        `authorization: Bearer ${secretToken} ` +
        "x".repeat(8_192),
    },
    // Deliberately smuggle fields a caller must never be able to serialize.
    packages: [secretPackage],
    lockfile: `${secretPackage}==1.0\n`,
    token: secretToken,
  } as EnvironmentSetupOutcome & {
    packages: string[];
    lockfile: string;
    token: string;
  };

  spool.begin(outcome);
  const persisted = spool.complete(outcome);
  const entries = readdirSync(root);

  expect(statSync(root).mode & 0o777).toBe(0o700);
  expect(entries).toHaveLength(2);
  expect(entries).toEqual(expect.arrayContaining([
    expect.stringMatching(/^[a-f0-9]{64}\.json$/),
    expect.stringMatching(/^[a-f0-9]{64}\.json\.terminal$/),
  ]));
  expect(entries.every((entry) => (statSync(join(root, entry)).mode & 0o777) === 0o600)).toBe(true);
  expect(entries.some((entry) => /\.\d+\.[a-f0-9]+$/.test(entry))).toBe(false);

  const raw = readFileSync(join(root, entries.find((entry) => entry.endsWith(".json"))!), "utf8");
  expect(raw).not.toContain(secretPassword);
  expect(raw).not.toContain(secretToken);
  expect(raw).not.toContain(secretPackage);
  const stored = JSON.parse(raw) as Record<string, unknown>;
  expect(Object.keys(stored).sort()).toEqual([
    "declarationGenerationId",
    "name",
    "requestId",
    "result",
    "state",
    "version",
  ]);
  expect(Buffer.byteLength((persisted.result as { error: string }).error, "utf8")).toBeLessThanOrEqual(4_096);
  expect(spool.load()).toEqual([persisted]);

  // A terminal destination is create-or-identical evidence. A conflicting
  // retry may neither replace it nor leave a visible temporary.
  expect(() =>
    spool.complete({
      ...persisted,
      result: { ok: false, name: "analysis", error: "replacement" },
    }),
  ).toThrow(/conflict/i);
  expect(readdirSync(root)).toEqual(entries);
  expect(spool.load()).toEqual([persisted]);
});

it("retains corrupt exact-request evidence fail closed even under a claimed acknowledgement", () => {
  const dataDir = temporaryDataDir();
  const spool = environmentSetupOutcomeSpool(dataDir);
  const requestId = "envsetup_truncated_spool";
  const outcome: EnvironmentSetupOutcome = {
    requestId,
    name: "analysis",
    declarationGenerationId: "envgen_truncated_spool",
    result: { ok: false, name: "analysis", error: "original" },
  };
  spool.begin(outcome);
  const terminal = spool.complete(outcome);
  const root = join(dataDir, "environment-setup-outcomes");
  const destination = join(root, readdirSync(root).find((entry) => entry.endsWith(".terminal"))!);

  writeFileSync(destination, '{"version":1,"requestId":', { mode: 0o600 });

  expect(spool.load()).toEqual([]);
  expect(spool.hasRecord(requestId)).toBe(true);
  expect(readFileSync(destination, "utf8")).not.toContain("original");

  expect(() => spool.acknowledge(terminal)).toThrow(/corrupt/i);
  expect(spool.hasRecord(requestId)).toBe(true);
  expect(readdirSync(root)).toHaveLength(2);
});

it("creates one exact provisioning journal before replacing it with the matching terminal outcome", () => {
  const dataDir = temporaryDataDir();
  const spool = environmentSetupOutcomeSpool(dataDir);
  const identity = {
    requestId: "envsetup_journal",
    name: "analysis",
    declarationGenerationId: "envgen_journal",
  };

  const provisioning = spool.begin(identity);
  expect(provisioning).toEqual({
    role: "owner",
    journal: { ...identity, state: "provisioning" },
  });
  expect(spool.begin(identity)).toEqual({
    role: "observer",
    journal: provisioning.journal,
  });
  expect(() => spool.begin({ ...identity, name: "other" })).toThrow(/conflict/i);

  const terminal = spool.complete({
    ...identity,
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
        packageCount: 12,
        lockRevision: 4,
        setupRequestId: identity.requestId,
        lockfileFingerprint: "a".repeat(64),
        packageFingerprint: "b".repeat(64),
        declarationGenerationId: "envgen_journal",
      },
    },
  });
  expect(terminal.state).toBe("terminal");
  expect(spool.load()).toEqual([terminal]);
  expect(spool.complete(terminal)).toEqual(terminal);
  expect(() => spool.begin(identity)).toThrow(/conflict/i);
  expect(() =>
    spool.complete({
      ...identity,
      result: { ok: false, name: "analysis", error: "conflicting failure" },
    })
  ).toThrow(/conflict/i);
  expect(spool.load()).toEqual([terminal]);
});

it("grants exactly one durable provisioning owner across independent spool instances", () => {
  const dataDir = temporaryDataDir();
  const identity = {
    requestId: "envsetup_exclusive_owner",
    name: "analysis",
    declarationGenerationId: "envgen_exclusive_owner",
  };
  const processOne = environmentSetupOutcomeSpool(dataDir);
  const processTwo = environmentSetupOutcomeSpool(dataDir);

  const claims = [processOne.begin(identity), processTwo.begin(identity)];
  let destructiveInvocations = 0;
  for (const claim of claims) {
    if (claim.role === "owner") destructiveInvocations += 1;
  }

  expect(claims.map(({ role }) => role).sort()).toEqual(["observer", "owner"]);
  expect(destructiveInvocations).toBe(1);
  expect(environmentSetupOutcomeSpool(dataDir).load()).toEqual([
    { ...identity, state: "provisioning" },
  ]);
});

it("returns no owner when a required directory durability barrier fails", () => {
  const dataDir = temporaryDataDir();
  const identity = {
    requestId: "envsetup_fsync_failure",
    name: "analysis",
    declarationGenerationId: "envgen_fsync_failure",
  };
  let destructiveInvocations = 0;
  const failing = environmentSetupOutcomeSpool(dataDir, {
    beforeDirectoryFsync(phase) {
      if (phase === "begin-claim") throw new Error("injected directory fsync failure");
    },
  });

  expect(() => {
    const claim = failing.begin(identity);
    if (claim.role === "owner") destructiveInvocations += 1;
  }).toThrow(/injected directory fsync failure/);
  expect(destructiveInvocations).toBe(0);

  // The uncertain durable link is a quarantine, never a stale claim that a
  // later process may take over merely because its creator saw an error.
  expect(environmentSetupOutcomeSpool(dataDir).begin(identity)).toEqual({
    role: "observer",
    journal: { ...identity, state: "provisioning" },
  });
});

it("scavenges only recognized private temp hardlinks already represented by a live journal", () => {
  const dataDir = temporaryDataDir();
  const identity = {
    requestId: "envsetup_temp_scavenge",
    name: "analysis",
    declarationGenerationId: "envgen_temp_scavenge",
  };
  const spool = environmentSetupOutcomeSpool(dataDir);
  expect(spool.begin(identity).role).toBe("owner");
  const root = join(dataDir, "environment-setup-outcomes");
  const main = readdirSync(root).find((entry) => entry.endsWith(".json"))!;
  const linkedTemp = `${main}.${process.pid}.abcdef123456`;
  linkSync(join(root, main), join(root, linkedTemp));

  const unrepresented = `${"a".repeat(64)}.json.${process.pid}.012345abcdef`;
  writeFileSync(join(root, unrepresented), "unrepresented in-flight temp", { mode: 0o600 });
  const wrongMode = `${"b".repeat(64)}.json.${process.pid}.fedcba654321`;
  writeFileSync(join(root, wrongMode), "not private", { mode: 0o600 });
  chmodSync(join(root, wrongMode), 0o644);

  const reloaded = environmentSetupOutcomeSpool(dataDir);
  expect(reloaded.load()).toEqual([{ ...identity, state: "provisioning" }]);
  expect(readdirSync(root)).toEqual(expect.arrayContaining([main, unrepresented, wrongMode]));
  expect(readdirSync(root)).not.toContain(linkedTemp);
});

it("redacts before UTF-8 truncation and byte-bounds every success string and the whole record", () => {
  const dataDir = temporaryDataDir();
  const spool = environmentSetupOutcomeSpool(dataDir);
  const identity = {
    requestId: "envsetup_bounded_unicode",
    name: "analysis",
    declarationGenerationId: "envgen_bounded_unicode",
  };
  spool.begin(identity);

  const boundarySecret = "boundary-password-must-not-survive";
  const failed = spool.complete({
    ...identity,
    result: {
      ok: false,
      name: "analysis",
      error: `${"🙂".repeat(1_020)} https://alice:${boundarySecret}`,
    },
  });
  const failureRaw = readFileSync(
    join(dataDir, "environment-setup-outcomes", readdirSync(join(dataDir, "environment-setup-outcomes"))[0]!),
    "utf8",
  );
  expect(failureRaw).not.toContain(boundarySecret);
  expect((failed.result as { error: string }).error).toContain("[redacted]");

  spool.acknowledge(failed);
  spool.begin(identity);
  const successSecret = "success-field-secret-must-not-survive";
  const succeeded = spool.complete({
    ...identity,
    result: {
      ok: true,
      status: {
        state: "ready",
        name: "analysis",
        language: "python",
        manager: "uv",
        platform: `token=${successSecret} ${"🙂".repeat(2_000)}`,
        root: `https://alice:${successSecret}@workspace.invalid/${"界".repeat(4_000)}`,
        version: `password=${successSecret} ${"v".repeat(4_000)}`,
        packageCount: 12,
        lockRevision: 4,
        setupRequestId: identity.requestId,
        lockfileFingerprint: "a".repeat(64),
        packageFingerprint: "b".repeat(64),
        declarationGenerationId: "envgen_bounded_unicode",
      },
    },
  });
  const successRaw = readFileSync(
    join(dataDir, "environment-setup-outcomes", readdirSync(join(dataDir, "environment-setup-outcomes"))[0]!),
    "utf8",
  );
  expect(Buffer.byteLength(succeeded.result.ok ? succeeded.result.status.platform : "", "utf8"))
    .toBeLessThanOrEqual(256);
  expect(Buffer.byteLength(succeeded.result.ok ? succeeded.result.status.root : "", "utf8"))
    .toBeLessThanOrEqual(4_096);
  expect(Buffer.byteLength(succeeded.result.ok ? succeeded.result.status.version ?? "" : "", "utf8"))
    .toBeLessThanOrEqual(256);
  expect(Buffer.byteLength(successRaw, "utf8")).toBeLessThanOrEqual(8_192);
  expect(successRaw).not.toContain(successSecret);
  expect(successRaw).toContain("[redacted]");
  expect(successRaw).not.toContain("packages");
  expect(successRaw).not.toContain('"lockfile":');
  expect(successRaw).not.toContain("authorization");
});

it("loads only the journal allowlist and never persists setup inputs", () => {
  const dataDir = temporaryDataDir();
  const spool = environmentSetupOutcomeSpool(dataDir);
  const identity = {
    requestId: "envsetup_allowlist",
    name: "analysis",
    declarationGenerationId: "envgen_allowlist",
  };
  spool.begin({
    ...identity,
    packages: ["private-package"],
    lockfile: "private-package==1",
    env: { PRIVATE_TOKEN: "secret" },
    authorization: "Bearer secret",
  } as typeof identity & Record<string, unknown>);

  const [journal] = spool.load() as EnvironmentSetupJournal[];
  expect(journal).toEqual({ ...identity, state: "provisioning" });
  const raw = readFileSync(
    join(dataDir, "environment-setup-outcomes", readdirSync(join(dataDir, "environment-setup-outcomes"))[0]!),
    "utf8",
  );
  expect(raw).not.toMatch(/private-package|PRIVATE_TOKEN|Bearer secret/);
});

it("rejects a terminal record whose individually bounded fields exceed the total encoded bound", () => {
  const dataDir = temporaryDataDir();
  const spool = environmentSetupOutcomeSpool(dataDir);
  const identity = {
    requestId: "r".repeat(1_024),
    name: "n".repeat(512),
    declarationGenerationId: "g".repeat(1_024),
  };
  spool.begin(identity);

  expect(() => spool.complete({
    ...identity,
    result: {
      ok: true,
      status: {
        state: "ready",
        name: identity.name,
        language: "python",
        manager: "uv",
        platform: "p".repeat(256),
        root: `/${"x".repeat(4_095)}`,
        version: "v".repeat(256),
        setupRequestId: identity.requestId,
        lockfileFingerprint: "a".repeat(64),
        packageFingerprint: "b".repeat(64),
        declarationGenerationId: identity.declarationGenerationId,
      },
    },
  })).toThrow(/total encoded record bound/i);
  expect(spool.load()).toEqual([{ ...identity, state: "provisioning" }]);
  const raw = readFileSync(
    join(
      dataDir,
      "environment-setup-outcomes",
      readdirSync(join(dataDir, "environment-setup-outcomes"))[0]!,
    ),
    "utf8",
  );
  expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(8_192);
});

it("converges identical interleaved terminal writers and never lets a conflicting writer replace the winner", () => {
  const identicalData = temporaryDataDir();
  const identicalIdentity = {
    requestId: "envsetup_identical_writers",
    name: "analysis",
    declarationGenerationId: "envgen_identical_writers",
  };
  const identicalOutcome: EnvironmentSetupOutcome = {
    ...identicalIdentity,
    result: { ok: false, name: "analysis", error: "same exact outcome" },
  };
  const identicalInner = environmentSetupOutcomeSpool(identicalData);
  let identicalInnerResult: EnvironmentSetupJournal | undefined;
  let identicalInterleaved = false;
  const identicalOuter = environmentSetupOutcomeSpool(identicalData, {
    afterTerminalRead() {
      if (identicalInterleaved) return;
      identicalInterleaved = true;
      identicalInnerResult = identicalInner.complete(identicalOutcome);
    },
  });
  identicalOuter.begin(identicalIdentity);

  const identicalOuterResult = identicalOuter.complete(identicalOutcome);
  expect(identicalInnerResult).toEqual(identicalOuterResult);
  expect(environmentSetupOutcomeSpool(identicalData).load()).toEqual([identicalOuterResult]);

  const conflictingData = temporaryDataDir();
  const conflictingIdentity = {
    requestId: "envsetup_conflicting_writers",
    name: "analysis",
    declarationGenerationId: "envgen_conflicting_writers",
  };
  const winner: EnvironmentSetupOutcome = {
    ...conflictingIdentity,
    result: {
      ok: true,
      status: {
        state: "ready",
        name: "analysis",
        language: "python",
        manager: "uv",
        platform: "macos-aarch64",
        root: "/work/envs/analysis",
        lockRevision: 7,
        setupRequestId: conflictingIdentity.requestId,
        lockfileFingerprint: "a".repeat(64),
        packageFingerprint: "b".repeat(64),
        declarationGenerationId: "envgen_conflicting_writers",
      },
    },
  };
  const loser: EnvironmentSetupOutcome = {
    ...conflictingIdentity,
    result: { ok: false, name: "analysis", error: "must not replace success" },
  };
  const conflictingInner = environmentSetupOutcomeSpool(conflictingData);
  let conflictInterleaved = false;
  const conflictingOuter = environmentSetupOutcomeSpool(conflictingData, {
    afterTerminalRead() {
      if (conflictInterleaved) return;
      conflictInterleaved = true;
      conflictingInner.complete(winner);
    },
  });
  conflictingOuter.begin(conflictingIdentity);

  expect(() => conflictingOuter.complete(loser)).toThrow(/conflict/i);
  expect(environmentSetupOutcomeSpool(conflictingData).load()).toEqual([
    expect.objectContaining({ ...winner, state: "terminal" }),
  ]);
});

it("reloads an exact terminal claim after a crash before main-journal promotion", () => {
  const dataDir = temporaryDataDir();
  const identity = {
    requestId: "envsetup_claim_crash",
    name: "analysis",
    declarationGenerationId: "envgen_claim_crash",
  };
  const outcome: EnvironmentSetupOutcome = {
    ...identity,
    result: { ok: false, name: "analysis", error: "exact failure" },
  };
  const crashing = environmentSetupOutcomeSpool(dataDir, {
    afterTerminalClaim() {
      throw new Error("injected crash after terminal claim");
    },
  });
  crashing.begin(identity);

  expect(() => crashing.complete(outcome)).toThrow(/injected crash/);
  const reloaded = environmentSetupOutcomeSpool(dataDir);
  const [terminal] = reloaded.load();
  expect(terminal).toEqual(expect.objectContaining({ ...outcome, state: "terminal" }));
  expect(() => reloaded.begin(identity)).toThrow(/conflict/i);

  const root = join(dataDir, "environment-setup-outcomes");
  const entries = readdirSync(root);
  expect(entries).toHaveLength(2);
  expect(entries.every((entry) => (statSync(join(root, entry)).mode & 0o777) === 0o600)).toBe(true);
  expect(entries.some((entry) => /\.\d+\.[a-f0-9]+$/.test(entry))).toBe(false);

  reloaded.acknowledge(terminal as Extract<EnvironmentSetupJournal, { state: "terminal" }>);
  expect(readdirSync(root)).toEqual([]);
});

it("converges exact acknowledgement from main-only, claim-only, and post-unlink missing states", () => {
  const identity = {
    requestId: "envsetup_ack_convergence",
    name: "analysis",
    declarationGenerationId: "envgen_ack_convergence",
  };
  const outcome: EnvironmentSetupOutcome = {
    ...identity,
    result: { ok: false, name: identity.name, error: "exact failure" },
  };

  // Main-only: a prior cleanup already removed the immutable claim.
  const mainOnlyData = temporaryDataDir();
  const mainOnly = environmentSetupOutcomeSpool(mainOnlyData);
  mainOnly.begin(identity);
  const mainTerminal = mainOnly.complete(outcome);
  const mainRoot = join(mainOnlyData, "environment-setup-outcomes");
  rmSync(join(mainRoot, readdirSync(mainRoot).find((entry) => entry.endsWith(".terminal"))!));
  mainOnly.acknowledge(mainTerminal);
  expect(readdirSync(mainRoot)).toEqual([]);

  // Claim-only: crash immediately after the main unlink, then restart.
  const claimOnlyData = temporaryDataDir();
  const crashAfterMain = environmentSetupOutcomeSpool(claimOnlyData, {
    afterAckMainUnlink() {
      throw new Error("injected crash after main unlink");
    },
  });
  crashAfterMain.begin(identity);
  const claimTerminal = crashAfterMain.complete(outcome);
  expect(() => crashAfterMain.acknowledge(claimTerminal)).toThrow(/after main unlink/);
  const claimRoot = join(claimOnlyData, "environment-setup-outcomes");
  expect(readdirSync(claimRoot)).toEqual([expect.stringMatching(/\.terminal$/)]);
  environmentSetupOutcomeSpool(claimOnlyData).acknowledge(claimTerminal);
  expect(readdirSync(claimRoot)).toEqual([]);

  // Missing: crash after both unlinks. The already-authoritatively-acked
  // cleanup retry is a no-op, not an endless repost loop.
  const missingData = temporaryDataDir();
  const phases: string[] = [];
  const crashAfterClaim = environmentSetupOutcomeSpool(missingData, {
    afterAckClaimUnlink() {
      throw new Error("injected crash after claim unlink");
    },
    beforeDirectoryFsync(phase) {
      if (phase.startsWith("ack-")) phases.push(phase);
    },
  });
  crashAfterClaim.begin(identity);
  const missingTerminal = crashAfterClaim.complete(outcome);
  expect(() => crashAfterClaim.acknowledge(missingTerminal)).toThrow(/after claim unlink/);
  const missingRoot = join(missingData, "environment-setup-outcomes");
  expect(readdirSync(missingRoot)).toEqual([]);
  expect(() => environmentSetupOutcomeSpool(missingData).acknowledge(missingTerminal)).not.toThrow();
  expect(phases).toContain("ack-main");
});

it("propagates an acknowledgement directory-fsync failure and leaves exact claim evidence", () => {
  const dataDir = temporaryDataDir();
  const identity = {
    requestId: "envsetup_ack_fsync",
    name: "analysis",
    declarationGenerationId: "envgen_ack_fsync",
  };
  const outcome: EnvironmentSetupOutcome = {
    ...identity,
    result: { ok: false, name: identity.name, error: "exact failure" },
  };
  const failing = environmentSetupOutcomeSpool(dataDir, {
    beforeDirectoryFsync(phase) {
      if (phase === "ack-main") throw new Error("injected ack fsync failure");
    },
  });
  failing.begin(identity);
  const terminal = failing.complete(outcome);

  expect(() => failing.acknowledge(terminal)).toThrow(/injected ack fsync failure/);
  expect(environmentSetupOutcomeSpool(dataDir).load()).toEqual([
    expect.objectContaining({ ...outcome, state: "terminal" }),
  ]);
  environmentSetupOutcomeSpool(dataDir).acknowledge(terminal);
  expect(environmentSetupOutcomeSpool(dataDir).hasRecord(identity.requestId)).toBe(false);
});
