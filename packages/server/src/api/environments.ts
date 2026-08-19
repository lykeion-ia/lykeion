import {
  LykeionError,
  type KernelEnvCreateInput,
  type KernelEnvDeclaration,
  type KernelEnvManager,
  type KernelEnvStatus,
  type Language,
  type LykeionApi,
} from "@lykeion/api";
import type { Deps } from "./index";
import type { ChangeRecorder } from "./changes";
import type { Store } from "../store/store";
import type { Actor } from "../auth";
import type { RunRelay } from "../run-relay";
import type { EnvSetupRegistry } from "../env-setup-registry";
import { environmentStore } from "../store/environments";
import { nextSeq } from "../store/migrations";
import { healthFor } from "../machine-health";
import { deliverOrRefuse } from "./kernels";

export type EnvironmentsApi = Pick<
  LykeionApi,
  "kernelEnvList" | "kernelEnvCreate" | "kernelEnvDelete" | "kernelEnvSetup" | "kernelEnvReclaim"
>;

/** The runtime a `kernelEnvSetup`/`kernelEnvReclaim` call may act on, or the
 *  refusal that keeps it off one it should not touch — the same three
 *  checks `authorizedKernelRuntime` (`kernels.ts`) holds a kernel command
 *  to, minus the kernel-identity fields neither command needs: this one
 *  addresses a machine directly, named by the caller (R2's ruling — the
 *  caller always knows which machine, so nothing here infers one). */
async function authorizedOwnRuntime(
  deps: Deps,
  actor: Actor,
  now: number,
  machineId: string,
): Promise<{ machineId: string; name: string }> {
  const row = deps.store.get(
    `SELECT owner_id AS owner_id, name AS name, last_seen_ts AS last_seen_ts
       FROM runtimes WHERE id = ? AND removed_ts IS NULL`,
    [machineId],
  );
  if (!row) throw new LykeionError("not-found", `no such machine: ${machineId}`);
  if (row.owner_id !== actor.userId)
    throw new LykeionError(
      "forbidden",
      "only the member who paired a machine may set up or free environments on it",
    );
  if (healthFor(row.last_seen_ts as number, now) === "offline")
    throw new LykeionError(
      "conflict",
      `${row.name as string} is offline — it has to be running and connected before an environment can be set up on it`,
    );
  return { machineId, name: row.name as string };
}

/**
 * One in-flight `kernelEnvSetup` per (machine, environment), shared by
 * however many callers ask while it is in flight — the coalescing wrapper
 * `sweep(deps)` (`kernels.ts`) uses for the same reason: two researchers
 * asking the same machine to build the same environment must collapse into
 * one build, not race two `uv venv --clear` invocations over the same
 * directory. Module-level, like `sweep`'s own `inFlight`, and for the same
 * reason — it coalesces across every request in this process, not just the
 * one that happened to start it.
 */
const inFlightSetups = new Map<string, Promise<SetupRound>>();

/** One finished build, and the package request it was planned against —
 *  which is what a caller who JOINED it needs in order to tell whether that
 *  build was ever told about the packages they came here for. */
interface SetupRound {
  status: KernelEnvStatus;
  /** The declaration's `packages` as the build read them when it was
   *  dispatched. On the resolving branch it is what the machine resolved
   *  from; on the replaying branch it is what the pin was already known to
   *  answer (that equality is why it replayed). Either way it is the request
   *  this build satisfies, and nothing added afterwards is in it. */
  covered: string[];
}

function coalescedSetup(key: string, run: () => Promise<SetupRound>): Promise<SetupRound> {
  const existing = inFlightSetups.get(key);
  if (existing) return existing;
  const started = run().finally(() => {
    inFlightSetups.delete(key);
  });
  inFlightSetups.set(key, started);
  return started;
}

/** Whether two package requests are the same request, whatever order they
 *  arrived in. `["a","b"]` and `["b","a"]` describe one environment, and a
 *  comparison that called them different would re-resolve — and so re-pin
 *  the whole lab — because somebody's list came back sorted. Duplicates are
 *  not collapsed: `environmentStore.addPackages` de-duplicates on the way in,
 *  so a repeated name is a shape neither side of this comparison produces. */
