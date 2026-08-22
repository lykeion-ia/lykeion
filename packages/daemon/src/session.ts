import type {
  AccessKind,
  AgentOption,
  ExecutionLogEntry,
  PermissionRequest,
  PermissionScope,
  Plan,
  RunDecision,
  RunEvent,
  ToolOutputPart,
} from "@lykeion/api";
import { isToolKind } from "@lykeion/api";
import { connectAcp, type AcpConnection } from "./acp";
import { confinementFor } from "./agent-home";
import { confinedEnv } from "./confined-env";
import { daemonProgramPaths, KERNEL_SERVER_NAME } from "./kernels";
import { boundaryOf, confine, covers, policyFor, type SandboxGrant } from "./sandbox";
import {
  confirmationOf,
  ordinaryWorkingMode,
  readAdvertised,
  type OptionSetter,
} from "./agent-options";
import { ensureTmpDir } from "./scratch";
import { sweepReplantedSkills } from "./agent-install";
import { isolationFor, lykeionHomeFor } from "./agent-registry";
import { recordDemotion } from "./agent-demotions";

/**
 * How long a stopped turn is given, after `session/cancel` is sent, to
 * settle on its own before this session ends it regardless. An adapter that
 * confirms (or otherwise ends the turn) within it changes nothing about how
 * the turn lands — this only matters for one that does not. Set with real
 * headroom above how long a slow but working confirmation may reasonably
 * take, so a merely unhurried adapter is never reported as having ignored
 * the stop. The clock starts at the `session/cancel` notify itself, not at
 * whatever raised it — a little more generous than timing from a
 * researcher's own click, which is what a client-side clock would measure
 * instead.
 */
const DEFAULT_CANCEL_GRACE_MS = 45_000;

/**
 * The tools whose provider wrapper this machine answers itself, by the exact
 * title the adapter announces the call under.
 *
 * An environment change arrives as TWO questions and is ONE decision. The
 * agent's own provider asks whether this tool may run at all — a card naming
 * a tool and nothing else, because that is all the provider knows; this
 * machine's kernel host then asks the question that matters, naming the
 * environment, the packages and the fact that they land on every machine in
 * this lab. Stacked, a researcher answers a card that says nothing and then a
 * card that says everything, and the first one teaches them that these cards
 * are noise. So the wrapper is answered here and the real card is the only
 * one raised.
 *
 * **Only these two, and only exactly.** Suppressing a provider card is safe
 * for one reason and no other: the kernel-host method behind each of these
 * performs no mutation before this daemon's own `askPermission` has been
 * answered — `_created` and `_managed_packages` read their arguments and this
 * session's own environment list, then ask, and every write is on the far
 * side of that. A tool without that property would be running unasked. The
 * match is therefore exact: no prefix, no suffix, no substring, no case
 * folding. A near-miss title an allowlist accepts is the whole defect this
 * exists to avoid, and an agent names its own tools.
 *
 * **Allowlisted by NAME, so every action of a named tool is covered.** A
 * provider card asks about the tool and never about the action, so there is no
 * per-action question here to suppress or keep. `manage_environments` carries
 * three: `create` is the consequential one and is guarded by the inner card
 * above; `list` reads back what this session was already told; and `require`
 * records that a declared, unbuilt environment is blocking this Task —
 * verified to write one waiter row and a change-log entry and to dispatch
 * nothing at all (`attachWaiter` in the lab's environment setup coordinator;
 * its route's own contract is "this route creates no physical job"). That is
 * what makes covering it safe, and it is a STANDING CONSTRAINT rather than an
 * observation: the day `require` starts physical work, it stops being covered
 * by this entry and this allowlist has to be keyed by tool AND action instead.
 *
 * **And the ARGUMENTS have to fit the tool the title claims.** The safety
 * argument above is a property of these two tools; the key is a string an
 * adapter supplies, on the same field `pathFrom` elsewhere treats as prose. A
 * call that is not one of these tools but announces itself under one of these
 * exact titles would have its provider card answered here with no inner card
 * behind it — the kernel host was never involved, so the suppressed card was
 * that call's ONLY gate. So each entry carries the shape its tool's published
 * `inputSchema` requires, checked against what the call actually announced,
 * and a call whose arguments are not that tool's arguments gets its card. The
 * shapes are the agent-facing ones — what the model sends to the MCP tool —
 * and not the kernel host's own `session_id`-carrying call to this daemon,
 * which the agent never writes and no `tool_call` update ever carries.
 *
 * This is also the answer to the per-action question left open above: an
 * action outside a tool's published enum is not that tool's argument shape,
 * so `require` and `create` are told apart here by value rather than by a
 * second allowlist keyed on `(tool, action)`.
 */
const BROKERED_ENVIRONMENT_TOOLS = new Map<string, (input: unknown) => boolean>([
  [
    "mcp__notebook__manage_environments",
    (input) => {
      if (!isRecord(input)) return false;
      // `action` is the tool's one required property, and its enum is closed.
      // `list` names nothing; `create` and `require` both name an
      // environment, which is the argument the inner card is raised about.
      if (input.action === "list") return true;
      if (input.action !== "create" && input.action !== "require") return false;
      return typeof input.name === "string" && input.name.length > 0;
    },
  ],
  [
    "mcp__notebook__manage_packages",
    (input) => {
      if (!isRecord(input)) return false;
      // `packages` is required and non-empty — "adding nothing is not a
      // request this tool takes" — and every entry is a package name.
      const packages = input.packages;
      return (
        Array.isArray(packages) &&
        packages.length > 0 &&
        packages.every((name) => typeof name === "string" && name.length > 0)
      );
    },
  ],
]);

export type StandingGrant = SandboxGrant;

/**
 * One program this machine names to an agent as a tool server it may reach.
 *
 * The agent's own CLI spawns it, inside the same boundary the agent is in,
 * and speaks the Model Context Protocol to it over its stdio. Everything
 * that decides WHICH work the program does is in `args` — this machine
 * writes them, so what an agent reaches through the server is settled here
 * and not by anything the agent says.
 */
/** One variable a named tool server's process is started with. */
export interface EnvVariable {
  name: string;
  value: string;
}

export interface McpServer {
  /** What the agent calls this server's tools by. */
  name: string;
  command: string;
  args: string[];
  /** Always present, even when empty: the ACP schema requires `env`, and the
   *  shipped adapters silently drop an entry without it — the session opens,
   *  nothing errors, and the server's tools are simply never offered. */
  env: EnvVariable[];
}

/**
 * What `session/new` carries in `_meta` for this agent, or undefined when its
 * adapter has no such channel.
 *
 * Which is which is not decided here. An adapter that takes options this way
 * declares them, and this hands over what it declared — so an agent gaining or
 * losing the channel is a line in the catalogue, not a change to how sessions
 * open. What the claude adapters accept, and why each entry is set the way it
 * is, is documented on the declaration itself.
 */
export async function sessionMetaFor(agent: string): Promise<Record<string, unknown> | undefined> {
  const isolation = isolationFor(agent);
  // Handed the row's own `skillsOff`, which is where the flags that close
  // this agent's skill set are declared. Passed rather than reached for, so a
  // row cannot declare one set and send another.
  return await isolation?.sessionMeta?.(isolation.skillsOff);
}

/**
 * Variables a spawn adds to this agent's adapter process, beyond the daemon's
 * own environment.
 *
 * One variable, and it moves the agent's entire installation to a directory
 * of ours: its configuration, its registries, its skills, and its sign-in.
 * The researcher's own is then not narrowed but absent — `agent-home.ts`
 * denies it outright — which is why nothing here has to argue with it. An
 * earlier version handed codex an empty `mcp_servers` table through
 * `CODEX_CONFIG` and lost, because that was a merge against a file the agent
 * could still read. This does not merge with anything.
 *
 * An agent with no declaration gets nothing, and is not offered besides.
 */
export function adapterEnvFor(agent: string): Record<string, string> {
  const isolation = isolationFor(agent);
  if (isolation === undefined) return {};
  return { [isolation.homeEnv]: lykeionHomeFor(agent) };
}

/**
 * Whether this agent's thought channel is carried at all.
 *
 * Codex's is not. Dropped at the source rather than hidden where it renders,
 * so that the turn in flight and the same turn reopened later agree: a thought
 * suppressed at render would still have streamed to whoever had the page open
 * while it ran, and would still sit in the recovery snapshot a reload reads.
 * Nothing else about the turn changes — the prose either side of a dropped
 * thought arrives as it always did.
 */
