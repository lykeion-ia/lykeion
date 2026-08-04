/**
 * The closed set of ways a call can fail. Closed on purpose: a caller
 * branching on an open set of strings has no way to be exhaustive, and every
 * surface that shows an error would need updating when a new one appeared.
 */
export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "invalid"
  | "unsupported";

/**
 * A failure any implementation of the contract can raise and any caller can
 * branch on. Every implementation throws this, so a surface that handles
 * `unauthenticated` by asking for a sign-in behaves the same wherever its
 * data comes from.
 */
export class LykeionError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "LykeionError";
    this.code = code;
  }
}

export function isLykeionError(value: unknown): value is LykeionError {
  return value instanceof LykeionError;
}