function sameRequest(a: string[], b: string[]): boolean {
  // Length first, and it is load-bearing rather than an optimization: without
  // it the element-wise walk below compares only as far as the shorter list
  // goes, so a pinned request that is a sorted PREFIX of the declaration —
  // pinned from `["anndata"]`, declaration now `["anndata","scanpy"]` — reads
  // as a match and `scanpy` is replayed away on every machine in the lab.
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((entry, i) => entry === right[i]);
}

/** What one `kernel-env-setup` command asks a machine to do: RESOLVE the
 *  declaration's own list, or MATERIALIZE a pin that still answers it. */
type SetupPlan =
  | { resolve: true; packages: string[] }
  | { resolve: false; lockfile: string; lockRevision: number };

/**
 * D4's branch, as one answer read from the store at one moment — and the only
 * place the resolve-or-replay question is decided, so a dispatch and the
 * re-check that follows it can never disagree about what "satisfied" means.
 *
 * A pin is this lab's answer to ONE package request. Adding packages to a
 * declaration moves the request out from under the pin — the declaration now
 * names software the lockfile was never resolved from — and replaying it
 * would silently drop every package the researcher just approved on a card.
 * So the question is not "is there a pin" but "is the pin still a pin for
 * what this declaration asks for", and it is DERIVED from the two lists
 * rather than recorded as a flag that could disagree with either.
 */
export function planFor(store: Store, name: string): SetupPlan {
  const envs = environmentStore(store);
  const declaration = envs.get(name);
  if (declaration === undefined)
    throw new LykeionError("not-found", `no such environment: ${name}`);
  if (declaration.lockRevision === 0) return { resolve: true, packages: declaration.packages };
  const lockfile = envs.readLock(name, declaration.lockRevision);
  // A revision this lab points at and holds no text for is a broken store,
  // not a stale pin, and it is refused rather than widened. Resolving here is
  // precisely the second, independent resolution D4 exists to prevent, and it
  // would quietly become the next revision as if nothing were wrong.
  if (lockfile === undefined)
    throw new LykeionError(
      "conflict",
      `${name}'s lockfile for revision ${declaration.lockRevision} is missing from this lab's own store`,
    );
  // A pin whose row is there but whose request this lab cannot name — written
  // before migration 28 — is the third case. It is not "resolved from
  // nothing", and it is not evidence of a match either, so the caller WIDENS,
  // the way `envBase` already widens for a `pyvenv.cfg` it cannot read.
  // Resolving where a replay would have done costs one re-pin; replaying
  // where a resolve was needed drops packages a researcher approved, on every
  // machine in the lab, with nothing saying so.
  const pinnedFrom = envs.readLockRequest(name, declaration.lockRevision);
  if (pinnedFrom === undefined || !sameRequest(pinnedFrom, declaration.packages))
    return { resolve: true, packages: declaration.packages };
  return { resolve: false, lockfile, lockRevision: declaration.lockRevision };
}

/**
 * How many builds one call will sit through before it gives up.
 *
 * A caller that JOINS an in-flight build re-checks when that build settles and
 * builds again if the declaration has moved past what got pinned (see
 * `buildEnvironmentOn`). Each round absorbs every addition made during the
 * previous one — the second round carries everything added while the first was
 * running, and so on — so the sequence terminates as soon as one whole build
 * window passes with nobody adding packages. Two rounds is the realistic worst
 * case (a build, and everything asked for while it ran); four leaves room for a
 * burst without letting a lab where something adds a package on a timer spin a
 * caller forever. A caller that exhausts this says so rather than reporting a
 * build that is not coming.
 */
const MAX_SETUP_ROUNDS = 4;

