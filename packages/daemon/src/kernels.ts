import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Language, NotebookCell, ProvenanceEnvelope, RunEvent } from "@lykeion/api";
import { allAgentHomes } from "./agent-home";
import { probeCodeState } from "./code-state";
import type { KernelHost } from "./kernel-host";
import {
  confine,
  NO_AGENT_HOME,
  noBackendReason,
  policyFor,
  programLocation,
  sandboxBackendFor,
  type SandboxGrant,
  type SandboxPolicy,
} from "./sandbox";
import type { McpServer } from "./session";

/**
 * What is handed to `confine` in place of the program, so the argument this
 * end contributes can be told from the one the host will. It carries a byte
 * no path and no rendered rule can hold, which is what makes the argument
 * holding it the one this put there rather than one that resembles it.
 */
const IN_PLACE_OF_THE_PROGRAM = "\0where a kernel's own command goes";

/**
 * The boundary one kernel runs inside, and the argv prefix that puts it
 * there.
 *
 * A kernel is not an agent. It owns no installation, authenticates from
 * nothing and holds no credential, so its policy declares no home and every
 * agent's installation on this machine is foreign to it. What it does need is
 * its environment: an interpreter it must read and must not write, because an
 * environment a cell can write is one a cell can leave a `sitecustomize.py`
 * in, and that runs on the next launch — which may be inside no boundary at
 * all.
 *
 * The prefix is produced here and nowhere else, and this renders no rule of
 * its own: every one of them comes from `policyFor`, and the invocation that
 * carries them comes from `confine`. The host receives the prefix already
 * assembled and concatenates an interpreter onto it, which is what keeps the
 * one thing that can express a boundary on this side of the wire.
 */
export function kernelConfinementFor(input: {
  platform: string;
  workspace: string;
  dataDir: string;
  /**
   * The standing grants this Task's turns run under. The researcher who
   * granted a folder so the agent could read it granted the folder, not the
   * program: a cell that could not open the data the agent beside it is
   * working on would be a notebook that cannot see what the conversation is
   * about.
   */
  grants: SandboxGrant[];
  /**
   * Every place a kernel of this machine has to be able to read in order to
   * start at all — its interpreter, whatever that interpreter is built out
   * of, and the file it is told to run. More than one, because they are more
   * than one place: an interpreter reached through an environment is a link
   * out of it, and a boundary is written where the operating system will
   * look, which is where the link lands.
   *
   * Reported by the host rather than worked out here. Which interpreter this
   * machine resolved is a fact about the process holding its kernels, and a
   * boundary guessed at instead would refuse the kernel before its first
   * instruction with nothing said about why.
   */
  reads: string[];
}): { policy: SandboxPolicy; prefix: string[] } {
  // Asked before a single path is resolved, so a machine that cannot confine
  // anything says that rather than naming whichever directory it would have
  // failed on first.
  if (!sandboxBackendFor(input.platform)) throw new Error(noBackendReason(input.platform));

  const policy = policyFor({
    workspace: input.workspace,
    grants: input.grants,
    dataDir: input.dataDir,
    home: NO_AGENT_HOME,
    foreign: allAgentHomes(input.workspace),
    readable: input.reads,
  });

  // Where the boundary's own arguments end is found rather than assumed: a
  // prefix built by counting a backend's arguments here would make this a
  // second place that knows what one of its invocations looks like, and the
  // one that renders it has to stay the only one.
  const confined = confine(input.platform, policy, {
    command: IN_PLACE_OF_THE_PROGRAM,
    args: [],
  });
  const argv = [confined.command, ...confined.args];
  const program = argv.lastIndexOf(IN_PLACE_OF_THE_PROGRAM);
  if (program === -1) throw new Error("this boundary did not carry the command it was given");
  return { policy, prefix: argv.slice(0, program) };
}

/** What the agent calls this machine's kernel tools by. */
export const KERNEL_SERVER_NAME = "notebook";

/** The one kernel a Task's session is given. A context owns one kernel per
 *  language it runs code in, and this is that one's name. */
export const MAIN_KERNEL = "main";

/**
 * How much room a unix socket's name has, counted in bytes and including the
 * byte that ends it. The smallest of what the platforms this runs on allow,
 * so a name this end accepts is one every one of them can bind.
 *
 * The host holds the same number and refuses a name past it, which is where
 * the operating system's own refusal is turned into words. It is asked here
 * as well because this is where the name is decided: a name decided here that
 * cannot be bound is a fact about this machine's layout, true before anything
 * is asked of the host and true again for every turn after.
 */
