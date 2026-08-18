import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * The boundary an agent's tool calls execute inside, on the machine the
 * researcher runs. Nothing here spawns anything unconfined: a run whose
 * boundary cannot be established fails, naming why, and this machine stays
 * up so it remains manageable rather than disappearing from the lab with no
 * explanation.
 */

/** A folder a run may reach, and how far. */
export interface SandboxGrant {
  path: string;
  mode: "read" | "write";
}

/**
 * An agent's own installation: not the researcher's data, but the places the
 * program itself keeps its credentials, its configuration and its state.
 *
 * A boundary drawn around the researcher's data alone denies all of this, and
 * an agent that cannot read its own token or write its own state is not an
 * agent — it starts, it opens a session, and then it reports itself as signed
 * out. This is declared per agent rather than granted to every run, so one
 * agent's store is never opened for another.
 */
export interface AgentHome {
  /** Directories the agent owns outright: read and write. */
  state: string[];
  /** Stores this agent authenticates from. Read only — a run proves who it
   *  is, and never edits the record of who it is. */
  credentials: string[];
  /** Entries inside `state` that stay read-only. An agent reads its own
   *  configuration to run at all, but a write here outlives the run: what an
   *  agent leaves in its own settings is what the next, unconfined start of
   *  that program executes. */
  sealed: string[];
  /** Shapes of scratch files an agent's shell makes and removes around every
   *  command it runs — the working directory it reports back afterwards, and
   *  its like. They carry a fresh random name each time, so there is no path
   *  to grant, only a shape. Anchored regexes over already-resolved paths.
   *
   *  A command that succeeds and a shell that then cannot tidy up is a step
   *  drawn as failed over output that worked, which is worse than either
   *  outcome on its own. */
  patterns: string[];
  /** Entries inside `state` a run may neither read nor write. An agent's own
   *  directory also holds the researcher's account of every other thing they
   *  have done with that program, and this run has no business in any of it.
   *  A `state` entry beneath one of these is re-allowed afterwards, which is
   *  how a run keeps its own record of this Task and nothing else's. */
  private: string[];
}

/** What an agent this machine knows nothing about reaches of its own, which
 *  is nothing. Named rather than left to an optional field, so declaring no
 *  home is something a caller does on purpose. */
export const NO_AGENT_HOME: AgentHome = {
  state: [],
  credentials: [],
  sealed: [],
  private: [],
  patterns: [],
};

/**
 * What a run may touch, with no platform in it. A backend renders it and
 * spawns the adapter inside it, so a second platform is a second backend
 * rather than a second policy.
 */
export interface SandboxPolicy {
  /** The one Task directory this run may write. Never the whole work dir:
   *  one run may not read another Task's. */
  workspace: string;
  /** Canonicalized standing and session grants. */
  grants: SandboxGrant[];
  /** Paths denied whatever the grants say. Rendered last. */
  denied: string[];
  /**
   * Paths a run may read and never write, belonging to no agent's own
   * installation. A kernel's environment is what this is for: it has to be
   * readable for an interpreter to start out of it, and unwritable because an
   * environment a cell can write is one a cell can leave a `sitecustomize.py`
   * in — and that runs on the next launch, which may not be inside any
   * boundary at all.
   */
  readable: string[];
  /** The agent's own installation, canonicalized. Separate from `grants`
   *  because nothing the researcher answers can widen or narrow it: it is a
   *  property of which program is being run, not of what it may reach. */
  home: AgentHome;
}

export interface SandboxBackend {
  /** What this backend is, for a reason a researcher reads. */
  name: string;
  /** The adapter command, wrapped so it runs inside the boundary. */
  confine(
    policy: SandboxPolicy,
    adapter: { command: string; args: string[] },
  ): { command: string; args: string[] };
}

