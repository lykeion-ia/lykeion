import type { KernelEnvStatus } from "./machine";
import { canonicalJson } from "./provenance";

export const ENVIRONMENT_SETUP_OUTCOME_LIMITS = {
  requestIdBytes: 1_024,
  nameBytes: 512,
  generationIdBytes: 1_024,
  platformBytes: 256,
  rootBytes: 4_096,
  versionBytes: 256,
  errorBytes: 4_096,
  recordBytes: 8_192,
} as const;

export interface EnvironmentSetupOutcomeIdentity {
  requestId: string;
  name: string;
  declarationGenerationId: string;
}

export type EnvironmentSetupTerminalResult =
  | { ok: true; status: KernelEnvStatus }
  | { ok: false; name: string; error: string };

export interface CanonicalEnvironmentSetupOutcome extends EnvironmentSetupOutcomeIdentity {
  result: EnvironmentSetupTerminalResult;
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function boundedUtf8(value: string, maxBytes: number): string {
  let used = 0;
  let result = "";
  for (const character of value) {
    const width = utf8Bytes(character);
    if (used + width > maxBytes) break;
    result += character;
    used += width;
  }
  return result;
}

/**
 * Removes credential-shaped material before any caller is allowed to truncate
 * it. The URL branch deliberately treats an authority containing `:` but no
 * `@` as incomplete userinfo rather than as a harmless host/port: losing a
 * port from a diagnostic is safer than persisting the first half of a secret
 * whose trailing `@host` landed just beyond a byte boundary.
 */
export function redactCredentialLike(value: string): string {
  const key =
    "(?:authorization|proxy[-_]authorization|" +
    "(?:[a-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|" +
    "auth[_-]?token|token|password|passwd|secret(?:[_-]?access[_-]?key)?))";
  const quotedOrRemainder =
    '(?:"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|[^\\r\\n,;&}]+)';
  const assignment = new RegExp(
    `(^|[^a-z0-9])(["']?)(${key})\\2\\s*[:=]\\s*(${quotedOrRemainder})`,
    "gim",
  );
  const option = new RegExp(`\\b(--${key})\\s+(${quotedOrRemainder})`, "gi");

  return value
    .replace(
      /([a-z][a-z0-9+.-]*:\/\/)([^\s/?#]*)/gi,
      (whole, scheme: string, authority: string) => {
        const at = authority.lastIndexOf("@");
        if (at >= 0) return `${scheme}[redacted]@${authority.slice(at + 1)}`;
        if (authority.includes(":") || /%3a/i.test(authority)) return `${scheme}[redacted]`;
        return whole;
      },
    )
    .replace(
      assignment,
      (_whole, prefix: string, quote: string, credentialKey: string) =>
        `${prefix}${quote}${credentialKey}${quote}=[redacted]`,
    )
    .replace(option, (_whole, credentialOption: string) => `${credentialOption} [redacted]`);
}

function exactIdentity(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || utf8Bytes(value) > maxBytes)
    throw new Error(`${label} is not a valid bounded environment setup identity`);
  return value;
}

function exactEvidenceFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new Error(`${label} must be an exact SHA-256 fingerprint`);
  return value;
}

export function boundedRedactedUtf8(value: string, maxBytes: number): string {
  const redacted = redactCredentialLike(value);
  let bounded = boundedUtf8(redacted, maxBytes);
  // Do not let the byte boundary turn our conservative replacement itself
  // into ambiguous URL/userinfo text. If it bisects the marker, make room for
  // the complete marker while retaining as much preceding diagnostic as fits.
  const marker = "[redacted]";
  const opening = bounded.lastIndexOf("[");
  if (
    opening >= 0 &&
    !bounded.slice(opening).includes("]") &&
    marker.startsWith(bounded.slice(opening))
  ) {
    bounded = `${boundedUtf8(bounded.slice(0, opening), maxBytes - utf8Bytes(marker))}${marker}`;
  }
  return bounded;
}

function safeDisplay(value: unknown, maxBytes: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return boundedRedactedUtf8(value, maxBytes);
}

function optionalNatural(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The single canonical terminal-result projection used by both daemon and
 * server. It validates exact identity, drops every non-allowlisted field,
 * redacts before UTF-8 byte bounds, and returns keys in the public semantic
 * shape. `canonicalJson` supplies deterministic ordering for fingerprinting.
 */
export function canonicalEnvironmentSetupOutcome(
  input: unknown,
): CanonicalEnvironmentSetupOutcome {
  if (!record(input)) throw new Error("environment setup outcome must be an object");
  const requestId = exactIdentity(
    input.requestId,
    ENVIRONMENT_SETUP_OUTCOME_LIMITS.requestIdBytes,
    "requestId",
  );
  const name = exactIdentity(
    input.name,
    ENVIRONMENT_SETUP_OUTCOME_LIMITS.nameBytes,
    "environment name",
  );
  const declarationGenerationId = exactIdentity(
    input.declarationGenerationId,
    ENVIRONMENT_SETUP_OUTCOME_LIMITS.generationIdBytes,
    "declarationGenerationId",
  );
  if (!record(input.result) || typeof input.result.ok !== "boolean")
    throw new Error("environment setup outcome needs an exact result");

  let result: EnvironmentSetupTerminalResult;
  if (input.result.ok) {
    const status = input.result.status;
    if (!record(status)) throw new Error("successful environment setup needs a status");
    if (status.state !== "ready") throw new Error("successful environment setup status must be ready");
    if (status.name !== name) throw new Error("successful environment setup name does not match");
    if (status.language !== "python" && status.language !== "r")
      throw new Error("successful environment setup language is invalid");
    if (status.manager !== "uv" && status.manager !== "conda")
      throw new Error("successful environment setup manager is invalid");
    if (status.declarationGenerationId !== declarationGenerationId)
      throw new Error("successful environment setup generation does not match");
    const setupRequestId = exactIdentity(
      status.setupRequestId,
      ENVIRONMENT_SETUP_OUTCOME_LIMITS.requestIdBytes,
      "setupRequestId",
    );
    if (setupRequestId !== requestId)
      throw new Error("successful environment setup request does not match");
    const lockfileFingerprint = exactEvidenceFingerprint(
      status.lockfileFingerprint,
      "environment lockfileFingerprint",
    );
    const packageFingerprint = exactEvidenceFingerprint(
      status.packageFingerprint,
      "environment packageFingerprint",
    );
    const platform = safeDisplay(
      status.platform,
      ENVIRONMENT_SETUP_OUTCOME_LIMITS.platformBytes,
      "environment platform",
    );
    const root = safeDisplay(
      status.root,
      ENVIRONMENT_SETUP_OUTCOME_LIMITS.rootBytes,
      "environment root",
    );
    const version = status.version === undefined
      ? undefined
      : safeDisplay(
          status.version,
          ENVIRONMENT_SETUP_OUTCOME_LIMITS.versionBytes,
          "environment version",
        );
    const packageCount = optionalNatural(status.packageCount, "environment packageCount");
    const lockRevision = optionalNatural(status.lockRevision, "environment lockRevision");
    const declarationCreatedTs = optionalNatural(
      status.declarationCreatedTs,
      "environment declarationCreatedTs",
    );
    result = {
      ok: true,
      status: {
        state: "ready",
        name,
        language: status.language,
        manager: status.manager,
        platform,
        root,
        ...(version === undefined ? {} : { version }),
        ...(packageCount === undefined ? {} : { packageCount }),
        ...(lockRevision === undefined ? {} : { lockRevision }),
        setupRequestId,
        lockfileFingerprint,
        packageFingerprint,
        declarationGenerationId,
        ...(declarationCreatedTs === undefined ? {} : { declarationCreatedTs }),
      },
    };
  } else {
    if (input.result.name !== name) throw new Error("failed environment setup name does not match");
    const error = safeDisplay(
      input.result.error,
      ENVIRONMENT_SETUP_OUTCOME_LIMITS.errorBytes,
      "environment setup error",
    );
    if (error.length === 0) throw new Error("failed environment setup needs a non-empty error");
    result = { ok: false, name, error };
  }

  const canonical: CanonicalEnvironmentSetupOutcome = {
    requestId,
    name,
    declarationGenerationId,
    result,
  };
  if (utf8Bytes(canonicalJson(canonical)) > ENVIRONMENT_SETUP_OUTCOME_LIMITS.recordBytes)
    throw new Error("environment setup outcome exceeds its total encoded record bound");
  return canonical;
}

export function canonicalEnvironmentSetupOutcomeJson(input: unknown): string {
  return canonicalJson(canonicalEnvironmentSetupOutcome(input));
}