const SOCKET_NAME_LIMIT = 104;

/**
 * The directory this machine binds its kernel sockets in.
 *
 * The platform's own per-user temporary directory, and not the Task's
 * workspace. A workspace is a Study and a Task nested inside a working
 * directory that itself sits under the researcher's home, and a socket named
 * beside one spends more than a unix socket's whole allowance before it has
 * said `.sock` — so on an ordinary install nothing could be bound at all, and
 * every machine would hold no kernels while saying nothing about why.
 *
 * Nothing about the boundary moves with it. A confined run may open a
 * connection, which is what reaching a socket is, and the Task directory it
 * may read and write is the same one it was. What the socket protects is what
 * it protects wherever it sits: the greeting names a session, and a connection
 * that does not hold the word this machine minted for that session reaches no
 * kernel.
 */
export function kernelSocketDir(): string {
  // Named per user rather than shared, so two researchers on one machine each
  // bind their own and neither is answering the other's relays.
  return join(tmpdir(), `lykeion-${process.getuid?.() ?? 0}`);
}

/** The socket directory itself, made if it is not there and readable by
 *  nobody else. What binds a socket inside it needs the directory first. */
export function ensureKernelSocketDir(): string {
  const dir = kernelSocketDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Where an agent working in this Task reaches its kernels.
 *
 * One socket per Task rather than per session: a connection says which kernel
 * it is for, and the host checks that against the session it was told about,
 * so one name answers for every session of that Task. The name is a digest of
 * the Task's own directory, which is what makes it that Task's while keeping
 * it inside the room a socket's name has — the directory itself is far longer
 * than the whole allowance.
 *
 * Throws, naming the path and its size, when even this does not fit. A socket
 * that cannot be bound is not a kernel that starts late; it is a machine that
 * will never hold one for this Task, and every turn after this would find the
 * same thing.
 */
export function kernelSocketPath(workspace: string): string {
  const digest = createHash("sha256").update(workspace).digest("base64url").slice(0, 16);
  const path = join(kernelSocketDir(), `${digest}.sock`);
  const bytes = Buffer.byteLength(path, "utf8");
  if (bytes >= SOCKET_NAME_LIMIT)
    throw new Error(
      `${path} is ${bytes} bytes, and a unix socket's name has room for fewer than ` +
        `${SOCKET_NAME_LIMIT} — this machine's temporary directory leaves no room for one`,
    );
  return path;
}

/**
 * Where this daemon's own program is, as paths a boundary can carry.
 *
 * An agent's own program starts the relay, and it starts it inside the
 * boundary this machine rendered — so a boundary that could not read this
 * would be one the relay cannot start inside. It is the narrowest addition
 * that makes the arrangement work, and it is this machine's own program
 * rather than anything of the researcher's.
 *
 * Read from what this process was actually started as, so both the boundary
 * the agent is confined by and the relay it is told to run name one thing.
 */
export function daemonProgram(): { command: string; args: string[] } {
  return { command: process.execPath, args: [process.argv[1] ?? ""] };
}

/**
 * The paths a boundary has to carry for `program` to be able to run inside it.
 *
 * Split out from `daemonProgramPaths` so a test can hand it a program of its
 * own: this machine's real one is read off `process.argv`, which under a test
 * runner names the runner.
 */
export function programPathsFor(program: { command: string; args: string[] }): string[] {
  const paths = programLocation(program);
  // `programLocation` grants an ARGUMENT its own file and its own directory,
  // and goes no further; the three-level grant that reaches a whole
  // installation is the COMMAND's. For an interpreted program the two are not
  // the same thing: the command is the interpreter, and the program itself
  // arrives as the first argument. This daemon is one of those — `node
  // bin/lykeion.js` — and its loader imports the bundle from a `dist` BESIDE
  // `bin`, which is outside both grants. A boundary rendered from those alone
  // carries the half of the relay that cannot run: it dies on its first
  // import with EPERM, and an agent's CLI reports that as a server holding no
  // tools rather than as a failure, so nothing anywhere says a word.
  //
  // So the first argument is asked the same question the command was, and
  // gets the same answer: it IS a program, and `programLocation` already
  // knows what a program needs — including the guard against a path so
  // shallow it would swallow the boundary, which is why this reuses the rule
  // rather than restating it.
  const program0 = program.args[0];
  if (program0 !== undefined && program0.includes(sep))
    paths.push(...programLocation({ command: program0, args: [] }));
  return paths;
}

export function daemonProgramPaths(): string[] {
  return programPathsFor(daemonProgram());
}

/**
 * The tool server this machine names to an agent working on one Task.
 *
 * Every argument is written here. Which kernel the agent reaches is settled
 * on this side of the wire and travels in the relay's own command line, so
 * there is nothing an agent can say afterwards that names a kernel at all.
 */
export function kernelBridgeFor(input: {
  workspace: string;
  sessionId: string;
  taskId: string;
  agent: string;
  /** The word this machine minted for this session, and told the host to
   *  expect. It is what the host tells one session's relay apart from
   *  another's on the one socket a Task has. */
  token: string;
}): McpServer {
  const program = daemonProgram();
  return {
    name: KERNEL_SERVER_NAME,
    command: program.command,
    args: [
      ...program.args,
      "bridge",
      "--socket",
      kernelSocketPath(input.workspace),
      "--session",
      input.sessionId,
      "--task",
      input.taskId,
      "--name",
      MAIN_KERNEL,
      "--agent",
      input.agent,
      "--token",
      input.token,
    ],
    // Everything the relay needs travels in argv; env is required on the
    // wire all the same (see McpServer.env).
    env: [],
  };
}

/** A word nothing else on this machine holds, minted for one session so the
 *  relay this machine starts for it can be told from one started by something
 *  that merely knows the session's name. */
export function kernelSessionToken(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * What a "cell" notification actually carries: the `NotebookCell` shape,
 * plus the session and Task it ran in, plus the record of how it ran. Those
 * two names are not on `NotebookCell` itself: a stored cell already stands
 * inside one Task's notebook, so naming it again on every row would be
 * saying the same thing twice. The notification has no such context to stand
 * inside, so it says it directly rather than making this machine invert a
 * kernel's own id back into the identity that produced it.
 */
export interface CellAnnouncement {
  /** The id the host minted, and the one the envelope beside this cell names
   *  as the cell it describes. */
  id: string;
  sessionId: string;
  taskId: string;
  kernelId: string;
  name: string;
  language: Language;
  environment: string;
  executionCount: number;
  source: string;
  origin: NotebookCell["origin"];
  ok: boolean;
  wallMs: number;
  ts: number;
  outputs: NotebookCell["outputs"];
  /** What this cell installed into the kernel that ran it and nowhere else.
   *  Absent on a cell that installed nothing — see `NotebookCell.installed`,
   *  and note that the absence is the whole point rather than a shortening:
   *  a hop that turned it into `[]` on the way past would make every cell in
   *  the lab claim the surface. */
  installed?: string[];
  /** The caller's own id for the tool call this cell arrived as, when the
   *  provider forwarded one in the call's `_meta`. Absent otherwise — the
   *  forwarder may still fill it in from the session's own log. */
  toolUseId?: string;
  /** What names the record beside this cell: the hash of that record's own
   *  bytes, computed by the host that wrote them. */
  provenanceId: string;
  /** The record itself. Opaque here — nothing on this machine reads a field
   *  of it, and nothing on this machine may rewrite one: its id is the hash
   *  of exactly these bytes, and the lab it is travelling to recomputes that
   *  hash before it trusts either. */
  provenance: ProvenanceEnvelope;
}

/**
 * Wires this machine's kernel host to the run each cell it announces
 * actually belongs to.
 *
 * Routed on the session a notification names directly — `runIdForSession`
 * is `runOfSession.get`, the same lookup every other event this machine
 * emits for a session's current turn already uses. A session with no run
 * currently taking its turn is dropped, the same as any notification
 * nothing is listening for.
 *
 * Only the agent's own cells travel this way. The host announces every cell
 * it runs, the researcher's REPL among them, and a REPL cell run while an
 * agent has that session's turn would find a run to be delivered to — while
 * the call that asked for it is already carrying the same cell to the lab
 * under the id the lab minted. Both would be recorded, and a researcher
 * would read one cell twice.
 *
 * The `id` a forwarded cell carries is the one the host announced it under,
 * carried through rather than replaced. It is not what the cell ends up
 * being called: a `NotebookCell` has an `id`, so a frame has to hold one,
 * and the lab mints the row's own on insert and joins the record to it
 * through `cells.provenance_id`. What carrying the host's through unchanged
 * buys is a frame that agrees with itself — the record travelling beside
 * the cell names this same id in `identity.cellId`, and that record cannot
 * be renamed, since it is addressed by the hash of its own bytes.
 *
 * A cell that arrives without a `toolUseId` — a provider that forwarded no
 * id of its own down the MCP channel — is offered to `claimToolUseId`, the
 * session's own view of which kernel call is in flight, so the recorded
 * cell still names the Execution Log step it arrived as. An announced id
 * always wins: the provider naming its own call is the authority on it.
 */
export function forwardKernelCells(
  host: KernelHost,
  runIdForSession: (sessionId: string) => string | undefined,
  emit: (runId: string, event: RunEvent) => void,
  claimToolUseId: (sessionId: string, source: string) => string | undefined,
): void {
  host.on("cell", (params) => {
    const announced = params as CellAnnouncement;
    if (announced.origin?.surface !== "agent") return;
    const runId = runIdForSession(announced.sessionId);
    if (runId === undefined) return;
    const toolUseId =
      announced.toolUseId ?? claimToolUseId(announced.sessionId, announced.source);
    emit(runId, {
      event: "cell",
      cell: {
        id: announced.id,
        kernelId: announced.kernelId,
        name: announced.name,
        language: announced.language,
        environment: announced.environment,
        executionCount: announced.executionCount,
        source: announced.source,
        origin: announced.origin,
        ok: announced.ok,
        wallMs: announced.wallMs,
        ts: announced.ts,
        outputs: announced.outputs,
        // Carried, and carried as an absence where there was one: this is
        // the only hop between the kernel that noticed the install and the
        // notebook a researcher reads it on, and a field dropped here is a
        // surface nothing anywhere can reach.
        ...(announced.installed === undefined ? {} : { installed: announced.installed }),
        ...(toolUseId === undefined ? {} : { toolUseId }),
        // Spread like its neighbours rather than written flat: a host that
        // announced none would otherwise put the key on the cell holding
        // `undefined`, and absent is not a value on this wire.
        ...(announced.provenanceId === undefined
          ? {}
          : { provenanceId: announced.provenanceId }),
      },
      // Beside the cell rather than on it, and unread on the way past: the
      // lab recomputes this record's hash over these very bytes, so a field
      // this machine reshaped would be a record that no longer answers to
      // the name it arrived under.
      provenance: announced.provenance,
    });
  });
}

/**
 * Tells this machine's kernel host what repository, if any, backs one
 * session's workspace, so the record it writes for every cell run there can
 * name it.
 *
 * Sent for a named session because the answer is drawn around that session's
 * workspace and one host holds every session on this machine. Two Tasks
 * taking turns at the same moment answer this differently, and a call that
 * named no session would leave whichever spoke last stamped on the record of
 * every cell running anywhere on the machine — records that are immutable and
 * named by the hash of their own bytes, so nothing afterwards could correct
 * one or even notice.
 *
 * The absence is sent as loudly as the answer. A session the host was told
 * nothing about keeps a reason meaning "nobody looked", recorded against its
 * cells on a machine where the real answer was there to be had.
 *
 * A host that will not take it costs nothing here. What travels is a fact
 * ABOUT a turn rather than the turn itself, and a cell whose record says
 * `not_captured` is a smaller loss than a turn refused over a `git`
 * invocation.
 */
export async function tellHostCodeState(
  host: KernelHost,
  sessionId: string,
  workspace: string,
): Promise<void> {
  const codeState = await probeCodeState(workspace);
  try {
    await host.call("kernel.set_code_state", { session_id: sessionId, codeState });
  } catch {
    // Said nowhere. This runs off the path a turn is waiting on, so there is
    // no caller left to answer it, and a host that cannot take this is one
    // that the call actually needing a kernel will report on for itself.
  }
}

/**
 * Where this machine keeps the record of how its cells ran.
 *
 * Under the daemon's own data directory rather than under a home directory
 * the host would otherwise choose for itself: one directory is one daemon,
 * and a second daemon run against a second lab must not write its records
 * into the first one's pile.
 *
 * Inside `dataDir` and therefore inside what every kernel's boundary denies,
 * which is the right side of that line for it: these records are written by
 * the process that holds the kernels, and nothing running inside one has any
 * business reading the lot.
 */
export function provenanceStoreRoot(dataDir: string): string {
  return join(dataDir, "provenance");
}
