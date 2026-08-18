import type { KernelEnvStatus } from "@lykeion/api";

/**
 * `kernel-env-setup` asks in flight: one per outstanding `kernelEnvSetup`
 * call, made through `RunRelay.deliverNow` and answered — or not — through
 * `/daemon/kernel-env/result`.
 *
 * Modeled on `title-registry.ts`/`kernel-list-registry.ts`, which solve the
 * identical problem for the identical reason: the command travels down the
 * relay and the answer arrives on a different HTTP call entirely, so
 * something has to hold the request open across that gap and settle it when
 * the reply lands, or give up.
 *
 * Unlike either of those, a timeout here does NOT read as a real answer
 * ("holds nothing" / "no title") — see `await`'s own doc.
 */

/** What a machine's `kernel-env-setup` finally came to: the finished status
 *  it materialized, or the reason it could not. */
export type EnvSetupResult =
  | { ok: true; status: KernelEnvStatus }
  | { ok: false; error: string };

/**
 * How long `kernelEnvSetup` waits on the machine it asked before giving up.
 *
 * Sized off `packages/daemon/src/probe.ts`'s own `PROVISION_TIMEOUT_MS` (ten
 * minutes): the revision-0 path runs three confined `uv` invocations in
 * sequence on that machine — compile, venv, sync — each individually
 * bounded by that constant, so the daemon's own worst case sits close to
 * three times it. This waits longer than that worst case, deliberately,
 * rather than shorter: giving up before the machine does would tell a
 * researcher their setup failed while it is quietly still running, and a
 * retry from here would duplicate the very download D4 exists to avoid
 * replaying.
 */
const DEFAULT_TIMEOUT_MS = 40 * 60_000;

export interface EnvSetupRegistry {
  /** Waits for `machineId` to answer the `requestId` it was asked with, for
   *  the environment `name` it was asked about — `name` is remembered here
   *  rather than merely sent down the wire, because `holds` has to be able
   *  to say later which environment this ask was for.
   *
   *  Resolves to `undefined` once the wait runs out — never rejects, so the
   *  caller decides how to phrase "the machine never came back" — and
   *  unlike `KernelListRegistry`/`TitleRegistry`, `undefined` here is NOT
   *  treated as a real, empty answer: a setup that timed out may still be
   *  running on the machine, and nothing here has any way to know it is
   *  not. */
  await(
    machineId: string,
    requestId: string,
    name: string,
    options?: {
      /** The package list this lab asked THIS machine to resolve from, on
       *  the ask this entry is for. Absent on the replay branch, which
       *  resolves nothing and pins nothing. Remembered here rather than
       *  re-read from the declaration when the pin lands, because the whole
       *  reason a pin can go stale is that the declaration MOVES: a lock
       *  stamped with whatever the declaration said at write time would
       *  claim a resolve covered packages that were added after it started,
       *  and the next machine would replay a lockfile missing them. */
      resolvedFrom?: string[];
      timeoutMs?: number;
    },
  ): Promise<EnvSetupResult | undefined>;
  /**
   * What a machine claiming to be `machineId` reported for `requestId`.
   * Accepted, and returns `true`, only when `machineId` is the one this
   * `requestId` was actually minted for — checked here, not left to the
   * caller, for the reason `kernel-list-registry.ts` checks it there: a
   * request id is minted off the same globally-sequential counter session
   * ids are and is exactly as guessable, and a bearer token proves only
   * that some paired machine is calling, never that it is the one a given
   * request was ever addressed to.
   *
   * Refuses and returns `false`, touching nothing, for a mismatched
   * `machineId` or a `requestId` nobody is waiting on. Refusing never
   * consumes the entry: the machine this request actually belongs to can
   * still settle it correctly afterward.
   */
  settle(machineId: string, requestId: string, result: EnvSetupResult): boolean;
  /**
   * Whether this lab asked `machineId` to RESOLVE `name` on `requestId` —
   * asked without settling anything, because a machine posting its resolved
   * lockfile is still mid-build and must go on being waited for.
   *
   * Four facts, not three. The machine, the request and the name are the
   * addressing; `resolvedFrom` being present is the ASK ITSELF, and it is the
   * one this method is named for. `oneSetup` sets it only on the resolving
   * branch — a replay "resolves nothing and pins nothing", in its own words —
   * so an entry without one is a machine that was handed this lab's existing
   * lockfile and told to materialize it. Such a machine has no lockfile of
   * its own to hand back, and a pin it posted anyway would be text this lab
   * never asked anyone to produce.
   *
   * `settle`'s reasoning applies unchanged to the addressing: a bearer token
   * proves some paired machine is calling, never that it is the one a given
   * request went to. It matters more here than anywhere else on this wire,
   * because a lockfile is the one thing every OTHER machine will later replay
   * verbatim (D4) — so a machine allowed to write a pin it was never asked
   * for would not merely corrupt its own build, it would repin an environment
   * lab-wide and every later machine would faithfully reproduce it.
   *
   * `name` is checked for that same reason and not one weaker. Machine plus
   * request alone would leave a machine legitimately building `foo` free to
   * post, during its own build window, a pin for any OTHER environment this
   * lab declares — a lab-wide, durable repin of something it was never asked
   * to touch. The ask names one environment; only that one may be pinned
   * under it.
   *
   * And the replay half is not weaker than either. A pin written under a
   * materialize-only ask cannot name what it was resolved from — this lab
   * never said — so `planFor` reads the new revision as one it cannot match
   * against the declaration and WIDENS every other machine in the lab to
   * `resolve`. D4's one-lockfile guarantee is then silently off for that
   * environment from that moment on, which is a worse outcome than the
   * corrupted build, and it is reached by a machine that was only ever asked
   * to copy.
   */
  askedToResolve(machineId: string, requestId: string, name: string): boolean;
  /**
   * What this lab asked `machineId` to resolve `name` from on `requestId`,
   * or `undefined` where it asked no such thing — a replay, a request nobody
   * is waiting on, or a machine that is not the one this ask went to.
   *
   * Checked on all three of machine, request and name for the reason
   * `askedToResolve` is: this answer is written down beside the lockfile and
   * every later machine's decision to replay or re-resolve turns on it, so a
   * machine must not be able to stamp its own pin with an ask it was never
   * given. `askedToResolve` is this same read, asked as a question — the two
   * are deliberately one fact so that a route which passes the first cannot
   * write a NULL through the second.
   */
  resolvedFrom(machineId: string, requestId: string, name: string): string[] | undefined;
}

