import {
  isLykeionError,
  LykeionError,
  type ErrorCode,
  type LykeionApi,
} from "@lykeion/api";

export type RpcResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: ErrorCode; message: string } };

/**
 * The methods this api object actually carries. Derived from the object
 * rather than from a list, so there is no second inventory to drift: the
 * object is typed `LykeionApi`, which is what guarantees it is complete.
 */
export function rpcMethods(api: LykeionApi): Set<string> {
  return new Set(Object.keys(api));
}

/**
 * Call one contract method by name and describe the outcome. A failure the
 * contract defines becomes an error envelope; anything else is a bug in the
 * server and is left to propagate, because a caller told `invalid` when the
 * server crashed will go looking in the wrong place.
 */
export async function dispatch(
  api: LykeionApi,
  method: string,
  args: unknown[],
): Promise<RpcResponse> {
  // Typed, because both are things a caller can get wrong. A plain Error
  // here would reach the transport as a crash, and a client would have no
  // way to tell its own typo from the server falling over.
  if (!Array.isArray(args))
    throw new LykeionError("invalid", "args must be an array");
  if (!rpcMethods(api).has(method))
    throw new LykeionError("not-found", `unknown method: ${method}`);
  const fn = (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
  try {
    return { ok: true, value: await fn.apply(api, args) };
  } catch (err) {
    if (isLykeionError(err)) return { ok: false, error: { code: err.code, message: err.message } };
    throw err;
  }
}