export function carriesThinking(agent: string): boolean {
  return agent !== "codex";
}

/**
 * What a researcher's answer to one of this machine's own cards came to.
 *
 * `allowed` alone is what the caller acts on. `remember` is what the answer
 * said to KEEP — a `conversation` scope on an environment card is a standing
 * grant that auto-allows every later card about that environment with no
 * question at all — and it is deliberately not applied when the answer
 * arrives.
 *
 * **Why the caller mints it and not `decide`.** A card is a question about an
 * act that has not happened yet, and the act can fail after the answer. The
 * reachable case: an agent asks to create `python`, a card reading *Create
 * environment python?* is answered "for this conversation", and the lab
 * refuses the create because `python` is the starter every lab already has.
 * Minted at answer time, the session would then hold a standing, uncarded
 * grant to add arbitrary packages to the environment every default Python
 * kernel in the lab runs in — authority over something the researcher was
 * never shown, obtained from a card for something that does not exist. So the
 * grant is minted by whoever performed the act, immediately after it lands,
 * and a grant can never outlive the act it was given for.
 *
 * Always present on an allowance, and a no-op for `once` — so the caller
 * calls it unconditionally and there is no second decision anywhere about
 * what a scope means.
 *
 * `scope` is that same answer said out loud, for the one caller that cannot
 * act on it here: this lab keeps a conversation's grants durably, so whoever
 * performs the act carries the scope to the lab with it and the lab writes
 * the grant inside the very transaction that makes the change — a change that
 * did not happen leaves no authority behind, on either side. `once` and
 * `conversation` are the whole set an environment card takes; a card answered
 * with anything wider is refused in `decide` and never reaches a caller.
 *
 * It says what THIS card was answered with, never what already stood. A card
 * drained against a grant this session already holds was answered by nobody
 * and reports `once`: whatever covered it is already durable, and re-declaring
 * a standing grant off a question nobody was shown is not this end's to do.
 */
export type Answered =
  | { allowed: false }
  | { allowed: true; scope: "once" | "conversation"; remember(): void };

export interface LiveSession {
  /**
   * Starts one turn. Callers serialise turns themselves: wait for a turn's
   * `completed` event before starting the next one. That event does not
   * always mean the turn's own underlying ACP call has actually settled,
   * though — `cancel`'s grace period can end a turn early, unacknowledged,
   * while that call is still outstanding, which is exactly when a caller's
   * own queue is freed to call this again. Every turn is tagged with its own
   * epoch internally so a late settlement from a turn abandoned that way can
   * never be mistaken for an ending of the turn that superseded it. Its
   * ordinary output may still surface mislabelled on whichever turn is
   * current by then — nothing here can attribute a plain ACP update to one
   * turn over the other — but a permission request in that position is
   * refused outright rather than risked against a turn it has nothing to do
   * with.
   */
  prompt(text: string): void;
  decide(decision: RunDecision): void;
  /**
   * Raises one card of this machine's OWN, and answers with what the
   * researcher decided.
   *
   * Every other card here relays one an adapter asked for. This one has no
   * adapter behind it: it is raised for something the machine is being asked
   * to do on the researcher's behalf — an agent asking for an environment,
   * over the kernel channel rather than over ACP — and it goes through the
   * same queue as all the others, because a turn that raised four questions
   * has four questions to answer whichever channel each arrived on.
   *
   * `tool` is what the card names as having asked, and the surface chooses
   * its wording from it; `detail` is for a caller with a real reason to
   * offer, never a restatement of the question. `allowed: false` is a refusal
   * for every reason there is — denied, answered with a scope this card does
   * not take, or abandoned when the turn ended underneath it — and the caller
   * owes whoever asked a sentence rather than a silent failure.
   */
  askPermission(access: AccessKind, tool: string, detail?: string): Promise<Answered>;
  /**
   * Stops the current turn: notifies the adapter over `session/cancel` and
   * settles every permission request still open, so no card is left waiting
   * on a decision the turn it belonged to will never reach. If the adapter
   * does not confirm within its own grace period (see
   * `DEFAULT_CANCEL_GRACE_MS`), the turn is ended here regardless, carrying
   * `unacknowledged: true` — the subprocess itself is left running; only the
   * turn this lab is waiting on is judged over.
   */
  cancel(): void;
  close(): Promise<void>;
  /**
   * The ACP tool-call id of the kernel call a cell with this source arrived
   * as, claimed at most once per call. For the daemon's kernel-cell
   * forwarder, on a cell whose provider forwarded no id of its own down the
   * MCP channel: ACP itself carries no correlation id between a `tool_call`
   * update and the MCP call it announces, but the kernel runs one cell at a
   * time in send order and a call's announcement precedes the whole of its
   * cell's runtime, so the turn's own log is consulted instead — an exact
   * `code` match first (an `execute_python_cell` call's input is the cell's
   * source, verbatim), then a `command` carried inside the source
   * (`execute_shell_cell` wraps the command in a subprocess template), then
   * the one still-pending call whose title names the kernel server. No match
   * answers undefined: an unjoined cell over a misjoined one.
   */
  claimKernelCall(source: string): string | undefined;
  /** What this session is confined by. A caller holding a live session
   *  compares this against the boundary the next turn needs: a profile is
   *  fixed when the process is spawned, so a turn whose grants no longer
   *  match cannot be run in it. */
  readonly boundary: string;
  /** The last of what the adapter wrote to stderr — `AcpConnection`'s own
   *  tail, read through the connection this session holds. A failure reason
   *  already carries it when a turn ends `failed`; this is for a caller that
   *  needs it while nothing has failed yet, such as a diagnostic on a turn
   *  that has stopped producing anything at all. */
  stderrTail(): string;
}

/** One block of a tool call's output, as the adapter sends it. The fields
 *  are the union of every block type's own, because the type is only known
 *  after reading `type`. */
interface AcpContentBlock {
  type?: string;
  content?: { type?: string; text?: string };
  path?: string;
  oldText?: string | null;
  newText?: string;
  output?: string;
  uri?: string;
  name?: string;
}

