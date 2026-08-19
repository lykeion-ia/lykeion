import type { KernelEnvDeclaration, KernelEnvStatus, Language, RunDecision, RunEvent } from "@lykeion/api";
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
 * having gone away — a revoked token, a removed machine, or an owner who has
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
  /** How much machine there is for kernels to fill. Near-static, which is
   *  why it rides the report rather than the kernel fan-out. */
  totalMemoryBytes: number;
  cores: number;
  /** Whether this machine meets the floor Lykeion's own kernel host needs to
   *  start at all — see `probeKernelFloor` — and what is missing when it
   *  does not. Always sent: a daemon new enough to carry this field has
   *  always checked, so the lab can tell "checked and failed" apart from
   *  "never asked", which is what an older daemon's report leaves this key
   *  out entirely to mean. */
  kernels: { ready: boolean; reason?: string };
  /** Which process-visibility rule this machine's own platform applies —
   *  see `processVisibility`. */
  processVisibility: string;
  /** What this machine holds of every environment this lab has declared,
   *  read fresh each report via `readEnvStatus` — a couple of `stat`s, safe
   *  to include on every cycle. Absent on a report this machine could not
   *  build (its own ask for the declared list failed) rather than sent as
   *  an empty array claiming nothing is held; the lab keeps whatever it
   *  last heard rather than overwriting a real report with a blank one. */
  environments?: KernelEnvStatus[];
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

/** The Studies and Tasks a working directory can belong to. */
export interface HeldWorkspaces {
  studyIds: string[];
  taskIds: string[];
}

/**
 * Asks the lab which of the Studies and Tasks this machine holds a working
 * directory for it no longer has. Those are the directories that may be
 * removed; anything the lab still has a Study or a Task for is work, and a
 * machine never decides on its own that work has gone stale.
 *
 * An answer that does not name an id is not an answer about it: a lab that
 * fails, or replies with a shape this does not recognise, removes nothing.
 */
export async function workspacesGone(
  lab: string,
  token: string,
  held: HeldWorkspaces,
  signal?: AbortSignal,
): Promise<HeldWorkspaces> {
  const res = await callLab(lab, "/daemon/workspaces", token, held, signal);
  const body = (await res.json().catch(() => ({}))) as Partial<HeldWorkspaces>;
  const named = (value: unknown, from: string[]): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => from.includes(id as string)) : [];
  return {
    studyIds: named(body.studyIds, held.studyIds),
    taskIds: named(body.taskIds, held.taskIds),
  };
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
 *  answer something a running turn asked, stop one, or reach a kernel
 *  directly. These share one shape rather than several because they arrive
 *  on the same stream in the same envelope — only `runId` is ever guaranteed
 *  present, and a kernel command carries one of the lab's own choosing since
 *  it belongs to no turn. Every kernel command is delivered, never queued —
 *  the lab's own `RunRelay.deliverNow` is what sends one, and it never
 *  reaches this daemon at all unless the command stream is open when it is
 *  issued. */
