import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  ENVIRONMENT_SETUP_OUTCOME_LIMITS,
  canonicalEnvironmentSetupOutcome,
  canonicalEnvironmentSetupOutcomeJson,
  canonicalJson,
  utf8Bytes,
  type CanonicalEnvironmentSetupOutcome,
  type EnvironmentSetupOutcomeIdentity,
} from "@lykeion/api";

export type EnvironmentSetupOutcome = CanonicalEnvironmentSetupOutcome;

export interface EnvironmentSetupProvisioning extends EnvironmentSetupOutcomeIdentity {
  state: "provisioning";
}

export interface EnvironmentSetupTerminal extends EnvironmentSetupOutcome {
  state: "terminal";
}

export type EnvironmentSetupJournal = EnvironmentSetupProvisioning | EnvironmentSetupTerminal;

export interface EnvironmentSetupOutcomeSpoolHooks {
  /** Deterministic race/crash seams used by the durability tests. */
  afterTerminalRead?: () => void;
  afterTerminalClaim?: () => void;
  afterAckMainUnlink?: () => void;
  afterAckClaimUnlink?: () => void;
  beforeDirectoryFsync?: (phase: EnvironmentSetupDirectoryFsyncPhase) => void;
}

export type EnvironmentSetupDirectoryFsyncPhase =
  | "root-create"
  | "root-ready"
  | "begin-claim"
  | "begin-temp-cleanup"
  | "terminal-claim"
  | "terminal-promotion"
  | "ack-main"
  | "ack-claim"
  | "temp-scavenge";

export type EnvironmentSetupBeginResult =
  | { role: "owner"; journal: EnvironmentSetupProvisioning }
  | { role: "observer"; journal: EnvironmentSetupProvisioning };

type StoredJournal =
  | ({ version: 2 } & EnvironmentSetupProvisioning)
  | ({ version: 2 } & EnvironmentSetupTerminal);

const OUTCOME_DIR = "environment-setup-outcomes";
const MAX_STORED_BYTES = ENVIRONMENT_SETUP_OUTCOME_LIMITS.recordBytes;

function outcomePath(root: string, requestId: string): string {
  const digest = createHash("sha256").update(requestId).digest("hex");
  return join(root, `${digest}.json`);
}