export function createEnvSetupRegistry(): EnvSetupRegistry {
  const waiting = new Map<
    string,
    {
      machineId: string;
      name: string;
      resolvedFrom?: string[];
      resolve: (result: EnvSetupResult | undefined) => void;
    }
  >();
  /** The one read of what this lab asked a machine to resolve, which both
   *  `askedToResolve` and `resolvedFrom` answer from. */
  const resolvedFromOf = (
    machineId: string,
    requestId: string,
    name: string,
  ): string[] | undefined => {
    const entry = waiting.get(requestId);
    if (entry === undefined || entry.machineId !== machineId || entry.name !== name)
      return undefined;
    return entry.resolvedFrom;
  };
  return {
    await(machineId, requestId, name, options) {
      const { resolvedFrom, timeoutMs = DEFAULT_TIMEOUT_MS } = options ?? {};
      return new Promise<EnvSetupResult | undefined>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(requestId);
          resolve(undefined);
        }, timeoutMs);
        timer.unref?.();
        waiting.set(requestId, {
          machineId,
          name,
          ...(resolvedFrom === undefined ? {} : { resolvedFrom }),
          resolve: (result) => {
            clearTimeout(timer);
            waiting.delete(requestId);
            resolve(result);
          },
        });
      });
    },
    settle(machineId, requestId, result) {
      const entry = waiting.get(requestId);
      if (!entry || entry.machineId !== machineId) return false;
      entry.resolve(result);
      return true;
    },
    askedToResolve(machineId, requestId, name) {
      // Written as the presence of the answer `resolvedFrom` gives, rather
      // than as a fourth condition beside it, so the two cannot drift into
      // disagreeing about what this lab asked for. Not `this.resolvedFrom`:
      // a caller that pulled the method off the object would lose the
      // receiver, and the check with it.
      return resolvedFromOf(machineId, requestId, name) !== undefined;
    },
    resolvedFrom(machineId, requestId, name) {
      return resolvedFromOf(machineId, requestId, name);
    },
  };
}