/**
 * One machine building (or replaying) one environment, and the wait for it
 * to say what it came to.
 *
 * Both callers of this reach it having ALREADY decided that this machine may
 * be asked — `kernelEnvSetup` through `authorizedOwnRuntime`, and
 * `/daemon/kernel-env/packages` because the machine it dispatches to is the
 * one whose bearer token authenticated the call, which is a machine
 * rebuilding its own copy. Neither fact is re-derived here.
 *
 * `reason` is why this rebuild is happening, in words, and rides the command
 * so the machine can carry it into the ending of every kernel the rebuild
 * displaces. Absent for a plain Setup click — a build nobody needs a
 * sentence for, because the researcher is looking at the button they pressed.
 *
 * **Coalesce, then re-check.** Two `uv venv --clear` runs racing over one
 * directory is the worse failure, so builds still collapse — but a caller who
 * joins an in-flight one does not get to assume it satisfies them. The build
 * they joined was planned from the declaration as it read when it STARTED; a
 * caller who arrived afterwards, having just appended packages, is asking for
 * something that build was never told about. So when it settles, this checks
 * what that build actually covered against what THIS caller came for, and
 * builds again if its own packages are not in it. Without that, the second of
 * two adds is answered `building: true`, is never built on any machine, and
 * every kernel in the environment restarts announcing only the first one.
 *
 * The same loop catches the other direction: an add landing while a Setup
 * click is REPLAYING the old pin joins that replay, which resolves nothing —
 * the re-check finds the caller's own packages absent from what was covered
 * and resolves.
 *
 * `wanted` is what this caller is owed: the declaration as it stood when the
 * call arrived, which for the packages route is the list its own append
 * produced. Checked as a SUBSET of what a build covered rather than as
 * equality, and that distinction is what keeps the reasons straight: the
 * caller who asked for `scanpy` is satisfied by the build that carried it and
 * returns, so the extra round is started by the caller who asked for
 * `anndata` and carries `anndata`'s sentence into the kernels it restarts.
 * Equality would have both loop, and the second build would announce the
 * first one's reason. A subset is sound here because there is no remove (D7):
 * a declaration only ever grows.
 */
export async function buildEnvironmentOn(
  parts: { store: Store; runs: RunRelay; envSetups: EnvSetupRegistry },
  machine: { machineId: string; name: string },
  name: string,
  wanted: string[],
  reason?: string,
): Promise<KernelEnvStatus> {
  for (let round = 0; round < MAX_SETUP_ROUNDS; round++) {
    // Coalesced BEFORE anything is delivered: two callers racing in must
    // never each mint their own `kernel-env-setup` and send this machine
    // building the same directory twice.
    const { status, covered } = await coalescedSetup(`${machine.machineId}:${name}`, () =>
      oneSetup(parts, machine, name, reason),
    );
    const held = new Set(covered);
    if (wanted.every((entry) => held.has(entry))) return status;
  }
  throw new LykeionError(
    "conflict",
    `${name} kept changing while ${machine.name} was building it — the packages are declared, but ` +
      `this lab gave up waiting for a build that includes them; set it up again once the changes stop`,
  );
}

