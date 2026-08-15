import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import type { AgentCli, AgentOption } from "@lykeion/api";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { connectAcp } from "./acp";
import { confinementFor } from "./agent-home";
import { confine, noBackendReason, policyFor, sandboxBackendFor } from "./sandbox";
import { readAdvertised } from "./agent-options";
import { sessionMetaFor } from "./session";
import { confinedEnv } from "./confined-env";
import {
  CATALOGUE,
  entryFor,
  isolationFor,
  type AdapterLaunch,
  type AdapterProvenance,
} from "./agent-registry";
import { agentAuthStates, confinedRunCommand, type AgentAuth } from "./agent-auth";
import { gatesOffering, provesRedirect, type RedirectState } from "./redirect";
import { acceptedAdapters, consentKey } from "./adapter-consent";
import { resolveOnPath } from "./command-path";
import { isDemoted } from "./agent-demotions";

export { CATALOGUE } from "./agent-registry";

/**
 * What a probe of this machine can say about a catalogue entry, before it is
 * attached to a particular runtime record. The daemon fills in `runtimeId`
 * once it knows which machine it is pairing as; probing itself has no
 * opinion on that.
 */
export type ProbedCli = Omit<AgentCli, "runtimeId">;

/**
 * How long a command is given to answer `--version`. Ten seconds is far more
 * than a program needs to print a string, and deliberately so: a probe runs
 * once every five minutes, nothing waits on its answer, and the commands
 * being asked are routinely a version-manager shim, a launcher script, or a
 * runtime starting cold — several seconds of real work before the version is
 * printed. A budget set close to what a working command actually takes turns
 * every probe into a race, and a race is decided by how loaded the machine
 * is rather than by what is installed on it.
 *
 * It is still a budget. A command that has hung answers nothing, and the
 * probe that asked it goes on without it rather than waiting forever; a
 * daemon that has been asked to stop takes its probes back through `signal`
 * without waiting this out at all.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ProbeOptions {
  /** PATH to search, colon/semicolon-separated. Defaults to the process's own. */
  path?: string;
  /** How long a `--version` call is given to answer before the probe gives up
   *  on hearing one. */
  timeoutMs?: number;
  /** Takes the probe back. Every catalogued command is allowed the version
   *  budget to answer, and that is time a daemon which has been asked to stop
   *  would otherwise spend waiting on programs it no longer cares about. */
  signal?: AbortSignal;
  /** Receives the exact launch spec whose successful handshake made an agent
   *  ready — resolved path and declared arguments together — so session launch
   *  starts that program rather than one reassembled from its name. */
  onAdapterResolved?: (agentId: string, launch: AdapterLaunch) => void;
  /** The platform whose sandbox backend would confine a session here.
   *  Production passes none and this machine's own platform is used. */
  platform?: string;
  /** Where this machine keeps its own state. Required, because a probe runs
   *  the researcher's own agent CLI and confines it the way a session is
   *  confined — and it can only deny this machine's own token if it is told
   *  where that is. */
  dataDir: string;
  /** Who each declared agent is signed in as, on this machine. Defaults to
   *  asking every agent's own CLI (`agentAuthStates`, which confines that CLI
   *  the way this file's own `readVersion` confines a `--version` call — see
   *  `agent-auth.ts`), called at most once per cycle rather than once per
   *  catalogue entry that needs it — every `probeAdapter` call below reads
   *  the same in-flight answer instead of re-asking a question this cycle
   *  already asked — and not called at all in a cycle where no entry's
   *  adapter ever resolves. Injectable for the same reason `path` is — a
   *  probe under test must not shell out to whatever the process's real
   *  `PATH` happens to resolve `claude`/`codex` to, which is a different
   *  program than the fixture the test built. */
  authStates?: () => Promise<AgentAuth[]>;
}

/**
 * The first line of an answer with anything on it. A CLI that opens its
 * version output with a blank line, or clears the screen before printing,
 * still said what it was asked; taking line zero regardless would read that
 * as having said nothing.
 */
function firstSpokenLine(output: string): string {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** A directory a confined probe works in, and the one directory it may
 *  write. Removed again whichever way the probe went. */
function throwawayWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "lykeion-probe-"));
}

/**
 * Runs an already-confined command in `workspace` and always removes it
 * afterwards, whichever way the run went. The one place this file spawns
 * anything: `readVersion` — which wants only the build a catalogued CLI
 * printed — and `runConfined` — whose caller wants to know whether the
 * command answered at all — both settle here rather than each owning an
 * `execFile` call of their own.
 */