export interface RunCommand {
  type:
    | "start-run"
    | "decision"
    | "cancel"
    | "revert"
    | "kernel-execute"
    | "kernel-interrupt"
    | "kernel-stop"
    | "kernel-restart"
    | "kernel-list"
    | "name-task"
    | "kernel-env-setup"
    | "kernel-env-reclaim";
  runId: string;
  studyId?: string;
  taskId?: string;
  sessionId?: string;
  agent?: string;
  prompt?: string;
  /** Which of the agent's own advertised choices this turn asked for. */
  model?: string;
  grants?: StandingGrant[];
  decision?: RunDecision;
  /** Which kernel a `kernel-execute`, `kernel-interrupt`, `kernel-stop` or
   *  `kernel-restart` command addresses. */
  kernelId?: string;
  /** What the researcher who asked for a `kernel-stop` said to the cell it
   *  is about to end. Absent when they said nothing; this machine then ends
   *  the kernel with no sentence to hand back. */
  feedback?: string;
  /** The source a `kernel-execute` command asks a kernel to run. */
  code?: string;
  /** The id the lab minted for the cell a `kernel-execute` command is
   *  asking a kernel to run, before that cell exists. */
  cellId?: string;
  /** The kernel context name a `kernel-execute` command runs in, e.g.
   *  `"main"`. */
  name?: string;
  /** The kernel language a `kernel-execute` command runs in. */
  language?: Language;
  /** The member a `kernel-execute` command's cell is recorded as run by, and
   *  the one a `kernel-stop` names to whatever cell was in the kernel. */
  by?: string;
  /** Which provisioner a `kernel-env-setup` command builds with — this
   *  phase always `"uv"` (D1). */
  manager?: "uv" | "conda";
  /** What a `kernel-env-setup` command asks this machine to RESOLVE.
   *  Present only when there is nothing to replay yet; absent whenever
   *  `lockfile` is present. */
  packages?: string[];
  /** The lockfile a `kernel-env-setup` command asks this machine to
   *  MATERIALIZE from, rather than resolve — D4. Absent only on the very
   *  first setup of a declaration, which is what tells this machine to
   *  resolve instead. */
  lockfile?: string;
  /** Which revision `lockfile` is, so this machine's own completion marker
   *  records the revision it actually built from. Absent exactly when
   *  `lockfile` is. */
  lockRevision?: number;
  /** Why a `kernel-env-setup` is happening, in words — "scanpy was added to
   *  python". Carried into the ending of every kernel this rebuild displaces,
   *  so a namespace that vanishes says what took it.
   *
   *  Absent for a plain Setup click, which is a rebuild nobody needs a
   *  sentence for — the researcher is looking at the button they pressed.
   *  Its absence does NOT make the restart optional: `uv venv --clear`
   *  removes the interpreter whoever asked for the build, so what its
   *  absence changes is only what the ending says. See
   *  `handleKernelEnvSetup`. */
  reason?: string;
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

/** Tells the lab whether this turn's working directory was snapshotted
 *  before it started, and when it was not, why — so a Revert control is
 *  offered only where it can actually restore something. */
export async function postRunSnapshot(
  lab: string,
  token: string,
  runId: string,
  snapshot: { taken: boolean; reason?: string },
  signal: AbortSignal,
): Promise<void> {
  await callLab(lab, "/daemon/run/snapshot", token, { runId, ...snapshot }, signal);
}

/** Tells the lab how a revert went. The lab truncates the record only once
 *  this says the files are back: a record truncated over an un-restored
 *  directory describes a state that never existed. */
export async function postRunReverted(
  lab: string,
  token: string,
  runId: string,
  outcome: { ok: boolean; error?: string },
  signal: AbortSignal,
): Promise<void> {
  await callLab(lab, "/daemon/run/reverted", token, { runId, ...outcome }, signal);
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

/** What one kernel's own `kernel.execute` answers with — every field this
 *  machine's kernel host reports about the cell it just ran, in the shape
 *  `forwardKernelCells`'s `CellAnnouncement` already carries for an agent's
 *  cells. A REPL cell has no run of its own to travel a `RunEvent` through,
 *  so it travels here instead. */
export interface KernelCellReport {
  sessionId: string;
  taskId: string;
  kernelId: string;
  name: string;
  language: string;
  environment: string;
  executionCount: number;
  source: string;
  origin: { surface: string; by: string };
  ok: boolean;
  wallMs: number;
  ts: number;
  outputs: unknown[];
  /** What this cell installed into the kernel that ran it and nowhere else —
   *  see `NotebookCell.installed`. Absent where nothing was, which is what
   *  the lab's own reader distinguishes. */
  installed?: string[];
  toolUseId?: string;
}

/** Tells the lab about one cell a kernel ran outside any turn — the
 *  researcher's own REPL, reached through `kernelExecute` rather than an
 *  agent's tool call. Carries the id the lab minted for it when it asked
 *  for the cell to run, so the lab records it under exactly the id it
 *  already promised the researcher who is waiting on it. */
export async function postKernelCell(
  lab: string,
  token: string,
  cellId: string,
  cell: KernelCellReport,
  signal: AbortSignal,
): Promise<void> {
  await callLab(lab, "/daemon/cell", token, { cellId, ...cell }, signal);
}

/** Answers the lab's `kernel-list` command with what this machine's kernel
 *  host says it is holding — every field `kernel.list` reports, none of
 *  which name a machine or a Study: this machine's own bearer token is what
 *  the lab already knows it by, and a Study is resolved from a kernel's own
 *  session, which the lab already holds durably. */
export async function postKernelList(
  lab: string,
  token: string,
  requestId: string,
  kernels: unknown[],
  signal: AbortSignal,
): Promise<void> {
  await callLab(lab, "/daemon/kernel/list", token, { requestId, kernels }, signal);
}

/**
 * Answers the lab's `name-task` command with what this machine's summarizer
 * made of the Task's opening message — or `null`, which is this machine
 * saying it asked and got nowhere.
 *
 * Answering `null` matters more than it looks. The lab is holding a call open
 * on this, and its only other way out is a deadline measured in tens of
 * seconds; a machine that knows now that there is no title coming should say
 * so now. Nothing is lost either way — the Task keeps the name it has — but
 * one of the two costs a researcher half a minute of a promise going nowhere.
 */
export async function postTaskTitle(
  lab: string,
  token: string,
  requestId: string,
  title: string | null,
  signal: AbortSignal,
): Promise<void> {
  await callLab(lab, "/daemon/task/title", token, { requestId, title }, signal);
}

/** Every environment this lab has declared, machine-free — what a
 *  `kernel-env-setup` command needs before this machine can say what it
 *  holds of each one, and what this machine reads `readEnvStatus` against
 *  on every regular report. Lab-wide rather than owner-scoped: any paired
 *  machine may read the declaration list, the same way any paired machine
 *  may resolve any declared environment (D2's declaration is a fact about
 *  the lab, not about whoever created it). */
export async function fetchKernelEnvDeclarations(
  lab: string,
  token: string,
  signal?: AbortSignal,
): Promise<KernelEnvDeclaration[]> {
  const res = await callLab(lab, "/daemon/kernel-envs", token, {}, signal);
  // A 200 this cannot read is not a lab that declared nothing. Answering
  // `[]` to an unreadable body would put "the lab declared nothing" on the
  // wire, and both callers pass that on as fact: the host then tells a
  // researcher *this lab has no environment named X* about an environment
  // their colleague declared, and the report claims this machine holds none
  // of environments it has never been told about.
  //
  // Throwing instead hands the failure to the `catch` each caller already
  // has — `runs.ts` leaves `declared` off `configure_session`, `main.ts`
  // leaves `environments` off the report — which is the same absence a
  // transport failure produces, and the honest one. This is that failure
  // wearing a 200.
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(`${lab} answered /daemon/kernel-envs with a body this could not read`);
  }
  const declarations = (parsed as { declarations?: unknown } | null)?.declarations;
  if (!Array.isArray(declarations))
    throw new Error(`${lab} answered /daemon/kernel-envs with no declaration list`);
  return declarations as KernelEnvDeclaration[];
}

/**
 * Asks this lab to declare one environment, on behalf of a researcher who
 * has just allowed it on a card.
 *
 * `sessionId` is what attributes the declaration to a person: the bearer
 * token names this MACHINE, which every session on it shares, and the lab
 * reads the researcher off the session rather than off the token. It is also
 * what the lab checks this machine against — a session this machine is not
 * running is refused there.
 *
 * A non-2xx carries the lab's own sentence through, which `callLab` already
 * does: the researcher just approved this, and "it failed" with no reason is
 * the worst possible answer to a card they said yes to.
 *
 * Two crossings worth naming rather than discovering, both the same shape. A
 * name this lab already declares comes back 409, and `callLab` raises every
 * 409 as `LabFrameConflict` — a class written for a frame batch the lab's
 * durable cursor will not take. A machine this lab has removed comes back
 * 401, which `callLab` raises as `LabRefused`, the signal a daemon's own
 * retry loops act on by setting the pairing aside; raised from here it is
 * caught by whoever is answering the host's ask and turned into a sentence
 * for the agent, so this machine learns it has been removed from its next
 * heartbeat rather than from this call.
 *
 * In both cases the sentence is what travels and what the agent is told, and
 * nothing between here and the host branches on the class, so both cost
 * nothing today. They would cost something the day a caller of this function
 * starts reading the class instead of the message.
 */
export async function postKernelEnvCreate(
  lab: string,
  token: string,
  sessionId: string,
  name: string,
  packages: string[],
  // Which language the declaration is for. Required rather than defaulted
  // here: the lab derives the package manager from it (`python` → uv,
  // `r` → conda), and a default living in two places is a default that can
  // disagree with itself. The caller has already refused anything else by
  // value, so the type is the whole of what can arrive.
  language: "python" | "r",
  signal?: AbortSignal,
): Promise<KernelEnvDeclaration> {
  const res = await callLab(
    lab,
    "/daemon/kernel-env/create",
    token,
    { sessionId, name, packages, language },
    signal,
  );
  const body = (await res.json().catch(() => ({}))) as { declaration?: unknown };
  // A 200 this cannot read is not a declaration. Answering with something
  // invented here would have the agent told its environment exists on the
  // strength of a body nothing understood.
  if (typeof body.declaration !== "object" || body.declaration === null)
    throw new Error(`${lab} answered /daemon/kernel-env/create with no declaration`);
  return body.declaration as KernelEnvDeclaration;
}

/** What this lab did with an ask to add packages to an environment it
 *  already declares: the declaration as it now stands, which of the asked-for
 *  packages were genuinely new, and whether a rebuild is running because of
 *  it. `added: []` is not a failure — it is everything asked for already
 *  being declared, which changes nothing and rebuilds nothing. */
export interface KernelEnvPackagesAdded {
  declaration: KernelEnvDeclaration;
  added: string[];
  building: boolean;
}

/**
 * Asks this lab to add packages to an environment it already declares, on
 * behalf of a researcher who has just allowed it on a card.
 *
 * `sessionId` carries the same two facts it carries for a create: which
 * person this is attributed to, and which machine the lab checks this call
 * against. The lab reads the researcher off the session rather than off the
 * token, because the token names a MACHINE that every session on it shares.
 *
 * What comes back is the lab's own record, not this machine's — including
 * whether anything was actually added, which only the lab can say, since only
 * it holds what the declaration already had.
 */
export async function postKernelEnvAddPackages(
  lab: string,
  token: string,
  sessionId: string,
  name: string,
  packages: string[],
  signal?: AbortSignal,
): Promise<KernelEnvPackagesAdded> {
  const res = await callLab(
    lab,
    "/daemon/kernel-env/packages",
    token,
    { sessionId, name, packages },
    signal,
  );
  const body = (await res.json().catch(() => ({}))) as {
    declaration?: unknown;
    added?: unknown;
    building?: unknown;
  };
  // A 200 this cannot read is not an answer. Invented here, the agent would
  // be told its packages were added on the strength of a body nothing
  // understood — and told to wait for a build that may never have started.
  if (typeof body.declaration !== "object" || body.declaration === null || !Array.isArray(body.added))
    throw new Error(`${lab} answered /daemon/kernel-env/packages with no declaration`);
  return {
    declaration: body.declaration as KernelEnvDeclaration,
    added: body.added.filter((entry): entry is string => typeof entry === "string"),
    building: body.building === true,
  };
}

/**
 * Hands this lab a lockfile this machine just resolved, and learns the
 * revision it became — synchronous, unlike `postKernelEnvResult` below,
 * because `materializeEnvironment` needs that revision BEFORE it can build:
 * the completion marker records which revision this machine actually built
 * from, and nothing here can name it before this call returns.
 */
export async function postKernelEnvLock(
  lab: string,
  token: string,
  requestId: string,
  name: string,
  lockfile: string,
  signal?: AbortSignal,
): Promise<{ lockRevision: number }> {
  // `requestId` names the ask this machine is carrying out, and the lab
  // refuses a pin from a machine it did not ask — a lockfile is the one
  // thing every other machine later replays verbatim, so writing one is not
  // something a bearer token alone should authorize.
  const res = await callLab(lab, "/daemon/kernel-env/lock", token, { requestId, name, lockfile }, signal);
  const body = (await res.json().catch(() => ({}))) as { lockRevision?: unknown };
  if (typeof body.lockRevision !== "number")
    throw new Error(`${lab} answered /daemon/kernel-env/lock with no lockRevision`);
  return { lockRevision: body.lockRevision };
}

/** One `uv` output line from a `kernel-env-setup` this machine is carrying
 *  out, forwarded live so a researcher watching the Notebook's Setup
 *  surface sees it rather than waiting out the whole build in silence.
 *  `name` rides along because `KERNEL_SETUP_CHANNEL` is one lab-wide
 *  channel, not one per build — without it, two environments building at
 *  once (on this machine or another) would interleave into one
 *  undifferentiated log. `runtimeId` is not this call's to send; the lab
 *  already knows which machine is calling from the bearer token, which is
 *  the one thing here a machine cannot misreport about itself. Best-effort:
 *  a progress line this lab never receives costs nothing but itself, unlike
 *  the final result below, which the waiting `kernelEnvSetup` call actually
 *  depends on. */
export async function postKernelEnvProgress(
  lab: string,
  token: string,
  requestId: string,
  name: string,
  line: string,
  signal?: AbortSignal,
): Promise<void> {
  await callLab(lab, "/daemon/kernel-env/progress", token, { requestId, name, line }, signal);
}

/** What a `kernel-env-setup` this machine was carrying out finally came to
 *  — settling the lab's own wait on it (`kernelEnvSetup`'s returned
 *  promise), unlike every other kernel command's reply, which nothing here
 *  waits on. `ok: false` is the honest outcome of a resolve or a
 *  materialize that failed; the lab surfaces `error` as the reason the
 *  researcher's own call rejects with, rather than leaving it to time out
 *  with no explanation. */
export async function postKernelEnvResult(
  lab: string,
  token: string,
  requestId: string,
  result: { ok: true; status: KernelEnvStatus } | { ok: false; error: string },
  signal?: AbortSignal,
): Promise<void> {
  await callLab(lab, "/daemon/kernel-env/result", token, { requestId, ...result }, signal);
}