/** One build: plan it, send it, wait for the machine to say what it came to. */
async function oneSetup(
  parts: { store: Store; runs: RunRelay; envSetups: EnvSetupRegistry },
  machine: { machineId: string; name: string },
  name: string,
  reason: string | undefined,
): Promise<SetupRound> {
  const { store, runs, envSetups } = parts;
  const envs = environmentStore(store);
  // Read INSIDE the coalesced body, never before it. `planFor` turns on
  // `lockRevision` and on what that revision was resolved from, and both move
  // the moment some machine finishes a resolve — so a plan made before this
  // point can be stale by the time it is used, and stale here means resolving
  // a package list this lab has already pinned. Two independent resolutions of
  // one list drift as soon as a maintainer publishes, which is the whole
  // failure D4 exists to prevent.
  //
  // The real race is untouched either way: two machines whose reads land in
  // the same instant both still resolve, and write revisions 1 and 2. See the
  // ledger's R25 for why that residue is parked rather than fixed here —
  // closing it needs a serialization point spanning two processes, which is
  // not a change to make without a test that can actually exercise it.
  const declaration = envs.get(name);
  if (declaration === undefined)
    throw new LykeionError("not-found", `no such environment: ${name}`);
  const plan = planFor(store, name);
  const requestId = `envsetup_${nextSeq(store)}`;
  const base = {
    type: "kernel-env-setup" as const,
    runId: requestId,
    name,
    language: declaration.language,
    manager: declaration.manager,
    ...(reason === undefined ? {} : { reason }),
  };
  deliverOrRefuse(
    runs,
    machine,
    plan.resolve
      ? { ...base, packages: plan.packages }
      : { ...base, lockfile: plan.lockfile, lockRevision: plan.lockRevision },
  );

  const result = await envSetups.await(machine.machineId, requestId, name, {
    // What this machine was asked to resolve from, remembered against this one
    // ask so that `/daemon/kernel-env/lock` can write it down beside the
    // lockfile it produces. Only ever set on the resolving branch: a replay
    // resolves nothing and pins nothing.
    ...(plan.resolve ? { resolvedFrom: plan.packages } : {}),
  });
  if (result === undefined)
    throw new LykeionError(
      "conflict",
      `${machine.name} did not finish setting up ${name} in time — check the machine and try again`,
    );
  // `conflict`, never `unsupported`. A build that failed is a build that can
  // be retried — a network blip mid-`uv pip sync`, a package that would not
  // compile today. `unsupported` is what `kernelEnvSetup`'s own removed
  // refusal meant ("this lab cannot set up managed environments yet"), so a
  // client reading it would take a transient failure for a permanent
  // capability gap and stop offering Setup at all. Same code as the timeout
  // above, which is the same class of fact: it did not work this time.
  if (!result.ok) throw new LykeionError("conflict", result.error);
  // Nothing here writes `lock_revision`: on the resolve branch, that already
  // happened — synchronously, from the machine's own mid-build call to
  // `/daemon/kernel-env/lock` — before this reply could ever arrive, so a
  // caller reading `envs.get(name)` right after this resolves already sees the
  // new revision.
  //
  // `covered` is the declaration as it read at DISPATCH, not as it reads now:
  // this is the request this build answers, and the whole point of handing it
  // back is that anything appended since is provably not in it.
  return { status: result.status, covered: declaration.packages };
}

/** A name every machine will be able to build: one path segment, and the
 *  same shape the daemon's own `envRoot` (`packages/daemon/src/environments.ts`)
 *  refuses anything else against — because that is what a declaration's name
 *  becomes on a machine, `<workDir>/envs/<name>`, the directory `uv venv
 *  --clear` is pointed at and the sandbox policy is rendered around.
 *
 *  Written out a second time here rather than imported: a lab and a machine
 *  are different trust domains, and the daemon must keep refusing a name it
 *  cannot resolve however the name reached it — including from a lab older
 *  than this check. What this copy buys is WHERE the refusal lands. Without
 *  it a researcher types a name here, the lab accepts it, and the failure
 *  surfaces on some colleague's machine hours later with nobody in front of
 *  it. */
const BUILDABLE_NAME = /^[A-Za-z0-9_-]+$/;

/** Which manager builds which language. Derived rather than supplied: a
 *  caller does not choose a package manager, because the two are not
 *  independent — an R environment that pins R itself is a conda one, and a
 *  Python environment resolved by uv is a uv one. */
const MANAGER_FOR: Record<Language, KernelEnvManager> = { python: "uv", r: "conda" };

/**
 * One declaration, made once — whoever asked for it.
 *
 * Two surfaces reach this: a researcher typing a name into the lab
 * (`kernelEnvCreate`, below), and an agent asking for one through
 * `manage_environments`, which arrives over `/daemon/kernel-env/create` on
 * the daemon wire. They must not hold two copies of these rules. A second
 * copy drifts, and the drift is a name a researcher can type into this lab
 * that no agent can create — or the reverse, an agent declaring a name no
 * researcher could have, which every machine then has to build.
 *
 * `ownerId` is passed rather than read off an actor, because the two
 * surfaces disagree about who that is and only the caller knows. On the
 * daemon wire the bearer token names the MACHINE; the researcher whose
 * environment this is comes from the session it was asked inside. Attributed
 * to the machine's owner instead, a colleague's environment would appear in
 * this lab under whoever happened to own the laptop it was typed on.
 */