interface AcpToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  content?: AcpContentBlock[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * What kind of call this is. An adapter that names no kind, and one naming a
 * kind this contract does not carry, both get `"other"` — a real member of
 * the set. An update that names none at all leaves the kind an earlier
 * update established, since only the announcement usually carries it.
 */
function kindOf(call: AcpToolCall, existing: ExecutionLogEntry | undefined): string {
  if (call.kind === undefined) return existing?.tool ?? "other";
  return isToolKind(call.kind) ? call.kind : "other";
}

/**
 * The arguments a call has been given so far. Later arguments merge over
 * earlier ones: an adapter announces a call before it knows what it is being
 * given, so an update carrying no keys states nothing about the arguments
 * and must not displace what an earlier one did carry.
 */
function mergeInput(existing: unknown, raw: unknown): unknown {
  if (raw === undefined || raw === null) return existing ?? {};
  if (!isRecord(raw)) return raw;
  if (Object.keys(raw).length === 0) return existing ?? {};
  return isRecord(existing) ? { ...existing, ...raw } : { ...raw };
}

/** One output block, as the part it is. A block whose type nothing draws is
 *  named by that type, so it is reported as present and unrecognised rather
 *  than dropped. */
function partOf(block: AcpContentBlock): ToolOutputPart {
  const type = block.type ?? (block.content !== undefined ? "content" : "");
  switch (type) {
    case "content": {
      const text = block.content?.text;
      if (typeof text === "string") return { type: "text", text };
      return { type: "other", blockType: block.content?.type ?? "content" };
    }
    case "diff":
      return {
        type: "diff",
        path: block.path ?? "",
        ...(typeof block.oldText === "string" ? { oldText: block.oldText } : {}),
        newText: block.newText ?? "",
      };
    case "terminal":
      return { type: "terminal", output: block.output ?? "" };
    case "resource_link":
      return {
        type: "resource",
        uri: block.uri ?? "",
        ...(block.name === undefined ? {} : { name: block.name }),
      };
    default:
      return { type: "other", blockType: type || "other" };
  }
}

/**
 * Everything a call produced, in arrival order and by type. An output that
 * is entirely text collapses to that text, its blocks concatenated — which
 * is what an output of text IS, and keeps the common case a plain string.
 * Anything else stays a list, so a diff, a terminal's output and a resource
 * reference each survive the trip as themselves.
 *
 * An empty block list therefore reads as the empty string: the call ran and
 * produced nothing, which is a different fact from an update that carried no
 * block list at all.
 */
function outputOf(blocks: AcpContentBlock[]): string | ToolOutputPart[] {
  const parts = blocks.map(partOf);
  return parts.every((part) => part.type === "text")
    ? parts.map((part) => (part as { text: string }).text).join("")
    : parts;
}

interface AcpUpdate {
  sessionUpdate: string;
  content?: { text?: string } | Array<{ content?: { text?: string } }>;
  entries?: Array<{ content: string; status: string }>;
}

/** What a permission request is asking to touch, read out of the title the
 *  adapter supplied. An adapter that names no path gets a card that names no
 *  path, which is honest — the researcher still sees the tool and the title. */
function pathFrom(title: string): string | undefined {
  const match = /(\/[^\s"']+|~\/[^\s"']+)/.exec(title);
  return match?.[1];
}

/**
 * Which notebook cell tool a call is, read off the name the agent gave it.
 *
 * The kernel host publishes one tool per language, and their names are the
 * only thing distinguishing a cell from any other call by the time a
 * permission request arrives — ACP's `title` for an MCP call is the tool's
 * own name, and it carries no path for `pathFrom` to find. Without this a
 * cell falls through to `execute`, and the card then asks whether to run a
 * shell command, which is not what is about to happen.
 */
function notebookCellLanguage(title: string): "python" | "r" | "shell" | undefined {
  const match = /(?:^|__)execute_(python|r|shell)_cell$/.exec(title.trim());
  if (match === null) return undefined;
  return match[1] as "python" | "r" | "shell";
}

/** Recovers the path and mode a raised card asked about, from the access it
 *  carries — the same shape `decide` needs to know what to remember. An
 *  `execute` card names no path, so there is nothing standing to grant. */
function grantFrom(request: PermissionRequest): StandingGrant | undefined {
  if (request.access.kind === "write-path") return { path: request.access.target, mode: "write" };
  if (request.access.kind === "read-path") return { path: request.access.target, mode: "read" };
  return undefined;
}

/** One of the answers an agent offered, as it described it. `kind` is the
 *  part of this the protocol fixes; `optionId` is the agent's own name for
 *  it and is never the same twice. */
interface PermissionOption {
  optionId?: unknown;
  kind?: unknown;
}

/** What the researcher decided, before it is expressed in any one agent's
 *  vocabulary. */
type Verdict = "allow" | "reject";

/** Which already-given consent covers a call, or `undefined` for one nobody
 *  has consented to yet — the answer that decides whether a call has to be
 *  asked about at all. Named as the decision it will be recorded under, so a
 *  call allowed on a standing grant and one allowed on this conversation's own
 *  grant never end up indistinguishable in the log. */
type Covered = "allowed-conversation" | "allowed-study" | undefined;

/**
 * The id to answer with, chosen from what this agent actually offered.
 *
 * An agent names its own options, and no two name them alike. An id this
 * machine invented selects nothing at all — the call is neither allowed nor
 * denied, and a researcher who pressed Allow watches it fail anyway. So the
 * kind, which the protocol fixes, is what is matched on, and the id is only
 * ever copied back out of what arrived.
 *
 * Allowing once is preferred over allowing always even when the researcher
 * said "for this conversation". What repeats a grant is this machine's own
 * record of it, which answers the next request without asking; "always" is
 * the agent widening its own permissions to something this machine does not
 * hold and could not later take back.
 *
 * Undefined when nothing offered fits, which is a thing to say rather than
 * to guess past.
 */
export function permissionAnswer(
  offered: unknown,
  verdict: Verdict,
): string | undefined {
  const options = Array.isArray(offered) ? (offered as PermissionOption[]) : [];
  const named = options.filter(
    (option): option is { optionId: string; kind?: unknown } =>
      typeof option.optionId === "string" && option.optionId.length > 0,
  );
  const kindOf = (option: { kind?: unknown }): string =>
    typeof option.kind === "string" ? option.kind : "";
  const exact = verdict === "allow" ? "allow_once" : "reject_once";
  const prefix = verdict === "allow" ? "allow" : "reject";
  const match =
    named.find((option) => kindOf(option) === exact) ??
    named.find((option) => kindOf(option).startsWith(prefix));
  return match?.optionId;
}

/**
 * The id this agent gave to "allow this call, once" — and only to that.
 *
 * The one answer a BROKERED card may be given. `permissionAnswer` above is
 * right for its own callers and is deliberately not reused here: there a
 * researcher chose the verdict and that function's job is to map their choice
 * onto whatever menu the agent happens to offer, falling back to `allow_always`
 * when nothing narrower exists. On the brokered path nobody chose anything, and
 * falling back would have this machine hand the agent a durable permission of
 * its own for a question no researcher ever saw. Suppressing a card is what the
 * design licenses; granting one is not.
 *
 * So the match is exact, on the kind the protocol fixes — the same discipline
 * `BROKERED_ENVIRONMENT_TOOLS` is matched with, and for the same reason. An
 * agent offering no `allow_once` gets `undefined`, and the caller raises the
 * ordinary card: the stacked pair of questions this brokering exists to remove
 * comes back for that adapter, which is a visible regression somebody can act
 * on rather than an invisible standing grant.
 */
function allowOnceAnswer(offered: unknown): string | undefined {
  const options = Array.isArray(offered) ? (offered as PermissionOption[]) : [];
  const match = options.find(
    (option): option is { optionId: string; kind: string } =>
      option.kind === "allow_once" &&
      typeof option.optionId === "string" &&
      option.optionId.length > 0,
  );
  return match?.optionId;
}

export async function startSession(options: {
  /** The adapter to run. It is confined HERE rather than by the caller, so
   *  spawning one outside a boundary is not something a caller can express:
   *  there is no argument that asks for it and no path through this
   *  function that does it. */
  adapter: { command: string; args: string[] };
  /** Which agent this adapter speaks for. Decides the one thing the boundary
   *  cannot infer from a command line: where this program keeps its own
   *  credentials and state, without which it starts and then reports itself
   *  signed out. */
  agent: string;
  /** The Task directory this session works in, and the one directory the
   *  boundary lets it write. */
  cwd: string;
  /** Where this machine keeps its own state. Denied to the agent: the
   *  machine token is the machine's identity. */
  dataDir: string;
  /** The platform whose backend confines this session. Production passes
   *  none and this machine's own platform is used. */
  platform?: string;
  grants: StandingGrant[];
  /** The environments this conversation has ALREADY been given standing
   *  permission to change, by name — what the lab persisted when a researcher
   *  answered an earlier environment card "for this conversation".
   *
   *  A conversation outlives the process holding it: a daemon restarts, a
   *  session is retired when its boundary changes, and the next turn opens a
   *  new one. Held only in memory, "for this conversation" would quietly mean
   *  "until something restarts" — and the researcher would be asked again
   *  about an environment they already allowed, in the same conversation.
   *  So the set is seeded from what the lab holds rather than from anything
   *  this process remembers, and grows from there as this session's own cards
   *  are answered.
   *
   *  Absent is empty: a conversation nobody has allowed anything in. */
  environmentGrants?: readonly string[];
  /** The tool servers this session's agent is told it may reach. Absent is
   *  the same as none: a session opens either way, and an agent given none is
   *  told so rather than left to guess whether the list was withheld. */
  mcpServers?: McpServer[];
  onEvent: (event: RunEvent) => void;
  onGrant: (grant: StandingGrant) => void;
  env?: NodeJS.ProcessEnv;
  /** Variables to put in front of the adapter deliberately, as opposed to
   *  `env` above, which is only ever a source to draw the allowlist from.
   *
   *  The distinction is the whole of `confined-env.ts`: what arrives because
   *  a named line of Lykeion put it there, against what happened to be in the
   *  environment this daemon was started from. `env` is the second kind and
   *  is filtered; this is the first kind and is not. Nothing in production
   *  sets it yet — it exists because the test harness wires its stub adapter
   *  through three variables of its own, and those are as deliberate as
   *  `TMPDIR`. Filtering them alongside the researcher's shell would have
   *  been the allowlist working correctly on the wrong input. */
  extraEnv?: Record<string, string>;
  /** Cancels ACP initialization and reaps the subprocess before this promise
   *  settles. Once initialization succeeds, lifecycle ownership transfers to
   *  the returned LiveSession and callers close it normally. */
  signal?: AbortSignal;
  /** Which of the agent's own advertised choices this turn asked for, by
   *  option value. Reused from `RunOptions.model`; an agent advertising no
   *  such value is left as it is rather than told something it never
   *  offered. */
  model?: string;
  /** Overrides `DEFAULT_CANCEL_GRACE_MS` — a test's own way to make a stop's
   *  grace period something shorter than real seconds. Production never
   *  passes this. */
  cancelGraceMs?: number;
}): Promise<LiveSession> {
  const { cwd, onEvent, onGrant } = options;
  const cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  // Asked again here, not only at daemon start. A CLI replants its own skill
  // bundle at the start of every process it spawns, and the first process to
  // run in a home this machine has never used before is a probe cycle's,
  // minutes before a researcher opens anything — so a sweep that only ran at
  // startup leaves that bundle in front of every session for the rest of the
  // daemon's life. See `sweepReplantedSkills`; it is a `readdirSync` over one
  // directory that usually does not exist.
  //
  // Left to refuse the session, like everything else above the spawn below. A
  // home this machine cannot read is one it cannot promise anything about
  // what the agent will find there, and refusing before anything is started
  // says so, rather than opening a session whose isolation is unverified.
  //
  // Framed rather than re-thrown bare: what the filesystem says on its own is
  // `EACCES: permission denied, scandir '…/skills/.system'`, which names
  // neither Lykeion, nor the agent, nor why a session that had nothing to do
  // with that directory did not open. The original message is kept inside it,
  // because it is the only part that says what actually went wrong.
  try {
    sweepReplantedSkills(options.agent);
  } catch (err) {
    throw new Error(
      `Lykeion refused to open a ${options.agent} session: its installation at ` +
        `${lykeionHomeFor(options.agent)} could not be cleared of skills no session may carry ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
  }
  // Established before anything is spawned, and nothing is spawned if it
  // cannot be: `policyFor` throws on a path that will not resolve and
  // `confine` throws on a platform with no backend, both before the first
  // line below that starts a process.
  const policy = policyFor({
    workspace: cwd,
    grants: options.grants,
    dataDir: options.dataDir,
    // This machine's own program, read-only. What an agent starts is confined
    // by the same profile the agent is, and the tool servers named below are
    // started by the agent — so a boundary that could not read this would be
    // one they cannot start inside. Carried whether or not any is named, so
    // that what a boundary permits is a fact about the machine rather than
    // about which turn happened to want a kernel.
    readable: daemonProgramPaths(),
    ...confinementFor(options.agent, cwd),
  });
  const confined = confine(options.platform ?? process.platform, policy, options.adapter);
  // Somewhere to put a scratch file. The machine's shared temporary directory
  // is deliberately not granted — it is one directory for every process here,
  // so granting it would let a run read what another left behind — and a
  // program handed no writable temporary directory at all fails in ways that
  // have nothing to do with what it was asked to do. This one is inside the
  // workspace, which is already the one directory this run may write.
  const scratch = ensureTmpDir(cwd);
  const connection: AcpConnection = await connectAcp(confined.command, confined.args, {
    cwd,
    env: confinedEnv(
      options.agent,
      { TMPDIR: scratch, ...(options.extraEnv ?? {}) },
      options.env ?? process.env,
    ),
  });
  let aborting: Promise<void> | undefined;
  const abortInitialization = () => {
    aborting ??= connection.close();
  };
  if (options.signal?.aborted) abortInitialization();
  else options.signal?.addEventListener("abort", abortInitialization, { once: true });

  // Session-scoped grants: what "this session" on a card means. Held here and
  // nowhere else, so they go when the session does.
  const sessionGrants: StandingGrant[] = [];
  // The environments this conversation has already said yes to, by name.
  // What "this conversation" MEANS on an environment card, and it cannot be
  // a `StandingGrant`: those are a path and a mode, and an environment card
  // names neither. Without this the card's two scopes would be one — `once`
  // and `conversation` both asking again next time, which teaches a
  // researcher their last answer meant less than it said.
  //
  // Seeded from what the LAB holds for this conversation, so a grant survives
  // the process it was given in — see the option's own note. What this session
  // then adds to it is minted the same way it always was: by whoever performed
  // the act, once it has landed.
  const environmentGrants = new Set<string>(options.environmentGrants ?? []);
  // What each card this machine raised itself was ANSWERED with, from the
  // moment `decide` records it until `askPermission` reads it back one line
  // later. Not a grant and not a decision — those are `environmentGrants` and
  // `waiting` — but the fact that lets a grant be minted by whoever performed
  // the act rather than by whoever heard the answer. See `Answered`.
  const answeredScopes = new Map<string, PermissionScope>();
  // The canonical set the boundary was rendered from, so the question "did
  // the researcher allow this?" is asked of exactly what the kernel was
  // told — not of the paths as they were written.
  const standing = [...policy.grants];

  let text = "";
  let thinking = "";
  let lastVisibleUpdate: "text" | "thought" | "tool" | undefined;
  let plan: Plan | undefined;
  const steps = new Map<string, ExecutionLogEntry>();
  const publishedStepFingerprints = new Map<string, string>();
  // Kernel calls already joined to a cell, so two cells with one source in a
  // turn each claim their own call rather than both claiming the first.
  const claimedKernelCalls = new Set<string>();
  // Resolved with what the researcher decided, not with any agent's word for
  // it. Turning a verdict into one of the offered ids happens where the offer
  // is in scope, so nothing downstream can invent one.
  const waiting = new Map<string, (verdict: Verdict) => void>();
  // Every card raised while it is still open, so a later `decide` can recover
  // what it was asking about — a decision only carries the request id back.
  const cards = new Map<string, PermissionRequest>();
  // Which execution-log row each open card's decision belongs to, decided at
  // the raise site and kept here because none of the three places that settle
  // a card — `publishGate`, `decide`, `abandonCards` — is the place that
  // raised it. See `recordDecision` for why this cannot simply be `card.tool`.
  const logKeys = new Map<string, string>();
  // Whether consent the researcher has given SINCE this card was raised already
  // covers it. Asked of the card's own raise site, which is the only place that
  // still knows what the original check looked at. A turn raises a whole batch
  // at once, so a card can be sitting in the queue when the answer that covers
  // it is given to one of its siblings.
  const coverage = new Map<string, () => Covered>();
  // The one card currently in front of the researcher. Every other open gate
  // waits its turn in `waiting`'s own insertion order — one question at a time,
  // because a turn that raises four calls at once is still four separate things
  // to consent to, and a surface with one slot for them can only lose three.
  let shown: string | undefined;
  // How many gates the batch in front of the researcher has already settled.
  // What makes the counter read "2 of 4" rather than restarting at "1 of 3".
  // Reset when the queue drains, so it counts the batch and not the session.
  let settledInGate = 0;
  // The last card and counter actually published, so re-publishing something
  // unchanged emits nothing.
  let published: { id: string; position: number; total: number } | undefined;
  let nextRequest = 1;

  const emitLive = (): void => {
    const live: { text?: string; thinking?: string } = {};
    if (text) live.text = text;
    if (thinking) live.thinking = thinking;
    onEvent({ event: "live", live });
  };

  const emitStep = (entry: ExecutionLogEntry): void => {
    steps.set(entry.toolUseId, entry);
    const fingerprint = JSON.stringify([
      entry.ts,
      entry.toolUseId,
      entry.tool,
      entry.title,
      entry.input,
      entry.decision,
      entry.result,
      entry.isError,
      entry.outsideWorkspace,
    ]);
    if (publishedStepFingerprints.get(entry.toolUseId) === fingerprint) return;
    publishedStepFingerprints.set(entry.toolUseId, fingerprint);
    onEvent({ event: "log-entry", entry });
  };

  // What this session said it lets a caller change, and which method a set
  // travels on. Read from what the session advertised, never from which CLI
  // it is.
  let advertised: { options: AgentOption[]; setter: OptionSetter } = {
    options: [],
    setter: "none",
  };
  // The id the agent assigned to this session in `session/new`'s response —
  // every later call names it, exactly as an adapter that checks it expects.
  let sessionId = "session";
  try {
    if (options.signal?.aborted) throw new Error("session initialization was cancelled");
    await connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const meta = await sessionMetaFor(options.agent);
    const created = await connection.request("session/new", {
      cwd,
      mcpServers: options.mcpServers ?? [],
      ...(meta === undefined ? {} : { _meta: meta }),
    });
    sessionId = (created as { sessionId?: string }).sessionId ?? sessionId;
    advertised = readAdvertised(created);
  } catch (err) {
    const tail = connection.stderrTail().trim();
    await (aborting ?? connection.close());
    throw new Error(tail || (err instanceof Error ? err.message : String(err)));
  } finally {
    options.signal?.removeEventListener("abort", abortInitialization);
  }
  if (options.signal?.aborted) {
    await (aborting ?? connection.close());
    throw new Error("session initialization was cancelled");
  }

  /** Tells this session to change one of its own advertised options, by the
   *  method the session's own advertisement chose. A refusal is not fatal:
   *  the boundary this run executes inside does not depend on the agent
   *  agreeing to anything. */
  const setOption = async (id: string, value: string): Promise<void> => {
    try {
      if (advertised.setter === "config") {
        const echoed = await connection.request("session/set_config_option", {
          sessionId,
          configId: id,
          value,
        });
        // What the option holds now is what came back, not what was asked
        // for: an agent that rejected the set echoes its real current value,
        // and recording the asked-for one instead would leave this session
        // describing itself as something it is not.
        const outcome = confirmationOf(echoed, id, value);
        advertised = {
          ...advertised,
          options: advertised.options.map((option) =>
            option.id === id ? { ...option, currentValue: outcome.value } : option,
          ),
        };
      } else if (advertised.setter === "model" && id === "model") {
        // This method answers with nothing at all, so the value is applied
        // and unconfirmed — recorded as asked for, and never as verified.
        await connection.request("session/set_model", { sessionId, modelId: value });
        advertised = {
          ...advertised,
          options: advertised.options.map((option) =>
            option.id === id ? { ...option, currentValue: value } : option,
          ),
        };
      }
    } catch {
      // Left as it was. What an agent may touch is settled by the kernel,
      // and what it runs on is the agent's own default.
    }
  };

  // The operating-system boundary is the outer bound. The agent's own mode
  // may narrow it and can never widen it, so this selects the ordinary
  // working mode and never the full-access one — an agent told it has full
  // access, inside a boundary that says otherwise, produces a turn full of
  // denials that look like breakage rather than policy.
  const mode = advertised.options.find((option) => option.category === "mode");
  if (mode) {
    const working = ordinaryWorkingMode(mode);
    if (working !== undefined) await setOption(mode.id, working);
  }
  // What the researcher picked beside the composer, if this agent offers it.
  if (options.model !== undefined) {
    const chosen = advertised.options.find((option) =>
      option.choices.some((choice) => choice.value === options.model),
    );
    if (chosen) await setOption(chosen.id, options.model);
  }

  connection.onNotify("session/update", (raw) => {
    // Not gated on `hasStaleOutstanding`. An abandoned turn's own ordinary
    // output arriving here cannot be told apart from the turn now current's
    // — ACP gives neither a per-call correlation id — so there is no way to
    // attribute it correctly. Between showing it anyway (mislabelled, but
    // visible, on whichever turn happens to be current) and dropping it,
    // dropping is worse: it would just as readily discard the CURRENT
    // turn's own legitimate output for as long as the abandoned call stays
    // outstanding, which an adapter that ignores `session/cancel` may never
    // resolve at all. `session/request_permission`, below, is held to the
    // opposite call: a wrongly-attributed permission answer has real
    // consequences a wrongly-attributed line of prose does not.
    const { update } = raw as { update: AcpUpdate };
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const chunk = (update.content as { text?: string })?.text ?? "";
        text += chunk;
        lastVisibleUpdate = "text";
        onEvent({ event: "assistant-text", text: chunk, partial: true });
        emitLive();
        return;
      }
      case "agent_thought_chunk": {
        // An agent whose thought channel this machine does not carry is left
        // exactly where it was — `lastVisibleUpdate` too, so a thought cannot
        // be what a later update is ordered against.
        if (!carriesThinking(options.agent)) return;
        const chunk = (update.content as { text?: string })?.text ?? "";
        thinking += chunk;
        lastVisibleUpdate = "thought";
        onEvent({ event: "assistant-thought", text: chunk, partial: true });
        emitLive();
        return;
      }
      case "plan": {
        plan = {
          steps: (update.entries ?? []).map((e) => ({
            title: e.content,
            done: e.status === "completed",
            status:
              e.status === "completed" ? "completed" : e.status === "in_progress" ? "in_progress" : "pending",
          })),
        };
        onEvent({ event: "plan-proposed", plan });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        lastVisibleUpdate = "tool";
        const call = update as unknown as AcpToolCall;
        const id = call.toolCallId;
        const existing = steps.get(id);
        const terminal = call.status === "completed" || call.status === "failed";
        const gated = existing?.decision !== undefined && existing.decision !== "pending";
        const entry: ExecutionLogEntry = {
          ts: existing?.ts ?? Math.floor(Date.now() / 1000),
          toolUseId: id,
          tool: kindOf(call, existing),
          input: mergeInput(existing?.input, call.rawInput),
          decision: gated ? existing.decision : terminal ? "ran" : "pending",
          isError:
            call.status === "failed" ||
            existing?.decision === "denied" ||
            existing?.decision === "cancelled",
        };
        if (call.title !== undefined) entry.title = call.title;
        else if (existing?.title !== undefined) entry.title = existing.title;
        const result = call.content === undefined ? undefined : outputOf(call.content);
        if (result !== undefined) entry.result = result;
        else if (existing?.result !== undefined) entry.result = existing.result;
        emitStep(entry);
        return;
      }
      default:
        return;
    }
  });

  connection.onRequest("session/request_permission", async (raw) => {
    const params = raw as {
      toolCall?: { toolCallId?: string; title?: string };
      options?: unknown;
    };
    const title = params.toolCall?.title ?? "";
    /** The agent's own id for a verdict, or a refusal saying it offered none
     *  this machine could answer with. */
    const answer = (
      verdict: Verdict,
    ): { outcome: { outcome: "selected"; optionId: string } } | undefined => {
      const optionId = permissionAnswer(params.options, verdict);
      return optionId === undefined ? undefined : { outcome: { outcome: "selected", optionId } };
    };
    const unanswerable = (): { outcome: { outcome: "cancelled" } } => {
      const entry: ExecutionLogEntry = {
        ts: Math.floor(Date.now() / 1000),
        toolUseId: params.toolCall?.toolCallId ?? "tool",
        tool: "other",
        ...(title !== "" ? { title } : {}),
        input: {},
        decision: "denied",
        isError: true,
        result:
          "this agent offered no answer this machine could give, so the call was left undecided",
      };
      emitStep(entry);
      return { outcome: { outcome: "cancelled" } };
    };
    const target = pathFrom(title);
    const mode: "read" | "write" = /write|edit|create|delete/i.test(title) ? "write" : "read";
    const cellLanguage = notebookCellLanguage(title);

    /**
     * What this call is asking to do, and the one line of prose the card puts
     * under the question.
     *
     * A cell's `detail` is deliberately absent. For every other kind it holds
     * the agent's own title, which the card renders as an agent-supplied
     * reason — but an MCP call's title is the tool's name, and a name
     * presented as a reason tells a researcher nothing while looking like it
     * does. What a cell is consenting to is its source, and that goes where
     * the code goes.
     */
    const asked = (): Pick<PermissionRequest, "access" | "detail"> => {
      if (target !== undefined)
        return {
          access:
            mode === "write"
              ? { kind: "write-path", target }
              : { kind: "read-path", target },
          detail: title,
        };
      if (cellLanguage !== undefined) {
        const announced = steps.get(params.toolCall?.toolCallId ?? "");
        const code = (announced?.input as { code?: unknown } | undefined)?.code;
        return {
          access: {
            kind: "notebook-cell",
            target: {
              language: cellLanguage,
              ...(typeof code === "string" && code !== "" ? { code } : {}),
            },
          },
        };
      }
      return { access: { kind: "execute", target: title }, detail: title };
    };

    // Before anything is asked of anyone. A card offering Allow and Deny is a
    // promise that either answer can be delivered, and an agent that offered
    // no way to say one of them cannot have it delivered — so the refusal
    // belongs here, where nobody has been asked yet, rather than after a
    // researcher has answered a question that was never answerable.
    if (
      permissionAnswer(params.options, "allow") === undefined ||
      permissionAnswer(params.options, "reject") === undefined
    )
      return unanswerable();

    // Checked first, regardless of which turn this request could even be
    // attributed to: a standing grant is the researcher's own prior
    // consent, not a fact about the turn asking, so a request landing here
    // during the ambiguous window below is still honoured by one exactly
    // the way a live turn's own request would be.
    // Asked of the same canonical grant set the sandbox profile is
    // rendered from, so the question "did the researcher allow this?" and
    // the question "will the kernel permit this?" cannot come apart.
    const sessionGrant = target !== undefined && covers(sessionGrants, target, mode);
    const studyGrant = target !== undefined && covers(standing, target, mode);
    if (sessionGrant || studyGrant) {
      const card: PermissionRequest = {
        id: `pr_${nextRequest++}`,
        tool: params.toolCall?.toolCallId ?? "tool",
        ...asked(),
      };
      const allowed = answer("allow");
      if (allowed === undefined) return unanswerable();
      emitStep(
        recordDecision(card.tool, card, sessionGrant ? "allowed-conversation" : "allowed-study"),
      );
      return allowed;
    }

    // Unlike `session/update`'s notifications, a wrongly-attributed answer
    // here has real consequences — it could authorise something the
    // researcher never saw asked, or (above) block something they already
    // allowed. `settled` catches the request landing in the gap between a
    // turn's own grace-triggered ending and a successor's `prompt()` ever
    // starting, where there is no OTHER epoch yet for `hasStaleOutstanding`
    // to compare against; `hasStaleOutstanding` catches it once a successor
    // has. Refused rather than raised as a card nobody still watching this
    // turn could ever answer — visibly, so the refusal is a disclosed fact
    // rather than a silent one.
    if (settled || hasStaleOutstanding()) {
      const refusedId = params.toolCall?.toolCallId ?? "tool";
      const entry: ExecutionLogEntry = {
        ts: Math.floor(Date.now() / 1000),
        toolUseId: refusedId,
        tool: "other",
        ...(title !== "" ? { title } : {}),
        input: {},
        decision: "denied",
        isError: true,
        result: "auto-refused — this request could not be attributed to a live turn",
      };
      // Written into `steps`, not only emitted, the same way a researcher's
      // own denial is: an adapter that reports the refused call afterwards
      // sends a `tool_call_update` for this id, and the merge above reads
      // `steps` to decide what the call's decision was. Without the entry
      // there, that update finds nothing and falls through to `ran` — a
      // second row claiming the call executed, directly after the row
      // saying it was refused.
      emitStep(entry);
      return answer("reject") ?? { outcome: { outcome: "cancelled" } };
    }

    // The provider's own wrapper around a tool that asks the real question
    // itself. Answered here, so the researcher is asked once — by the card
    // that names the environment rather than by the one that names a tool.
    //
    // Read off the EXECUTION LOG rather than off this request: an adapter's
    // permission title is often prose ("Run a shell command"), while the
    // `tool_call` update it announced the call with carries the tool's own
    // name, which is what the allowlist is written in. A call this session
    // has no log entry for — an adapter that asked before it announced, or
    // announced no title — matches nothing and gets its card, which is the
    // safe direction for an absence. The same entry carries the arguments the
    // call announced, and they have to be the named tool's own: a title is
    // free text an adapter supplies, and a call that merely SAYS it is one of
    // these two has no inner card behind it to fall back on.
    //
    // Nothing is written here: no card, because none was raised, and no
    // grant, because nothing has been consented to yet. What the researcher
    // decides is decided one layer down, on `askPermission`'s own card, and
    // the arguments that reach it are not this end's to trust either — the
    // kernel-host method behind both of these tools mutates nothing before
    // that card is answered.
    //
    // And only ever with the agent's own `allow_once`. An agent that offers
    // none is answered by nobody here — the card below is raised instead, and
    // the researcher answers the provider's question the way they always did.
    // See `allowOnceAnswer`.
    const logged = steps.get(params.toolCall?.toolCallId ?? "");
    const brokered =
      logged?.title === undefined ? undefined : BROKERED_ENVIRONMENT_TOOLS.get(logged.title);
    if (brokered !== undefined && brokered(logged?.input)) {
      const allowedOnce = allowOnceAnswer(params.options);
      if (allowedOnce !== undefined)
        return { outcome: { outcome: "selected" as const, optionId: allowedOnce } };
    }

    const id = `pr_${nextRequest++}`;
    const request: PermissionRequest = {
      id,
      tool: params.toolCall?.toolCallId ?? "tool",
      ...asked(),
    };
    // The same two questions the fast path above asked, asked again if this
    // card ever reaches the head of the queue. A batch is raised all at once,
    // so a sibling's answer can arrive after this card was already waiting —
    // and the grant it created covers this call exactly as it would have if it
    // had existed when the call first arrived.
    const verdict = await gated(
      request,
      () =>
        target === undefined
          ? undefined
          : covers(sessionGrants, target, mode)
            ? "allowed-conversation"
            : covers(standing, target, mode)
              ? "allowed-study"
              : undefined,
      // The adapter's own id for the call this card gates, which is the id
      // its `tool_call` update arrives under: the decision and the call it
      // decides have to land on one row.
      request.tool,
    );
    return answer(verdict) ?? unanswerable();
  });

  /**
   * What a card was asking about, for a row nothing else is going to fill in.
   *
   * An ACP card's own arguments arrive on the adapter's `tool_call` update and
   * are already in `steps` under the same key by the time a decision lands —
   * which is what `existing` below carries, and why this answers `{}` for one.
   * A card this machine raised has no adapter update behind it at all, so
   * without this its row would stand for a decision with an empty object where
   * the thing decided about should be: a researcher reading the transcript
   * would see that something was allowed and never what.
   */
  const askedAbout = (card: PermissionRequest): unknown =>
    card.access.kind === "environment"
      ? { environment: card.access.target.name, packages: card.access.target.packages }
      : {};

  /**
   * Merges a decision about a permission-gated call into its execution-log
   * entry. A later adapter update reads the same stored decision and cannot
   * contradict it.
   *
   * `logKey` is which row this decision belongs to, and it is an argument
   * rather than `card.tool` because the two raise sites mean different things
   * by that field. An ACP card carries the adapter's own tool-call id there,
   * unique per call and the same id its `tool_call` update will arrive under —
   * so the decision and the call it decides land on one row, which is the
   * whole point. A card this machine raised carries the TOOL'S NAME there
   * instead, because the surface reads it to choose the card's wording; keyed
   * on that, every environment decision in a turn would write over the last
   * one, inheriting its `ts` and its `result` and publishing a row whose
   * stated reason belongs to a different decision. Two of them shaped alike
   * would not even be published twice — `emitStep` suppresses a byte-identical
   * republish, so the second consent would exist nowhere. So that raise site
   * passes its own `pr_` id, which is unique per card by construction.
   */
  const recordDecision = (
    logKey: string,
    card: PermissionRequest,
    decision: "allowed-once" | "allowed-conversation" | "allowed-study" | "denied" | "cancelled",
    result?: string,
  ): ExecutionLogEntry => {
    const existing = steps.get(logKey);
    const entry: ExecutionLogEntry = {
      ts: existing?.ts ?? Math.floor(Date.now() / 1000),
      toolUseId: logKey,
      tool: existing?.tool ?? "other",
      input: existing?.input ?? askedAbout(card),
      decision,
      isError: decision === "denied" || decision === "cancelled",
    };
    const title = existing?.title ?? card.detail;
    if (title !== undefined) entry.title = title;
    if (result !== undefined) entry.result = result;
    else if (existing?.result !== undefined) entry.result = existing.result;
    steps.set(logKey, entry);
    return entry;
  };

  /**
   * Puts the head of the queue in front of the researcher, or leaves the gate
   * once there is nothing left to ask about.
   *
   * A permission card is a transient execution gate, and a turn may hold
   * several at once: an agent asked to batch independent tool calls into one
   * block raises one request per call, all of them before any is answered.
   * Only ONE is ever published, because the turn state has one slot for a
   * question and a second card written into it would erase the first — which
   * is not a display defect but a silent loss of consent: the researcher never
   * sees the request, and the agent is eventually told they refused it.
   *
   * So the rest wait here, and each decision publishes the next instead of
   * ending the gate. The gate ends when the queue is actually empty.
   *
   * Called after a decision is recorded and before the ACP request it settles
   * is released, so a persisted recovery snapshot cannot keep offering an
   * already-spent decision after a reload.
   */
  const publishGate = (): void => {
    // A card whose answer arrived while it waited is not a question any more.
    // Drained here rather than shown, because asking a researcher to allow
    // something they just allowed teaches them their last answer meant less
    // than it said.
    while (shown === undefined || !waiting.has(shown)) {
      const [next] = waiting.keys();
      if (next === undefined) {
        shown = undefined;
        published = undefined;
        settledInGate = 0;
        onEvent({
          event: "state",
          state: plan ? { state: "executing", plan } : { state: "planning" },
        });
        return;
      }
      const already = coverage.get(next)?.();
      if (already === undefined) {
        shown = next;
        break;
      }
      const settle = waiting.get(next);
      const covered = cards.get(next);
      const logKey = logKeys.get(next);
      waiting.delete(next);
      cards.delete(next);
      coverage.delete(next);
      logKeys.delete(next);
      if (covered && logKey !== undefined) emitStep(recordDecision(logKey, covered, already));
      settle?.("allow");
    }

    const head = shown;
    if (head === undefined) return;
    const request = cards.get(head);
    if (request === undefined) return;
    const position = settledInGate + 1;
    const total = settledInGate + waiting.size;
    if (
      published !== undefined &&
      published.id === head &&
      published.position === position &&
      published.total === total
    )
      return;
    // Only a card the researcher has not been shown yet is a new card. The
    // same card re-published with a grown `total` — a sibling raised while
    // this one was still on screen — is the same question, and announcing it
    // twice would put two of it in a log that records one per gate.
    const first = published?.id !== head;
    published = { id: head, position, total };
    if (first) onEvent({ event: "permission-card", request });
    onEvent({
      event: "state",
      state: {
        state: "awaiting-permission",
        request,
        // Absent for a lone gate: there is no batch to place it in, and "1 of
        // 1" is a count of nothing.
        ...(total > 1 ? { queue: { position, total } } : {}),
        ...(plan ? { plan } : {}),
      },
    });
  };

  /** Holds a raised card until it is answered — by the researcher, or by
   *  consent `covered` reports has since arrived for it. Every gate in this
   *  session goes through here, so there is one queue and one place that
   *  decides what is on screen. */
  const gated = (
    request: PermissionRequest,
    covered: () => Covered,
    logKey: string,
  ): Promise<Verdict> => {
    cards.set(request.id, request);
    coverage.set(request.id, covered);
    logKeys.set(request.id, logKey);
    // The executor runs synchronously, so `waiting` has this card before
    // `publishGate` below goes looking for the head of the queue.
    const verdict = new Promise<Verdict>((resolve) => waiting.set(request.id, resolve));
    publishGate();
    return verdict;
  };

  /** Settles every card still open when the turn ends underneath it. A card
   *  nobody answered is not consent, so the ACP request it is holding open
   *  is refused; and since the adapter that raised it may already be gone or
   *  going, there is no `tool_call_update` to wait on the way a plain denial
   *  can, so the step is written and reported here, as `cancelled` —
   *  abandoned at the gate, never run, no result — rather than left as a
   *  card with no resolution a consumer would otherwise have to guess at. */
  const abandonCards = (): void => {
    for (const [id, resolve] of waiting) {
      resolve("reject");
      const card = cards.get(id);
      const logKey = logKeys.get(id);
      if (card && logKey !== undefined) emitStep(recordDecision(logKey, card, "cancelled"));
    }
    waiting.clear();
    cards.clear();
    coverage.clear();
    logKeys.clear();
    // Deliberately not `publishGate()`: the caller is ending the turn and
    // emits `completed` next, and a `planning` state slipped in between would
    // say this session went back to work.
    shown = undefined;
    published = undefined;
    settledInGate = 0;
  };

  // Bumped once per `prompt()` call — the epoch the turn that call started
  // belongs to. A grace timeout can end a turn while its own `session/prompt`
  // call is still outstanding (see `cancelTurn`), and this lab's own queue
  // moves straight on to the next turn once that happens (deliberately —
  // this session is left running, not closed, so its conversation state
  // survives). The epoch is what lets a LATER arrival from that abandoned
  // call — its real settlement, or any `session/update`/permission request
  // still in flight under it — be recognised as belonging to a turn that is
  // already over, rather than mistaken for the turn that superseded it.
  let epoch = 0;
  // Every epoch whose own `session/prompt` call has been sent but has not
  // yet resolved or rejected — normally just the current one. More than one
  // entry means an EARLIER turn's call is still outstanding after this
  // session already moved on to a later epoch: the window in which neither
  // `finish` nor a `session/update`/permission notification can trust which
  // turn it belongs to. Cleared per epoch by the `.then()`/`.catch()` on
  // that epoch's own `session/prompt` call, whichever way it settles.
  const pendingRequests = new Set<number>();
  const hasStaleOutstanding = (): boolean => {
    for (const e of pendingRequests) if (e !== epoch) return true;
    return false;
  };
  // True once the current epoch's own ending has been decided — by a real
  // settlement or by this session's own grace timing out first, whichever
  // happens first (`finish` checks and sets this). Starts `true` — idle,
  // nothing to end — and is set `false` at the top of every `prompt()`.
  let settled = true;
  // The pending grace timer for the current turn's stop, if `cancelTurn` has
  // armed one and it has not fired or been cleared yet.
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const clearGrace = (): void => {
    if (graceTimer === undefined) return;
    clearTimeout(graceTimer);
    graceTimer = undefined;
  };

  /** Ends the turn `forEpoch` names — a no-op if that epoch is not the
   *  current one (a later `prompt()` has since superseded it) or has
   *  already been settled (grace and a real settlement racing each other).
   *  Either guard alone would miss the other's failure mode: the epoch
   *  check alone would still let a grace timeout and a real settlement for
   *  the SAME still-current epoch double-emit; the `settled` check alone
   *  would still let a stale settlement from an abandoned epoch end
   *  whatever epoch is current now. */
  const finish = (
    forEpoch: number,
    state: "completed" | "failed" | "cancelled",
    reason?: string,
    unacknowledged?: true,
  ): void => {
    if (forEpoch !== epoch || settled) return;
    settled = true;
    clearGrace();
    // Only here, and only for `failed`. A turn that ENDED in error is the one
    // observation that can tell a working sign-in from a revoked one, because
    // rung 7's question — "who are you signed in as" — is answered identically
    // by both: the account metadata outlives the grant behind it.
    //
    // Placed inside `finish` rather than at the call site that passes
    // "failed", and after the guard above rather than before it. The guard is
    // what makes one failed turn record exactly ONE demotion: a stale epoch's
    // late settlement, or a grace timeout racing a real one, would otherwise
    // each record their own. Being the single choke point is the rest of it —
    // any failure path added later inherits this rather than having to
    // remember it.
    //
    // The `session/update` streaming path cannot reach this: it never calls
    // `finish`, and an agent writing prose about OAuth is not an agent whose
    // OAuth failed. But `reason` is not scoped to THIS turn either: it is
    // `connection.stderrTail()` (below) or the adapter's JSON-RPC error, and
    // `stderrTail()` accumulates for the connection's whole lifetime with no
    // per-turn reset (`acp.ts`'s `stderr` buffer is never cleared between
    // turns). So an adapter that wrote an auth-shaped line to stderr during
    // an EARLIER turn that succeeded can still have that line in the tail
    // when a later, unrelated turn fails — a false positive that takes a
    // working agent off the page for `DEMOTION_HOLD_SECONDS`. Narrowing the
    // tail to the current turn would close this; nothing here does that.
    if (state === "failed" && reason !== undefined) {
      const failed = isolationFor(options.agent)?.auth.failed;
      if (failed?.(reason) === true) recordDemotion(options.agent, reason);
    }
    abandonCards();
    for (const entry of steps.values()) {
      emitStep(
        state === "completed" && entry.decision === "pending"
          ? { ...entry, decision: "ran" }
          : entry,
      );
    }
    onEvent({
      event: "completed",
      state:
        state === "failed"
          ? { state: "failed", reason: reason ?? "the turn failed" }
          : state === "cancelled"
            ? { state: "cancelled", ...(unacknowledged ? { unacknowledged: true } : {}) }
            : { state: "completed" },
    });
  };

  /** Stops the current turn: told to the adapter over `session/cancel`, and
   *  every card still open settled as abandoned rather than left waiting on a
   *  decision the turn will never reach. The one body behind both a decision
   *  of `{ action: "cancel" }` and a direct `cancel()` call — the two ways a
   *  turn actually gets stopped over the wire. Also arms this turn's grace
   *  timer (unless one is already running, or the turn has already ended) —
   *  see `finish`'s own `unacknowledged` branch for what happens if it runs
   *  out before the adapter confirms. */
  const cancelTurn = (): void => {
    connection.notify("session/cancel", { sessionId });
    abandonCards();
    if (settled || graceTimer !== undefined) return;
    const forEpoch = epoch;
    graceTimer = setTimeout(() => {
      graceTimer = undefined;
      finish(forEpoch, "cancelled", undefined, true);
    }, cancelGraceMs);
    graceTimer.unref?.();
  };

  const claimKernelCall = (source: string): string | undefined => {
    const open = [...steps.values()].filter(
      (entry) =>
        !claimedKernelCalls.has(entry.toolUseId) &&
        entry.decision !== "denied" &&
        entry.decision !== "cancelled",
    );
    const claim = (entry: ExecutionLogEntry): string => {
      claimedKernelCalls.add(entry.toolUseId);
      return entry.toolUseId;
    };
    for (const entry of open)
      if (isRecord(entry.input) && entry.input.code === source) return claim(entry);
    for (const entry of open)
      if (
        isRecord(entry.input) &&
        typeof entry.input.command === "string" &&
        entry.input.command.length > 0 &&
        source.includes(entry.input.command)
      )
        return claim(entry);
    const pending = open.filter(
      (entry) => entry.decision === "pending" && (entry.title ?? "").includes(KERNEL_SERVER_NAME),
    );
    return pending.length === 1 && pending[0] !== undefined ? claim(pending[0]) : undefined;
  };

  return {
    prompt(body) {
      const myEpoch = ++epoch;
      pendingRequests.add(myEpoch);
      text = "";
      thinking = "";
      lastVisibleUpdate = undefined;
      steps.clear();
      publishedStepFingerprints.clear();
      claimedKernelCalls.clear();
      // No grace timer can still be pending here: `completed` — the
      // caller's own signal that it may call `prompt` again — is only ever
      // fired from inside `finish`, which always clears one first.
      settled = false;
      onEvent({ event: "state", state: { state: "planning" } });
      void connection
        .request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: body }],
        })
        .then(
          (result) => {
            pendingRequests.delete(myEpoch);
            const stopReason = (result as { stopReason?: string } | undefined)?.stopReason;
            if (
              myEpoch === epoch &&
              stopReason !== "cancelled" &&
              lastVisibleUpdate === "text"
            )
              onEvent({ event: "assistant-text-final" });
            finish(myEpoch, stopReason === "cancelled" ? "cancelled" : "completed");
          },
          (err: unknown) => {
            pendingRequests.delete(myEpoch);
            const tail = connection.stderrTail().trim();
            finish(myEpoch, "failed", tail || (err instanceof Error ? err.message : String(err)));
          },
        );
    },
    async askPermission(access, tool, detail) {
      const request: PermissionRequest = {
        // From the same counter every relayed card is numbered off, so one
        // session has one id space: a decision names a request id and
        // nothing else, and two cards that could share one would settle
        // each other's.
        id: `pr_${nextRequest++}`,
        access,
        tool,
        ...(detail === undefined ? {} : { detail }),
      };
      // The same guard the ACP raise site applies, for the same reason and
      // not because this caller is likely to hit it: a card raised in the gap
      // between one turn's grace-triggered ending and the next turn's
      // `prompt()` would be published into a run that has already emitted its
      // terminal frame, and answered by a researcher who is looking at a
      // different turn.
      //
      // Refused without writing a step, which is where this differs from the
      // ACP path deliberately. That one writes one because an adapter that
      // reports the refused call afterwards sends a `tool_call_update` under
      // the same id, and the merge reads `steps` to decide what the call's
      // decision was — a row that is not there is a row that update turns
      // into "it ran". Nothing is coming for this id: there is no adapter
      // call behind this card, and no live run for the frame to travel on
      // either. What the caller does with `allowed: false` is the whole of the
      // disclosure here.
      if (settled || hasStaleOutstanding()) return { allowed: false };
      // The same question asked again if this card ever reaches the head of
      // the queue: a sibling raised in the same batch can be answered "for
      // this conversation" while this one is still waiting, and the answer
      // covers this card exactly as it would have had it arrived first.
      const verdict = await gated(
        request,
        () =>
          access.kind === "environment" && environmentGrants.has(access.target.name)
            ? "allowed-conversation"
            : undefined,
        // Its own request id, not the tool's name: there is no adapter call
        // behind this card for a row to be shared with, and the name is the
        // same string for every environment decision in the turn. See
        // `recordDecision`.
        request.id,
      );
      // Read and cleared whichever way this went, so nothing can read one
      // researcher's answer twice and nothing accumulates for a card that was
      // denied or abandoned. Absent for a card `publishGate` drained against
      // a grant that already existed — that answer is already standing, and
      // re-adding it is not what `remember` is for.
      const scope = answeredScopes.get(request.id);
      answeredScopes.delete(request.id);
      if (verdict !== "allow") return { allowed: false };
      return {
        allowed: true,
        // What this card was answered with, for the caller to carry to the
        // lab beside the act itself. `once` for a card nobody answered —
        // drained against a grant that already stands, and therefore already
        // durable. `study` and `global` cannot arrive: `decide` refuses an
        // environment card answered with either, so this never resolves
        // `allow` holding one.
        scope: scope === "conversation" ? "conversation" : "once",
        // The whole of what "for this conversation" means on an environment
        // card, held until the caller says the act actually happened. See
        // `Answered`. `once` leaves nothing behind, which is what makes this
        // a no-op there rather than a branch the caller has to write.
        remember: () => {
          if (access.kind === "environment" && scope === "conversation")
            environmentGrants.add(access.target.name);
        },
      };
    },
    decide(decision) {
      if (decision.action === "cancel") {
        cancelTurn();
        return;
      }
      if (decision.action !== "permission") return;
      const resolve = waiting.get(decision.requestId);
      if (!resolve) return;
      waiting.delete(decision.requestId);
      const card = cards.get(decision.requestId);
      const logKey = logKeys.get(decision.requestId);
      cards.delete(decision.requestId);
      coverage.delete(decision.requestId);
      logKeys.delete(decision.requestId);
      // Counted whichever way this card goes. The counter names the
      // researcher's place in the batch, and a denial is as much a decision
      // made as an allowance.
      settledInGate += 1;

      if (decision.decision.decision === "deny") {
        if (card && logKey !== undefined) emitStep(recordDecision(logKey, card, "denied"));
        publishGate();
        resolve("reject");
        return;
      }
      const scope = decision.decision.scope;
      // An environment card takes `once` and `conversation` and nothing
      // wider. The surface offers only those two — and the surface is not a
      // guard: a decision arrives over the wire, from a browser this end
      // does not control, so which scopes a card was SHOWN with is not
      // something to take a client's word for. Refused by name, the way
      // `global` already is below, because a researcher told "for this
      // Study" and given "this call only" would believe the wrong thing.
      if (card?.access.kind === "environment" && (scope === "study" || scope === "global")) {
        if (logKey !== undefined)
          emitStep(
            recordDecision(
              logKey,
              card,
              "denied",
              "an environment change is not something to remember beyond this conversation — allow it once, or for this conversation",
            ),
          );
        publishGate();
        resolve("reject");
        return;
      }
      if (scope === "global") {
        // Refused by name rather than quietly narrowed: a researcher told
        // "always" and given "this session" would believe the wrong thing.
        if (card && logKey !== undefined)
          emitStep(
            recordDecision(
              logKey,
              card,
              "denied",
              "a grant for every Study needs the lab's grant store, which this lab does not have yet",
            ),
          );
        publishGate();
        resolve("reject");
        return;
      }
      const grant = card ? grantFrom(card) : undefined;
      if (grant && scope === "conversation") sessionGrants.push(grant);
      if (grant && scope === "study") onGrant(grant);
      // What the researcher answered WITH, handed back to whoever raised this
      // card rather than acted on here. An environment card's "for this
      // conversation" is a standing grant over a name, and `decide` runs at
      // the moment the researcher answers — before the act the card was about
      // has been attempted, and therefore before anybody knows whether it
      // happened. A create that then fails on a name collision would leave a
      // grant over a COLLEAGUE'S environment that no card ever asked about.
      // So this records the answer and `askPermission` hands it to the caller
      // as `remember`, which is called once the act has landed. See
      // `Answered`.
      //
      // The two lines above are a different case and stay here: an ACP card's
      // grant is a path and a mode, the act behind it is the adapter's own
      // tool call, and this end never learns whether that call succeeded.
      answeredScopes.set(decision.requestId, scope);
      if (card && logKey !== undefined)
        emitStep(
          recordDecision(
            logKey,
            card,
            scope === "once"
              ? "allowed-once"
              : scope === "conversation"
                ? "allowed-conversation"
                : "allowed-study",
          ),
        );
      publishGate();
      resolve("allow");
    },
    cancel() {
      cancelTurn();
    },
    close() {
      abandonCards();
      return connection.close();
    },
    claimKernelCall,
    boundary: boundaryOf(policy),
    stderrTail() {
      return connection.stderrTail();
    },
  };
}
