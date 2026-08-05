import type { RunDecision, RunEvent } from "@lykeion/api";
import type { ProbedCli } from "./probe";
import type { StandingGrant } from "./session";

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

/** A daemon frame batch cannot be accepted at the server's durable cursor.
 * Retrying the same batch forever cannot repair this: the run has to leave
 * the daemon's live set so `/daemon/run/live` can settle it explicitly. */
export class LabFrameConflict extends Error {}

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
): Promise<Response> {
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
  if (res.status === 409) {
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    throw new LabFrameConflict(parsed.error ?? `${lab} answered ${path} with status 409`);
  }
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(parsed.error ?? `${lab} answered ${path} with status ${res.status}`);
  }
  return res;
}

/** Tells the lab what this machine can run. Sent once right after pairing,
 *  and again whenever a re-probe finds the set has changed. */
export async function report(
  lab: string,
  token: string,
  body: DaemonReport,
  signal?: AbortSignal,
): Promise<void> {
  await callLab(lab, "/daemon/report", token, body, signal);
}

/** Tells the lab this machine is still here. Carries nothing beyond the
 *  bearer token that already names which machine is calling. */
export async function heartbeat(lab: string, token: string, signal?: AbortSignal): Promise<void> {
  await callLab(lab, "/daemon/heartbeat", token, {}, signal);
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

/** One instruction the lab sends down the command stream: start a turn,
 *  answer something a running turn asked, or stop one. The three kinds share
 *  one shape rather than three because they arrive on the same stream in the
 *  same envelope — only `runId` is ever guaranteed present. */
export interface RunCommand {
  type: "start-run" | "decision" | "cancel";
  runId: string;
  studyId?: string;
  sessionId?: string;
  agent?: string;
  prompt?: string;
  grants?: StandingGrant[];
  decision?: RunDecision;
}

/** One SSE block's `data:` line(s), joined the way the spec joins a
 *  multi-line field — newline is what a producer would have split a large
 *  payload on, though nothing here ever sends more than one line. `undefined`
 *  is a block with no `data:` line at all, which nothing here ever sends
 *  either but a keep-alive comment on the wire would look like. */
function commandFrom(block: string): { seq: number; command: RunCommand } | undefined {
  const lines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  if (lines.length === 0) return undefined;
  try {
    return JSON.parse(lines.join("\n")) as { seq: number; command: RunCommand };
  } catch {
    return undefined;
  }
}

/**
 * Holds the lab's command stream open and calls `onCommand` for every
 * `start-run` / `decision` / `cancel` it sends, in the same newline-framed
 * style `acp.ts` reads a subprocess's stdout in — except the frame here is an
 * SSE block (ended by a blank line) rather than one JSON line.
 *
 * Resolves once the stream is over, however it got that way: the lab closed
 * it, the connection dropped, or `signal` was aborted. `onClose` fires at
 * that same moment, so a caller driving a reconnect loop off it does not also
 * have to inspect why this settled. Only a stream that never opened at all —
 * refused outright, or never reachable — rejects, on the same terms `callLab`
 * rejects on.
 */
export async function openCommands(
  lab: string,
  token: string,
  cursor: number | undefined,
  onCommand: (seq: number, command: RunCommand) => void,
  onClose: () => void,
  signal: AbortSignal,
): Promise<void> {
  const url = new URL("/daemon/commands", lab);
  if (cursor !== undefined) url.searchParams.set("cursor", String(cursor));

  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal });
  } catch (err) {
    throw new Error(`could not reach ${lab}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401) {
    if (await refusedByLab(res))
      throw new LabRefused(`${lab} no longer recognizes this machine — it was removed from the lab`);
    throw new Error(
      `${lab} answered /daemon/commands with status 401, but not as the lab — something in front of it is asking for a sign-in`,
    );
  }
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(parsed.error ?? `${lab} answered /daemon/commands with status ${res.status}`);
  }
  if (!res.body) {
    onClose();
    return;
  }

  let buffered = "";
  try {
    for await (const chunk of res.body) {
      buffered += Buffer.from(chunk as Uint8Array).toString("utf8");
      let cut = buffered.indexOf("\n\n");
      while (cut !== -1) {
        const block = buffered.slice(0, cut);
        buffered = buffered.slice(cut + 2);
        const frame = commandFrom(block);
        if (frame) onCommand(frame.seq, frame.command);
        cut = buffered.indexOf("\n\n");
      }
    }
  } catch {
    // The read ended in an error rather than a clean close — a dropped
    // connection and an abort both land here. Either way the stream is over,
    // which `onClose` below says regardless of which one it was.
  }
  onClose();
}

/** Posts the events one run produced since the last post, numbered by this
 *  daemon — the only producer there is, so a retry can never mint a
 *  duplicate. */
export async function postRunEvents(
  lab: string,
  token: string,
  runId: string,
  frames: Array<{ seq: number; event: RunEvent }>,
  signal: AbortSignal,
): Promise<void> {
  await callLab(lab, "/daemon/run/events", token, { runId, frames }, signal);
}

/** Tells the lab a card answered "for the Study" was granted, so the lab's
 *  own `folder_grants` remembers it — what lets a later run on this Study
 *  never raise the same card again. */
export async function postRunGrant(
  lab: string,
  token: string,
  runId: string,
  grant: StandingGrant,
  signal: AbortSignal,
): Promise<void> {
  await callLab(lab, "/daemon/run/grant", token, { runId, path: grant.path, mode: grant.mode }, signal);
}

/** Tells the lab which runs this daemon currently holds — sent as soon as
 *  the command stream (re)connects, so a lab that lost the connection knows
 *  what survived on this end without waiting for those runs to produce
 *  events of their own. */
export async function postRunLive(
  lab: string,
  token: string,
  runIds: string[],
  generation: string | undefined,
  commandCursor: number | undefined,
  signal: AbortSignal,
): Promise<{ generation?: string; retireRunIds: string[] }> {
  const res = await callLab(
    lab,
    "/daemon/run/live",
    token,
    {
      runIds,
      ...(generation === undefined ? {} : { generation }),
      ...(commandCursor === undefined ? {} : { commandCursor }),
    },
    signal,
  );
  const body = (await res.json().catch(() => ({}))) as {
    generation?: unknown;
    retireRunIds?: unknown;
  };
  return {
    ...(typeof body.generation === "string" ? { generation: body.generation } : {}),
    retireRunIds: Array.isArray(body.retireRunIds)
      ? body.retireRunIds.filter((runId): runId is string => typeof runId === "string")
      : [],
  };
}