export function declareEnvironment(
  store: Store,
  record: ChangeRecorder["record"],
  input: KernelEnvCreateInput,
  ownerId: string,
  now: number,
): KernelEnvDeclaration {
  // Checked by VALUE against the record's own keys, not by trusting the
  // declared type. `input` arrives over the wire, and nothing on that path
  // validates it against a schema — the same reason every refusal on the MCP
  // surface is written in code. `Language` being a closed union makes this
  // branch unreachable to a TypeScript caller and reachable to every other
  // one, which is exactly the set of callers that matters here.
  const named = (input as { language?: unknown }).language;
  if (typeof named !== "string" || !(named in MANAGER_FOR)) {
    throw new LykeionError(
      "unsupported",
      `Lykeion builds Python and R environments — it has no provisioner for ${String(named)}.`,
    );
  }
  const manager = MANAGER_FOR[named as Language];
  // Refused here, in front of whoever asked, rather than on whichever
  // machine is first asked to build it — every machine turns this name into
  // a directory of its own, and one that cannot be a directory is a
  // declaration nothing in this lab can ever build.
  if (!BUILDABLE_NAME.test(input.name)) {
    throw new LykeionError(
      "invalid",
      // Quoted, unlike the refusals below it: the names this turns away are
      // the ones whose spaces, slashes or emptiness are the whole problem,
      // and bare in a sentence they are invisible.
      `${JSON.stringify(input.name)} cannot be an environment name — use only letters, numbers, ` +
        "dashes and underscores, since each machine builds an environment into a folder of that name.",
    );
  }
  const envs = environmentStore(store);
  return store.tx(() => {
    // A hard delete (see `environmentStore.remove`), so a row returned at all
    // means this name is taken — there is no "was deleted, so it's free
    // again" case that could fall through to a raw PRIMARY KEY collision
    // below.
    //
    // Asked WITHOUT REGARD TO CASE, which is the collation that actually
    // decides whether two declarations can coexist. SQLite's is BINARY, so
    // `python` and `Python` are two rows and this check would not fire; but a
    // name is a directory on every machine, `<workDir>/envs/<name>`, and the
    // only sandbox backend this phase ships is seatbelt, so every machine is
    // macOS with a case-insensitive volume. Two rows, one directory, and
    // `materializeEnvironment`'s `uv venv --clear` deletes whatever is
    // already there: the second declaration's first build silently replaces
    // the first's, and every kernel that says `python` afterwards runs
    // `Python`'s interpreter and site-packages. D9's "two environments are
    // two interpreters, which are two processes, which are two namespaces"
    // would stop being true with nothing anywhere saying so.
    //
    // Refused rather than folded to a canonical spelling. A silent lowercase
    // would answer an agent that asked for `Python` with a declaration named
    // something else, which it then has to notice in order to write its next
    // call — and it would rename nothing on the labs that already hold a
    // colliding pair, so the failure above would survive the fix. Refusing
    // touches no existing declaration: a lab keeps every name it has, in the
    // case it has it, and only a NEW name that cannot coexist with one is
    // turned away.
    const taken = envs.getIgnoringCase(input.name);
    if (taken !== undefined) {
      throw new LykeionError(
        "conflict",
        taken.name === input.name
          ? `this lab already has an environment named ${input.name}`
          : // Named, because the two spellings are the whole of the problem
            // and a sentence about ${input.name} alone would read as this lab
            // contradicting the list the caller just read.
            `this lab already has an environment named ${taken.name}, and ${input.name} would be the` +
              " same folder on every machine that builds it — names differing only in case cannot both exist",
      );
    }
    const declared = envs.declare({
      name: input.name,
      language: input.language,
      manager,
      packages: input.packages,
      createdBy: ownerId,
      createdTs: now,
    });
    record("environment-created", { name: input.name }, ownerId);
    return declared;
  });
}

/**
 * The lab's environment declarations, over `environmentStore`, and the wire
 * that turns a declaration into a build on a researcher's own machine.
 *
 * `buildEnvironmentOn` is where D4 lives: a machine resolves when nothing is
 * pinned yet, or when what IS pinned was resolved from a package request
 * this declaration has since grown past, and otherwise replays this lab's
 * stored lockfile. Get that branch wrong in one direction and two machines
 * independently resolve the same package list, drifting the moment a
 * maintainer publishes; get it wrong in the other and a machine replays a
 * lockfile that predates packages a researcher approved, and the software
 * they asked for is silently absent everywhere.
 */