function execConfined(
  confined: { command: string; args: string[] },
  workspace: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      confined.command,
      confined.args,
      // In the directory the boundary was rendered for. Without this the
      // child inherits whichever directory this daemon happens to have been
      // started in, which the profile does not allow — and a program that
      // cannot reach its own working directory does not get as far as
      // printing anything, so every run reads as unknown.
      { timeout: timeoutMs, signal, cwd: workspace },
      (error, stdout, stderr) => {
        rmSync(workspace, { recursive: true, force: true });
        resolvePromise({ ok: !error, stdout, stderr });
      },
    );
  });
}

/**
 * Asks a resolved executable which build it is, and answers with what it
 * said — or the empty string, when it said nothing usable. Always an
 * argument array, never a shell string: a catalogue command name that
 * happened to contain shell syntax must not gain any meaning from it.
 *
 * Both streams are read, because a good number of command-line programs
 * answer `--version` on the error stream and exit zero; refusing to look
 * there would leave a working tool's build unread.
 *
 * A rejection, a non-zero exit and a timeout are one fact from here: this
 * machine could not be told which build it has. That is all they are. None
 * of them says the command is missing — the file was found and run, which is
 * the only thing "installed" ever meant — so none of them is reported that
 * way.
 */
function readVersion(
  resolved: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  platform: string,
  dataDir: string,
  agent: string,
): Promise<string> {
  // Asking a program what it is means running it, and it is the
  // researcher's agent CLI — the same code a turn drives. It is confined
  // exactly as a session is, so nothing about a probe is a way around the
  // boundary.
  const workspace = throwawayWorkspace();
  const confined = confine(
    platform,
    policyFor({ workspace, grants: [], dataDir, ...confinementFor(agent, workspace) }),
    { command: resolved, args: ["--version"] },
  );
  return execConfined(confined, workspace, timeoutMs, signal).then(({ ok, stdout, stderr }) =>
    ok ? firstSpokenLine(stdout) || firstSpokenLine(stderr) : "",
  );
}

/** An id no catalogue entry uses — never shown to anybody, only ever compared
 *  against `CATALOGUE`. What `confinementFor` is given to render a boundary
 *  for a command that belongs to no agent's own installation: it hands back
 *  `NO_AGENT_HOME` for what the run owns, and every agent's own home plus
 *  every researcher installation this machine knows of for what it may not
 *  touch — the same posture an agent's own `--version` check gets, for a
 *  command that is nobody's CLI. */
const NO_AGENT = "lykeion:no-agent";

/**
 * Runs `command` inside this machine's own boundary and reports back
 * whether it could be run at all, plus whatever it printed on each stream.
 *
 * Resolution and confinement are asked in the order `probeCliVersion` asks
 * them, and for the same reason. A command missing from `PATH` never reaches
 * a `confine()` call at all — `ok` false, both streams empty, nothing spent
 * rendering a policy for a program that is not there. A command this
 * platform has no sandbox backend to confine is reported found rather than
 * run — `ok` true, both streams empty — because a platform with no backend
 * decides whether a program can be CONFINED, never whether it exists.
 *
 * The one confined spawner this file owns for a command belonging to no
 * particular agent. `probeKernelFloor` calls this rather than composing its
 * own `execFile` + `confine()`, which is what keeps the `cwd` fix from
 * `159d0f2` — passing the boundary the directory it was actually rendered
 * for — from needing to be made a second time.
 */
