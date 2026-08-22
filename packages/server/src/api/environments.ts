import {
  LykeionError,
  type KernelEnvCreateInput,
  type KernelEnvDeclaration,
  type KernelEnvManager,
  type Language,
  type LykeionApi,
} from "@lykeion/api";
import type { Deps } from "./index";
import type { ChangeRecorder } from "./changes";
import type { Store } from "../store/store";
import type { Actor } from "../auth";
import { environmentStore } from "../store/environments";
import { environmentSetupStore } from "../store/environment-setups";
import { nextSeq } from "../store/migrations";
import { healthFor } from "../machine-health";
import { deliverOrRefuse } from "./kernels";

export type EnvironmentsApi = Pick<
  LykeionApi,
  | "kernelEnvList" | "kernelEnvCreate" | "kernelEnvDelete" | "kernelEnvReclaim"
  | "requestKernelEnvironmentSetup" | "taskEnvironmentSetups"
  | "retryKernelEnvironmentSetup" | "answerEnvironmentDefaultSuggestion"
>;

/** The runtime a `kernelEnvReclaim` call may act on, or the
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

/** Whether two package requests are the same request, whatever order they
 *  arrived in. `["a","b"]` and `["b","a"]` describe one environment, and a
 *  comparison that called them different would re-resolve — and so re-pin
 *  the whole lab — because somebody's list came back sorted. Duplicates are
 *  not collapsed: `environmentStore.addPackages` de-duplicates on the way in,
 *  so a repeated name is a shape neither side of this comparison produces. */
export function sameRequest(a: string[], b: string[]): boolean {
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
 * `planFor` is where D4 lives: a machine resolves when nothing is
 * pinned yet, or when what IS pinned was resolved from a package request
 * this declaration has since grown past, and otherwise replays this lab's
 * stored lockfile. Get that branch wrong in one direction and two machines
 * independently resolve the same package list, drifting the moment a
 * maintainer publishes; get it wrong in the other and a machine replays a
 * lockfile that predates packages a researcher approved, and the software
 * they asked for is silently absent everywhere.
 */
export function environmentsApi(deps: Deps): EnvironmentsApi {
  const { store, actor, now, runs, coordinator } = deps;
  const { record } = deps.changes;
  const envs = environmentStore(store);
  const setups = environmentSetupStore(store);

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
      const { cancellations } = store.tx(() => {
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
        // Inside the same transaction as the removal, because a Research
        // default naming an environment this lab no longer declares is not a
        // stale default — it is a default nothing can ever resolve, and every
        // unaddressed cell of that language would be refused by a name that
        // exists nowhere. The pending question goes with it for the same
        // reason: answering "use it by default" about a deleted environment
        // would write exactly the row this line just swept.
        //
        // And every Task still waiting on this name goes with them, because
        // the build it is waiting for can no longer be planned at all: the
        // declaration is gone, so nothing will ever settle that waiter and no
        // continuation will ever start. That cancellation is the coordinator's
        // rather than this line's — it is the half-operation this used to
        // decline to perform, and the coordinator is what pairs it with
        // `finishTurn` for a `queued` waiter's own continuation turn and with
        // the `cancel` command dispatched below, after this transaction has
        // committed.
        //
        // Reclaim does none of this and must not: freeing a machine's own
        // copy leaves the declaration standing, so the default still names
        // something this lab has, and the next machine to build it makes the
        // default reachable again.
        const cancelled = coordinator.cancelForEnvironment(name);
        record("environment-deleted", { name });
        return cancelled;
      });
      // Outside the transaction: a machine told to stop a run that a
      // rolled-back delete would have left running is a command this lab
      // cannot take back.
      for (const cancellation of cancellations)
        runs.enqueue(cancellation.machineId, {
          type: "cancel",
          runId: cancellation.runId,
        });
    },

    async requestKernelEnvironmentSetup(input) {
      return coordinator.request(input, actor, record);
    },

    async taskEnvironmentSetups(taskId) {
      const task = store.get(`SELECT id FROM tasks WHERE id = ?`, [taskId]);
      if (!task) throw new LykeionError("not-found", `no such Task: ${taskId}`);
      return setups.forTask(taskId);
    },

    async retryKernelEnvironmentSetup(waiterId) {
      return coordinator.retry(waiterId, actor, record);
    },

    async answerEnvironmentDefaultSuggestion(suggestionId, useByDefault) {
      if (!setups.answerSuggestion(suggestionId, actor.userId, useByDefault, now())) {
        throw new LykeionError(
          "not-found",
          `no such pending environment default suggestion: ${suggestionId}`,
        );
      }
      record("environment-setup-changed", { suggestionId });
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