export function environmentsApi(deps: Deps): EnvironmentsApi {
  const { store, actor, now, runs, envSetups } = deps;
  const { record } = deps.changes;
  const envs = environmentStore(store);

  return {
    async kernelEnvList() {
      return envs.list();
    },

    async kernelEnvCreate(input: KernelEnvCreateInput) {
      // Everything about declaring one lives in `declareEnvironment`, which
      // the daemon wire's own `/daemon/kernel-env/create` reaches too. What
      // this surface knows and that one does not is who is asking: the
      // signed-in actor is the researcher, here, in front of the form.
      return declareEnvironment(store, record, input, actor.userId, now());
    },

    async kernelEnvDelete(name: string) {
      store.tx(() => {
        const declaration = envs.get(name);
        if (declaration === undefined) {
          throw new LykeionError("not-found", `no such environment: ${name}`);
        }
        // Absent `createdBy` means Lykeion declared this, not a researcher
        // (R14) — the starter, seeded on every fresh lab. That same fact is
        // why it cannot be deleted: under D7 the agent may create an
        // environment (`manage_environments`) but a researcher cannot from
        // this surface, so a lab that deleted its only environment would
        // have none and no way to make one — stranded by two clicks. A
        // delete that silently undid itself on the next boot would be no
        // better, a lie to whoever performed it — so this is refused
        // outright, here, rather than left to reboot behaviour either way.
        // Reached from wherever `kernelEnvDelete` is called, not merely
        // hidden in the UI, so it holds however the call arrives.
        //
        // Freeing a MACHINE's own copy (`kernelEnvReclaim`) is a different
        // operation entirely — the declaration stands, the gigabytes go,
        // and it rebuilds from the lockfile this lab still holds — and is
        // unaffected by this guard.
        if (declaration.createdBy === undefined) {
          throw new LykeionError(
            "forbidden",
            `${name} is Lykeion's own starter environment, not one this lab created, and cannot be deleted — free a machine's own copy instead with Reclaim.`,
          );
        }
        envs.remove(name);
        record("environment-deleted", { name });
      });
    },

    async kernelEnvSetup(machineId: string, name: string, _onProgress?: (line: string) => void) {
      // `onProgress` is part of the contract's shape and is honoured by no
      // implementation at all — not this one, and not the in-memory core
      // either, which refuses `kernelEnvSetup` outright rather than
      // pretending to provision. Progress lines reach the browser over
      // `KERNEL_SETUP_CHANNEL` instead (this lab publishes them the moment
      // `/daemon/kernel-env/progress` reports one), and subscribing to that
      // channel is the client's job, not this method's.
      const declared = envs.get(name);
      if (declared === undefined)
        throw new LykeionError("not-found", `no such environment: ${name}`);
      const resolved = await authorizedOwnRuntime(deps, actor, now(), machineId);
      // What this click is owed: the declaration as it reads right now. A
      // package somebody adds while the build runs is not something this
      // researcher asked for, so it must not keep their Setup waiting — the
      // caller who added it does its own round for it.
      //
      // No `reason`: a researcher clicking Setup is looking at the button
      // they pressed, and a sentence explaining why their kernels restarted
      // would be this lab telling them what they just did.
      return buildEnvironmentOn({ store, runs, envSetups }, resolved, name, declared.packages);
    },

    async kernelEnvReclaim(machineId: string, name: string) {
      const resolved = await authorizedOwnRuntime(deps, actor, now(), machineId);
      // No reply awaited, the same as `kernelStop`/`kernelRestart`: this is
      // a researcher's own machine freeing its own disk, there is no build
      // to watch progress on, and the next report this machine sends is
      // what tells `computeSnapshot` it is gone.
      deliverOrRefuse(runs, resolved, { type: "kernel-env-reclaim", runId: `envreclaim_${nextSeq(store)}`, name });
    },
  };
}