export async function runConfined(
  command: string,
  args: string[],
  opts: {
    dataDir: string;
    path?: string;
    platform?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const pathValue = opts.path ?? process.env.PATH ?? "";
  const resolved = await resolveOnPath(command, pathValue);
  if (resolved === undefined) return { ok: false, stdout: "", stderr: "" };
  const platform = opts.platform ?? process.platform;
  if (sandboxBackendFor(platform) === undefined) return { ok: true, stdout: "", stderr: "" };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const workspace = throwawayWorkspace();
  const confined = confine(
    platform,
    policyFor({ workspace, grants: [], dataDir: opts.dataDir, ...confinementFor(NO_AGENT, workspace) }),
    { command: resolved, args },
  );
  return execConfined(confined, workspace, timeoutMs, opts.signal);
}

/**
 * Whether the command resolves on `PATH` to a file this machine can run, and
 * which build it is when it does.
 *
 * Whether the command resolves at all is what `available` reports, and it is
 * the whole of what it reports. A search of `PATH` either finds such a file
 * or does not; there is no clock on it and nothing to lose a race to.
 *
 * Which build that file is, is the second question, and asking it means
 * running a program that answers on its own schedule. A command that will
 * not say — because it printed nothing, failed, or was still starting when
 * the budget ran out — leaves the build unknown, and an unknown build is
 * reported as the empty string beside an available command. That is a
 * narrower claim than a version, and a true one: a screen showing it says
 * the tool is there and its build is unknown, which is exactly what was
 * observed. Calling the command missing instead would report an absence
 * nobody saw, on a machine where a researcher can run the thing by typing
 * its name.
 */
async function probeCliVersion(
  command: string,
  pathValue: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  platform: string,
  dataDir: string,
  agent: string,
): Promise<{ available: boolean; version: string }> {
  const resolved = await resolveOnPath(command, pathValue);
  if (resolved === undefined) return { available: false, version: "" };
  // Found by looking, not by running: a machine whose platform has no
  // backend cannot confine this program, so it is never executed. The CLI
  // is still reported as installed, with its build unknown — a narrower
  // claim than a version, and a true one.
  if (sandboxBackendFor(platform) === undefined) return { available: true, version: "" };
  return {
    available: true,
    version: await readVersion(resolved, timeoutMs, signal, platform, dataDir, agent),
  };
}

/** The budget ran out, as its own type rather than as a message to match on.
 *  A caller has to tell "the adapter is alive and has said nothing" apart
 *  from "the adapter died", because those are different things to tell a
 *  researcher — and a rejection that only differs by its wording is one a
 *  later edit to that wording silently reclassifies. */
class ProbeTimeout extends Error {}

/** Whatever `promise` settles to, unless `timeoutMs` passes or `signal`
 *  fires first. A probe's own clock, not the adapter's: an `initialize` a
 *  real adapter never answers must not hold the probe cycle open the way it
 *  would hold a researcher who actually needs the session — this is what
 *  keeps that from happening. `signal` firing and the timer firing are told
 *  apart in the rejection so a caller never mistakes an operator's stop for
 *  the adapter simply running out of time. */
function raced<T>(promise: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rejectPromise(new ProbeTimeout(`did not answer within ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        rejectPromise(err);
      },
    );
  });
}

/**
 * What a researcher is told about an agent that is installed, bridged, and
 * not signed in.
 *
 * No command in it. The daemon runs the sign-in itself, from the pairing page
 * where this is meant to be met; this string is the fallback surface, for
 * whoever skipped that step or whose token lapsed months later. An
 * instruction here would be a second way to do the same thing, and the two
 * would drift.
 */
export function signedOutReasonFor(agentId: string): string | undefined {
  const entry = entryFor(agentId);
  if (entry?.isolation === undefined) return undefined;
  return `${entry.name} is not signed in on this machine — open Lykeion's setup page to sign in`;
}

/** The `initialize` handshake ACP opens with, the same shape `session.ts`
 *  sends when it opens a real session — a probe asking the same question a
 *  session start would, so `sessionReady` never claims more than a session
 *  start could actually cash in. */
const INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
};

/**
 * The first declared adapter this machine actually has, as the spec it will be
 * started with: the path it resolved to, and the arguments its row declared.
 *
 * Built once, here, so that the spec the boundary is rendered against, the spec
 * that handshakes, and the spec a later run is launched with are one object
 * rather than three separate agreements about what the adapter was called.
 */
export async function resolveLaunch(
  declared: readonly AdapterLaunch[],
  pathValue: string,
): Promise<AdapterLaunch | undefined> {
  for (const candidate of declared) {
    const found = await resolveOnPath(candidate.command, pathValue);
    if (found !== undefined) return { ...candidate, command: found, args: [...candidate.args] };
  }
  return undefined;
}

/**
 * What to tell a researcher whose declared agent has no adapter on this
 * machine.
 *
 * Two sentences, because there are two situations. An adapter that is a
 * separate program is something to go and install. An adapter that IS the CLI
 * under a flag is not — naming a bridge there describes a program nobody
 * publishes, and sends someone looking for it.
 *
 * Decided from what the row states, never from which agent it is: a row whose
 * adapter command is its own command is a CLI that speaks ACP itself, and that
 * is a fact about the declaration rather than about the name on it.
 */
export function adapterMissingReason(
  entry: { id: string; name: string; command: string },
  declared: readonly AdapterLaunch[],
): string {
  if (declared.some((launch) => launch.command === entry.command))
    return `install ${entry.name} to run ${entry.name} sessions`;
  return `none of ${declared.map((a) => a.command).join(", ")} is installed — install an ACP adapter to run ${entry.name} sessions`;
}

/**
 * Why this adapter may not be started yet, or nothing if it may.
 *
 * A `community` adapter is one nobody official stands behind, and where it
 * runs is what makes that matter: inside the boundary, with read and write on
 * this agent's own home — which holds the credential it signed in with — and
 * with `(allow network-outbound)` unrestricted, because the agent has to
 * reach its vendor. So the sentence names both of those, rather than saying
 * "third-party" and leaving the researcher to agree to something nobody
 * described to them.
 *
 * `declared` is the command the ROW names, never the path it resolved to: a
 * researcher accepts a program, and where it happens to sit on this machine
 * is an installation detail that changes without the program changing.
 *
 * Takes the accepted set rather than reading it, so the decision is a
 * function of its inputs and needs no directory to test.
 */
export function consentGap(
  entry: { id: string; name: string },
  declared: AdapterLaunch,
  accepted: ReadonlySet<string>,
): string | undefined {
  if (declared.provenance !== "community") return undefined;
  if (accepted.has(consentKey(entry.id, declared.command))) return undefined;
  return `${declared.command} is published by neither ${entry.name}'s vendor nor the ACP project, and runs with ${entry.name}'s sign-in and network access — accept it once to run ${entry.name} sessions`;
}

/**
 * Every agent the catalogue knows, and whether its CLI is on this PATH.
 *
 * The roster, not the interrogation. `agentAuthStates` answers for the agents
 * that have an isolation declaration, because only those have a confined home
 * to ask a sign-in question from — two entries out of twelve. That is the
 * right list for that question and the wrong list for a screen, and the two
 * were the same list: the first run counted the agents it could ask about
 * while the workbench a moment later counted the whole catalogue, about the
 * same computer.
 *
 * Availability comes from a PATH lookup rather than from running each command
 * with `--version`, the way `probeAgentClis` does. This answers a route a page
 * polls; twelve spawns per poll is not a price a list is worth.
 */
export interface AgentOnThisMachine {
  agent: string;
  name: string;
  available: boolean;
}

export async function catalogueOnThisMachine(pathValue: string): Promise<AgentOnThisMachine[]> {
  return Promise.all(
    CATALOGUE.map(async (entry) => ({
      agent: entry.id,
      name: entry.name,
      available: (await resolveOnPath(entry.command, pathValue)) !== undefined,
    })),
  );
}

/**
 * What one agent's adapter is on THIS machine, for the page that asks a
 * researcher to decide about it.
 *
 * Answered without spawning anything: a PATH lookup and one file read. That
 * matters because it is asked from a route a browser polls, and the ladder in
 * `probeAdapter` — which knows all of this already — costs a confined
 * subprocess and an ACP handshake to reach the same three fields.
 *
 * Every field is absent rather than defaulted where nothing is known. A page
 * that could not tell "no adapter here" from "an adapter nobody has agreed
 * to" would ask about a program that is not on the machine.
 */
export interface AdapterOnThisMachine {
  /** The bare name a catalogue row declares, never a path. */
  adapterCommand?: string;
  /** Where that name resolved. The same name can be several programs. */
  adapterPath?: string;
  /** Whether a decision is outstanding. Absent when no adapter resolved, so
   *  there is nothing yet to decide about. */
  consentNeeded?: boolean;
}

export async function adapterOnThisMachine(
  agentId: string,
  pathValue: string,
  dataDir: string,
): Promise<AdapterOnThisMachine> {
  const entry = entryFor(agentId);
  const declared = isolationFor(agentId)?.adapters;
  if (entry === undefined || declared === undefined) return {};
  const launch = await resolveLaunch(declared, pathValue);
  if (launch === undefined) return {};
  // The same file-name match `probeAdapter` makes, and for the same reason: a
  // declared `agy-acp` is a suffix of a resolved `/opt/bin/my-agy-acp`, and
  // an acceptance recorded against the wrong one accepts a different program.
  const declaredAdapter = declared.find((a) => basename(launch.command) === a.command) ?? launch;
  return {
    adapterCommand: declaredAdapter.command,
    adapterPath: launch.command,
    consentNeeded: consentGap(entry, declaredAdapter, acceptedAdapters(dataDir)) !== undefined,
  };
}

/**
 * What one entry's rungs settled, split into the verdict and the facts that
 * ride alongside it.
 *
 * The verdict stays a discriminated union, so "ready, and here is why it is
 * not" remains unrepresentable. The facts are separate because they are not
 * the verdict: an agent that is signed out and an agent whose isolation could
 * not be demonstrated both fail, and a row has to tell them apart to know
 * whether there is anything a person could do about it.
 */
type AdapterFacts = {
  /** Set when, and only when, a rung actually asked. See `AgentCli.signedIn`
   *  — absent and `false` are different answers all the way down. */
  signedIn?: boolean;
  account?: string;
  heldBackReason?: string;
  adapterProvenance?: AdapterProvenance;
};

type AdapterOutcome = AdapterFacts &
  ({ sessionReady: true; options?: AgentOption[] } | { sessionReady: false; sessionReadyReason: string });

/**
 * What a row says to the researcher when rung 5 holds it back, as opposed to
 * what it says to a log.
 *
 * `sessionReadyReason` names the environment variable and the row that
 * declared it, which is what somebody debugging a catalogue entry needs.
 * Neither of these sentences does, because neither of these is a problem the
 * researcher can solve: what they need to know is that Lykeion will not run
 * this agent and why that is not negligence. Written here rather than in the
 * page that shows them, because the daemon is the only thing that knows
 * which of the two happened.
 */
function heldBackByRungFive(state: RedirectState): string | undefined {
  if (state === "redirect-broken")
    return "answered as signed in from a home created empty a moment ago, so Lykeion cannot keep its runs separate from yours";
  if (state === "not-understood")
    return "answered in a way this machine could not read, so nothing was shown either way";
  return undefined;
}

/**
 * Whether `agentId` can actually be run: its adapter resolved on `PATH` and
 * answered `initialize` inside the probe's own budget. An id with no adapter
 * mapping is settled without spawning anything — there is nothing to look
 * for. Otherwise the adapter is spawned, asked, and always closed again
 * before this returns, whichever way the handshake went — a probe that
 * leaves an adapter process behind on every cycle would leak one every five
 * minutes, forever, for a machine that only ever finds the same answer.
 */
async function probeAdapter(
  agentId: string,
  pathValue: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onResolved: ((agentId: string, launch: AdapterLaunch) => void) | undefined,
  platform: string,
  dataDir: string,
  authStates: () => Promise<AgentAuth[]>,
  /** This CLI's own build, for rung 5's cache key. A redirect proof cannot
   *  change without the program changing, and an upgrade IS the program
   *  changing — so the key carries what was upgraded.
   *
   *  Taken as the PROMISE rather than the value, and awaited only at the rung
   *  that needs it. `probeOne` deliberately asks its two questions at once so
   *  an entry with both to check costs the slower rather than the sum;
   *  awaiting a version here to build a key would quietly turn that back into
   *  a sum, on every entry, forever. */
  cliVersion: Promise<{ available: boolean; version: string }>,
): Promise<AdapterOutcome> {
  // Asked before anything is looked for. A machine whose platform has no
  // sandbox backend cannot confine a run, and no agent is offered on it —
  // an agent that is never offered is the whole of how "never launch an
  // unsandboxed run" is kept before a run is even asked for.
  if (sandboxBackendFor(platform) === undefined)
    return { sessionReady: false, sessionReadyReason: noBackendReason(platform) };

  const entry = entryFor(agentId);
  const adapterCommands = isolationFor(agentId)?.adapters;
  if (adapterCommands === undefined)
    return {
      sessionReady: false,
      // Nothing here for the researcher to do. What is missing is this
      // daemon's own declaration row, and no amount of installing supplies
      // one — an earlier wording sent them off to find an ACP adapter, which
      // for at least one catalogue entry meant hunting a product whose vendor
      // had already switched it off.
      sessionReadyReason: `Lykeion cannot run ${entry?.name ?? agentId} yet`,
    };

  const launch = await resolveLaunch(adapterCommands, pathValue);
  if (launch === undefined)
    return {
      sessionReady: false,
      sessionReadyReason:
        entry === undefined
          ? `no adapter for ${agentId} is installed`
          : adapterMissingReason(entry, adapterCommands),
    };

  // Matched on the file name rather than on how the path ends: a declared
  // `agy-acp` is a suffix of a resolved `/opt/bin/my-agy-acp`, and the two are
  // different programs whose acceptances must not be confused.
  //
  // Resolved here rather than at rung 6, which is where it used to be looked
  // up, because who published this adapter is a fact about the machine from
  // the moment one is found — and a row held back at rung 5 still has to say
  // whose program it was going to run.
  const declaredAdapter =
    adapterCommands.find((a) => basename(launch.command) === a.command) ?? launch;
  const facts: AdapterFacts = { adapterProvenance: declaredAdapter.provenance };

  // Rung 5. The row SAYS `homeEnv` moves this CLI's configuration somewhere
  // we own; this is where that stops being a claim. A declaration that is
  // wrong here fails silently in the worst possible way — every run reads the
  // researcher's own installation while every other rung stays green — so it
  // is demonstrated before an adapter is ever started.
  //
  // Placed after the adapter resolves so a machine without one never pays for
  // it, and before rung 7 spawns anything, so a row whose isolation is
  // unproven starts no adapter at all. Confined exactly as the sign-in check
  // confines the same command: this runs the researcher's own CLI, and a
  // probe is not a reason to drop the boundary.
  if (entry !== undefined) {
    const { available, version } = await cliVersion;
    // A machine with the bridge installed but not the CLI it bridges to is an
    // ordinary mistake, and it is not an isolation failure. Asking a command
    // that is not there produces the same "did not answer" as a wedged one,
    // which would send that researcher looking for a problem with their
    // configuration instead of at the thing they have not installed. Rung 7's
    // own auth check already refuses to conflate these two; so does this.
    if (!available)
      return { sessionReady: false, sessionReadyReason: `${entry.name} is not installed on this machine` };
    const proof = await provesRedirect(
      entry,
      `${entry.command}@${version}`,
      confinedRunCommand({
        dataDir,
        platform,
        path: pathValue,
        timeoutMs,
        // Nothing to clear here any more. `confinedRunCommand` builds this
        // child's environment from the allowlist rather than from whatever
        // this daemon inherited, so a CLI that reads its sign-in out of an
        // ambient variable no longer answers the same from every home — the
        // variable is not there to read. The rung-5/rung-7 asymmetry this
        // field existed to patch went with it: both questions are now asked
        // in the same environment.
      }),
    );
    if (gatesOffering(proof)) {
      const heldBack = heldBackByRungFive(proof.state);
      return {
        ...facts,
        sessionReady: false,
        sessionReadyReason: proof.reason ?? "isolation unverified",
        ...(heldBack === undefined ? {} : { heldBackReason: heldBack }),
      };
    }
  }

  // Rung 6. A community adapter is not started until the researcher has said
  // it may, once, for this agent. Reported as an ACTION rather than an error:
  // the sentence is what the page turns into a prompt, and an agent waiting on
  // a person is not the same thing as one that cannot run.
  //
  // Keyed by the DECLARED command rather than `launch.command`, which is the
  // absolute path this machine happened to resolve — an acceptance recorded
  // against a path would silently lapse the next time the adapter moved.
  if (entry !== undefined) {
    const gap = consentGap(entry, declaredAdapter, acceptedAdapters(dataDir));
    if (gap !== undefined) return { ...facts, sessionReady: false, sessionReadyReason: gap };
  }

  // Rung 7. Asked before anything is spawned: an adapter started against an
  // installation with no sign-in opens a session that answers every turn by
  // reporting itself signed out, which reaches a researcher as an agent that
  // is broken rather than one that needs a minute of their time. Only
  // reached once some catalogue entry's own adapter has actually resolved —
  // a cycle where nothing resolves never asks a CLI this at all — and
  // `authStates` memoizes its own first call, so two entries that both reach
  // this share one round trip through every declared agent's CLI rather than
  // each starting a fresh one.
  const authState = (await authStates()).find((state) => state.agent === agentId);
  // Recorded from here on, and only from here: this is the first rung that
  // actually asks. A row that never got this far reports no answer rather
  // than a `false` that would put a Sign in control on a machine where
  // signing in changes nothing.
  if (authState !== undefined) {
    facts.signedIn = authState.signedIn;
    if (authState.account !== undefined) facts.account = authState.account;
  }
  if (authState !== undefined && !authState.signedIn)
    return {
      ...facts,
      sessionReady: false,
      sessionReadyReason: signedOutReasonFor(agentId) ?? "not signed in",
    };

  // Confined exactly as a real session is. A probe that opens a session
  // opens one an agent could act in, and "never launch an unsandboxed run"
  // is not a rule about which caller asked — and the same goes for the
  // isolation a real session carries: the per-agent adapter env rides the
  // spawn here just as it does in `startSession`.
  const workspace = throwawayWorkspace();
  const confined = confine(
    platform,
    policyFor({ workspace, grants: [], dataDir, ...confinementFor(agentId, workspace) }),
    { command: launch.command, args: [...launch.args] },
  );
  const connection = await connectAcp(confined.command, confined.args, {
    cwd: workspace,
    env: confinedEnv(agentId),
  });
  // A throwaway session, opened and closed on every path. Options are
  // advertised on `session/new` rather than on `initialize`, and a Task
  // holds no session until its first Send — so without this the picker would
  // be empty at exactly the moment a researcher wants it, choosing a model
  // BEFORE asking the first question. A probe cycle costs one more round
  // trip; the adapter is torn down either way.
  let sessionId: string | undefined;
  try {
    await raced(connection.request("initialize", INITIALIZE_PARAMS), timeoutMs, signal);
    onResolved?.(agentId, launch);
    let options: AgentOption[] | undefined;
    try {
      // A throwaway session is still a session the owner's registries could
      // leak into, so it carries the same `_meta` a real one does.
      const meta = await sessionMetaFor(agentId);
      const created = await raced(
        connection.request("session/new", {
          cwd: workspace,
          mcpServers: [],
          ...(meta === undefined ? {} : { _meta: meta }),
        }),
        timeoutMs,
        signal,
      );
      sessionId = (created as { sessionId?: string }).sessionId;
      options = readAdvertised(created).options;
    } catch {
      // An entitlement refusal, an unauthenticated CLI: the agent keeps the
      // `sessionReady` answer its handshake earned, and what it offers is
      // left UNKNOWN rather than reported as nothing.
      //
      // The next probe that gets a session is what fills it in — which is
      // why `cliFingerprint` counts the options. A real session reads the
      // same answer when a turn starts, but keeps it to itself: nothing on
      // the run path carries it back to the lab.
    }
    return { ...facts, sessionReady: true, ...(options === undefined ? {} : { options }) };
  } catch (err) {
    // An adapter fails in one of two ways, and they need different sentences.
    //
    // It can EXIT — a crash, a non-zero code, an ENOENT — or it can spawn and
    // then never speak: the process is alive, the handshake never lands, and
    // it stays that way forever. The second was observed rather than
    // imagined: a CLI's own ACP mode printed an entitlement refusal to stderr
    // and then held the connection open, so no exit code ever described it
    // and the budget above is the only thing that ends the wait.
    //
    // What it wrote on its way to saying nothing is worth more than anything
    // this file could compose, because it is the vendor's own account of why.
    const tail = connection.stderrTail().trim();
    if (tail) return { ...facts, sessionReady: false, sessionReadyReason: tail };

    // Silent, so there is nothing to quote. Only the budget running out earns
    // the sentence about the handshake — an adapter that EXITED has its own
    // error, and describing that as "started but never finished" would be a
    // plain lie about what happened.
    if (err instanceof ProbeTimeout)
      return {
        ...facts,
        sessionReady: false,
        sessionReadyReason: `${launch.command} started but never completed the ACP handshake within ${timeoutMs}ms`,
      };
    return {
      ...facts,
      sessionReady: false,
      sessionReadyReason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Closed on every path, including the failing ones: a probe that leaks a
    // session leaks one every cycle, forever.
    if (sessionId !== undefined) connection.notify("session/cancel", { sessionId });
    await connection.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** One catalogue entry, settled as two independent questions asked at once:
 *  whether the CLI itself is installed and which build it is, and whether a
 *  session can actually be started against it. Run concurrently rather than
 *  one after the other, so a catalogue entry with both to check never costs
 *  more than the slower of the two — not their sum. */
async function probeOne(
  entry: { id: string; name: string; command: string },
  pathValue: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onResolved: ((agentId: string, launch: AdapterLaunch) => void) | undefined,
  platform: string,
  dataDir: string,
  authStates: () => Promise<AgentAuth[]>,
): Promise<ProbedCli> {
  // Started, not awaited. Rung 5 needs the build to key its proof on, and
  // handing it the promise is what keeps these two questions concurrent —
  // awaiting the version here to pass a string would make every entry cost
  // the sum of both rather than the slower of them.
  const cliVersion = probeCliVersion(
    entry.command,
    pathValue,
    timeoutMs,
    signal,
    platform,
    dataDir,
    entry.id,
  );
  const [cli, adapter] = await Promise.all([
    cliVersion,
    probeAdapter(entry.id, pathValue, timeoutMs, signal, onResolved, platform, dataDir, authStates, cliVersion),
  ]);
  return { id: entry.id, name: entry.name, command: entry.command, ...cli, ...adapter };
}

/**
 * Probes every catalogued CLI concurrently and reports them back in
 * catalogue order, so the list a machine reports never depends on which
 * binary happened to answer first.
 */
export async function probeAgentClis(options: ProbeOptions): Promise<ProbedCli[]> {
  const pathValue = options.path ?? process.env.PATH ?? "";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const platform = options.platform ?? process.platform;
  // `agentAuthStates` confines and rate-bounds this itself by default — see
  // `agent-auth.ts` — so this only has to hand it the same clock and PATH the
  // rest of this cycle is already using.
  const defaultAuthStates = (): Promise<AgentAuth[]> =>
    agentAuthStates({ path: pathValue, timeoutMs, signal: options.signal, platform, dataDir: options.dataDir });
  // Not called here. A cycle where no catalogue entry's adapter ever resolves
  // must not pay for this at all — the researcher's own agent CLI is real,
  // and one that hangs and ignores its signal (see `probe.test.ts`'s
  // catalogue-command-that-ignores-cancellation case) would otherwise hold
  // this cycle's promise, and this process's exit, open behind a call
  // nothing downstream even needed. `probeAdapter` below calls this itself,
  // lazily, only an entry that reaches the rung actually asks — and the
  // memoization is what keeps two such entries in the same cycle from each
  // starting their own round trip through every declared agent's CLI.
  let auth: Promise<AgentAuth[]> | undefined;
  // Demotions are applied HERE rather than inside `defaultAuthStates`, and the
  // distinction is not cosmetic. A demotion is a fact about this machine's own
  // observed turn failures, not about which provider supplied the auth
  // answers, and this is the boundary where an answer becomes THIS cycle's
  // answer. Filtering only the default path would leave anything supplying
  // `options.authStates` — every test in `probe.test.ts` today, and whatever
  // reason a caller has for overriding it tomorrow — offering an agent whose
  // sign-in this daemon has already watched fail.
  //
  // A CLI answers rung 7 out of its own account metadata, which survives the
  // grant behind it being revoked. A turn that failed is the only evidence to
  // the contrary, so it wins until `DEMOTION_HOLD_SECONDS` elapses — set to
  // twice `main.ts`'s probe interval (which is itself derived from this
  // constant, see `agent-demotions.ts`), so a demotion recorded anywhere in a
  // cycle is guaranteed to still be read by the next one, not merely likely
  // to be. Once the window closes, the next cycle asks the CLI again, so a
  // researcher who signs back in is offered the agent without restarting
  // anything.
  const authStates = (): Promise<AgentAuth[]> =>
    (auth ??= (options.authStates ?? defaultAuthStates)().then((states) =>
      states.map((state) => (isDemoted(state.agent) ? { ...state, signedIn: false } : state)),
    ));
  return Promise.all(
    CATALOGUE.map((entry) =>
      probeOne(
        entry,
        pathValue,
        timeoutMs,
        options.signal,
        options.onAdapterResolved,
        platform,
        options.dataDir,
        authStates,
      ),
    ),
  );
}

/**
 * A probe's result, reduced to what two probes of the same machine are
 * judged identical on: which ids are present, at which version, whether
 * each is installed, whether each can actually run a session, and what each
 * said it offers. `id` alone is not enough — a version bump on a CLI that
 * was already known, one that has left PATH, or an adapter that starts or
 * stops answering, all leave the id set unchanged and still have to compare
 * as different. Sorted by id first, so probing the catalogue in a different
 * order never registers as a change on its own.
 *
 * The options belong here for a reason worth stating. A probe that reaches
 * an adapter but cannot open a throwaway session leaves them UNKNOWN rather
 * than reporting them as nothing (see `probeAdapter`) — an ordinary outcome
 * for a CLI that is installed but not signed in. Left out of this hash, the
 * successful probe five minutes later compared equal to the failed one and
 * was dropped, so the lab kept its "unknown" for the life of the daemon and
 * the composer offered a bare *Default* against an agent that had a whole
 * catalogue to give. Nothing else could correct it: a real session reads
 * what the agent advertises, but keeps it to itself.
 *
 * `sessionReadyReason` belongs here for the same kind of reason, and rung 6
 * is exactly the case that would otherwise go unseen: install an ACP
 * adapter for an agent that is not yet signed in, and `sessionReady` stays
 * false across that step while the reason moves from "no ACP adapter is
 * installed" to "not signed in". Every other field this hashes is unchanged,
 * so without the reason here that transition sends no report, and the dock
 * goes on telling a researcher to install an adapter they already have.
 *
 * `signedIn` and `account` are here because signing in is the one thing a
 * researcher does at this screen and then waits to see happen. On a machine
 * whose adapter is already resolved and ready, signing in changes these two
 * fields and nothing else — so left out, the probe that finally sees the new
 * account compares equal to the one before it, no report is sent, and the
 * screen goes on saying "signed out" beside a CLI that is not. Switching
 * accounts is the same shape with `signedIn` unchanged as well.
 */
export function cliFingerprint(clis: ProbedCli[]): string {
  return JSON.stringify(
    [...clis]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((cli) => [
        cli.id,
        cli.version,
        cli.available,
        cli.sessionReady,
        cli.sessionReadyReason,
        cli.options,
        cli.signedIn,
        cli.account,
        cli.heldBackReason,
        cli.adapterProvenance,
      ]),
  );
}

/** "{os}-{arch}", the form the contract's `Runtime.platform` uses. */
export function platformTag(): string {
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case "darwin-arm64":
      return "macos-aarch64";
    case "darwin-x64":
      return "macos-x86_64";
    case "linux-x64":
      return "linux-x86_64";
    case "linux-arm64":
      return "linux-aarch64";
    case "win32-x64":
      return "windows-x86_64";
    default:
      return key;
  }
}