function terminalClaimPath(root: string, requestId: string): string {
  // Beside the main journal so hard-link creation never crosses a filesystem.
  return `${outcomePath(root, requestId)}.terminal`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactIdentity(input: unknown): EnvironmentSetupOutcomeIdentity {
  if (!isRecord(input)) throw new Error("environment setup journal identity must be an object");
  const { requestId, name, declarationGenerationId } = input;
  if (
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    utf8Bytes(requestId) > ENVIRONMENT_SETUP_OUTCOME_LIMITS.requestIdBytes ||
    typeof name !== "string" ||
    name.length === 0 ||
    utf8Bytes(name) > ENVIRONMENT_SETUP_OUTCOME_LIMITS.nameBytes ||
    typeof declarationGenerationId !== "string" ||
    declarationGenerationId.length === 0 ||
    utf8Bytes(declarationGenerationId) > ENVIRONMENT_SETUP_OUTCOME_LIMITS.generationIdBytes
  )
    throw new Error("environment setup journal has an invalid bounded exact identity");
  return { requestId, name, declarationGenerationId };
}

function parseJournal(value: unknown): EnvironmentSetupJournal | undefined {
  if (!isRecord(value)) return undefined;

  if (value.version === 2 && value.state === "provisioning") {
    try {
      return { ...exactIdentity(value), state: "provisioning" };
    } catch {
      return undefined;
    }
  }

  if (value.version === 2 && value.state === "terminal") {
    try {
      return { ...canonicalEnvironmentSetupOutcome(value), state: "terminal" };
    } catch {
      return undefined;
    }
  }

  // Version 1 was terminal-only. It is safe to replay only when it already
  // carries the exact generation required by the v2 canonical contract.
  if (value.version === 1) {
    try {
      return { ...canonicalEnvironmentSetupOutcome(value), state: "terminal" };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sameIdentity(
  left: EnvironmentSetupOutcomeIdentity,
  right: EnvironmentSetupOutcomeIdentity,
): boolean {
  return (
    left.requestId === right.requestId &&
    left.name === right.name &&
    left.declarationGenerationId === right.declarationGenerationId
  );
}

function journalJson(journal: EnvironmentSetupJournal): string {
  const stored: StoredJournal = { version: 2, ...journal };
  const encoded = canonicalJson(stored);
  if (utf8Bytes(encoded) > MAX_STORED_BYTES)
    throw new Error("environment setup journal exceeds its total encoded record bound");
  return encoded;
}

function syncDirectory(
  root: string,
  phase: EnvironmentSetupDirectoryFsyncPhase,
  hooks: EnvironmentSetupOutcomeSpoolHooks,
): void {
  hooks.beforeDirectoryFsync?.(phase);
  const directory = openSync(root, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/**
 * A daemon-owned exact setup journal. The provisioning entry is the write-
 * ahead boundary: no resolver or materializer may run before `begin` returns.
 * It stores only bounded identity and canonical terminal result fields, never
 * packages, lockfiles, command environments, authorization, or progress logs.
 */
export function environmentSetupOutcomeSpool(
  dataDir: string,
  hooks: EnvironmentSetupOutcomeSpoolHooks = {},
) {
  const root = join(dataDir, OUTCOME_DIR);
  const rootExisted = existsSync(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  if (!rootExisted) syncDirectory(dataDir, "root-create", hooks);
  syncDirectory(root, "root-ready", hooks);

  function scavengeRepresentedTempHardlinks(): void {
    const tempPattern = /^([a-f0-9]{64}\.json)\.\d+\.[a-f0-9]{12}$/;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const matched = tempPattern.exec(entry.name);
      if (matched === null) continue;
      const path = join(root, entry.name);
      const temp = lstatSync(path);
      if (!temp.isFile() || (temp.mode & 0o777) !== 0o600 || temp.nlink < 2) continue;
      const main = join(root, matched[1]!);
      const claim = `${main}.terminal`;
      const represented = [main, claim].some((candidate) => {
        try {
          const authority = lstatSync(candidate);
          return (
            authority.isFile() &&
            (authority.mode & 0o777) === 0o600 &&
            authority.dev === temp.dev &&
            authority.ino === temp.ino
          );
        } catch {
          return false;
        }
      });
      if (!represented) continue;
      rmSync(path);
      syncDirectory(root, "temp-scavenge", hooks);
    }
  }

  scavengeRepresentedTempHardlinks();

  function readJournal(
    path: string,
    expectedPath: (requestId: string) => string,
    requiredState?: EnvironmentSetupJournal["state"],
  ): EnvironmentSetupJournal {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      throw new Error(`environment setup journal cannot be read: ${String(error)}`);
    }
    if (utf8Bytes(raw) > MAX_STORED_BYTES)
      throw new Error("environment setup journal is corrupt or oversized");
    try {
      const parsed = parseJournal(JSON.parse(raw));
      if (
        parsed === undefined ||
        expectedPath(parsed.requestId) !== path ||
        (requiredState !== undefined && parsed.state !== requiredState)
      )
        throw new Error("invalid exact journal record");
      return parsed;
    } catch (error) {
      throw new Error(`environment setup journal is corrupt: ${String(error)}`);
    }
  }

  function readExact(requestId: string): EnvironmentSetupJournal | undefined {
    const claim = terminalClaimPath(root, requestId);
    if (existsSync(claim)) return readJournal(claim, (id) => terminalClaimPath(root, id), "terminal");
    const destination = outcomePath(root, requestId);
    if (!existsSync(destination)) return undefined;
    return readJournal(destination, (id) => outcomePath(root, id));
  }

  function temporaryFile(destination: string, journal: EnvironmentSetupJournal): string {
    const temporary = `${destination}.${process.pid}.${randomBytes(6).toString("hex")}`;
    writeFileSync(temporary, journalJson(journal), { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    const file = openSync(temporary, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    return temporary;
  }

  return {
    load(): EnvironmentSetupJournal[] {
      const entries = readdirSync(root, { withFileTypes: true });
      const claimNames = new Set(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json.terminal"))
          .map((entry) => entry.name),
      );
      const journals = new Map<string, EnvironmentSetupJournal>();
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const path = join(root, entry.name);
        try {
          if (entry.name.endsWith(".json.terminal")) {
            const parsed = readJournal(path, (id) => terminalClaimPath(root, id), "terminal");
            journals.set(parsed.requestId, parsed);
            continue;
          }
          if (!entry.name.endsWith(".json") || claimNames.has(`${entry.name}.terminal`)) continue;
          const parsed = readJournal(path, (id) => outcomePath(root, id));
          journals.set(parsed.requestId, parsed);
        } catch {
          // Fail closed. An unreadable or tampered record authorizes neither a
          // repost nor another provision attempt; hasRecord still quarantines
          // its exact hashed request id when a matching command arrives.
        }
      }
      return [...journals.values()];
    },

    begin(input: EnvironmentSetupOutcomeIdentity): EnvironmentSetupBeginResult {
      const identity = exactIdentity(input);
      const journal: EnvironmentSetupProvisioning = { ...identity, state: "provisioning" };
      const destination = outcomePath(root, identity.requestId);
      if (existsSync(terminalClaimPath(root, identity.requestId))) {
        readExact(identity.requestId);
        throw new Error("environment setup journal identity or state conflict");
      }
      const temporary = temporaryFile(destination, journal);
      try {
        try {
          // Linking a synced temporary file gives an atomic create-if-absent
          // operation. Unlike rename, it cannot replace conflicting evidence.
          linkSync(temporary, destination);
          syncDirectory(root, "begin-claim", hooks);
          rmSync(temporary);
          syncDirectory(root, "begin-temp-cleanup", hooks);
          return { role: "owner", journal };
        } catch (error) {
          const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
          if (code !== "EEXIST") throw error;
          const existing = readExact(identity.requestId);
          if (existing?.state === "provisioning" && sameIdentity(existing, identity))
            return { role: "observer", journal: existing };
          throw new Error("environment setup journal identity or state conflict");
        }
      } finally {
        rmSync(temporary, { force: true });
      }
    },

    complete(input: EnvironmentSetupOutcome): EnvironmentSetupTerminal {
      const outcome = canonicalEnvironmentSetupOutcome(input);
      const terminal: EnvironmentSetupTerminal = { ...outcome, state: "terminal" };
      const destination = outcomePath(root, outcome.requestId);
      const existing = readExact(outcome.requestId);
      if (existing?.state === "terminal") {
        if (canonicalEnvironmentSetupOutcomeJson(existing) === canonicalEnvironmentSetupOutcomeJson(outcome))
          return existing;
        throw new Error("environment setup terminal outcome conflict");
      }
      if (existing === undefined || !sameIdentity(existing, outcome))
        throw new Error("environment setup journal identity or state conflict");
      hooks.afterTerminalRead?.();

      const temporary = temporaryFile(destination, terminal);
      try {
        const claim = terminalClaimPath(root, outcome.requestId);
        let createdClaim = false;
        try {
          // This immutable claim is the compare-and-swap authority that a
          // replacing rename alone cannot provide. Two writers may both have
          // read provisioning, but only one can hard-link its already synced
          // 0600 terminal record here. The claim and temporary are in the
          // same directory, so link never relies on cross-filesystem support.
          linkSync(temporary, claim);
          chmodSync(claim, 0o600);
          syncDirectory(root, "terminal-claim", hooks);
          createdClaim = true;
        } catch (error) {
          const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
          if (code !== "EEXIST") throw error;
          const claimed = readJournal(
            claim,
            (id) => terminalClaimPath(root, id),
            "terminal",
          );
          if (
            canonicalEnvironmentSetupOutcomeJson(claimed) !==
            canonicalEnvironmentSetupOutcomeJson(outcome)
          )
            throw new Error("environment setup terminal outcome conflict");
        }
        if (createdClaim) hooks.afterTerminalClaim?.();
        // Exact matching provisioning evidence is the only record that may be
        // atomically promoted. The immutable claim above prevents a second,
        // conflicting writer from ever reaching this replacing rename.
        renameSync(temporary, destination);
        chmodSync(destination, 0o600);
        syncDirectory(root, "terminal-promotion", hooks);
      } finally {
        rmSync(temporary, { force: true });
      }
      return terminal;
    },

    hasRecord(requestId: string): boolean {
      return (
        existsSync(outcomePath(root, requestId)) ||
        existsSync(terminalClaimPath(root, requestId))
      );
    },

    acknowledge(expected: EnvironmentSetupTerminal): void {
      const canonical = canonicalEnvironmentSetupOutcome(expected);
      const main = outcomePath(root, canonical.requestId);
      const claim = terminalClaimPath(root, canonical.requestId);
      const mainExists = existsSync(main);
      const claimExists = existsSync(claim);
      // A cleanup retry after both exact evidence links were already removed
      // has reached its requested state. This method is called only after the
      // lab's authoritative exact 2xx; with nothing left, there is nothing a
      // mismatched object could remove.
      if (!mainExists && !claimExists) return;
      const existing = readExact(canonical.requestId);
      if (
        existing?.state !== "terminal" ||
        canonicalEnvironmentSetupOutcomeJson(existing) !== canonicalEnvironmentSetupOutcomeJson(canonical)
      )
        throw new Error("environment setup acknowledgement does not match terminal evidence");
      if (mainExists) {
        rmSync(main, { force: true });
        hooks.afterAckMainUnlink?.();
        syncDirectory(root, "ack-main", hooks);
      }
      if (claimExists) {
        rmSync(claim, { force: true });
        hooks.afterAckClaimUnlink?.();
        syncDirectory(root, "ack-claim", hooks);
      }
    },
  };
}
