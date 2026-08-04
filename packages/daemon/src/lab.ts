import type { ProbedCli } from "./probe";

/** What a lab hands back once it has traded a pairing code for a bearer
 *  token — everything the daemon needs to store and report itself by. */
export interface ExchangeResult {
  token: string;
  runtimeId: string;
  machineName: string;
  labName: string;
}

/**
 * Trades a one-time pairing code, and the verifier proving this daemon is
 * the one that minted the challenge behind it, for a bearer token. The lab
 * is the only party that knows why a code was refused — expired, already
 * spent, presented with the wrong verifier — so its own message is what
 * belongs in front of a person watching a pairing fail, not a generic one
 * invented here.
 */
export async function exchangeCode(
  lab: string,
  code: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<ExchangeResult> {
  const res = await fetch(new URL("/daemon/pair/exchange", lab), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, verifier }),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as Partial<ExchangeResult> & { error?: string };
  if (!res.ok || typeof body.token !== "string")
    throw new Error(body.error ?? `the lab answered pairing with status ${res.status}`);
  return {
    token: body.token,
    runtimeId: body.runtimeId ?? "",
    machineName: body.machineName ?? "",
    labName: body.labName ?? "",
  };
}

/**
 * What a 401 from the lab means on a route that requires a bearer token: not
 * a transient failure to retry, but the lab's own record of this machine
 * having gone away — a revoked token, a removed runtime, or an owner who has
 * left. Its own class so a caller can tell it apart from an ordinary
 * failure without parsing a message.
 */
export class LabRefused extends Error {}

/** The body `report` sends: what the daemon found on this machine, in the
 *  shape the lab's `/daemon/report` route reads. */
export interface DaemonReport {
  platform: string;
  daemonVersion: string;
  capabilities: string[];
  clis: ProbedCli[];
}

/**
 * Posts an authenticated call to the lab and settles on what came back.
 * A 401 is `LabRefused`; a network failure, a non-2xx status, or a body
 * that will not parse are all an ordinary `Error` naming the lab, so a
 * caller retrying on anything but `LabRefused` treats them alike.
 *
 * `signal` is how a caller takes a call back. A lab that accepts the
 * connection and then never answers — a suspended machine, a load balancer
 * that has lost its backend — leaves this waiting on the request timeout
 * the runtime happens to use, which is five minutes. A daemon told to stop
 * cannot spend five minutes leaving, so the one thing that holds it open
 * has to be something the caller can end.
 */
/**
 * Whether a refusal came from the lab itself. The lab answers a machine it
 * does not know with `application/json` carrying an `error` it wrote; nothing
 * else on the way to it does both. Deliberately not matched on the wording:
 * the lab is entitled to refuse a machine for a reason it has not thought of
 * yet, and a daemon that only recognised one sentence would keep calling a
 * lab that had already dismissed it.
 */
async function refusedByLab(res: Response): Promise<boolean> {
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return false;
  const parsed = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
  return typeof parsed?.error === "string";
}

async function callLab(
  lab: string,
  path: string,
  token: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(new URL(path, lab), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new Error(`could not reach ${lab}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) {
    // Only the lab's own refusal means this machine was removed, and the lab
    // refuses in JSON saying why. A 401 from something standing in front of
    // it — an SSO portal, a reverse proxy asking a human to sign in — is a
    // sign-in page, and it says nothing about whether this lab still knows
    // this machine. Answering one by setting the pairing aside throws away a
    // working token over somebody else's outage, and leaves a daemon that
    // cannot come back on its own once the thing in front of the lab does.
    if (await refusedByLab(res))
      throw new LabRefused(`${lab} no longer recognizes this machine — it was removed from the lab`);
    throw new Error(
      `${lab} answered ${path} with status 401, but not as the lab — something in front of it is asking for a sign-in`,
    );
  }
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(parsed.error ?? `${lab} answered ${path} with status ${res.status}`);
  }
}

/** Tells the lab what this machine can run. Sent once right after pairing,
 *  and again whenever a re-probe finds the set has changed. */
export function report(
  lab: string,
  token: string,
  body: DaemonReport,
  signal?: AbortSignal,
): Promise<void> {
  return callLab(lab, "/daemon/report", token, body, signal);
}

/** Tells the lab this machine is still here. Carries nothing beyond the
 *  bearer token that already names which machine is calling. */
export function heartbeat(lab: string, token: string, signal?: AbortSignal): Promise<void> {
  return callLab(lab, "/daemon/heartbeat", token, {}, signal);
}

/** Doubled with every failed attempt, `attempt` counting from 1. */
const BACKOFF_BASE_MS = 1000;

/** The most a retry ever waits, so a lab down for hours does not leave a
 *  failed call backing off longer and longer without bound. */
const BACKOFF_MAX_MS = 30_000;

/**
 * How long to wait before retrying the `attempt`-th failed call to the lab.
 * Pure, and depends on nothing but its argument, so the ceiling it enforces
 * can be asserted directly without standing up a server or a fake clock.
 */
export function backoffDelayMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
}