/**
 * The physical path a name resolves to: every symlink followed, and `~`
 * read as the home directory so a grant written that way names the same
 * place a grant written in full does.
 *
 * Resolving physically rather than lexically is what puts a rule where the
 * kernel will actually look — it canonicalizes the path being accessed and
 * not the one in the filter, so a rule written against an unresolved name
 * matches nothing.
 *
 * Throws, naming the path, when it will not resolve. A rule that cannot
 * match is indistinguishable from an allowance nobody asked for, and a
 * researcher watching an agent be denied a folder they can see themselves
 * having granted has nothing connecting the two.
 */
export function canonicalPath(path: string): string {
  const home = homedir();
  const expanded =
    path === "~" ? home : path.startsWith(`~${sep}`) ? join(home, path.slice(2)) : path;
  try {
    return realpathSync(isAbsolute(expanded) ? expanded : resolve(expanded));
  } catch {
    throw new Error(`${path} is not a path this machine can resolve`);
  }
}

/**
 * The deepest part of `path` that exists, with the rest named from there.
 * A rule is written where the kernel will look even for something not
 * created yet — which is what a deny needs, since a credential store this
 * machine does not happen to have today is still a place nothing should be
 * allowed to write tomorrow.
 */
function canonicalPrefix(path: string): string | undefined {
  const home = homedir();
  const expanded =
    path === "~" ? home : path.startsWith(`~${sep}`) ? join(home, path.slice(2)) : path;
  const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);
  const parts = absolute.split(sep);
  for (let depth = parts.length; depth > 0; depth -= 1) {
    try {
      const head = realpathSync(parts.slice(0, depth).join(sep) || sep);
      return depth === parts.length ? head : join(head, ...parts.slice(depth));
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Whether `path` is `root` or lies beneath it. Both are already physical,
 *  so no `..` and no symlink can build a name that passes here and is
 *  refused by the kernel. */
function beneath(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Whether the researcher has already allowed this access. Asked of the same
 * canonical grant set the profile is rendered from, so "did the researcher
 * allow this?" and "will the kernel permit this?" cannot drift apart.
 *
 * Both sides are resolved as far as they exist, because the thing being
 * asked about is often a file the call is on its way to creating. Resolving
 * that far is what the kernel does too, so no `..` and no symlink can build
 * a name that passes here and is refused there.
 */
export function covers(
  grants: SandboxGrant[],
  path: string,
  mode: "read" | "write",
): boolean {
  const target = canonicalPrefix(path);
  if (target === undefined) return false;
  return grants.some((grant) => {
    if (mode === "write" && grant.mode === "read") return false;
    const root = canonicalPrefix(grant.path);
    return root !== undefined && beneath(root, target);
  });
}

/** A path as one Seatbelt string literal. A quote inside a path ends the
 *  literal early and turns the rest of the rule into something else, so it
 *  is escaped rather than assumed absent. */
function literal(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Shallow before deep, so a rule on a folder is written before a rule on
 *  something inside it and reading the profile follows the tree. */
function shallowToDeep<T>(items: T[], pathOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const left = pathOf(a);
    const right = pathOf(b);
    return left.split(sep).length - right.split(sep).length || left.localeCompare(right);
  });
}

/**
 * The read this machine must grant for a program to be a program at all:
 * the system, the runtime, and the operating system's own configuration.
 * Without it `(deny default)` aborts the child before it reaches its first
 * instruction, which is a failure that looks nothing like a denial — the
 * process dies with no output and nothing refused.
 *
 * The root directory itself is named because a child that cannot read it
 * never starts. It is one directory entry, not a subtree: reading `/` says
 * what is at the top level and nothing about what is inside any of it.
 */
const SYSTEM_READ = [
  "/usr",
  "/bin",
  "/sbin",
  "/opt",
  "/etc",
  "/System",
  "/Library",
  "/Applications",
  "/dev",
  "/var/db",
  "/var/select",
];

/**
 * Whether the baseline every profile already carries makes `path` readable on
 * its own — `path` beneath one of the `SYSTEM_READ` trees, which
 * `renderSeatbeltProfile` emits unconditionally into every profile it renders.
 *
 * Containment and not membership: `/usr/local/opt/python@3.13` is reached by
 * the grant on `/usr` like everything else beneath it, and a comparison
 * against the eleven strings above would answer no about a path the kernel can
 * plainly open.
 *
 * Canonical on both sides, because that is the shape the rule is written in
 * (`renderSeatbeltProfile` canonicalizes `SYSTEM_READ` before rendering it,
 * since the kernel canonicalizes the path being accessed and not the path in
 * the filter). `/var/db` is `/private/var/db` on this platform, and a raw
 * comparison would miss every path beneath it.
 *
 * Exported for the one caller that has a path it may either name or leave to
 * the baseline. Nothing here decides what a profile grants — this only answers
 * whether naming a path again would add anything.
 */
export function alreadySystemReadable(path: string): boolean {
  const target = canonicalPrefix(path);
  if (target === undefined) return false;
  return SYSTEM_READ.map(canonicalPrefix).some(
    (root) => root !== undefined && beneath(root, target),
  );
}

/**
 * The directory names a credential store goes by. Denied at any depth, under
 * any grant — the researcher's keys are theirs whether they sit in their home
 * directory or inside the folder they meant to share.
 *
 * Written without the leading dot, which the rule adds.
 */
const CREDENTIAL_STORE_NAMES = ["ssh", "aws", "gnupg", "docker", "kube", "netrc", "git-credentials"];

/** Devices and inherited descriptors a runtime writes to as a matter of
 *  course, and which carry nothing of the researcher's. */
const DEVICE_WRITE = ["/dev/null", "/dev/dtracehelper", "/dev/tty"];

/**
 * Renders a policy as a Seatbelt profile. A pure function of the policy, so
 * what it produces can be read and asserted without a sandbox or a
 * subprocess anywhere near it.
 *
 * The order is the specification rather than an implementation detail,
 * because the last rule that matches is the one that decides. A deny
 * emitted before an allow on its own ancestor is simply defeated — which is
 * how a researcher granting a folder that happens to hold their keys would
 * hand them over without ever being asked.
 */
export function renderSeatbeltProfile(policy: SandboxPolicy, program: string[] = []): string {
  const lines: string[] = ["(version 1)", "(deny default)", ""];

  lines.push("; the baseline, without which nothing starts");
  lines.push("(allow process-fork)");
  lines.push("(allow process-exec)");
  lines.push("(allow signal (target self))");
  lines.push("(allow sysctl-read)");
  lines.push("(allow file-read-metadata)");
  lines.push("(allow mach-lookup)");
  // An agent's model is not on this machine. Reaching it is the one thing
  // every turn does, so a boundary that denies it denies the turn — and does
  // so in the agent's own words rather than in the kernel's, which is how
  // this went unnoticed: the adapter reported not being signed in.
  //
  // Outbound only, and it is not an egress boundary: this says a run may
  // open a connection, and nothing about where to. What a run may take with
  // it is decided by what it can read, which is the file rules above.
  lines.push("(allow network-outbound)");
  lines.push(`(allow file-read* (literal ${literal(sep)}))`);
  // Written where the kernel will look. It canonicalizes the path being
  // accessed and not the path in the filter, so a rule naming a directory
  // that is itself a link matches nothing at all.
  const system = SYSTEM_READ.map(canonicalPrefix).filter((path): path is string => !!path);
  lines.push(`(allow file-read* ${system.map((path) => `(subpath ${literal(path)})`).join(" ")})`);
  const devices = DEVICE_WRITE.map(canonicalPrefix).filter((path): path is string => !!path);
  lines.push(
    `(allow file-write* ${devices.map((path) => `(literal ${literal(path)})`).join(" ")} (subpath "/dev/fd"))`,
  );
  // Nothing grants the platform's shared temporary directory. It is one
  // directory for every process on the machine, so granting it would let a
  // run read what another run left there — and would swallow the boundary
  // for anything the researcher happens to keep beneath it. A run's own
  // scratch belongs inside its workspace, which is already granted.
  //
  // Nothing grants the home directory's hidden entries either, and that is
  // the whole of this task. A rule here used to open every one of them to any
  // agent declaring an installation, reasoning that an agent must read its own
  // configuration to run and that configuration is what hidden entries hold.
  // Both halves are true; the conclusion was far too wide. What else lives
  // there is the researcher's package-index tokens, their shell history, their
  // cloud credentials and every other agent's installation — and the denies
  // beneath it were a list of exceptions, which is only ever as complete as
  // the last time somebody thought about it.
  //
  // What an agent actually needs to run, it already has: `programLocation`
  // grants the binary, its directory and its grandparent, and a real install
  // resolves through that grandparent to the whole of its own installation.
  // Checked before this was proposed rather than after — with no blanket
  // allow at all, `CLAUDE_CONFIG_DIR=<fresh> claude auth status` ran correctly
  // under `sandbox-exec` and answered `{"loggedIn": false, …}`. An agent that
  // turns out to need something specific names it on its row, which is a
  // grant somebody had to write down.
  //
  // The program this machine is about to run has to be readable to be that
  // program: the adapter itself, whatever its argument array names, and the
  // directories a command is looked up in. This machine built that argument
  // array, so nothing an agent says reaches here.
  for (const path of shallowToDeep([...new Set(program)], (p) => p))
    lines.push(`(allow file-read* (subpath ${literal(path)}))`);
  lines.push("");

  lines.push("; the policy's own allows, shallow to deep");
  lines.push(`(allow file-read* file-write* (subpath ${literal(policy.workspace)}))`);
  for (const grant of shallowToDeep(policy.grants, (g) => g.path))
    lines.push(
      `(allow file-read*${grant.mode === "write" ? " file-write*" : ""} (subpath ${literal(grant.path)}))`,
    );
  // Read and never write, and here rather than lower down: what a run is given
  // to execute out of is still beneath every deny, so a credential store a
  // researcher happens to keep inside one of these is refused by the same rule
  // that refuses it inside a grant.
  for (const path of shallowToDeep(policy.readable, (p) => p))
    lines.push(`(allow file-read* (subpath ${literal(path)}))`);
  lines.push("");

  // What this particular agent needs in order to be itself. Written after the
  // researcher's grants and before every deny, so a seal below still holds.
  if (
    policy.home.state.length > 0 ||
    policy.home.credentials.length > 0 ||
    policy.home.patterns.length > 0
  ) {
    lines.push("; the agent's own installation");
    for (const path of shallowToDeep(policy.home.state, (p) => p))
      lines.push(`(allow file-read* file-write* (subpath ${literal(path)}))`);
    for (const path of shallowToDeep(policy.home.credentials, (p) => p))
      lines.push(`(allow file-read* (subpath ${literal(path)}))`);
    for (const pattern of [...policy.home.patterns].sort())
      lines.push(`(allow file-read* file-write* (regex ${literal(pattern)}))`);
    lines.push("");
  }

  lines.push("; denies last, so a deny survives an allow on its ancestor");
  // A credential store is denied wherever it is, not only where this policy
  // happened to name one. A researcher grants a folder because of the data
  // in it, and a folder that also holds their keys is the ordinary case
  // rather than the unusual one — the grant would otherwise hand those keys
  // over without anyone being asked.
  lines.push(
    `(deny file-read* file-write* (regex ${literal(`/\\.(${CREDENTIAL_STORE_NAMES.join("|")})(/|$)`)}))`,
  );
  for (const path of shallowToDeep(policy.denied, (p) => p)) lines.push(...denyBoth(path));
  // Writing only. An agent reads its own configuration to start at all; what
  // it may not do is edit the file that decides what runs the next time this
  // program starts outside any boundary of ours.
  for (const path of shallowToDeep(policy.home.sealed, (p) => p))
    lines.push(`(deny file-write* (subpath ${literal(path)}))`);
  // Neither reading nor writing. The researcher's own account of everything
  // else they have done with this program sits inside the same directory the
  // program needs, and a run has no business in any of it.
  for (const path of shallowToDeep(policy.home.private, (p) => p)) lines.push(...denyBoth(path));

  // Last, and only what is both the agent's own and beneath something denied
  // above: this Task's record, inside the directory holding every Task's. The
  // last rule that matches is the one that decides, so the narrow allow has to
  // come after the wide deny — the same ordering that lets a seal beat the
  // state directory it sits in, read the other way round.
  const reopened = policy.home.state.filter((path) =>
    policy.home.private.some((denied) => beneath(denied, path) && path !== denied),
  );
  if (reopened.length > 0) {
    lines.push("");
    lines.push("; what the agent keeps inside what it is denied");
    for (const path of shallowToDeep(reopened, (p) => p))
      lines.push(`(allow file-read* file-write* (subpath ${literal(path)}))`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * The two rules one denied path actually needs.
 *
 * `subpath` matches a directory and everything beneath it, and stops at the
 * component boundary — so a deny naming `~/.claude` says nothing at all about
 * `~/.claude.json`, which is where Claude Code keeps the researcher's MCP
 * server definitions and their whole project history. Verified reachable
 * under `sandbox-exec` with the directory deny in force.
 *
 * The second rule closes exactly that: anchored at the start, ending in a
 * literal dot, so it covers `<path>.json`, `<path>.json.backup` and anything
 * else a vendor spells as a sibling — and does not touch `<path>` itself
 * (the subpath above owns that) or an unrelated neighbour like `<path>x`.
 */
function denyBoth(path: string): string[] {
  return [
    `(deny file-read* file-write* (subpath ${literal(path)}))`,
    `(deny file-read* file-write* (regex ${literal(`^${escapeRegex(path)}\\.`)}))`,
  ];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether this policy names an installation of its own at all.
 *
 * Asked of the shape of `NO_AGENT_HOME` rather than of a list of fields
 * spelled out here, so a part of an installation that is added later is a
 * part this question already covers instead of one it quietly ignores.
 */
/**
 * A place too broad to be one thing's own, whatever derived it. The root of
 * the disk, a top-level directory and a home directory are each somebody's
 * whole world, and opening one as where a program lives or as what a run may
 * read swallows the boundary: every other Task on this machine, and every
 * study beside them, come with it.
 *
 * Refused or dropped rather than trimmed: a location this wide is a mistake
 * in whatever produced it, not a rule to emit more carefully.
 */
function swallowsTheBoundary(path: string): boolean {
  if (path.split(sep).filter(Boolean).length < 2) return true;
  return path === canonicalPrefix(homedir());
}

/**
 * Where one program lives: the command itself, the directory holding it, the
 * package root above that — a program installed as `<prefix>/bin/x` keeps its
 * own files under `<prefix>` — and anything its argument array names that is
 * really on disk.
 *
 * Read only, and only what a program needs in order to be a program. A path
 * that does not resolve is simply not a file and contributes nothing; one
 * that is too broad to be a program's own location contributes nothing
 * either.
 *
 * Exported because a boundary sometimes has to carry a program it is not
 * itself rendered for: what a confined program starts is confined by the same
 * profile, and a helper it cannot read is a helper it cannot start.
 */
export function programLocation(program: { command: string; args: string[] }): string[] {
  const paths: string[] = [];
  const push = (path: string | undefined): void => {
    if (path !== undefined && !swallowsTheBoundary(path)) paths.push(path);
  };
  const resolved = (path: string): string | undefined => {
    try {
      return canonicalPath(path);
    } catch {
      return undefined;
    }
  };

  const command = resolved(program.command);
  if (command !== undefined) {
    push(command);
    push(dirname(command));
    push(dirname(dirname(command)));
  }
  for (const arg of program.args) {
    if (!arg.includes(sep)) continue;
    const named = resolved(arg);
    if (named === undefined) continue;
    push(named);
    push(dirname(named));
  }
  return paths;
}

/**
 * Everything the adapter about to be spawned has to be able to read in order
 * to be a program at all: its own location, and the directories a command is
 * looked up in — which is where the runtime a script names in its own first
 * line is found.
 *
 * A directory on the search path is taken as itself and never with its
 * parent: it is ALREADY the directory holding the program, and the thing
 * above it is a home directory or the root of the disk.
 */
function programPaths(adapter: { command: string; args: string[] }): string[] {
  const paths = programLocation(adapter);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue;
    try {
      const resolved = canonicalPath(dir);
      if (!swallowsTheBoundary(resolved)) paths.push(resolved);
    } catch {
      // A directory named on the search path that is not there. It holds no
      // program, so there is nothing to make readable.
    }
  }
  return paths;
}

const SEATBELT: SandboxBackend = {
  name: "seatbelt",
  confine(policy, adapter) {
    return {
      command: "/usr/bin/sandbox-exec",
      args: [
        "-p",
        renderSeatbeltProfile(policy, programPaths(adapter)),
        "--",
        adapter.command,
        ...adapter.args,
      ],
    };
  },
};

/** The backend that can confine a run on `platform`, or undefined. A
 *  platform with none is a named gap with a shaped hole to fill: the policy
 *  carries no platform, so a second backend is all it takes. */
export function sandboxBackendFor(platform: string): SandboxBackend | undefined {
  return platform === "darwin" ? SEATBELT : undefined;
}

/** The reason a machine cannot run an agent at all, when its platform has
 *  no backend. */
export function noBackendReason(platform: string): string {
  return `this machine runs ${platform}, and agent runs are only confined on macOS so far`;
}

/**
 * A stable summary of what a policy permits, so a caller can tell whether a
 * session already running is confined by the boundary this turn actually
 * needs. Order-independent: the same permissions listed differently are the
 * same boundary.
 *
 * A profile is fixed when the process is spawned and cannot be widened or
 * narrowed underneath it, so a turn whose grants no longer match the ones a
 * live session was rendered from has to be given a new process rather than
 * be run inside a boundary that describes something else.
 */
export function boundaryOf(policy: SandboxPolicy): string {
  return JSON.stringify({
    workspace: policy.workspace,
    grants: policy.grants.map((grant) => `${grant.mode}:${grant.path}`).sort(),
    denied: [...policy.denied].sort(),
    // Two runs given different environments to execute out of are two
    // boundaries, and a session opened inside one is not one the other reuses.
    readable: [...policy.readable].sort(),
    // Two agents confined for the same Task are not confined the same way,
    // and a session opened for one is not a session the other may reuse.
    home: [
      ...policy.home.state.map((path) => `state:${path}`),
      ...policy.home.credentials.map((path) => `credentials:${path}`),
      ...policy.home.sealed.map((path) => `sealed:${path}`),
      ...policy.home.private.map((path) => `private:${path}`),
      ...policy.home.patterns.map((pattern) => `pattern:${pattern}`),
    ].sort(),
  });
}

/**
 * The adapter command, wrapped so it runs inside the boundary. Throws when
 * the platform has no backend, naming it — the one thing that never happens
 * is an adapter spawned outside one.
 */
export function confine(
  platform: string,
  policy: SandboxPolicy,
  adapter: { command: string; args: string[] },
): { command: string; args: string[] } {
  const backend = sandboxBackendFor(platform);
  if (!backend) throw new Error(noBackendReason(platform));
  return backend.confine(policy, adapter);
}

/**
 * What is denied whatever a grant says. This machine's own token is its
 * identity, and an agent that can read it off disk can impersonate the
 * machine; the rest are the credential stores a researcher keeps beside the
 * data they meant to share.
 *
 * A store this machine does not happen to have is still named, so nothing
 * turns on whether it existed at the moment a run started.
 *
 * These are all flat files, which is the whole reason a deny belongs here: a
 * file rule is the only gate they have. The operating system's own credential
 * service is deliberately absent — nothing in the baseline allows the
 * directory holding it, so it is already out of reach by default, and naming
 * it here as well would outlive the allow an agent's own home renders and
 * take that agent's credential down with it.
 */
export function deniedPaths(dataDir: string): string[] {
  const home = homedir();
  const candidates = [
    dataDir,
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".docker"),
    join(home, ".kube"),
    join(home, ".netrc"),
    join(home, ".config", "gcloud"),
  ];
  return [...new Set(candidates.map(canonicalPrefix).filter((path): path is string => !!path))];
}

/**
 * The one canonical policy a run is both rendered from and asked about. The
 * profile and `covers()` are two consumers of this same list, so a card that
 * says yes and a write the kernel refuses cannot come apart.
 *
 * Throws, naming the path, when the workspace or a grant will not resolve.
 * Every grant comes from a card the agent raised about a path it had just
 * tried to reach, so a resolution failure means something genuinely unusual,
 * and refusing the run says so once at the moment the answer was given.
 */
export function policyFor(input: {
  workspace: string;
  grants: SandboxGrant[];
  dataDir: string;
  home?: AgentHome;
  /** Other agents' installations, denied whatever else this policy allows. */
  foreign?: string[];
  /** What this run may read and never write, owned by no agent. */
  readable?: string[];
}): SandboxPolicy {
  const workspace = canonicalPath(input.workspace);
  const grants = input.grants.map((grant) => ({
    path: canonicalPath(grant.path),
    mode: grant.mode,
  }));
  // An agent's own home is resolved as far as it exists rather than being
  // required to. A researcher who has never run one of these programs has no
  // such directory yet, and a rule written where it will be is what lets the
  // program create it — while a grant, which names something the researcher
  // is looking at, still refuses when it will not resolve.
  const declared = input.home ?? NO_AGENT_HOME;
  const home: AgentHome = {
    state: resolveEachThatCan(declared.state),
    credentials: resolveEachThatCan(declared.credentials),
    sealed: resolveEachThatCan(declared.sealed),
    private: resolveEachThatCan(declared.private),
    // Already written against resolved paths by whoever declared them: there
    // is no file here to resolve, only the shape of one that does not exist
    // yet and will not exist for long.
    patterns: [...declared.patterns],
  };
  const denied = [
    ...deniedPaths(input.dataDir),
    ...resolveEachThatCan(input.foreign ?? []),
  ];
  // Resolved as far as it exists, like a home and unlike a grant: an
  // environment is built by this machine rather than named by a researcher
  // looking at it, so a rule written where it will be is what lets it be built.
  const readable = resolveEachThatCan(input.readable ?? []);
  // Checked once resolved, because that is the shape the rule would be
  // written in and a link is one name for another place. Refused rather than
  // dropped, unlike a program's own location: a program with one path fewer
  // still runs out of the system directories, while a run given nothing to
  // execute out of fails in words nobody can trace back to here. Nothing a
  // researcher answered reaches this list — it is this machine's own — so a
  // path this wide is a defect rather than an answer.
  for (const path of readable)
    if (swallowsTheBoundary(path))
      throw new Error(`${path} is too broad to be an environment a run reads out of`);
  return { workspace, grants, denied: [...new Set(denied)], readable, home };
}

/** Each path written where the kernel will look, dropping the ones this
 *  machine cannot place at all. */
function resolveEachThatCan(paths: string[]): string[] {
  return [...new Set(paths.map(canonicalPrefix).filter((path): path is string => !!path))];
}
